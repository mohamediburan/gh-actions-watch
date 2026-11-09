import * as vscode from 'vscode';
import { GitHubSession } from './auth';
import { ActionsClient, GitHubApiError } from './github';
import { resolveWorkspaceRepos } from './repository';
import type { Job, RepoState, ViewState, WorkflowRun, WorkflowRunStatus } from './types';

export interface PollerOptions {
  /** Explicit `owner/name` list. Empty means "the GitHub remote of each open folder". */
  repositories: string[];
  activePollMs: number;
  idlePollMs: number;
  recentRuns: number;
}

export interface RefreshOptions {
  /** Token from an interactive sign-in, used instead of a silent lookup. */
  token?: string;
  /** Run even while the window is unfocused (the user asked for it explicitly). */
  force?: boolean;
}

const MIN_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;
/** Enough for a large matrix; GitHub's cap for this endpoint. */
const JOBS_PER_PAGE = 100;

function isActive(status: WorkflowRunStatus): boolean {
  return (
    status === 'in_progress' ||
    status === 'queued' ||
    status === 'waiting' ||
    status === 'requested' ||
    status === 'pending'
  );
}

/**
 * The single owner of the network and the single timer.
 *
 * The overlay reads `snapshot()` and never fetches: that keeps one token, one
 * `ETag` cache and one cadence in one place. While the window is unfocused the
 * poll returns without a request, so a background window costs nothing.
 */
export class ActionsPoller implements vscode.Disposable {
  private readonly client = new ActionsClient();
  private readonly session = new GitHubSession();
  private readonly states = new Map<string, RepoState>();
  private readonly listeners: Array<(state: ViewState) => void> = [];

  private options: PollerOptions;
  private repositories: string[] = [];
  private signedIn = false;
  /** False until the first silent token lookup has answered. */
  private authPending = true;
  private hint: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private refreshing = false;
  private focused = true;
  private disposed = false;

  constructor(options: PollerOptions) {
    this.options = options;
  }

  onState(listener: (state: ViewState) => void): void {
    this.listeners.push(listener);
  }

  /** The last known state. The overlay renders from this, never from a fetch. */
  snapshot(): ViewState {
    const repos = this.repositories
      .map((repo) => this.states.get(repo))
      .filter((state): state is RepoState => state !== undefined);

    return {
      signedIn: this.signedIn,
      authPending: this.authPending,
      repos,
      rateLimit: repos.map((repo) => repo.rateLimit).find((limit) => limit !== null) ?? null,
      polledAt: Date.now(),
      hint: this.hint,
    };
  }

  async start(): Promise<void> {
    await this.reloadRepositories();
    await this.refresh();
  }

  configure(options: PollerOptions): void {
    this.options = options;
    void this.reloadRepositories().then(() => this.refresh());
  }

  async reloadRepositories(): Promise<void> {
    const configured = this.options.repositories
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    this.repositories = configured.length > 0 ? configured : await resolveWorkspaceRepos();

    const stale = Array.from(this.states.keys()).filter(
      (repo) => !this.repositories.includes(repo),
    );
    for (const repo of stale) this.states.delete(repo);

    this.hint =
      this.repositories.length === 0
        ? 'No GitHub repository. Open a checkout with a GitHub `origin` remote, or set `ghActionsWatch.repositories`.'
        : null;
  }

  setFocused(focused: boolean): void {
    const wasUnfocused = !this.focused;
    this.focused = focused;
    if (focused && wasUnfocused) void this.refresh();
  }

  async signIn(): Promise<void> {
    const token = await this.session.signIn();
    this.authPending = false;
    this.signedIn = token !== null;
    // Hand the freshly granted token straight to the poll: a silent lookup right
    // after the interactive flow is not guaranteed to return it.
    if (token === null) this.publish();
    else await this.refresh({ token });
  }

  async refresh(options: RefreshOptions = {}): Promise<void> {
    if (this.disposed || this.refreshing) return;

    // Nothing is looking at this. Re-arm on the slow cadence instead of
    // spending requests; focus or an explicit command refreshes immediately.
    if (!this.focused && options.force !== true) {
      // Still resolve the session once: it is a local lookup, not a request,
      // and it keeps the card from sitting on "checking" in the background.
      if (this.authPending) {
        this.signedIn = (await this.session.silentToken()) !== null;
        this.authPending = false;
      }
      this.publish();
      this.schedule();
      return;
    }

    this.refreshing = true;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    try {
      const token = options.token ?? (await this.session.silentToken());
      this.signedIn = token !== null;
      this.authPending = false;
      if (token === null) return;

      for (const repo of this.repositories) {
        if (controller.signal.aborted) return;
        await this.pollRepo(repo, token, controller.signal);
      }
    } finally {
      this.refreshing = false;
      this.publish();
      this.schedule();
    }
  }

  /**
   * Jobs and steps for one run. Called only when the user drills into a run, so
   * it is deliberately outside the poll loop.
   */
  async loadJobs(repo: string, run: WorkflowRun): Promise<Job[] | null> {
    const token = await this.session.silentToken();
    this.authPending = false;
    if (token === null) {
      this.signedIn = false;
      this.publish();
      return null;
    }

    try {
      return await this.client.listJobs(repo, run.id, { token, perPage: JOBS_PER_PAGE });
    } catch (error) {
      const message =
        error instanceof GitHubApiError ? error.message : 'Could not read the jobs for this run.';
      void vscode.window.showErrorMessage(`GitHub Actions Watch: ${message}`);
      return null;
    }
  }

  /**
   * Raw log for one job, for the step drill-down. On demand only, like
   * `loadJobs`; it never enters the poll.
   */
  async loadLog(repo: string, jobId: number): Promise<string | null> {
    const token = await this.session.silentToken();
    this.authPending = false;
    if (token === null) {
      this.signedIn = false;
      this.publish();
      return null;
    }

    try {
      return await this.client.jobLog(repo, jobId, { token });
    } catch (error) {
      const message =
        error instanceof GitHubApiError ? error.message : 'Could not read that step’s log.';
      void vscode.window.showErrorMessage(`GitHub Actions Watch: ${message}`);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async pollRepo(repo: string, token: string, signal: AbortSignal): Promise<void> {
    const previous = this.states.get(repo);
    try {
      const result = await this.client.listRuns(repo, {
        token,
        perPage: this.options.recentRuns,
        signal,
      });
      this.states.set(repo, {
        repo,
        // A 304 carries no body; the rows from the previous poll are still current.
        runs: result.notModified && previous !== undefined ? previous.runs : result.runs,
        fetchedAt: Date.now(),
        error: null,
        rateLimit: result.rateLimit,
      });
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      const failure =
        error instanceof GitHubApiError
          ? error
          : new GitHubApiError('Could not read Actions runs.', 'network');
      if (failure.kind === 'auth') this.signedIn = false;

      this.states.set(repo, {
        repo,
        runs: previous?.runs ?? [],
        fetchedAt: previous?.fetchedAt ?? null,
        error: { kind: failure.kind, message: failure.message, resetAt: failure.resetAt },
        rateLimit: previous?.rateLimit ?? null,
      });
    }
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.nextDelayMs());
  }

  private nextDelayMs(): number {
    if (!this.signedIn) return this.options.idlePollMs;

    // Backing off to the reset time is what keeps a 403 from turning into a
    // tight loop; the clamp keeps a bogus header from parking the item for a day.
    const limited = [...this.states.values()]
      .map((state) => state.error)
      .find((error) => error?.kind === 'rate-limit' && error.resetAt !== null);
    if (limited?.resetAt !== undefined && limited.resetAt !== null) {
      const untilReset = Date.parse(limited.resetAt) - Date.now() + 5_000;
      return Math.min(Math.max(untilReset, MIN_RATE_LIMIT_WAIT_MS), MAX_RATE_LIMIT_WAIT_MS);
    }

    const busy = [...this.states.values()].some((state) =>
      state.runs.some((run) => isActive(run.status)),
    );
    return busy ? this.options.activePollMs : this.options.idlePollMs;
  }
}

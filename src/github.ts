import type {
  Job,
  JobStep,
  RateLimitSnapshot,
  RepoErrorKind,
  WorkflowRun,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from './types';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
/** A failed run's jobs do not change, so a repeat drill-down costs nothing. */
const JOBS_CACHE_MS = 60_000;
/** One page of jobs with steps is ~0.4 MB, so the cache must stay small. */
const JOBS_CACHE_ENTRIES = 8;
/** A job log is one text blob: the API has no per-step log endpoint. */
const LOG_CACHE_MS = 5 * 60_000;
const LOG_CACHE_ENTRIES = 8;
/** Enough for the failure at the end of a step, not a 20 MB matrix log. */
const LOG_MAX_BYTES = 256 * 1024;

const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'in_progress',
  'queued',
  'waiting',
  'requested',
  'pending',
];

const RUN_CONCLUSIONS: readonly Exclude<WorkflowRunConclusion, null>[] = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
];

export class GitHubApiError extends Error {
  readonly kind: RepoErrorKind;
  readonly resetAt: string | null;

  constructor(message: string, kind: RepoErrorKind, resetAt: string | null = null) {
    super(message);
    this.name = 'GitHubApiError';
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

export interface ListRunsOptions {
  token: string;
  perPage: number;
  signal: AbortSignal;
}

export interface ListRunsResult {
  runs: WorkflowRun[];
  rateLimit: RateLimitSnapshot | null;
  /** True when GitHub answered 304: the caller must keep the previous runs. */
  notModified: boolean;
}

export interface ListJobsOptions {
  token: string;
  perPage: number;
  signal?: AbortSignal;
}

interface RequestSpec {
  url: string;
  token: string;
  etag?: string;
  signal?: AbortSignal;
  /** Message to surface on a 404, which means "missing or not visible to you". */
  notFoundMessage: string;
}

interface Reply {
  status: number;
  body: unknown;
  etag: string | null;
  rateLimit: RateLimitSnapshot | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStatus(value: unknown): WorkflowRunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
    ? (value as WorkflowRunStatus)
    : 'unknown';
}

function toConclusion(value: unknown): WorkflowRunConclusion {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && (RUN_CONCLUSIONS as readonly string[]).includes(value)
    ? (value as WorkflowRunConclusion)
    : 'unknown';
}

/**
 * Decodes `GET /repos/{owner}/{repo}/actions/runs`.
 *
 * A run missing an id, a sha or a URL is dropped rather than patched: those
 * three are what identify the row, and a placeholder would be a lie.
 */
export function parseWorkflowRuns(payload: unknown): WorkflowRun[] {
  const root = asRecord(payload);
  const raw = root ? root['workflow_runs'] : null;
  if (!Array.isArray(raw)) return [];

  const runs: WorkflowRun[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = readNumber(record, 'id');
    const sha = readString(record, 'head_sha');
    const url = readString(record, 'html_url');
    if (id === null || sha === null || url === null) continue;

    runs.push({
      id,
      runNumber: readNumber(record, 'run_number') ?? 0,
      workflowId: readNumber(record, 'workflow_id') ?? 0,
      name: readString(record, 'name') ?? readString(record, 'display_title') ?? 'Workflow',
      url,
      branch: readString(record, 'head_branch') ?? '—',
      sha,
      shortSha: sha.slice(0, 7),
      event: readString(record, 'event') ?? 'unknown',
      status: toStatus(record['status']),
      conclusion: toConclusion(record['conclusion']),
      createdAt: readString(record, 'created_at') ?? '',
      startedAt: readString(record, 'run_started_at'),
      attempt: readNumber(record, 'run_attempt') ?? 1,
    });
  }
  return runs;
}

function parseSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) return [];

  const steps: JobStep[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;

    const number = readNumber(record, 'number');
    const name = readString(record, 'name');
    if (number === null || name === null) continue;

    steps.push({
      number,
      name,
      status: toStatus(record['status']),
      conclusion: toConclusion(record['conclusion']),
      startedAt: readString(record, 'started_at'),
      completedAt: readString(record, 'completed_at'),
    });
  }
  return steps;
}

/** Decodes `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`. */
export function parseJobs(payload: unknown): Job[] {
  const root = asRecord(payload);
  const raw = root ? root['jobs'] : null;
  if (!Array.isArray(raw)) return [];

  const jobs: Job[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = readNumber(record, 'id');
    const name = readString(record, 'name');
    if (id === null || name === null) continue;

    jobs.push({
      id,
      name,
      url: readString(record, 'html_url') ?? '',
      status: toStatus(record['status']),
      conclusion: toConclusion(record['conclusion']),
      startedAt: readString(record, 'started_at'),
      completedAt: readString(record, 'completed_at'),
      steps: parseSteps(record['steps']),
    });
  }
  return jobs;
}

function readRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = Number.parseInt(headers.get('x-ratelimit-limit') ?? '', 10);
  const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') ?? '', 10);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;

  const reset = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
  return {
    limit,
    remaining,
    resetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
  };
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'GitHub did not answer within 15 seconds.';
  }
  if (error instanceof Error) return `Could not reach GitHub: ${error.message}`;
  return 'Could not reach GitHub.';
}

/** Signed storage URL: https only, and deliberately no `Authorization` header. */
async function downloadLog(url: string, signal: AbortSignal): Promise<Response> {
  if (!url.startsWith('https://')) {
    throw new GitHubApiError('GitHub returned an insecure log URL.', 'http');
  }
  try {
    return await fetch(url, { signal });
  } catch (error) {
    throw new GitHubApiError(describeNetworkError(error), 'network');
  }
}

/** Reads a bounded prefix of a text body, then cancels the stream. */
async function readCappedText(response: Response, max: number): Promise<string> {
  if (!response.ok) throw new GitHubApiError(`GitHub answered HTTP ${response.status}.`, 'http');
  if (response.body === null) return (await response.text()).slice(0, max);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < max) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text.slice(0, max);
}

/**
 * Two endpoints, and only one of them is polled.
 *
 * `/actions/runs` is fetched on a timer with an `ETag` replayed as
 * `If-None-Match`; GitHub answers 304 without consuming rate-limit quota, so an
 * idle poll is free. `/actions/runs/{id}/jobs` is fetched only when the user
 * drills into a run, and the result is cached briefly.
 */
export class ActionsClient {
  private readonly etags = new Map<string, string>();
  private readonly jobs = new Map<string, { fetchedAt: number; jobs: Job[] }>();
  private readonly logs = new Map<string, { fetchedAt: number; text: string }>();

  async listRuns(repo: string, options: ListRunsOptions): Promise<ListRunsResult> {
    const url = `${API_ROOT}/repos/${repo}/actions/runs?per_page=${options.perPage}`;
    const reply = await this.request({
      url,
      token: options.token,
      etag: this.etags.get(repo),
      signal: options.signal,
      notFoundMessage: `No access to ${repo}. Check the name, and that the account can read its Actions.`,
    });

    if (reply.status === 304) {
      return { runs: [], rateLimit: reply.rateLimit, notModified: true };
    }
    if (reply.etag !== null) this.etags.set(repo, reply.etag);

    return {
      runs: parseWorkflowRuns(reply.body),
      rateLimit: reply.rateLimit,
      notModified: false,
    };
  }

  async listJobs(repo: string, runId: number, options: ListJobsOptions): Promise<Job[]> {
    const key = `${repo}#${runId}`;
    const cached = this.jobs.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < JOBS_CACHE_MS) {
      // Re-insert so the oldest entry is the least recently used one.
      this.jobs.delete(key);
      this.jobs.set(key, cached);
      return cached.jobs;
    }

    const url = `${API_ROOT}/repos/${repo}/actions/runs/${runId}/jobs?per_page=${options.perPage}`;
    const reply = await this.request({
      url,
      token: options.token,
      signal: options.signal,
      notFoundMessage: `Run ${runId} was not found in ${repo}.`,
    });

    const jobs = parseJobs(reply.body);
    this.evictJobs(Date.now());
    this.jobs.delete(key);
    this.jobs.set(key, { fetchedAt: Date.now(), jobs });
    return jobs;
  }

  /**
   * A session that browses many failing runs must not retain one page of jobs
   * per run. Expired entries go first, then the oldest; the hit path above
   * re-inserts, so "oldest" is really "least recently used".
   */
  private evictJobs(now: number): void {
    for (const [cachedKey, entry] of this.jobs) {
      if (now - entry.fetchedAt >= JOBS_CACHE_MS) this.jobs.delete(cachedKey);
    }
    while (this.jobs.size >= JOBS_CACHE_ENTRIES) {
      const oldest = this.jobs.keys().next();
      if (oldest.done === true) return;
      this.jobs.delete(oldest.value);
    }
  }

  /**
   * Raw log of one job, capped. GitHub answers the API URL with a redirect to a
   * signed storage URL, so the redirect is followed manually and **without**
   * the token: a credential must not travel to a third-party host.
   */
  async jobLog(repo: string, jobId: number, options: { token: string }): Promise<string> {
    const key = `${repo}#${jobId}`;
    const cached = this.logs.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < LOG_CACHE_MS) {
      this.logs.delete(key);
      this.logs.set(key, cached);
      return cached.text;
    }

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/repos/${repo}/actions/jobs/${jobId}/logs`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': API_VERSION,
        },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw new GitHubApiError(describeNetworkError(error), 'network');
    }

    if (response.status === 401) {
      throw new GitHubApiError('GitHub rejected the session. Sign in again.', 'auth');
    }
    if (response.status === 404) {
      throw new GitHubApiError('That job log is not available.', 'not-found');
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubApiError('GitHub refused to hand out this log.', 'http');
    }

    const location = response.headers.get('location');
    const source = location === null ? response : await downloadLog(location, signal);
    const text = await readCappedText(source, LOG_MAX_BYTES);

    this.evictLogs(Date.now());
    this.logs.delete(key);
    this.logs.set(key, { fetchedAt: Date.now(), text });
    return text;
  }

  private evictLogs(now: number): void {
    for (const [cachedKey, entry] of this.logs) {
      if (now - entry.fetchedAt >= LOG_CACHE_MS) this.logs.delete(cachedKey);
    }
    while (this.logs.size >= LOG_CACHE_ENTRIES) {
      const oldest = this.logs.keys().next();
      if (oldest.done === true) return;
      this.logs.delete(oldest.value);
    }
  }

  private async request(spec: RequestSpec): Promise<Reply> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${spec.token}`,
      'x-github-api-version': API_VERSION,
    };
    if (spec.etag !== undefined) headers['if-none-match'] = spec.etag;

    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (spec.signal !== undefined) signals.push(spec.signal);

    let response: Response;
    try {
      response = await fetch(spec.url, { headers, signal: AbortSignal.any(signals) });
    } catch (error) {
      if (spec.signal?.aborted === true) throw error;
      throw new GitHubApiError(describeNetworkError(error), 'network');
    }

    const rateLimit = readRateLimit(response.headers);

    if (response.status === 304) {
      return { status: 304, body: null, etag: null, rateLimit };
    }
    if (response.status === 401) {
      throw new GitHubApiError('GitHub rejected the session. Sign in again.', 'auth');
    }
    if (response.status === 404) {
      throw new GitHubApiError(spec.notFoundMessage, 'not-found');
    }
    if (response.status === 403 || response.status === 429) {
      if (rateLimit?.remaining === 0) {
        const until = rateLimit.resetAt === null ? '' : ` until ${rateLimit.resetAt}`;
        throw new GitHubApiError(
          `GitHub API rate limit reached${until}.`,
          'rate-limit',
          rateLimit.resetAt,
        );
      }
      throw new GitHubApiError(`GitHub refused the request (HTTP ${response.status}).`, 'http');
    }
    if (!response.ok) {
      throw new GitHubApiError(`GitHub answered HTTP ${response.status}.`, 'http');
    }

    const body: unknown = await response.json();
    return { status: response.status, body, etag: response.headers.get('etag'), rateLimit };
  }
}

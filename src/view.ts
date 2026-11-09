import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  allRunRows,
  describe,
  detailRows,
  groupByWorkflow,
  isRelevantJob,
  relative,
  runRows,
  sectionRow,
  statusSummary,
  stepKey,
  stepLogLines,
  workflowGroupRow,
} from './grouping';
import type { ActionsPoller } from './poller';
import type {
  CardCommand,
  CardRow,
  CardSection,
  CardView,
  CardViewMessage,
  ViewState,
  WorkflowRun,
} from './types';

type Level = { kind: 'workflows' } | { kind: 'run'; repo: string; runId: number };

/** The header fields every level shares. */
type CardBase = Pick<
  CardView,
  'signedIn' | 'authPending' | 'status' | 'statusTip' | 'busy' | 'hint' | 'error'
>;

function parseCommand(value: unknown): CardCommand | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  switch (record['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'signin':
      return { type: 'signin' };
    case 'back':
      return { type: 'back' };
    case 'select': {
      const id = record['id'];
      return typeof id === 'string' && id.length > 0 ? { type: 'select', id } : null;
    }
    default:
      return null;
  }
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The sidebar card: two collapsible sections -> a run's failed step.
 *
 * Navigation lives HERE, in the host, not in the webview. That is what keeps
 * the card open while you drill in (`retainContextWhenHidden` stays off, so a
 * hidden view holds no renderer), and what lets the view be recreated from
 * scratch at any moment and still show the same level.
 */
export class ActionsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'ghActionsWatch.runs';

  private readonly visibilityListeners: Array<(visible: boolean) => void> = [];
  private view: vscode.WebviewView | undefined;
  private level: Level = { kind: 'workflows' };
  /** Which list sections are open. "By workflow" starts closed. */
  private readonly openSections = new Set<CardSection>(['runs']);
  /** Workflow group keys whose runs are showing. */
  private readonly openWorkflows = new Set<string>();
  /** Jobs whose steps are open; unset means "the failed ones". */
  private readonly openJobs = new Map<number, boolean>();
  /** Parsed step log excerpts, keyed by `stepKey`. */
  private readonly logs = new Map<string, string[]>();
  /** A one-off message that must survive a re-render (e.g. a vanished run). */
  private notice: string | null = null;
  /** True while jobs or a step log are being fetched. */
  private loading = false;
  private rows: CardRow[] = [];
  private last: CardView | null = null;
  /** Serialised last payload, so an unchanged model does not rebuild the DOM. */
  private lastSent = '';
  private pushing = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly poller: ActionsPoller,
  ) {
    // One subscription for the whole extension: when a poll lands, the card
    // re-renders, and only while it is on screen.
    poller.onState(() => void this.push());
  }

  onVisibilityChange(listener: (visible: boolean) => void): void {
    this.visibilityListeners.push(listener);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ActionsView.viewId}.focus`);
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;
    // A fresh renderer starts empty, so the dedupe cache must not swallow the
    // first paint.
    this.lastSent = '';
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message));
    view.onDidChangeVisibility(() => {
      for (const listener of this.visibilityListeners) listener(view.visible);
      if (view.visible) {
        // The renderer may have been discarded while hidden. Forget what the
        // previous one was painted, or the dedupe would suppress this paint.
        this.lastSent = '';
        this.repaintLast();
        void this.push();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });

    // A view can resolve already visible; without this the card would wait for
    // a visibility toggle before painting.
    if (view.visible) {
      for (const listener of this.visibilityListeners) listener(true);
    }
    // Repaint what the host already has before re-fetching anything, so
    // returning to this view never shows the placeholder.
    this.repaintLast();
    void this.push();
  }

  dispose(): void {
    this.view = undefined;
    this.last = null;
    this.lastSent = '';
  }

  private async onMessage(message: unknown): Promise<void> {
    const command = parseCommand(message);
    if (command === null) return;

    // Any deliberate interaction supersedes a one-off notice.
    if (command.type !== 'ready') this.notice = null;

    switch (command.type) {
      case 'ready':
        // A (re)loaded renderer asks for its first paint. `lastSent` describes
        // the *previous* renderer, so reset it: otherwise a reloaded webview is
        // deduped against itself and stays on the placeholder forever.
        this.lastSent = '';
        this.repaintLast();
        await this.push();
        return;
      case 'refresh':
        await this.poller.refresh({ force: true });
        await this.push();
        return;
      case 'signin':
        await this.poller.signIn();
        await this.push();
        return;
      case 'back':
        this.level = { kind: 'workflows' };
        await this.push();
        return;
      case 'select':
        await this.select(command.id);
    }
  }

  private async select(id: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return;

    switch (row.action.kind) {
      case 'url':
        await vscode.env.openExternal(vscode.Uri.parse(row.action.url));
        return;
      case 'toggle-section':
        this.toggle(this.openSections, row.action.section);
        await this.push();
        return;
      case 'toggle-workflow':
        this.toggle(this.openWorkflows, row.action.key);
        await this.push();
        return;
      case 'toggle-job':
        this.openJobs.set(row.action.jobId, row.expanded !== true);
        await this.push();
        return;
      case 'toggle-step-log': {
        const key = stepKey(row.action.jobId, row.action.step);
        if (this.logs.has(key)) {
          this.logs.delete(key);
          await this.push();
          return;
        }
        if (this.loading) return;
        // The log is a network call; show the pending state while it lands.
        this.loading = true;
        this.postBusy();
        try {
          await this.showStepLog(row.action.jobId, row.action.step, row.title, key);
        } finally {
          this.loading = false;
        }
        return;
      }
      case 'run':
        if (this.loading) return;
        this.loading = true;
        this.level = { kind: 'run', repo: row.action.repo, runId: row.action.runId };
        // Jobs are a network call; show the pending state immediately so the card
        // never looks frozen.
        this.postBusy();
        try {
          await this.push();
        } finally {
          this.loading = false;
        }
        return;
    }
  }

  private async showStepLog(
    jobId: number,
    step: number,
    name: string,
    key: string,
  ): Promise<void> {
    if (this.level.kind !== 'run') {
      // The row can only come from a run view; if the level moved on, clear the
      // pending state rather than leaving the card dimmed.
      await this.push();
      return;
    }
    const log = await this.poller.loadLog(this.level.repo, jobId);
    if (log === null) {
      await this.push();
      return;
    }

    // Bound what expansion can retain; excerpts are small, but not unlimited.
    while (this.logs.size >= 8) {
      const oldest = this.logs.keys().next();
      if (oldest.done === true) break;
      this.logs.delete(oldest.value);
    }
    this.logs.set(key, stepLogLines(log, step, name));
    await this.push();
  }

  private toggle<T>(set: Set<T>, value: T): void {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  private runFor(repo: string, runId: number) {
    return this.poller
      .snapshot()
      .repos.find((state) => state.repo === repo)
      ?.runs.find((run) => run.id === runId);
  }

  private async push(): Promise<void> {
    if (this.view === undefined || !this.view.visible || this.pushing) return;

    this.pushing = true;
    try {
      const view = await this.buildView();
      this.last = view;
      this.rows = view.rows;
      this.post(view);
    } finally {
      this.pushing = false;
    }
  }

  private post(view: CardView): void {
    const message: CardViewMessage = { type: 'view', view };
    // A poll that returns identical rows should cost nothing on the renderer:
    // no postMessage, no DOM teardown/rebuild.
    const payload = JSON.stringify(message);
    if (payload === this.lastSent) return;
    this.lastSent = payload;
    void this.view?.webview.postMessage(message);
  }

  private postBusy(): void {
    if (this.view === undefined || this.last === null) return;
    this.post({ ...this.last, busy: true });
  }

  /** Paint the host's last model into a fresh renderer, before any re-fetch. */
  private repaintLast(): void {
    if (this.last === null) return;
    this.rows = this.last.rows;
    this.post(this.last);
  }

  private async buildView(): Promise<CardView> {
    const snapshot = this.poller.snapshot();
    const repoError =
      snapshot.repos.map((state) => state.error).find((error) => error !== null) ?? null;
    const summary = statusSummary(snapshot);
    const base: CardBase = {
      signedIn: snapshot.signedIn,
      authPending: snapshot.authPending,
      status: summary.tone,
      statusTip: summary.tip,
      busy: false,
      hint: snapshot.hint,
      error: this.notice ?? repoError?.message ?? null,
    };

    if (!snapshot.signedIn) {
      return {
        ...base,
        level: 'workflows',
        title: 'Actions',
        subtitle: '',
        canGoBack: false,
        rows: [],
      };
    }

    if (this.level.kind === 'run') {
      const level = this.level;
      const run = this.runFor(level.repo, level.runId);
      if (run !== undefined) return this.runView(base, level.repo, run);
      // The run aged out of the polled page. Fall back to the list rather than
      // parking the card on an error with no rows and no way back.
      this.notice = 'That run is no longer in the list.';
      this.level = { kind: 'workflows' };
      return { ...this.listView(base, snapshot), error: this.notice };
    }

    return this.listView(base, snapshot);
  }

  /**
   * The two sections. Children sit one indent deeper than their header, and a
   * workflow's runs one deeper again, so a header never looks like a row.
   */
  private listView(base: CardBase, snapshot: ViewState): CardView {
    const groups = groupByWorkflow(snapshot.repos);
    const multiRepo = new Set(groups.map((group) => group.repo)).size > 1;
    const runs = allRunRows(snapshot.repos, 1);
    const rows: CardRow[] = [];

    // With no runs, leave the rows empty so the painter shows the hint ("no
    // repository", "signed out", ...) instead of two empty headers.
    if (runs.length > 0) {
      const runsOpen = this.openSections.has('runs');
      rows.push(sectionRow('runs', 'All runs', runs.length, runsOpen));
      if (runsOpen) rows.push(...runs);

      const workflowsOpen = this.openSections.has('workflows');
      rows.push(sectionRow('workflows', 'By workflow', groups.length, workflowsOpen));
      if (workflowsOpen) {
        for (const group of groups) {
          const open = this.openWorkflows.has(group.key);
          rows.push(workflowGroupRow(group, open, multiRepo, 1));
          if (open) rows.push(...runRows(group.repo, group.runs, { depth: 2 }));
        }
      }
    }

    return {
      ...base,
      level: 'workflows',
      title: 'Actions',
      subtitle:
        runs.length === 0
          ? ''
          : `${runs.length} run${runs.length === 1 ? '' : 's'} · ${groups.length} workflow${groups.length === 1 ? '' : 's'}`,
      canGoBack: false,
      rows,
    };
  }

  private async runView(base: CardBase, repo: string, run: WorkflowRun): Promise<CardView> {
    const jobs = await this.poller.loadJobs(repo, run);
    if (jobs === null) {
      return {
        ...base,
        level: 'run',
        title: run.name,
        subtitle: `#${run.runNumber}`,
        error: 'Could not read this run’s jobs.',
        canGoBack: true,
        rows: [],
      };
    }

    // Failed jobs start open so the break is visible; everything else is one
    // click away, which keeps a 100-job matrix readable.
    const openJobs = new Set(
      jobs.filter((job) => this.openJobs.get(job.id) ?? isRelevantJob(job)).map((job) => job.id),
    );

    return {
      ...base,
      level: 'run',
      title: run.name,
      subtitle: `#${run.runNumber} · ${describe(run)} · ${relative(run.startedAt ?? run.createdAt)}`,
      canGoBack: true,
      rows: detailRows(run, jobs, { openJobs, logs: this.logs }),
    };
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'card.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'card.css'));
    const nonceValue = nonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonceValue}';"
    />
    <link rel="stylesheet" href="${style.toString()}" />
    <title>GitHub Actions</title>
  </head>
  <body>
    <div id="app"><p class="note">Loading…</p></div>
    <script nonce="${nonceValue}" src="${script.toString()}"></script>
  </body>
</html>`;
  }
}

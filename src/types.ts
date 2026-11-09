/**
 * Shapes shared by the extension host and the API decoder.
 *
 * Everything here crosses the HTTP boundary, so nothing may be assumed about
 * it at runtime. `github.ts` is what turns an untyped GitHub payload into
 * these types.
 */

export type WorkflowRunStatus =
  | 'completed'
  | 'in_progress'
  | 'queued'
  | 'waiting'
  | 'requested'
  | 'pending'
  | 'unknown';

export type WorkflowRunConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | 'startup_failure'
  | 'success'
  | 'timed_out'
  | 'unknown'
  | null;

export interface WorkflowRun {
  id: number;
  /** Per-workflow counter GitHub shows as `#123`. */
  runNumber: number;
  /** Groups runs of the same workflow file; 0 when GitHub sent none. */
  workflowId: number;
  name: string;
  /** `html_url` — the page a row opens. */
  url: string;
  branch: string;
  sha: string;
  shortSha: string;
  event: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
  createdAt: string;
  startedAt: string | null;
  attempt: number;
}

export interface JobStep {
  number: number;
  name: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Job {
  id: number;
  name: string;
  /** `html_url` of the job log page. */
  url: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
  startedAt: string | null;
  completedAt: string | null;
  steps: JobStep[];
}

export interface RateLimitSnapshot {
  limit: number;
  remaining: number;
  /** ISO timestamp of the window reset, or null when GitHub sent no header. */
  resetAt: string | null;
}

export type RepoErrorKind = 'auth' | 'rate-limit' | 'not-found' | 'http' | 'network';

export interface RepoError {
  kind: RepoErrorKind;
  message: string;
  resetAt: string | null;
}

export interface RepoState {
  repo: string;
  runs: WorkflowRun[];
  /** Epoch ms of the last successful fetch, or null if none has ever succeeded. */
  fetchedAt: number | null;
  error: RepoError | null;
  rateLimit: RateLimitSnapshot | null;
}

export interface ViewState {
  signedIn: boolean;
  /** False until the first silent token lookup has answered. */
  authPending: boolean;
  repos: RepoState[];
  rateLimit: RateLimitSnapshot | null;
  polledAt: number;
  /** Set when there is nothing to poll, e.g. no GitHub remote was found. */
  hint: string | null;
}

/* ------------------------------------------------------------------ *
 * Sidebar card model.
 *
 * Built in the extension host and rendered verbatim by the webview: the
 * webview owns no formatting logic, no token and no navigation state, so it
 * stays a few dozen lines and can be thrown away at any time.
 * ------------------------------------------------------------------ */

export type CardTone = 'success' | 'failure' | 'running' | 'pending' | 'muted';

/** The two collapsible groups on the list screen. */
export type CardSection = 'runs' | 'workflows';

export type CardAction =
  | { kind: 'run'; repo: string; runId: number }
  | { kind: 'url'; url: string }
  | { kind: 'toggle-section'; section: CardSection }
  /** `key` is the workflow group identity from `groupByWorkflow`. */
  | { kind: 'toggle-workflow'; key: string }
  /** Expand the steps of one job in the run view. */
  | { kind: 'toggle-job'; jobId: number }
  /** Expand the log excerpt for one step of a job. */
  | { kind: 'toggle-step-log'; jobId: number; step: number };

/** `section`/`group` rows toggle, `item` is a leaf, `log` is plain text. */
export type CardRowKind = 'section' | 'group' | 'item' | 'log';

export interface CardRow {
  id: string;
  kind: CardRowKind;
  title: string;
  /** Right-aligned, single line: outcome and age. */
  meta: string;
  /** Hover text: branch, sha, event, or the full URL. */
  tip: string;
  tone: CardTone;
  /** 0 for top-level rows, 1 for a workflow's runs and a failed job's steps. */
  depth: number;
  /** Set on `section` and `group` rows: whether the group is open. */
  expanded?: boolean;
  action: CardAction;
}

export type CardLevel = 'workflows' | 'run';

export interface CardView {
  level: CardLevel;
  title: string;
  subtitle: string;
  /** Aggregate repository state, painted as a dot beside the title. */
  status: CardTone;
  /** Hover text for that dot: the latest run per repository and API quota. */
  statusTip: string;
  signedIn: boolean;
  /** The silent session check has not answered yet: do not offer sign-in. */
  authPending: boolean;
  busy: boolean;
  /** Navigation help when there is nothing to poll. */
  hint: string | null;
  /** Transport/repository failure, shown as one compact line. */
  error: string | null;
  canGoBack: boolean;
  rows: CardRow[];
}

export interface CardViewMessage {
  type: 'view';
  view: CardView;
}

export type CardCommand =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'signin' }
  | { type: 'back' }
  | { type: 'select'; id: string };

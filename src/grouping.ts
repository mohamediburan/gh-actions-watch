import type {
  CardRow,
  CardSection,
  CardTone,
  Job,
  RepoState,
  ViewState,
  WorkflowInfo,
  WorkflowRun,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from './types';

const HARD_FAILURES: readonly string[] = ['failure', 'timed_out', 'startup_failure'];

export interface WorkflowGroup {
  /** Stable identity for expansion state and row ids. */
  key: string;
  repo: string;
  workflowId: number;
  name: string;
  /** Newest first, as GitHub returns them. */
  runs: WorkflowRun[];
  latest: WorkflowRun;
}

/**
 * Runs grouped by the workflow file that produced them.
 *
 * GitHub returns runs newest-first, so the first run seen for a workflow is its
 * latest; the group order follows that recency.
 */
export function groupByWorkflow(repos: RepoState[]): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>();

  for (const repo of repos) {
    for (const run of repo.runs) {
      // `workflow_id` survives branch changes; the name is the fallback when
      // GitHub omits it. Repo names cannot contain `:` or `#`, so the key is
      // unambiguous either way.
      const key =
        run.workflowId > 0 ? `${repo.repo}:${run.workflowId}` : `${repo.repo}#${run.name}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          key,
          repo: repo.repo,
          workflowId: run.workflowId,
          name: run.name,
          runs: [run],
          latest: run,
        });
      } else {
        existing.runs.push(run);
      }
    }
  }

  return [...groups.values()].sort(
    (a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt),
  );
}

/** Shared by runs, jobs and steps — all three carry the same two fields. */
export function describe(item: {
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
}): string {
  if (item.status !== 'completed') {
    return item.status === 'in_progress' ? 'in progress' : item.status;
  }
  if (item.conclusion === null) return 'completed';
  return item.conclusion.replace(/_/g, ' ');
}

export function toneFor(status: WorkflowRunStatus, conclusion: WorkflowRunConclusion): CardTone {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'pending';
  if (conclusion === 'success') return 'success';
  if (typeof conclusion === 'string' && HARD_FAILURES.includes(conclusion)) return 'failure';
  return 'muted';
}

/** The card header's status dot, which replaced the old status-bar item. */
export interface StatusSummary {
  tone: CardTone;
  tip: string;
}

function statusGlyph(run: WorkflowRun): string {
  if (run.status !== 'completed') return run.status === 'in_progress' ? '●' : '○';
  if (run.conclusion === 'success') return '✓';
  if (isHardFailure(run.conclusion)) return '✕';
  return '·';
}

/**
 * One aggregate state for every watched repository.
 *
 * Precedence is deliberate and copied from the status bar this replaced: a
 * fetch error outranks a failure, and a failure outranks a spinner, so a
 * building repository never hides a red one somewhere else.
 */
export function statusSummary(state: ViewState): StatusSummary {
  if (state.authPending) {
    return { tone: 'pending', tip: 'Checking your GitHub session…' };
  }
  if (!state.signedIn) {
    return { tone: 'pending', tip: 'Not signed in — use the sign-in button below.' };
  }
  if (state.repos.length === 0) {
    return { tone: 'muted', tip: state.hint ?? 'No repository configured.' };
  }

  const lines: string[] = [];
  let errored = false;
  let failing = false;
  let active = false;
  let hasRun = false;

  for (const repo of state.repos) {
    const latest = repo.runs[0];
    if (latest === undefined) {
      lines.push(`${repo.repo} — no runs yet`);
    } else {
      hasRun = true;
      if (isHardFailure(latest.conclusion)) failing = true;
      else if (latest.status !== 'completed') active = true;
      lines.push(
        `${repo.repo} — ${statusGlyph(latest)} ${latest.name} · ${latest.branch} · ${latest.shortSha}`,
      );
    }
    if (repo.error !== null) {
      errored = true;
      lines.push(`${repo.repo} — ⚠ ${repo.error.message}`);
    }
  }

  if (state.rateLimit !== null) {
    lines.push(`API ${state.rateLimit.remaining}/${state.rateLimit.limit} requests remaining`);
  }

  const tone: CardTone = errored
    ? 'pending'
    : failing
      ? 'failure'
      : active
        ? 'running'
        : hasRun
          ? 'success'
          : 'muted';

  return { tone, tip: lines.join('\n') };
}

/** Short by design: the sidebar has no room for "5 minutes ago". */
export function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * When the rows were last read. A refresh that finds nothing new is still a
 * refresh, and this is the only evidence of it.
 */
export function updatedLabel(fetchedAt: number | null): string {
  if (fetchedAt === null || fetchedAt <= 0) return '';
  const seconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
  if (seconds < 45) return 'Updated just now';
  return `Updated ${relative(new Date(fetchedAt).toISOString())} ago`;
}

export function duration(start: string | null, end: string | null): string {
  if (start === null || end === null) return '';
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '';
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function isHardFailure(conclusion: WorkflowRunConclusion): boolean {
  return typeof conclusion === 'string' && HARD_FAILURES.includes(conclusion);
}

/** Jobs whose steps are worth showing without asking: the ones that broke. */
export function isRelevantJob(job: Job): boolean {
  return isHardFailure(job.conclusion) || job.conclusion === 'cancelled';
}

/** Key for one step's expanded log excerpt. */
export function stepKey(jobId: number, step: number): string {
  return `${jobId}:${step}`;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const STEP_START = /^##\[section\]Starting: /;
const STEP_FINISH = /^##\[section\]Finishing: /;
const GROUP_MARKER = /^##\[(group|endgroup)\]$/;

/**
 * The lines of one step, from a raw job log.
 *
 * The Actions API has no per-step log: a job log is one blob, and the runner
 * delimits steps with `##[section]Starting: <name>`. The name is matched first
 * and the ordinal second, so a log that no longer starts at step 1 still works.
 * If neither matches, the tail of the log is returned instead of nothing.
 */
export function stepLogLines(
  log: string,
  stepNumber: number,
  stepName: string,
  limit = 120,
): string[] {
  const lines = log
    .split(/\r?\n/)
    .map((line) =>
      line.replace(ANSI, '').replace(TIMESTAMP, '').replace(GROUP_MARKER, '').trimEnd(),
    )
    .filter((line) => line.trim().length > 0);

  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (STEP_START.test(line)) starts.push(index);
  });

  const named = lines.findIndex((line) => line === `##[section]Starting: ${stepName}`);
  const from = named >= 0 ? named : starts[stepNumber - 1];
  if (from === undefined) return lines.slice(-limit);

  const to = starts.find((index) => index > from) ?? lines.length;
  const slice = lines.slice(from + 1, to).filter((line) => !STEP_FINISH.test(line));

  return slice.length > limit
    ? ['… start of the step omitted …', ...slice.slice(-limit)]
    : slice;
}

/** The detail rows for one run: every job, every step, and logs on demand. */
export interface DetailOptions {
  /** Jobs whose steps are showing. */
  openJobs: ReadonlySet<number>;
  /** Expanded step logs, keyed by `stepKey`, with the time they were read. */
  logs: ReadonlyMap<string, { at: number; lines: string[] }>;
}

/**
 * Every job and every step of one run, so the failed step is seen in context.
 *
 * A job row toggles its steps and a step row toggles its log excerpt; the tag
 * row inside an open log is the way back to github.com, anchored at the step.
 */
export function detailRows(run: WorkflowRun, jobs: Job[], options: DetailOptions): CardRow[] {
  const rows: CardRow[] = [
    {
      id: `open:${run.id}`,
      kind: 'item',
      title: 'Open on GitHub',
      meta: '',
      tip: run.url,
      tone: 'muted',
      depth: 0,
      action: { kind: 'url', url: run.url },
    },
  ];

  if (jobs.length === 0) {
    rows.push({
      id: `none:${run.id}`,
      kind: 'item',
      title: `No jobs reported (${describe(run)})`,
      meta: '',
      tip: '',
      tone: 'muted',
      depth: 0,
      action: { kind: 'url', url: run.url },
    });
    return rows;
  }

  for (const job of jobs) {
    const took = duration(job.startedAt, job.completedAt);
    const open = options.openJobs.has(job.id);
    rows.push({
      id: `job:${job.id}`,
      kind: 'group',
      title: job.name,
      meta: took === '' ? describe(job) : `${describe(job)} · ${took}`,
      tip: `${job.name} — ${open ? 'hide' : 'show'} ${job.steps.length} steps`,
      tone: toneFor(job.status, job.conclusion),
      depth: 0,
      expanded: open,
      action: { kind: 'toggle-job', jobId: job.id },
    });

    if (!open) continue;

    for (const step of job.steps) {
      const stepTook = duration(step.startedAt, step.completedAt);
      const excerpt = options.logs.get(stepKey(job.id, step.number));      // GitHub anchors a step by number on the job page's log timeline.
      const anchor = job.url === '' ? run.url : `${job.url}#step:${step.number}:1`;

      rows.push({
        id: `step:${job.id}:${step.number}`,
        kind: 'group',
        title: step.name,
        meta: `step ${step.number}${stepTook === '' ? '' : ` · ${stepTook}`}`,
        tip: `${step.name} — ${excerpt === undefined ? 'show' : 'hide'} log`,
        tone: toneFor(step.status, step.conclusion),
        depth: 1,
        expanded: excerpt !== undefined,
        action: { kind: 'toggle-step-log', jobId: job.id, step: step.number },
      });

      if (excerpt === undefined) continue;

      rows.push({
        id: `log:${job.id}:${step.number}:open`,
        kind: 'item',
        title: 'Open full log on GitHub',
        meta: '',
        tip: anchor,
        tone: 'muted',
        depth: 2,
        action: { kind: 'url', url: anchor },
      });

      excerpt.lines.forEach((line, index) => {
        rows.push({
          id: `log:${job.id}:${step.number}:${index}`,
          kind: 'log',
          title: line,
          meta: '',
          tip: '',
          tone: 'muted',
          depth: 2,
          action: { kind: 'url', url: anchor },
        });
      });
    }
  }

  return rows;
}

/** A collapsible group header: the label plus how many rows sit under it. */
export function sectionRow(
  section: CardSection,
  title: string,
  count: number,
  expanded: boolean,
): CardRow {
  return {
    id: `section:${section}`,
    kind: 'section',
    title,
    meta: `${count}`,
    tip: expanded ? `Collapse ${title}` : `Expand ${title}`,
    tone: 'muted',
    depth: 0,
    expanded,
    action: { kind: 'toggle-section', section },
  };
}

/**
 * A workflow file that has no run inside the current page.
 *
 * It cannot be expanded — there is nothing to show — so it opens the workflow
 * on github.com instead, and says why it is quiet.
 */
export function idleWorkflowRow(repo: string, workflow: WorkflowInfo, depth: number): CardRow {
  const disabled = workflow.state !== 'active';
  return {
    id: `wf-idle:${repo}:${workflow.id}`,
    kind: 'item',
    title: workflow.name,
    meta: disabled ? workflow.state.replace(/_/g, ' ') : 'no run in this page',
    tip: disabled ? `${workflow.name} — ${workflow.state}` : `${workflow.name} — open on GitHub`,
    tone: 'muted',
    depth,
    action: { kind: 'url', url: workflow.url },
  };
}

/** A repository header, used only when more than one repository is watched. */
export function repoRow(repo: string, expanded: boolean, count: number): CardRow {
  return {
    id: `repo:${repo}`,
    kind: 'group',
    title: repo,
    meta: `${count}`,
    tip: `${repo} — ${expanded ? 'hide' : 'show'} its workflows`,
    tone: 'muted',
    depth: 1,
    expanded,
    action: { kind: 'toggle-repo', repo },
  };
}

/** A workflow in the "By workflow" section; clicking it toggles its runs. */
export function workflowGroupRow(
  group: WorkflowGroup,
  expanded: boolean,
  multiRepo: boolean,
  depth = 0,
): CardRow {
  const latest = group.latest;
  return {
    id: `wf:${group.key}`,
    kind: 'group',
    title: group.name,
    meta: `${describe(latest)} · ${relative(latest.createdAt)}`,
    tip: `${group.repo} · ${group.runs.length} run${group.runs.length === 1 ? '' : 's'} · ${multiRepo ? latest.branch : `${latest.branch} · ${latest.shortSha}`}`,
    tone: toneFor(latest.status, latest.conclusion),
    depth,
    expanded,
    action: { kind: 'toggle-workflow', key: group.key },
  };
}

/**
 * Every run from every repository, newest first — the flat "All runs" list.
 * The workflow name is part of the title because runs of different workflows
 * are interleaved here. `depth` places them under their section header.
 */
export function allRunRows(repos: RepoState[], depth = 0): CardRow[] {
  const entries = repos.flatMap((repo) => repo.runs.map((run) => ({ repo: repo.repo, run })));
  entries.sort((a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt));

  return entries.map(({ repo, run }) => ({
    id: `run:${repo}:${run.id}`,
    kind: 'item',
    title: `${run.name} #${run.runNumber}`,
    meta: `${describe(run)} · ${relative(run.startedAt ?? run.createdAt)}`,
    tip: `${repo} · ${run.branch} · ${run.shortSha} · ${run.event}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`,
    tone: toneFor(run.status, run.conclusion),
    depth,
    action: { kind: 'run', repo, runId: run.id },
  }));
}

/** Runs of one workflow, shown under an expanded workflow group. */
export function runRows(
  repo: string,
  runs: WorkflowRun[],
  options: { depth?: number } = {},
): CardRow[] {
  const depth = options.depth ?? 0;
  return runs.map((run) => ({
    id: `run:${repo}:${run.id}`,
    kind: 'item',
    title: run.attempt > 1 ? `#${run.runNumber} ·${run.attempt}` : `#${run.runNumber}`,
    meta: `${describe(run)} · ${relative(run.startedAt ?? run.createdAt)}`,
    tip: `${repo} · ${run.branch} · ${run.shortSha} · ${run.event}`,
    tone: toneFor(run.status, run.conclusion),
    depth,
    action: { kind: 'run', repo, runId: run.id },
  }));
}

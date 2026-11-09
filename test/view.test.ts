/**
 * Behavioural test for the sidebar card, run with `npm test`.
 *
 * No VS Code and no network: `vscode` is aliased to ./vscode-stub and `fetch`
 * serves canned GitHub payloads, so the three levels can be driven exactly like
 * a click.
 */

import { ActionsPoller } from '../src/poller';
import type { CardView } from '../src/types';
import { ActionsView } from '../src/view';
import { makeView, recorded, Uri, type FakeView } from './vscode-stub';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` got ${a} want ${e}`}`);
}

const now = Date.now();
const iso = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();

const RUNS = {
  workflow_runs: [
    {
      id: 101,
      run_number: 41,
      workflow_id: 7,
      name: 'CI',
      html_url: 'https://github.com/o/r/actions/runs/101',
      head_branch: 'dev',
      head_sha: 'a1b2c3d4e5f6',
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      created_at: iso(5),
      run_started_at: iso(5),
      run_attempt: 1,
    },
    {
      id: 102,
      run_number: 40,
      workflow_id: 7,
      name: 'CI',
      html_url: 'https://github.com/o/r/actions/runs/102',
      head_branch: 'dev',
      head_sha: 'bbbbbbbbbbbb',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      created_at: iso(60),
      run_started_at: iso(60),
      run_attempt: 1,
    },
    {
      id: 103,
      run_number: 12,
      workflow_id: 8,
      name: 'Deploy Edge',
      html_url: 'https://github.com/o/r/actions/runs/103',
      head_branch: 'dev',
      head_sha: 'cccccccccccc',
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      created_at: iso(120),
      run_started_at: iso(120),
      run_attempt: 2,
    },
  ],
};

const JOBS = {
  jobs: [
    {
      id: 900,
      name: 'build (ubuntu-latest)',
      html_url: 'https://github.com/o/r/actions/runs/101/job/900',
      status: 'completed',
      conclusion: 'failure',
      started_at: iso(5),
      completed_at: iso(1),
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        {
          number: 7,
          name: 'Build images',
          status: 'completed',
          conclusion: 'failure',
          started_at: iso(5),
          completed_at: iso(2),
        },
        { number: 8, name: 'Always run', status: 'completed', conclusion: 'skipped' },
      ],
    },
    {
      id: 901,
      name: 'test',
      html_url: 'https://github.com/o/r/actions/runs/101/job/901',
      status: 'completed',
      conclusion: 'success',
      steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'success' }],
    },
    {
      id: 903,
      name: 'e2e',
      html_url: 'https://github.com/o/r/actions/runs/101/job/903',
      status: 'in_progress',
      conclusion: null,
      steps: [{ number: 1, name: 'Playwright', status: 'in_progress', conclusion: null }],
    },
  ],
};

const asked: string[] = [];

function reply(body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status: 200,
    ok: true,
    headers: new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      ...headers,
    }),
    json: async () => body,
  } as unknown as Response;
}

function textReply(text: string): Response {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    body: null,
    text: async () => text,
  } as unknown as Response;
}

function notModified(): Response {
  return {
    status: 304,
    ok: false,
    headers: new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4997' }),
    json: async () => null,
  } as unknown as Response;
}

/** A secondary limit: 403 with `retry-after`, and quota still remaining. */
function secondaryLimit(): Response {
  return {
    status: 403,
    ok: false,
    headers: new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4990',
      'retry-after': '30',
    }),
    json: async () => ({ message: 'You have exceeded a secondary rate limit.' }),
  } as unknown as Response;
}

const WORKFLOWS = {
  workflows: [
    {
      id: 7,
      name: 'CI',
      state: 'active',
      html_url: 'https://github.com/o/r/actions/workflows/ci.yml',
    },
    {
      id: 8,
      name: 'Deploy Edge',
      state: 'active',
      html_url: 'https://github.com/o/r/actions/workflows/deploy.yml',
    },
    {
      id: 9,
      name: 'Nightly',
      state: 'active',
      html_url: 'https://github.com/o/r/actions/workflows/nightly.yml',
    },
  ],
};

/** Raw job log: one blob whose steps are delimited by `##[section]` markers. */const LOG = [
  '2026-11-09T10:00:00.0000000Z ##[section]Starting: Set up job',
  '2026-11-09T10:00:01.0000000Z Preparing runner',
  '2026-11-09T10:00:02.0000000Z ##[section]Finishing: Set up job',
  '2026-11-09T10:00:03.0000000Z ##[section]Starting: Build images',
  '2026-11-09T10:00:04.0000000Z docker build .',
  '2026-11-09T10:00:05.0000000Z ##[error]exit code 1',
  '2026-11-09T10:00:06.0000000Z ##[section]Finishing: Build images',
  '2026-11-09T10:00:07.0000000Z ##[section]Starting: Always run',
  '2026-11-09T10:00:08.0000000Z ##[section]Finishing: Always run',
].join('\n');

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function send(fake: FakeView, message: unknown): Promise<void> {
  await fake.handlers.message?.(message);
  await tick();
}

const last = (fake: FakeView): CardView => fake.posted[fake.posted.length - 1].view;
const labels = (fake: FakeView): string[] => last(fake).rows.map((row) => row.title);
const row = (fake: FakeView, title: string) =>
  last(fake).rows.find((item) => item.title === title);

async function main(): Promise<void> {
  let runsPayload = RUNS;
  let workflowsFail = false;
  let runsLimited = false;
  let lastJobsValidator: string | undefined;

  globalThis.fetch = (async (
    input: unknown,
    init?: { headers?: Record<string, string> },
  ) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/logs')) return textReply(LOG);
    if (url.includes('/workflows')) {
      return workflowsFail
        ? ({ status: 500, ok: false, headers: new Headers() } as unknown as Response)
        : reply(WORKFLOWS);
    }
    if (url.includes('/jobs')) {
      // Conditional read: a replayed validator means nothing changed.
      lastJobsValidator = init?.headers?.['if-none-match'];
      if (lastJobsValidator === 'W/"jobs-1"') return notModified();
      return reply(JOBS, { etag: 'W/"jobs-1"' });
    }
    if (runsLimited) return secondaryLimit();
    return reply(runsPayload, { etag: 'W/"runs-1"' });
  }) as typeof fetch;

  (globalThis as Record<string, unknown>)['__GH_TOKEN__'] = 'token-for-test';

  const poller = new ActionsPoller({
    repositories: ['o/r'],
    activePollMs: 15_000,
    idlePollMs: 90_000,
    recentRuns: 25,
  });
  poller.onState(() => {});
  await poller.start();

  const view = new ActionsView(Uri.joinPath({}, 'tmp'), poller);
  const fake = makeView();
  view.resolveWebviewView(fake as never, {} as never, {} as never);
  await tick();

  check(
    'html loads the card assets',
    /card\.js/.test(fake.webview.html) && /card\.css/.test(fake.webview.html),
    true,
  );
  check('html carries a nonce CSP', /script-src 'nonce-[^']+'/.test(fake.webview.html), true);

  check('list screen level', last(fake).level, 'workflows');
  check('header status reflects a failure', last(fake).status, 'failure');
  check('header status tip names the repository', /o\/r/.test(last(fake).statusTip), true);
  check('list screen rows', labels(fake), [
    'All runs',
    'CI #41',
    'CI #40',
    'Deploy Edge #12',
    'By workflow',
  ]);
  check('flat run tone reflects the run', row(fake, 'CI #41')?.tone, 'failure');
  check(
    'flat run meta is outcome and age',
    /^failure · \d+m$/.test(String(row(fake, 'CI #41')?.meta)),
    true,
  );
  check('subtitle counts runs and workflows', last(fake).subtitle, '3 runs · 2 workflows');
  check('list screen has no back button', last(fake).canGoBack, false);
  check('all runs section starts open', row(fake, 'All runs')?.expanded, true);
  check('workflows section starts closed', row(fake, 'By workflow')?.expanded, false);
  check('section header is a section row', row(fake, 'By workflow')?.kind, 'section');
  check('section header is not indented', row(fake, 'All runs')?.depth, 0);
  check('rows under a section are indented once', row(fake, 'CI #41')?.depth, 1);
  check('only runs polled', asked.filter((url) => url.includes('/jobs')).length, 0);
  check(
    'the workflows endpoint is untouched until its section opens',
    asked.filter((url) => url.includes('/actions/workflows')).length,
    0,
  );

  // A background poll that returns the same rows must not touch the renderer.
  const beforeIdle = fake.posted.length;
  await poller.refresh({ force: true });
  await tick();
  check('an unchanged poll does not repaint', fake.posted.length, beforeIdle);

  await send(fake, { type: 'select', id: 'section:workflows' });

  check('workflows section opens', row(fake, 'By workflow')?.expanded, true);
  check('workflow group row kind', row(fake, 'CI')?.kind, 'group');
  check('workflow groups indent under their section', row(fake, 'CI')?.depth, 1);
  check('workflow groups start closed', row(fake, 'CI')?.expanded, false);
  check('a closed group hides its runs', labels(fake).includes('#41'), false);

  // The workflows endpoint names the quiet ones without entering the poll.
  check('a workflow with no run is still listed', row(fake, 'Nightly')?.kind, 'item');
  check('the quiet workflow says why', row(fake, 'Nightly')?.meta, 'no run in this page');
  check('the quiet workflow is muted', row(fake, 'Nightly')?.tone, 'muted');
  check('the section counts every workflow', row(fake, 'By workflow')?.meta, '3');
  check(
    'workflow definitions are read once',
    asked.filter((url) => url.includes('/actions/workflows')).length,
    1,
  );

  await send(fake, { type: 'select', id: 'wf-idle:o/r:9' });
  check(
    'a quiet workflow opens its GitHub page',
    recorded.opened[recorded.opened.length - 1],
    'https://github.com/o/r/actions/workflows/nightly.yml',
  );
  check(
    'the definition cache survives a re-open',
    asked.filter((url) => url.includes('/actions/workflows')).length,
    1,
  );

  await send(fake, { type: 'select', id: 'wf:o/r:7' });

  check('workflow group opens', row(fake, 'CI')?.expanded, true);
  check('group rows are the workflow runs', row(fake, '#41')?.kind, 'item');
  check('group runs are indented', row(fake, '#41')?.depth, 2);
  check('group run meta', /^failure · \d+m$/.test(String(row(fake, '#41')?.meta)), true);

  await send(fake, { type: 'select', id: 'run:o/r:101' });

  check('run detail level', last(fake).level, 'run');
  check(
    'run detail paints a pending state first',
    fake.posted.some((message) => message.view.busy),
    true,
  );
  check(
    'the clicked row is the one marked busy',
    fake.posted.some((message) => message.view.busyKey === 'run:o/r:101'),
    true,
  );
  check('run detail rows', labels(fake), [
    'Open on GitHub',
    'build (ubuntu-latest)',
    'Set up job',
    'Build images',
    'Always run',
    'test',
    'e2e',
  ]);
  check('passing steps are listed too', labels(fake).includes('Set up job'), true);
  check('skipped steps are listed too', labels(fake).includes('Always run'), true);
  check('failed job starts expanded', row(fake, 'build (ubuntu-latest)')?.expanded, true);
  check('passing job starts collapsed', row(fake, 'test')?.expanded, false);
  check('a collapsed job hides its steps', labels(fake).includes('Run tests'), false);
  check('step is indented under its job', row(fake, 'Build images')?.depth, 1);
  check('failed step keeps its tone', row(fake, 'Build images')?.tone, 'failure');
  check(
    'step meta names the step number',
    /^step 7( · |$)/.test(String(row(fake, 'Build images')?.meta)),
    true,
  );
  check(
    'run detail fetched jobs once',
    asked.filter((url) => url.includes('/runs/101/jobs')).length,
    1,
  );

  await send(fake, { type: 'select', id: 'step:900:7' });
  check('step log expands', row(fake, 'Build images')?.expanded, true);
  check(
    'log excerpt is that step, not the whole job',
    last(fake)
      .rows.filter((item) => item.kind === 'log')
      .map((item) => item.title),
    ['docker build .', '##[error]exit code 1'],
  );
  check('log fetched once', asked.filter((url) => url.includes('/logs')).length, 1);

  await send(fake, { type: 'select', id: 'log:900:7:open' });
  check(
    'open full log uses the step anchor',
    recorded.opened[recorded.opened.length - 1],
    'https://github.com/o/r/actions/runs/101/job/900#step:7:1',
  );

  await send(fake, { type: 'select', id: 'step:900:7' });
  check('step log collapses again', last(fake).rows.some((item) => item.kind === 'log'), false);

  await send(fake, { type: 'select', id: 'job:901' });
  check('a passing job expands to its steps', labels(fake).includes('Run tests'), true);

  // GitHub publishes a job's log only once the job finishes, so asking for a
  // running step would 404. The card must say so without a request.
  await send(fake, { type: 'select', id: 'job:903' });
  const logsBefore = asked.filter((url) => url.includes('/logs')).length;
  await send(fake, { type: 'select', id: 'step:903:1' });
  check(
    'a running step does not request a log',
    asked.filter((url) => url.includes('/logs')).length,
    logsBefore,
  );
  check(
    'a running step explains why it has no log',
    String(last(fake).rows.find((item) => item.kind === 'log')?.title).includes('Still running'),
    true,
  );
  check('no error is shown for it', recorded.error, '');

  await send(fake, { type: 'back' });
  check('back returns to the list', last(fake).level, 'workflows');
  check('back keeps the workflow group open', row(fake, 'CI')?.expanded, true);
  check('back keeps its runs visible', row(fake, '#41')?.depth, 2);

  await send(fake, { type: 'select', id: 'section:runs' });
  check('all runs section closes', row(fake, 'All runs')?.expanded, false);
  check('closing hides the flat runs', labels(fake).includes('CI #41'), false);

  await send(fake, { type: 'select', id: 'run:o/r:101' });
  check(
    'jobs cache avoids a second request',
    asked.filter((url) => url.includes('/runs/101/jobs')).length,
    1,
  );

  // Refresh must be visible and must re-read the open run, not the warm cache.
  fake.posted.length = 0;
  await send(fake, { type: 'refresh' });
  check('refresh shows a busy state', fake.posted.some((message) => message.view.busy), true);
  check(
    'refresh re-reads the open run',
    asked.filter((url) => url.includes('/runs/101/jobs')).length,
    2,
  );
  check('refresh ends unbusy', last(fake).busy, false);
  check('the jobs re-read is conditional', lastJobsValidator, 'W/"jobs-1"');
  check('a 304 keeps the run rows instead of emptying them', labels(fake).includes('test'), true);
  check('a 304 raises no error', recorded.error, '');
  check(
    'refresh leaves visible evidence even when nothing changed',
    /Updated/.test(last(fake).footer),
    true,
  );

  // The open run can fall out of the polled page; the card must not dead-end.
  runsPayload = { workflow_runs: RUNS.workflow_runs.filter((item) => item.id !== 101) };
  await send(fake, { type: 'refresh' });
  check('a vanished run falls back to the list', last(fake).level, 'workflows');
  check('fallback says why', /no longer in the list/.test(String(last(fake).error)), true);
  check('fallback shows the remaining runs', labels(fake).includes('#40'), true);

  // No runs at all must reach the painter's empty state, not two empty headers.
  runsPayload = { workflow_runs: [] };
  await send(fake, { type: 'refresh' });
  check('no runs leaves the painter its empty state', last(fake).rows.length, 0);

  // A hidden view must not be painted: no renderer, no work.
  fake.visible = false;
  const before = fake.posted.length;
  await send(fake, { type: 'refresh' });
  check('hidden view is not painted', fake.posted.length, before);

  // Signed out: the card offers the explicit consent button instead.
  fake.visible = true;
  delete (globalThis as Record<string, unknown>)['__GH_TOKEN__'];
  await send(fake, { type: 'refresh' });
  check('signed out is reported', last(fake).signedIn, false);
  check('signed out status points at the button', last(fake).status, 'pending');
  check('signed out has no rows', last(fake).rows.length, 0);

  // Returning to the view must repaint the last model, not the placeholder.
  fake.visible = true;
  (globalThis as Record<string, unknown>)['__GH_TOKEN__'] = 'token-for-test';
  runsPayload = RUNS;
  await send(fake, { type: 'refresh' });
  const restored = last(fake);
  check('signed back in shows runs', restored.rows.length > 0, true);

  // While hidden the poller keeps working but the card is not painted, so the
  // host's last model is deliberately stale.
  fake.visible = false;
  runsPayload = { workflow_runs: [] };
  await poller.refresh({ force: true });
  await tick();

  const again = makeView();
  view.resolveWebviewView(again as never, {} as never, {} as never);
  await tick();
  check(
    'a rebuilt webview repaints the last model first',
    (again.posted[0] as { view: CardView } | undefined)?.view.rows.length,
    restored.rows.length,
  );
  check('the repaint is then refreshed', last(again).rows.length, 0);

  // Two repositories get a header each, and a full page explains its cap.
  runsPayload = RUNS;
  const multi = new ActionsPoller({
    repositories: ['o/r', 'o/r2'],
    activePollMs: 15_000,
    idlePollMs: 90_000,
    recentRuns: 3,
  });
  multi.onState(() => {});
  await multi.start();
  const multiView = new ActionsView(Uri.joinPath({}, 'tmp'), multi);
  const multiFake = makeView();
  multiView.resolveWebviewView(multiFake as never, {} as never, {} as never);
  await tick();
  check('a full page says it is capped', /newest 3 runs/i.test(last(multiFake).footer), true);

  await send(multiFake, { type: 'select', id: 'section:workflows' });
  check('each repository gets a header', row(multiFake, 'o/r')?.kind, 'group');
  check('repo headers indent under their section', row(multiFake, 'o/r')?.depth, 1);
  check('workflows indent under their repo', row(multiFake, 'CI')?.depth, 2);
  multiView.dispose();
  multi.dispose();

  // A workflow read that fails is remembered, not retried on every rebuild.
  workflowsFail = true;
  const failPoller = new ActionsPoller({
    repositories: ['o/fail'],
    activePollMs: 15_000,
    idlePollMs: 90_000,
    recentRuns: 5,
  });
  failPoller.onState(() => {});
  await failPoller.start();
  const failView = new ActionsView(Uri.joinPath({}, 'tmp'), failPoller);
  const failFake = makeView();
  failView.resolveWebviewView(failFake as never, {} as never, {} as never);
  await tick();
  await send(failFake, { type: 'select', id: 'section:workflows' });
  const workflowTries = (): number =>
    asked.filter((url) => url.includes('/repos/o/fail/actions/workflows')).length;
  check('a failing workflow read is attempted once', workflowTries(), 1);
  await failPoller.refresh({ force: true });
  await tick();
  check('a poll does not retry it', workflowTries(), 1);
  await send(failFake, { type: 'refresh' });
  check('an explicit refresh does retry it', workflowTries(), 2);
  check('the card still lists the runs without it', labels(failFake).includes('CI #41'), true);
  failView.dispose();
  failPoller.dispose();

  // A secondary limit keeps quota but asks for `retry-after`; treating it as a
  // plain HTTP error would make the poll walk straight back into the block.
  runsLimited = true;
  const limitPoller = new ActionsPoller({
    repositories: ['o/limit'],
    activePollMs: 15_000,
    idlePollMs: 90_000,
    recentRuns: 5,
  });
  limitPoller.onState(() => {});
  await limitPoller.start();
  const limitFailure = limitPoller.snapshot().repos[0]?.error;
  check('a secondary limit is classified as rate limiting', limitFailure?.kind, 'rate-limit');
  check(
    'and pauses for the retry-after window',
    /limiting requests until/.test(String(limitFailure?.message)),
    true,
  );
  const pauseMs = limitFailure?.resetAt === null ? 0 : Date.parse(String(limitFailure?.resetAt)) - Date.now();
  check('the reset time follows retry-after', pauseMs > 25_000 && pauseMs <= 31_000, true);
  limitPoller.dispose();

  // VS Code can keep the WebviewView and only reload its renderer, which sends
  // `ready` again without a new resolve. The dedupe must not swallow that
  // first paint, or the card sits on "Loading…" forever.
  again.posted.length = 0;
  await send(again, { type: 'ready' });
  check('a reloaded renderer is repainted on ready', again.posted.length > 0, true);

  poller.dispose();
  view.dispose();

  // Before the first silent lookup answers, the card must not offer sign-in.
  const cold = new ActionsPoller({
    repositories: ['o/r'],
    activePollMs: 15_000,
    idlePollMs: 90_000,
    recentRuns: 25,
  });
  const coldView = new ActionsView(Uri.joinPath({}, 'tmp'), cold);
  const coldFake = makeView();
  coldView.resolveWebviewView(coldFake as never, {} as never, {} as never);
  await tick();
  check('pre-auth view reports that it is checking', last(coldFake).authPending, true);
  check('pre-auth view does not offer sign-in', last(coldFake).signedIn, false);
  check('pre-auth view has no rows', last(coldFake).rows.length, 0);
  coldView.dispose();
  cold.dispose();

  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('all checks passed');
  process.exit(0);
}

void main();

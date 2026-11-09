# AGENTS.md

Working rules for this extension. Read this before changing the UI.

## What this is

A VS Code extension that shows GitHub Actions runs for the repository you have
open: one compact **Actions** sidebar view with two collapsible sections — a flat
**All runs** list and **By workflow** groups whose runs open in place — and the
failed job and step one click deeper.

The design goal is a card that is compact, stays open while you browse, does not
compete with the terminal, and spends as little GitHub API quota as possible.
Keep new work pointed at that goal.

## Non-negotiables

- **No runtime dependencies.** `dependencies` stays empty. The bundle is a
  single file produced by esbuild; `@types/*`, `esbuild`, `oxlint` and
  `typescript` are dev-only. Adding React, a UI kit or an HTTP client to render
  a list of ~10 rows is a regression, not an improvement.
- **The surface is a sidebar webview view.** There is no status-bar item; the
  view is opened from the activity bar.
- **One polled endpoint.** `/repos/{owner}/{repo}/actions/runs`, with
  `If-None-Match`. Do not add a second polling loop.
- **Jobs are on demand.** `/runs/{id}/jobs` is fetched only when a run is
  opened, and cached 60 s in a cache capped at 8 runs (one page of jobs with
  steps is ~0.4 MB). It must never enter the poll.
- **Logs are on demand, twice over.** A step's log is one blob fetched from
  `/actions/jobs/{id}/logs` only when that step is expanded: 256 KB cap, 5 min
  cache, 8 jobs, and the redirect is followed without the token. It never
  enters the poll either.

## Why the sidebar

There is **no API for a popover anchored to a status-bar item**, and every
surface an extension does get costs something: the panel competes with the
terminal, an editor tab costs a tab, and QuickPick is a list that closes and
reopens at each level. The sidebar view is always available, never competes, and
does not steal the terminal — so that is the surface, and it stays that way.

### Gotcha

`"views": { "panel": [...] }` is not a valid contribution: the only built-in
`views` targets are `explorer`, `scm`, `debug`, `test`, `extensions`. A panel
needs its own `viewsContainers.panel` entry (`{ id, title, icon }`) plus
`views[<that id>]`, otherwise VS Code logs *"View container 'panel' does not
exist"* and dumps the view into the Explorer.

## Layout

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation: poller, view provider, commands, config listeners. |
| `src/poller.ts` | The only timer and the only network loop. Owns cadence, backoff, gating, and `loadJobs` for the drill-down. |
| `src/github.ts` | HTTP + decoding. `ETag` map per repo, jobs cache, error classification. |
| `src/git.ts` | Local git ref watcher. A commit or push wakes the poller; it makes no requests. |
| `src/types.ts` | Everything crossing HTTP or `postMessage`, plus the card view model. |
| `src/grouping.ts` | Pure model building: grouping, tones, relative times, failed-step selection. No `vscode` import. |
| `src/view.ts` | `WebviewViewProvider`. Owns navigation and expansion state and builds `CardView`s. |
| `src/auth.ts` | Thin wrapper over VS Code's GitHub auth provider. |
| `src/repository.ts` | `git remote get-url origin` → `owner/name`. |
| `media/card.js` | ~70-line painter. Renders `CardView`, posts clicks. No fetch, no state. |
| `media/card.css` | Compact sizing: 26px header, 22px rows. |
| `test/` | Headless harness: `vscode` stub + canned GitHub payloads. |

## Navigation lives in the host

The webview holds no navigation state. It sends `{ type: 'select', id }`,
`{ type: 'back' }`, `{ type: 'refresh' }`, `{ type: 'signin' }`; the host moves
its own `level` and pushes a finished `CardView`. This is what lets the view be
destroyed at any moment (`retainContextWhenHidden: false`) and rebuilt on the
same level, and it keeps credentials and formatting in one place.

Corollaries:

- Nothing is built or painted while the view is hidden (`push()` returns early
  on `!this.view.visible`). Keep that.
- A rebuilt webview is handed the host's last `CardView` first
  (`repaintLast()`), then refreshed, so switching views and coming back never
  shows the placeholder while a jobs request runs. `lastSent` is cleared on
  `ready`, on resolve and on becoming visible: VS Code can reload the renderer
  under the same view object, and the dedupe would otherwise suppress its first
  paint.
- Rows carry their own `action`, so the painter never needs to know what a
  workflow or run is. A `section`/`group` row toggles (`toggle-section`,
  `toggle-workflow`); an `item` row opens a run or a URL.
- Expansion is host state too: `openSections` (All runs / By workflow) and
  `openWorkflows` (one key per workflow group). A rebuilt webview reopens the
  same sections and groups.
- `CardRow.depth` is the only layout hint: 0 = a section header or top-level
  row, 1 = a row under a section (and a failed step under its job), 2 = a run
  under a workflow.

## Cost rules

- `ETag` per repository, replayed as `If-None-Match`; **a 304 does not consume
  rate-limit quota**, so an idle poll is effectively free.
- 15 s cadence while any run is queued/in progress, 90 s otherwise.
- No request while the window is unfocused unless `refresh({ force: true })`.
- On 403/429 with `x-ratelimit-remaining: 0`, back off to `x-ratelimit-reset`,
  clamped to 30 s…15 min.
- A commit or push wakes the same loop (`src/git.ts`) instead of adding one: a
  fingerprint of HEAD and the remote-tracking refs that has not changed spends
  nothing, the resulting poll lands on a 304, and an unfocused window still
  spends nothing because the refresh is not forced.
- An unchanged model is never posted: `post()` compares the serialised payload,
  so a poll that returns the same rows costs the renderer nothing.

## Auth

`vscode.authentication.getSession('github', ['repo'], { silent: true })`.
VS Code holds and refreshes the token; this extension never stores one, and
there is no PAT to configure. No `gh` CLI is involved.

**The first silent call returns nothing on purpose.** `getSession` requires the
exact scope set to be already granted, and until this extension has asked for
`repo` there is no matching session — a scope mismatch, not a failure. Hence:

- startup is silent and the card offers a **Sign in with GitHub** button;
- until that lookup answers, `authPending` makes the card say it is checking,
  so the button never flashes on load;
- that button calls `createIfNone`, which is what raises the consent dialog;
- `onDidChangeSessions` re-polls when the session is replaced or revoked.

Do not "fix" this by falling back to another token source.

## Test

```bash
npm test
```

It bundles `test/view.test.ts` with `--alias:vscode=./test/vscode-stub.ts` and
stubs `globalThis.fetch`, so the whole card runs headlessly: no VS Code, no
network. It covers grouping, run order, all-jobs/all-steps rendering, job and
step-log expansion, the `job.html_url#step:<n>:1` anchor, section and group
expansion, back navigation, the jobs and logs caches, hidden-view suppression
and the signed-out state.

When you change the model, extend this test rather than eyeballing the UI — the
stub's `makeView()` records every `postMessage`, so a new level or toggle is
just another `select` in the test.

## Style

- TypeScript strictness: `strict`, `noUncheckedIndexedAccess`, no `any`.
  GitHub payloads arrive as `unknown` and are decoded in `src/github.ts`.
- TS 6 rejects `moduleResolution: node`; the project uses `node16` and has no
  `"type": "module"`, so sources are CommonJS.
- Formatting is whatever the repo standard is (2 spaces, single quotes, ~100
  columns, semicolons).

## Open items

- Polling stops while the window is unfocused; a run that finishes while you are
  away shows as "in progress" until you return. Deliberate (zero background
  requests) — revisit only if asked.
- `publisher` must match a Marketplace publisher the account owns before the
  first `vsce publish`.

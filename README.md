# GitHub Actions Watch

GitHub Actions runs, in the sidebar, for the repository you already have open.

The card lists every recent run, groups the same runs by workflow, and goes one
click deeper to the failed job, the failed step, and that step's log excerpt —
without leaving the editor or opening a browser tab.

## Install

Search for **GitHub Actions Watch** in the Extensions view, or install a local
package:

```bash
npm run package
code --install-extension gh-actions-watch-0.1.0.vsix
```

Then click the **Actions** icon in the Activity Bar. To keep it out of the way,
right-click the view title → **Move View** and send it to the secondary sidebar.

## The card

Rows are 22px and the header is 26px, so a narrow sidebar still lists a lot:
one line per row, name on the left, outcome and age on the right, full detail on
hover. The header carries the overall state as a dot — red when a recent run
failed, pulsing while one is building — and its tooltip shows the latest run per
repository.

```
▾ All runs                              3
    ✕ CI #41             failure · 5m
    ✓ CI #40             success · 1h
    ◌ Deploy Edge #12    in progress · 2h
▸ By workflow                           2

⎯⎯ after opening By workflow and CI ⎯⎯
▾ All runs                              3
    ✕ CI #41             failure · 5m
    ✓ CI #40             success · 1h
    ◌ Deploy Edge #12    in progress · 2h
▾ By workflow                           2
    ▾ CI                 failure · 5m
        ✕ #41            failure · 5m
        ✓ #40            success · 1h
    ▸ Deploy Edge        in progress · 2h

⎯⎯ after opening #41 ⎯⎯
← CI                                   ⟳
   #41 · failure · 5m

· Open on GitHub
▾ ✕ build (ubuntu-latest)  failure · 4m 12s
    ▸ ✓ Set up job         step 1 · 2s
    ▾ ✕ Build images       step 7 · 2m 58s
        · Open full log on GitHub
              docker build .
              ##[error]exit code 1
    ▸ · Always run         step 8 · 0s
▸ ✓ test                   success · 1m 3s
```

The list screen has two collapsible sections. **All runs** is the newest run
page (`ghActionsWatch.recentRuns`, default 25) from every watched repository,
newest first. **By workflow** groups those same runs by workflow and opens each
group's runs in place. All runs starts open, By workflow starts collapsed.

Opening a run lists **every** job and every step of that run, so a failure is
seen in context: failed jobs are red and start expanded, the rest are one click
away. Expanding a step shows that step's lines from the job log inline, with
**Open full log on GitHub** one click away.

Clicking a row never reloads the card: the level you are on and the sections and
groups you opened stay put, even when you switch to another sidebar view and
come back.

## Sign-in

The card uses VS Code's built-in GitHub session, so there is nothing to
configure and no personal access token to create, copy or rotate:

- the first time, the card offers **Sign in with GitHub**, and the consent
  dialog asks for the `repo` scope;
- while that first lookup is still running the card says it is checking, so the
  button does not flash on load;
- if the session is replaced or revoked, the card returns to the sign-in button
  and starts polling again once you sign in.

## Refreshing

The card refreshes itself, so there is nothing to keep in sync by hand:

- every 15 s while a run is queued or in progress, every 90 s when everything is
  finished;
- immediately when the window regains focus, when you press the refresh button,
  when you run **GitHub Actions Watch: Refresh**, or when a commit or push lands
  in the open repository;
- not at all while the window is in the background.

Requests are conditional, so a refresh that finds nothing new spends no GitHub
API quota. Jobs are fetched only for a run you open, and a step's log only when
you expand that step.

## Repository scope

The default is the current checkout: for each workspace folder, the extension
runs `git -C <folder> remote get-url origin` and resolves `owner/name` from it.
Set `ghActionsWatch.repositories` (an array of `owner/name`) only to override
that, e.g. to watch a repository that is not the one you have open.

## Develop

```bash
npm install
npm run bundle     # esbuild -> dist/extension.js (one file, zero runtime deps)
npm run typecheck
npm run lint
npm test           # headless: vscode aliased to a stub, GitHub responses canned
npm run package    # -> gh-actions-watch-0.1.0.vsix
```

Open the folder in VS Code and press `F5` for an Extension Development Host.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ghActionsWatch.repositories` | `[]` | `owner/name` list; empty uses each folder's `origin` |
| `ghActionsWatch.activePollMs` | `15000` | Poll interval while a run is active |
| `ghActionsWatch.idlePollMs` | `90000` | Poll interval when nothing is running |
| `ghActionsWatch.recentRuns` | `25` | Runs fetched per repository, shown in both sections |

## License

MIT — see [LICENSE](LICENSE).

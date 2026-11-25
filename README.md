# GitHub Actions Watch

A lightweight alternative to GitHub's Actions extension for VS Code. It keeps a
compact Actions list in the sidebar for the repository you already have open, so
you can check a run without switching tabs or opening a browser.

The card shows recent runs, groups them by workflow, and opens a run to its jobs,
steps, and log excerpt. It uses VS Code's GitHub sign-in and makes no requests
while the window is in the background.

## Install

Search for **GitHub Actions Watch** in the Extensions view and install it. Then
click the **Actions** icon in the Activity Bar.

To keep it out of the way, right-click the view title → **Move View** and send it
to the secondary sidebar.

## Sign-in

The card uses VS Code's built-in GitHub session, so there is nothing to
configure and no personal access token to create, copy, or rotate:

- the first time, the card offers **Sign in with GitHub**, and the consent
  dialog asks for the `repo` scope;
- while that first lookup is still running the card says it is checking, so the
  button does not flash on load;
- if the session is replaced or revoked, the card returns to the sign-in button
  and starts again once you sign in.

## Repository scope

By default the extension uses the `origin` remote of each open folder. To watch
other repositories, set `ghActionsWatch.repositories` to a list of `owner/name`
values, for example `mohamediburan/gh-actions-watch`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ghActionsWatch.repositories` | `[]` | Repositories to watch; empty uses each folder's `origin` |
| `ghActionsWatch.activePollMs` | `10000` | Refresh interval while a run is active |
| `ghActionsWatch.idlePollMs` | `90000` | Refresh interval when nothing is running |
| `ghActionsWatch.recentRuns` | `25` | Runs shown per repository in both sections |

## License

MIT — see [LICENSE](LICENSE).

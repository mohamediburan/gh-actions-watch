import * as vscode from 'vscode';

/**
 * The slice of the built-in git extension's API (v1) this file uses.
 *
 * GitHub has no push channel an extension can subscribe to: webhooks need a
 * server GitHub can reach, and the Actions endpoint has no streaming variant.
 * What a local extension can see is the checkout, so a commit or a push is used
 * as the signal to poll *now* instead of waiting for the next tick. This is an
 * event source, not a second loop — it calls the poller's existing refresh.
 */
interface GitRef {
  name?: string;
  commit?: string;
  /** Set on remote-tracking refs, which is how a push shows up locally. */
  remote?: string;
}

interface GitRepositoryState {
  HEAD?: { name?: string; commit?: string };
  refs?: GitRef[];
  onDidChange: vscode.Event<void>;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

/**
 * HEAD plus the remote-tracking refs — the two things that change when you
 * commit or push. Index and working-tree changes are ignored on purpose: a
 * save must not spend a request.
 */
function fingerprint(repo: GitRepository): string {
  const head = repo.state.HEAD;
  const remote = (repo.state.refs ?? [])
    .filter((ref) => ref.remote !== undefined)
    .map((ref) => `${ref.name ?? ''}@${ref.commit ?? ''}`)
    .sort()
    .join('|');
  return `${head?.name ?? ''}@${head?.commit ?? ''}#${remote}`;
}

/** Calls `onChange` when a repository's HEAD or remote-tracking refs move. */
export function watchGitRefs(onChange: () => void): vscode.Disposable {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (extension === undefined) return new vscode.Disposable(() => {});

  const disposables: vscode.Disposable[] = [];
  let disposed = false;

  const attach = (api: GitApi): void => {
    const seen = new Map<GitRepository, string>();
    const subscribe = (repo: GitRepository): void => {
      seen.set(repo, fingerprint(repo));
      disposables.push(
        repo.state.onDidChange(() => {
          if (disposed) return;
          const next = fingerprint(repo);
          if (next === seen.get(repo)) return;
          seen.set(repo, next);
          onChange();
        }),
      );
    };

    for (const repo of api.repositories) subscribe(repo);
    disposables.push(api.onDidOpenRepository((repo) => subscribe(repo)));
  };

  if (extension.isActive) {
    attach(extension.exports.getAPI(1));
  } else {
    // The git extension is built in but may not have activated yet. A failure
    // here just means no local git events; the poll timer still works.
    void extension.activate().then(
      (exports) => {
        if (!disposed) attach(exports.getAPI(1));
      },
      () => {},
    );
  }

  return new vscode.Disposable(() => {
    disposed = true;
    for (const disposable of disposables) disposable.dispose();
    disposables.length = 0;
  });
}

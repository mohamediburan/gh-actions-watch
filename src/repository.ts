import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

const GIT_TIMEOUT_MS = 5_000;

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git` and
 * `ssh://git@github.com/owner/repo` all resolve to `owner/repo`. The repository
 * name is matched lazily so the optional `.git` suffix (and a trailing slash)
 * are not swallowed into it.
 */
const GITHUB_REMOTE = /github\.com[:/]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function repositoryFromRemote(remote: string): string | null {
  const match = GITHUB_REMOTE.exec(remote.trim());
  if (match === null) return null;
  const owner = match[1];
  const name = match[2];
  return owner !== undefined && name !== undefined ? `${owner}/${name}` : null;
}

function readOriginUrl(folder: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', folder, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * The `origin` remote of each open folder, deduplicated.
 *
 * `git remote get-url` is used rather than parsing `.git/config` so worktrees
 * and `insteadOf` rewrites resolve the same way git itself does.
 */
export async function resolveWorkspaceRepos(): Promise<string[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === 'file',
  );

  const repos: string[] = [];
  for (const folder of folders) {
    try {
      const repo = repositoryFromRemote(await readOriginUrl(folder.uri.fsPath));
      if (repo !== null && !repos.includes(repo)) repos.push(repo);
    } catch {
      // Not a git checkout, git is not installed, or there is no `origin`.
      // The next folder may still match, so this is not worth reporting.
    }
  }
  return repos;
}

import * as vscode from 'vscode';

/**
 * Actions runs on a private repository need the classic `repo` scope.
 *
 * The token comes from VS Code's built-in `github` provider
 * (`vscode.github-authentication`, shipped with VS Code), so this extension
 * never stores, refreshes or falls back to a personal access token. `silent`
 * is the default path: no modal appears unless the user asks to sign in.
 */
const SCOPES = ['repo'];

export class GitHubSession {
  async silentToken(): Promise<string | null> {
    const session = await vscode.authentication.getSession('github', SCOPES, { silent: true });
    return session?.accessToken ?? null;
  }

  async signIn(): Promise<string | null> {
    const session = await vscode.authentication.getSession('github', SCOPES, {
      createIfNone: true,
    });
    return session?.accessToken ?? null;
  }
}

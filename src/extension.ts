import * as vscode from 'vscode';
import { watchGitRefs } from './git';
import { ActionsPoller, type PollerOptions } from './poller';
import { ActionsView } from './view';

function readOptions(): PollerOptions {
  const config = vscode.workspace.getConfiguration('ghActionsWatch');
  return {
    repositories: config.get<string[]>('repositories', []),
    activePollMs: config.get<number>('activePollMs', 15_000),
    idlePollMs: config.get<number>('idlePollMs', 90_000),
    recentRuns: config.get<number>('recentRuns', 25),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const poller = new ActionsPoller(readOptions());
  const view = new ActionsView(context.extensionUri, poller);

  context.subscriptions.push(
    poller,
    view,
    vscode.window.registerWebviewViewProvider(ActionsView.viewId, view, {
      // The card is rebuilt from the host's state on reveal, so it does not
      // need a retained renderer sitting in the background.
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('ghActionsWatch.show', async () => {
      await view.reveal();
      // A silent lookup returns nothing until the `repo` scope has been
      // granted, so the first visit is where consent has to happen.
      if (!poller.snapshot().signedIn) await poller.signIn();
    }),
    vscode.commands.registerCommand('ghActionsWatch.refresh', () => view.refreshNow()),
    vscode.commands.registerCommand('ghActionsWatch.signIn', () => poller.signIn()),
    // A commit or a push is the local echo of "a run may now exist". Refresh
    // immediately instead of waiting for the next tick; the `ETag` makes the
    // extra request free when nothing on GitHub has changed yet. Not `force`,
    // so an unfocused window still spends nothing.
    watchGitRefs(() => void poller.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ghActionsWatch')) poller.configure(readOptions());
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void poller.reloadRepositories().then(() => poller.refresh({ force: true }));
    }),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') void poller.refresh({ force: true });
    }),
    vscode.window.onDidChangeWindowState((state) => poller.setFocused(state.focused)),
  );

  void poller.start();
}

export function deactivate(): void {
  // Everything is registered on `context.subscriptions` and disposed by VS Code.
}

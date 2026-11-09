/**
 * Minimal `vscode` module stand-in, used only by `npm test`.
 *
 * The test bundle is built with `--alias:vscode=./test/vscode-stub.ts`, so the
 * extension's own `import * as vscode from 'vscode'` resolves to this file and
 * the whole card can be driven headlessly: no VS Code, no network.
 */

import type { CardView } from '../src/types';

type Disposable = { dispose(): void };

const disposable = (): Disposable => ({ dispose() {} });

export interface SentMessage {
  type: 'view';
  view: CardView;
}

export interface FakeView {
  visible: boolean;
  posted: SentMessage[];
  handlers: { message?: (message: unknown) => unknown };
  webview: {
    options: unknown;
    html: string;
    asWebviewUri(uri: { path: string }): { toString(): string };
    onDidReceiveMessage(fn: (message: unknown) => unknown): Disposable;
    postMessage(message: unknown): Promise<boolean>;
  };
  onDidChangeVisibility(fn: (visible: boolean) => void): Disposable;
  onDidDispose(fn: () => void): Disposable;
}

/** A fake WebviewView that records everything the host pushes into it. */
export function makeView(): FakeView {
  const view: FakeView = {
    visible: true,
    posted: [],
    handlers: {},
    webview: {
      options: {},
      html: '',
      asWebviewUri: (uri) => ({ toString: () => String(uri.path) }),
      onDidReceiveMessage: (fn) => {
        view.handlers.message = fn;
        return disposable();
      },
      postMessage: (message) => {
        view.posted.push(message as SentMessage);
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => disposable(),
    onDidDispose: () => disposable(),
  };
  return view;
}

/** What the extension did, so tests can assert side effects. */
export const recorded = {
  opened: [] as string[],
  info: '',
  error: '',
  commands: [] as string[],
};

export const QuickPickItemKind = { Separator: -1, Default: 0 };

export const Uri = {
  joinPath: (_base: unknown, ...parts: string[]) => {
    const path = parts.filter(Boolean).join('/');
    return { path, toString: () => `file://${path}` };
  },
  parse: (value: string) => ({ toString: () => value }),
};

export const window = {
  state: { focused: true },
  onDidChangeWindowState: () => disposable(),
  registerWebviewViewProvider: () => disposable(),
  showInformationMessage: async (message: string) => {
    recorded.info = message;
  },
  showErrorMessage: async (message: string) => {
    recorded.error = message;
  },
};

export const workspace = {
  workspaceFolders: [] as unknown[],
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
  onDidChangeConfiguration: () => disposable(),
  onDidChangeWorkspaceFolders: () => disposable(),
};

export const authentication = {
  // The token is injected by the test so the flow can be driven both ways.
  getSession: async () =>
    (globalThis as Record<string, unknown>)['__GH_TOKEN__']
      ? { accessToken: (globalThis as Record<string, unknown>)['__GH_TOKEN__'] }
      : undefined,
  onDidChangeSessions: () => disposable(),
};

export const commands = {
  registerCommand: (id: string) => {
    recorded.commands.push(id);
    return disposable();
  },
  executeCommand: async () => undefined,
};

export const env = {
  openExternal: async (uri: { toString(): string }) => {
    recorded.opened.push(uri.toString());
    return true;
  },
};

/**
 * Minimal stub of the `vscode` module for unit tests (vitest aliases the
 * real module name here — see vitest.config.ts). Only what the modules under
 * test actually touch; everything is inert.
 */

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    update: async (): Promise<void> => undefined,
  }),
};

export const window = {
  showInformationMessage: async (): Promise<undefined> => undefined,
  showWarningMessage: async (): Promise<undefined> => undefined,
  showInputBox: async (): Promise<undefined> => undefined,
};

export const commands = {
  executeCommand: async (): Promise<undefined> => undefined,
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// --- tree-view primitives (enough for the native providers) ---------------

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  resourceUri?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire = (e: T) => {
    for (const l of this.listeners) {
      l(e);
    }
  };
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  value = '';
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
  appendText(s: string): this {
    this.value += s;
    return this;
  }
}

export const Uri = {
  file: (p: string) => ({ scheme: 'file', path: p, fsPath: p }),
};

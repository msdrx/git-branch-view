import * as vscode from 'vscode';
import * as path from 'path';
import { BranchViewPanel } from './panel/branchViewPanel';
import { NativeBranchView } from './native/nativeBranchView';
import { GitContentProvider, BRANCH_VIEW_SCHEME } from './git/gitContentProvider';
import { GitService } from './git/gitService';

/** Which front-end renders the branch view (`both` activates the two together). */
type UiMode = 'webview' | 'native' | 'both';

const UI_MODES: readonly UiMode[] = ['webview', 'native', 'both'];

/**
 * Resolve the active UI mode. The `gitBranchView.ui` setting wins when it
 * names a concrete mode; otherwise (`auto`, the default) we fall back to the
 * value baked into package.json at package time (`gitBranchViewDefaults.ui`),
 * defaulting to the webview to preserve historical behaviour.
 */
function resolveUiMode(context: vscode.ExtensionContext): UiMode {
  const setting = vscode.workspace
    .getConfiguration('gitBranchView')
    .get<string>('ui', 'auto');
  if ((UI_MODES as readonly string[]).includes(setting)) {
    return setting as UiMode;
  }
  const baked = context.extension.packageJSON?.gitBranchViewDefaults?.ui;
  return (UI_MODES as readonly string[]).includes(baked) ? (baked as UiMode) : 'webview';
}

export function activate(context: vscode.ExtensionContext): void {
  // Logs every git command (and its duration) to the "Branch View" channel
  // in the Output view, mirroring how the built-in Git extension logs to "Git".
  const log = vscode.window.createOutputChannel('Branch View', { log: true });
  context.subscriptions.push(log);

  const mode = resolveUiMode(context);
  const nativeEnabled = mode !== 'webview';
  const webviewEnabled = mode !== 'native';
  void vscode.commands.executeCommand('setContext', 'gitBranchView.uiMode', mode);
  // Drives the `when` clauses that show the native views (native or both mode).
  void vscode.commands.executeCommand('setContext', 'gitBranchView.nativeEnabled', nativeEnabled);

  // Serve file-at-a-ref contents for diff editors in both front-ends (the
  // native commit/file tree and the webview's changed-files tree).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BRANCH_VIEW_SCHEME,
      new GitContentProvider()
    )
  );

  let native: NativeBranchView | undefined;
  if (nativeEnabled) {
    native = new NativeBranchView(context, log);
    context.subscriptions.push(native);
  }

  const refreshActive = () => {
    void native?.refresh();
    if (webviewEnabled) {
      void BranchViewPanel.current?.refresh();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitBranchView.open', () => {
      // In `both` mode the open command targets the webview panel (the
      // primary UI); the native views live in the activity bar regardless.
      if (webviewEnabled) {
        void BranchViewPanel.createOrShow(context, log);
      } else {
        native?.reveal();
      }
    }),
    vscode.commands.registerCommand('gitBranchView.refresh', refreshActive),
    vscode.commands.registerCommand('gitBranchView.selectUi', async () => {
      const descriptions: Record<UiMode, string> = {
        webview:
          'Visual Studio-style window with the commit graph and resizable columns (default)',
        native: 'Built-in tree views (Branches + Commits) in the activity bar',
        both: 'The graph window and the native tree views together',
      };
      const pick = await vscode.window.showQuickPick(
        UI_MODES.map((m) => ({
          label: m === 'webview' ? 'Webview' : m === 'native' ? 'Native' : 'Both',
          description: m === mode ? '✓ current' : '',
          detail: descriptions[m],
          ui: m,
        })),
        { placeHolder: 'Which front-end should the branch view use?' }
      );
      if (!pick || pick.ui === mode) {
        return;
      }
      // The onDidChangeConfiguration listener below prompts for the reload.
      await vscode.workspace
        .getConfiguration('gitBranchView')
        .update('ui', pick.ui, vscode.ConfigurationTarget.Global);
    })
  );

  // Refresh when files change under .git (commits, checkouts, fetches, etc.).
  // `packed-refs` is included because git packs refs there (e.g. after `git gc`
  // or a fetch), so a ref update can land in that single file rather than under
  // refs/.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,packed-refs,refs/**}');
  watcher.onDidChange(refreshActive);
  watcher.onDidCreate(refreshActive);
  watcher.onDidDelete(refreshActive);
  context.subscriptions.push(watcher);

  // The glob above only sees `.git` directories that live INSIDE a workspace
  // folder. A linked worktree keeps its `.git` as a *file* pointing at
  // `<main>/.git/worktrees/<name>`, and a repo rooted above the opened folder
  // keeps `.git` outside it — in both cases ref changes happen at an absolute
  // path the glob can't match. Resolve each folder's real git directories and
  // watch those too, recomputing when the workspace folders change.
  const worktreeWatchers: vscode.Disposable[] = [];
  const disposeWorktreeWatchers = () => {
    while (worktreeWatchers.length) {
      worktreeWatchers.pop()?.dispose();
    }
  };
  const setupWorktreeWatchers = async () => {
    disposeWorktreeWatchers();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    for (const f of folders) {
      const dirs = await GitService.getGitDirs(f.uri.fsPath, log);
      if (!dirs) {
        continue;
      }
      for (const dir of [dirs.gitDir, dirs.commonDir]) {
        // A git dir inside a workspace folder is already covered by the glob;
        // only out-of-tree ones (worktrees, ancestor repos) need watching here.
        if (seen.has(dir) || isInsideWorkspace(dir, folders)) {
          continue;
        }
        seen.add(dir);
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,packed-refs,refs/**}')
        );
        w.onDidChange(refreshActive);
        w.onDidCreate(refreshActive);
        w.onDidDelete(refreshActive);
        worktreeWatchers.push(w);
      }
    }
  };
  void setupWorktreeWatchers();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void setupWorktreeWatchers()),
    { dispose: disposeWorktreeWatchers }
  );

  // Switching UI mode swaps which views/commands are registered, which only
  // happens at activation — prompt for a reload so the change takes effect.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The date format only affects rendering — push fresh data so the
      // Date column re-renders immediately, no reload needed.
      if (e.affectsConfiguration('gitBranchView.dateFormat')) {
        refreshActive();
      }
      if (!e.affectsConfiguration('gitBranchView.ui')) {
        return;
      }
      void vscode.window
        .showInformationMessage(
          'Git Branch View: reload the window to apply the new UI mode.',
          'Reload Window'
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

/** True when `dir` is the same as, or nested inside, any workspace folder. */
function isInsideWorkspace(
  dir: string,
  folders: readonly vscode.WorkspaceFolder[]
): boolean {
  return folders.some((f) => {
    const rel = path.relative(f.uri.fsPath, dir);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

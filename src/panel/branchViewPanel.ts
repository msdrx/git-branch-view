import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { GitService } from '../git/gitService';
import { activeEditorRepoRoot, resolveRepoRoot } from '../git/resolveRepo';
import {
  ensureClean,
  getDateFormat,
  getPullStrategy,
  pushWithRecovery,
  setPullStrategy,
} from '../git/gitActions';
import { BRANCH_VIEW_SCHEME, fileAtRefUri, refLabel } from '../git/gitContentProvider';
import { displayRefName } from '../refName';
import { sanitizeColumnWidths } from './columnWidths';

/**
 * Owns the single Branch View webview panel. Re-uses one panel instance
 * (singleton) and rebuilds its data on demand.
 */
export class BranchViewPanel {
  public static current: BranchViewPanel | undefined;
  private static readonly viewType = 'gitBranchView.panel';
  /** globalState key: commit-list column widths (UI preference, shared repos). */
  private static readonly columnWidthsKey = 'gitBranchView.columnWidths';
  /** workspaceState key: the branch the user last viewed in this workspace. */
  private static readonly focusKey = 'gitBranchView.focusedRef';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private git: GitService | undefined;
  /** Repo root the resolved GitService runs in; needed to build diff URIs. */
  private repoRoot: string | undefined;
  /**
   * Ref whose history the graph is focused on. `undefined` means "follow the
   * current branch" (the default). A branch click sets this to view another
   * ref without checking it out.
   */
  private focusedRef: string | undefined;
  /** Last HEAD we rendered, used to notice checkouts made outside the panel. */
  private lastCurrent: string | undefined;
  /**
   * Commits per page, sent by the webview with `ready` (≈2× the rows visible
   * in its viewport). The list loads one page up front and pages in the rest
   * on scroll instead of loading the whole history.
   */
  private pageSize = 100;
  /**
   * How many commits the webview currently holds for the focused history.
   * Refreshes re-fetch this many so the loaded depth (and the user's scroll
   * position) survives; selecting a branch resets it to one page.
   */
  private loadedCount = 0;

  static async createOrShow(
    context: vscode.ExtensionContext,
    logger: vscode.LogOutputChannel
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (BranchViewPanel.current) {
      BranchViewPanel.current.panel.reveal(column);
      await BranchViewPanel.current.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BranchViewPanel.viewType,
      'Git Branches',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
    };

    BranchViewPanel.current = new BranchViewPanel(panel, context, logger);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel
  ) {
    this.panel = panel;
    // Restore the branch the user was last viewing in this workspace, so
    // reopening the panel lands back on it instead of always snapping to HEAD.
    this.focusedRef = context.workspaceState.get<string>(BranchViewPanel.focusKey) || undefined;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    // Pick up checkouts made outside the panel (e.g. in a terminal): refresh
    // whenever the panel is shown again or the window regains focus. The
    // `.git` FileSystemWatcher in extension.ts only fires while VS Code is the
    // focused app, so this covers checkouts done in an external terminal.
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          void this.loadAll();
        }
      },
      null,
      this.disposables
    );
    vscode.window.onDidChangeWindowState(
      (e) => {
        if (e.focused && this.panel.visible) {
          void this.loadAll();
        }
      },
      null,
      this.disposables
    );

    // Re-resolve the repository when the workspace folders change (a folder was
    // added/removed/reordered): the cached GitService may now point at a folder
    // that's gone, or a better candidate may have appeared.
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        this.git = undefined;
        this.repoRoot = undefined;
        void this.loadAll();
      },
      null,
      this.disposables
    );

    // In a multi-root workspace, follow the active editor: switching to a file
    // in a different in-workspace repo retargets the view to that repo, so the
    // active-editor preference isn't only honoured on the first resolution.
    vscode.window.onDidChangeActiveTextEditor(
      () => void this.retargetToActiveEditor(),
      null,
      this.disposables
    );

    // Initial data load once the webview signals it's ready.
  }

  async refresh(): Promise<void> {
    await this.loadAll();
  }

  /**
   * Set the focused ref and persist it for this workspace. Passing `undefined`
   * clears the saved selection (so the next open follows the current branch).
   */
  private setFocus(ref: string | undefined): void {
    this.focusedRef = ref;
    void this.context.workspaceState.update(BranchViewPanel.focusKey, ref);
  }

  /** Persisted commit-list column widths (sanitized), keyed by column. */
  private getColumnWidths(): Record<string, number> {
    return sanitizeColumnWidths(
      this.context.globalState.get<Record<string, number>>(BranchViewPanel.columnWidthsKey)
    );
  }

  private async resolveGit(): Promise<GitService | undefined> {
    if (this.git) {
      return this.git;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: 'error', message: 'Open a folder that is a Git repository.' });
      return undefined;
    }
    // Prefers the active editor's repo in multi-root workspaces (shared with
    // the native UI so both resolve the same repo).
    const root = await resolveRepoRoot(this.logger);
    if (root) {
      this.git = new GitService(root, this.logger);
      this.repoRoot = root;
      this.post({ type: 'repo', root });
      return this.git;
    }
    this.post({ type: 'error', message: 'No Git repository found in the workspace.' });
    return undefined;
  }

  /**
   * Multi-root only: when the active editor moves to a file owned by a
   * *different* in-workspace repo, swap the resolved repository to follow it.
   * Git is asked which repo actually owns the file rather than assuming
   * path-containment implies the same repo — a nested repository inside the
   * current repoRoot would otherwise be masked (its files sit under the parent's
   * path yet belong to the nested repo). Re-resolving to the same repo is a
   * no-op, and an editor with no file (e.g. focusing the panel) or one outside
   * the workspace is ignored, so the view never snaps away on its own.
   */
  private async retargetToActiveEditor(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length < 2) {
      return;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active || active.scheme !== 'file') {
      return;
    }
    const root = await activeEditorRepoRoot(this.logger);
    if (!root || root === this.repoRoot) {
      return;
    }
    // Adopted a different repo: its diff URIs and history replace the old one.
    this.git = new GitService(root, this.logger);
    this.repoRoot = root;
    this.post({ type: 'repo', root });
    // The persisted focus belongs to the previous repo; follow the new repo's
    // HEAD and reset the loaded depth.
    this.setFocus(undefined);
    this.lastCurrent = undefined;
    this.loadedCount = 0;
    await this.loadAll();
  }

  /**
   * Fetch one page of commits plus a sentinel row, so the webview learns
   * whether more history exists without a separate rev-list count.
   */
  private async getPage(
    git: GitService,
    refs: string[] | undefined,
    skip: number,
    limit: number
  ): Promise<{ commits: Awaited<ReturnType<GitService['getCommits']>>; hasMore: boolean }> {
    const commits = await git.getCommits(limit + 1, refs, skip);
    const hasMore = commits.length > limit;
    return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
  }

  private async loadAll(): Promise<void> {
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      // Re-fetch at least what the webview already shows, so a refresh after
      // deep scrolling doesn't visibly shrink the list.
      const limit = Math.max(this.pageSize, this.loadedCount);

      const current = await git.getCurrentBranch();

      if (this.lastCurrent === undefined) {
        // First load of this panel — adopt HEAD as the baseline without
        // clearing any branch focus restored from the previous session.
        this.lastCurrent = current;
      } else if (current !== this.lastCurrent) {
        // HEAD moved since the last load — including checkouts done in a
        // terminal or another Git tool — so drop any sticky branch focus and
        // let the graph snap to whatever is now checked out.
        this.setFocus(undefined);
        this.lastCurrent = current;
      }

      // Show the focused ref's history, defaulting to the current branch.
      const focus = this.focusedRef ?? (current || undefined);

      const [page, branches] = await Promise.all([
        this.getPage(git, focus ? [focus] : undefined, 0, limit).catch(() => {
          // Focused ref vanished (deleted/renamed) — fall back to all branches.
          this.setFocus(undefined);
          return this.getPage(git, undefined, 0, limit);
        }),
        git.getBranches(),
      ]);
      this.loadedCount = page.commits.length;

      // The ref whose history is actually shown (re-read after the catch above,
      // which clears focus when the focused ref vanished).
      const effectiveFocus = this.focusedRef ?? (current || undefined);

      // Tracking counts must reflect the DISPLAYED branch, not always HEAD.
      // for-each-ref already carries each branch's ahead/behind vs its upstream
      // (see getBranches), so use the focused branch's own counts; fall back to
      // HEAD's tracking only when the focused ref isn't a known branch (a
      // detached hash or a vanished ref).
      const focusedBranch = effectiveFocus
        ? branches.find((b) => b.refName === effectiveFocus || b.name === effectiveFocus)
        : undefined;
      const tracking = focusedBranch
        ? {
            ahead: focusedBranch.ahead ?? 0,
            behind: focusedBranch.behind ?? 0,
            upstream: focusedBranch.upstream,
          }
        : await git.getTracking();

      this.post({
        type: 'data',
        branches,
        commits: page.commits,
        hasMore: page.hasMore,
        tracking,
        current,
        focused: effectiveFocus ?? null,
        pullStrategy: getPullStrategy(),
        dateFormat: getDateFormat(),
        columnWidths: this.getColumnWidths(),
      });
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      switch (msg.type) {
        case 'ready':
          // The webview sends a bare `ready` on first load — keep any branch
          // focus restored from the previous session. The Refresh button sends
          // `reset: true` to deliberately clear it and follow the current branch.
          if (typeof msg.pageSize === 'number' && msg.pageSize > 0) {
            this.pageSize = Math.floor(msg.pageSize);
          }
          if (msg.reset) {
            this.setFocus(undefined);
            this.loadedCount = 0; // back to one page
          }
          await this.loadAll();
          break;

        case 'refresh':
          // Lightweight reload the webview fires when it regains focus (the user
          // clicked back into the panel — e.g. after a checkout in the
          // integrated terminal, where neither the window focus nor the panel
          // visibility changes, so the host's own triggers don't fire). Unlike
          // 'ready' this keeps the branch you're viewing; loadAll() still snaps
          // to HEAD if it moved, fixing the stale "current branch" highlight.
          await this.loadAll();
          break;

        case 'selectBranch': {
          // View another branch's history without checking it out; the focus
          // sticks across refreshes (and sessions) until HEAD changes or
          // Refresh is pressed. A new history starts back at one page.
          this.setFocus(msg.ref);
          const page = await this.getPage(git, [msg.ref], 0, this.pageSize);
          this.loadedCount = page.commits.length;
          this.post({
            type: 'branchCommits',
            ref: msg.ref,
            commits: page.commits,
            hasMore: page.hasMore,
          });
          break;
        }

        case 'moreCommits': {
          // Scroll reached the bottom: append the next page of the focused
          // history (same scope as loadAll computes).
          const skip = Math.max(0, Math.floor(msg.skip) || 0);
          const focus = this.focusedRef ?? ((await git.getCurrentBranch()) || undefined);
          const page = await this.getPage(git, focus ? [focus] : undefined, skip, this.pageSize);
          this.loadedCount = skip + page.commits.length;
          this.post({
            type: 'moreCommits',
            // Stamp the scope so the webview can reject this page if it switched
            // to a different branch while it was in flight (a stale append would
            // otherwise splice this ref's commits into the other branch).
            ref: focus ?? null,
            skip,
            commits: page.commits,
            hasMore: page.hasMore,
          });
          break;
        }

        case 'commitDetail': {
          const detail = await git.getCommitDetail(msg.hash);
          this.post({ type: 'commitDetail', detail });
          break;
        }

        case 'openFileDiff': {
          // A changed file was selected in the webview's files tree: open VS
          // Code's real diff editor (commit vs. first parent) in a split
          // BESIDE the panel, so the Branch View stays visible. preserveFocus
          // keeps the panel focused; preview reuses one tab across clicks. A
          // missing side (root commit, add, delete) renders as a blank pane
          // via the content provider.
          const root = this.repoRoot;
          if (!root) {
            break;
          }
          // Renames carry their old path separately; literal path text is left
          // untouched.
          const oldPath = msg.oldPath ?? msg.path;
          const newPath = msg.path;
          // First diff of a session: shrink the panel AND pre-create the wide
          // group the diff will open into, in a SINGLE layout change, so the
          // panel resizes exactly once. (Opening the diff Beside first and
          // resizing afterwards flashes the panel at half width before it snaps
          // to a sliver.) While a diff is already open the preview tab is reused
          // and the layout is left untouched, so re-clicks don't re-snap and any
          // width the user dragged back is respected; closing the diff removes
          // its group and the panel reclaims the width on its own.
          const panelColumn = this.panel.viewColumn;
          if (!this.hasOpenDiff() && panelColumn !== undefined) {
            await this.prepareDiffLayout(panelColumn);
          }
          // Open into the column beside the panel. Targeting that column
          // explicitly (rather than ViewColumn.Beside) keeps every click aimed at
          // the same group, so the preview tab is reliably reused and no stray
          // group is created; preserveFocus keeps the panel focused for keyboard
          // nav. VS Code renders a diff side-by-side only when it's wide enough
          // (it collapses to an inline view otherwise), so the full-width group
          // keeps it side-by-side like a normal VS Code diff.
          const diffColumn: vscode.ViewColumn =
            panelColumn === undefined
              ? vscode.ViewColumn.Beside
              : ((panelColumn + 1) as vscode.ViewColumn);
          await vscode.commands.executeCommand(
            'vscode.diff',
            fileAtRefUri(root, msg.parent ?? `${msg.hash}^`, oldPath),
            fileAtRefUri(root, msg.hash, newPath),
            `${newPath} (${refLabel(String(msg.hash))})`,
            {
              viewColumn: diffColumn,
              preserveFocus: true,
              preview: true,
            }
          );
          break;
        }

        case 'compare': {
          const result = await git.compare(msg.base, msg.target);
          this.post({ type: 'compareResult', base: msg.base, target: msg.target, result });
          break;
        }

        case 'checkout': {
          if (
            !(await ensureClean(
              git,
              `You have uncommitted changes in the working directory. ` +
                `Commit them before checking out "${displayRefName(msg.branch)}".`
            ))
          ) {
            break;
          }
          await git.checkout(msg.branch);
          vscode.window.showInformationMessage(`Checked out ${displayRefName(msg.branch)}`);
          // Focus the graph on the branch (or commit) we just switched to so
          // its history shows immediately instead of the unchanged --all view.
          // loadAll() sees HEAD move and updates lastCurrent, so this focus
          // survives the move.
          this.lastCurrent = await git.getCurrentBranch();
          this.setFocus(msg.branch);
          await this.loadAll();
          break;
        }

        case 'createBranch': {
          if (
            !(await ensureClean(
              git,
              `You have uncommitted changes in the working directory. ` +
                `Commit them before creating a new branch.`
            ))
          ) {
            break;
          }
          const name = await vscode.window.showInputBox({
            prompt: `New branch from ${displayRefName(msg.startPoint) || 'HEAD'}`,
            placeHolder: 'feature/my-branch',
          });
          if (name) {
            await git.createBranch(name, msg.startPoint);
            // createBranch does `checkout -b`, so HEAD is now on the new branch.
            this.lastCurrent = name;
            this.setFocus(name);
            await this.loadAll();
          }
          break;
        }

        case 'deleteBranch': {
          const ok = await vscode.window.showWarningMessage(
            `Delete branch ${displayRefName(msg.branch)}?`,
            { modal: true },
            'Delete'
          );
          if (ok === 'Delete') {
            await git.deleteBranch(msg.branch);
            if (this.focusedRef === msg.branch) {
              this.setFocus(undefined);
            }
            await this.loadAll();
          }
          break;
        }

        case 'merge':
          await git.merge(msg.branch);
          await this.loadAll();
          break;

        case 'fetch':
          await git.fetch();
          await this.loadAll();
          break;
        case 'pull':
          await git.pull(getPullStrategy());
          await this.loadAll();
          break;
        case 'push':
          await pushWithRecovery(git, () => this.loadAll());
          break;

        case 'setPullStrategy': {
          // Persist the chosen strategy globally so it becomes the default for
          // all future pulls (in every repo), then echo fresh data so the
          // webview menu reflects the new selection.
          await setPullStrategy(msg.strategy);
          await this.loadAll();
          break;
        }

        case 'setColumnWidths':
          // Persist the user's commit-list column widths globally. No reload —
          // the webview already applied them locally as the user dragged.
          await this.context.globalState.update(
            BranchViewPanel.columnWidthsKey,
            sanitizeColumnWidths(msg.widths)
          );
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Whether one of our diff editors (a `gitbranchview:` compare/parent diff) is
   * currently open in any tab group. Used to tell a click that *creates* the
   * diff split from one that merely refreshes the reused preview tab, so the
   * panel is only resized once — when the split first appears — and the user's
   * own resizing is left alone afterwards.
   */
  private hasOpenDiff(): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          (input.original.scheme === BRANCH_VIEW_SCHEME ||
            input.modified.scheme === BRANCH_VIEW_SCHEME)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Lay out the editor groups so the Branch View panel (in `panelColumn`)
   * shrinks to its smallest width while the column beside it — where the diff
   * is about to open — gets the rest. When the panel has no group to its right
   * yet, this adds one as part of the SAME resize, so the panel reflows a single
   * time instead of flashing at half width (the diff opens straight into the
   * already-wide group afterwards). Sizing the diff column wide also keeps the
   * diff side-by-side: VS Code collapses a narrow diff to an inline view.
   *
   * It only changes column widths, not focus, so the panel stays focused for
   * keyboard nav once the diff opens with `preserveFocus`.
   */
  private async prepareDiffLayout(panelColumn: number): Promise<void> {
    const groupCount = vscode.window.tabGroups.all.length;
    // The diff opens in the column right of the panel. If the panel is the last
    // column there's no group there yet, so the layout needs one extra slot.
    const needNewGroup = panelColumn >= groupCount;
    const targetCount = groupCount + (needNewGroup ? 1 : 0);
    if (targetCount < 2) {
      return;
    }
    // A tiny size for the panel column (VS Code clamps it up to the minimum
    // group width) and a large, even share for every other column.
    const groups: { size: number }[] = [];
    for (let col = 1; col <= targetCount; col++) {
      groups.push({ size: col === panelColumn ? 1 : 20 });
    }
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0, // lay the groups out as side-by-side columns
      groups,
    });
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

    // The React bundle (built from src/webview/ by scripts/build-webview.js).
    const styleUri = uri('dist/webview.css');
    const scriptUri = uri('dist/webview.js');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Git Branches</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    BranchViewPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/**
 * A fresh, unguessable CSP nonce for the webview's <script>. Built from a
 * cryptographically secure RNG (`crypto.randomBytes`) — NOT `Math.random()`,
 * whose output is predictable and would let an attacker who can inject markup
 * guess the nonce and satisfy the script-src allow-list. 128 bits, base64url so
 * the value is safe to drop straight into the CSP header and the nonce attribute.
 */
function getNonce(): string {
  return randomBytes(16).toString('base64url');
}

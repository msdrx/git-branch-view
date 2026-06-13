import * as vscode from 'vscode';
import { BranchInfo, CompareResult, GitService } from '../git/gitService';
import {
  ensureClean,
  getPullStrategy,
  pushWithRecovery,
  setPullStrategy,
  PULL_STRATEGIES,
  PULL_STRATEGY_LABELS,
} from '../git/gitActions';
import { BranchesProvider, BranchTreeNode } from './branchesProvider';
import { CommitsProvider, CommitTreeNode } from './commitsProvider';
import { fileAtRefUri, refLabel } from '../git/gitContentProvider';

/**
 * The native (non-webview) front-end: two VS Code tree views — Branches and
 * Commits — plus the commands wiring them to `GitService`. It mirrors
 * `BranchViewPanel`'s responsibilities (resolve the repo, track the focused
 * ref per workspace, reload on demand) but renders with built-in widgets, so it
 * shares the same `gitActions` helpers and the workspace focus key as the panel.
 */
export class NativeBranchView implements vscode.Disposable {
  /** workspaceState key — shared with the panel so focus survives a mode switch. */
  private static readonly focusKey = 'gitBranchView.focusedRef';
  /** Container id used to reveal the views (`gitBranchView.open`). */
  private static readonly containerId = 'gitBranchView';

  private readonly disposables: vscode.Disposable[] = [];
  private readonly branchesProvider = new BranchesProvider();
  private readonly commitsProvider: CommitsProvider;
  private readonly commitsView: vscode.TreeView<CommitTreeNode>;

  private git: GitService | undefined;
  private repoRoot: string | undefined;
  private focusedRef: string | undefined;
  /** Last HEAD we rendered, used to notice checkouts made outside the views. */
  private lastCurrent: string | undefined;
  /**
   * Commits currently loaded for the focused history. Tree views get no
   * scroll events, so paging is driven by a trailing "Load more commits…"
   * row instead (commitLimit is the page size); refreshes re-fetch this many
   * so the loaded depth survives, and focusing a branch resets to one page.
   */
  private loadedCount = 0;
  /** Re-entrancy guard for the Load more row. */
  private loadingMore = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel
  ) {
    this.focusedRef =
      context.workspaceState.get<string>(NativeBranchView.focusKey) || undefined;

    this.commitsProvider = new CommitsProvider((hash) => this.filesFor(hash));
    const branchesView = vscode.window.createTreeView('gitBranchView.branches', {
      treeDataProvider: this.branchesProvider,
      showCollapseAll: true,
    });
    this.commitsView = vscode.window.createTreeView('gitBranchView.commits', {
      treeDataProvider: this.commitsProvider,
    });
    this.disposables.push(branchesView, this.commitsView);

    this.registerCommands();

    // Pick up checkouts made outside the views (e.g. in a terminal) when the
    // window regains focus — the `.git` watcher only fires while VS Code has it.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
          void this.refresh();
        }
      })
    );

    void this.refresh();
  }

  /** Reveal the Branches/Commits views (wired to `gitBranchView.open`). */
  reveal(): void {
    void vscode.commands.executeCommand(
      `workbench.view.extension.${NativeBranchView.containerId}`
    );
  }

  /** Commits per page (the `commitLimit` setting). */
  private pageSize(): number {
    const limit = vscode.workspace
      .getConfiguration('gitBranchView')
      .get<number>('commitLimit', 500);
    return Math.max(1, Math.floor(limit) || 500);
  }

  /**
   * Fetch one page of commits plus a sentinel row, so the tree learns whether
   * a Load more row is needed without a separate rev-list count.
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

  async refresh(reset = false): Promise<void> {
    if (reset) {
      this.setFocus(undefined);
      this.loadedCount = 0; // back to one page
    }
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      // Re-fetch at least what the tree already shows, so a refresh after
      // loading more pages doesn't visibly shrink the list.
      const limit = Math.max(this.pageSize(), this.loadedCount);

      const current = await git.getCurrentBranch();

      if (this.lastCurrent === undefined) {
        // First load — adopt HEAD as the baseline without clearing restored focus.
        this.lastCurrent = current;
      } else if (current !== this.lastCurrent) {
        // HEAD moved (possibly via a terminal) — drop sticky focus, follow HEAD.
        this.setFocus(undefined);
        this.lastCurrent = current;
      }

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

      this.branchesProvider.setBranches(branches, this.focusedRef ?? (current || undefined));
      this.commitsProvider.setCommits(page.commits, page.hasMore);
      this.commitsView.description = focus;
    } catch (err) {
      this.showError(err);
    }
  }

  // --- command registration ---------------------------------------------

  private registerCommands(): void {
    const reg = (id: string, fn: (...args: any[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));

    reg('gitBranchView.native.focusBranch', (node?: BranchTreeNode) => {
      if (node?.kind === 'branch') {
        this.setFocus(node.info.name);
        this.loadedCount = 0; // a new history starts back at one page
        void this.refresh();
      }
    });
    reg('gitBranchView.native.loadMore', () => this.loadMore());
    reg('gitBranchView.native.checkout', (node?: BranchTreeNode) =>
      this.onBranch(node, (git, b) => this.checkout(git, b.name))
    );
    reg('gitBranchView.native.newBranch', (node?: BranchTreeNode) =>
      this.newBranch(node?.kind === 'branch' ? node.info.name : undefined)
    );
    reg('gitBranchView.native.merge', (node?: BranchTreeNode) =>
      this.onBranch(node, (git, b) => this.merge(git, b.name))
    );
    reg('gitBranchView.native.delete', (node?: BranchTreeNode) =>
      this.onBranch(node, (git, b) => this.deleteBranch(git, b.name))
    );
    reg('gitBranchView.native.compare', (node?: BranchTreeNode) =>
      this.onBranch(node, (git, b) => this.compare(git, b.name))
    );

    reg('gitBranchView.native.fetch', () => this.doGit((git) => git.fetch()));
    reg('gitBranchView.native.pull', () => this.doGit((git) => git.pull(getPullStrategy())));
    reg('gitBranchView.native.push', () =>
      this.doGit((git) => pushWithRecovery(git, () => this.refresh()), false)
    );
    reg('gitBranchView.native.setPullStrategy', () => this.pickPullStrategy());
    reg('gitBranchView.native.refresh', () => this.refresh(true));

    reg('gitBranchView.native.openCommitFile', (node?: CommitTreeNode) =>
      this.openCommitFile(node)
    );
    reg('gitBranchView.native.copyCommitId', (node?: CommitTreeNode) => {
      if (node?.kind === 'commit') {
        void vscode.env.clipboard.writeText(node.info.hash);
      }
    });
    reg('gitBranchView.native.newBranchFromCommit', (node?: CommitTreeNode) => {
      if (node?.kind === 'commit') {
        void this.newBranch(node.info.hash);
      }
    });
    reg('gitBranchView.native.checkoutCommit', (node?: CommitTreeNode) => {
      if (node?.kind === 'commit') {
        void this.doGit((git) => this.checkout(git, node.info.hash));
      }
    });
  }

  // --- actions ----------------------------------------------------------

  /** The Load more row was clicked: append the next page of the history. */
  private async loadMore(): Promise<void> {
    if (this.loadingMore) {
      return;
    }
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    this.loadingMore = true;
    this.commitsProvider.setLoadingMore();
    try {
      const current = await git.getCurrentBranch();
      const focus = this.focusedRef ?? (current || undefined);
      const skip = this.loadedCount;
      const page = await this.getPage(git, focus ? [focus] : undefined, skip, this.pageSize());
      this.loadedCount = skip + page.commits.length;
      this.commitsProvider.appendCommits(page.commits, page.hasMore);
    } catch (err) {
      this.showError(err);
      this.commitsProvider.appendCommits([], true); // keep the row for a retry
    } finally {
      this.loadingMore = false;
    }
  }

  private async checkout(git: GitService, target: string): Promise<void> {
    if (
      !(await ensureClean(
        git,
        `You have uncommitted changes in the working directory. ` +
          `Commit them before checking out "${target}".`
      ))
    ) {
      return;
    }
    await git.checkout(target);
    vscode.window.showInformationMessage(`Checked out ${target}`);
    this.lastCurrent = target;
    this.setFocus(target);
    await this.refresh();
  }

  private async newBranch(startPoint?: string): Promise<void> {
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      if (
        !(await ensureClean(
          git,
          `You have uncommitted changes in the working directory. ` +
            `Commit them before creating a new branch.`
        ))
      ) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: `New branch from ${startPoint ?? 'HEAD'}`,
        placeHolder: 'feature/my-branch',
      });
      if (!name) {
        return;
      }
      await git.createBranch(name, startPoint);
      this.lastCurrent = name;
      this.setFocus(name);
      await this.refresh();
    } catch (err) {
      this.showError(err);
    }
  }

  private async merge(git: GitService, branch: string): Promise<void> {
    await git.merge(branch);
    await this.refresh();
  }

  private async deleteBranch(git: GitService, branch: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Delete branch ${branch}?`,
      { modal: true },
      'Delete'
    );
    if (ok !== 'Delete') {
      return;
    }
    await git.deleteBranch(branch);
    if (this.focusedRef === branch) {
      this.setFocus(undefined);
    }
    await this.refresh();
  }

  /** Pick a base branch, then show the comparison in the Commits tree. */
  private async compare(git: GitService, target: string): Promise<void> {
    const branches = await git.getBranches();
    const others = branches.map((b) => b.name).filter((name) => name !== target);
    const base = await vscode.window.showQuickPick(others, {
      placeHolder: `Compare ${target} with… (pick the base branch)`,
    });
    if (!base) {
      return;
    }
    const result = await git.compare(base, target);
    this.showCompare(base, target, result);
  }

  /**
   * Render the comparison in the Commits tree (mirrors the webview's compare
   * mode): a changed-files section whose files open merge-base-vs-target diff
   * editors, plus the ahead/behind commit sections. The next refresh — or
   * focusing a branch — returns the tree to branch history.
   */
  private showCompare(base: string, target: string, result: CompareResult): void {
    this.commitsProvider.setCompare(base, target, result);
    this.commitsView.description = `${base} ⇄ ${target}`;
  }

  private async openCommitFile(node?: CommitTreeNode): Promise<void> {
    if (!node || node.kind !== 'file' || !this.repoRoot) {
      return;
    }
    const root = this.repoRoot;
    // Renames arrive as "old → new"; diff the old path on the left, new on right.
    const [oldPath, newPath] = node.path.includes(' → ')
      ? node.path.split(' → ')
      : [node.path, node.path];
    await vscode.commands.executeCommand(
      'vscode.diff',
      fileAtRefUri(root, node.parentHash, oldPath),
      fileAtRefUri(root, node.commitHash, newPath),
      `${newPath} (${refLabel(node.commitHash)})`
    );
  }

  private async pickPullStrategy(): Promise<void> {
    const current = getPullStrategy();
    const items = PULL_STRATEGIES.map((s) => ({
      label: PULL_STRATEGY_LABELS[s],
      description: s === current ? '✓ current' : '',
      strategy: s,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Strategy used for future pulls',
    });
    if (pick) {
      await setPullStrategy(pick.strategy);
      await this.refresh();
    }
  }

  // --- plumbing ---------------------------------------------------------

  /** Run `fn` against the resolved git service for a branch tree node. */
  private async onBranch(
    node: BranchTreeNode | undefined,
    fn: (git: GitService, b: BranchInfo) => Promise<void>
  ): Promise<void> {
    if (!node || node.kind !== 'branch') {
      return;
    }
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      await fn(git, node.info);
    } catch (err) {
      this.showError(err);
    }
  }

  /** Run a toolbar git action, refreshing afterwards unless `refresh` is false. */
  private async doGit(
    fn: (git: GitService) => Promise<void>,
    refresh = true
  ): Promise<void> {
    const git = await this.resolveGit();
    if (!git) {
      return;
    }
    try {
      await fn(git);
      if (refresh) {
        await this.refresh();
      }
    } catch (err) {
      this.showError(err);
    }
  }

  private async filesFor(hash: string): Promise<{ status: string; path: string }[]> {
    const git = await this.resolveGit();
    if (!git) {
      return [];
    }
    try {
      return (await git.getCommitDetail(hash)).files;
    } catch {
      return [];
    }
  }

  private async resolveGit(): Promise<GitService | undefined> {
    if (this.git) {
      return this.git;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      void vscode.commands.executeCommand('setContext', 'gitBranchView.noRepo', true);
      return undefined;
    }
    for (const f of folders) {
      const root = await GitService.findRepoRoot(f.uri.fsPath, this.logger);
      if (root) {
        this.repoRoot = root;
        this.git = new GitService(root, this.logger);
        void vscode.commands.executeCommand('setContext', 'gitBranchView.noRepo', false);
        return this.git;
      }
    }
    void vscode.commands.executeCommand('setContext', 'gitBranchView.noRepo', true);
    return undefined;
  }

  private setFocus(ref: string | undefined): void {
    this.focusedRef = ref;
    void this.context.workspaceState.update(NativeBranchView.focusKey, ref);
  }

  private showError(err: unknown): void {
    vscode.window.showErrorMessage(String(err));
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

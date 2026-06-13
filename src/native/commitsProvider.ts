import * as vscode from 'vscode';
import { CommitInfo, CompareResult } from '../git/gitService';

/** git's well-known empty-tree hash — the "parent" used to diff a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * A node in the Commits tree: a commit row, one of its changed files, or — in
 * compare mode — a section header grouping the comparison's files/commits. The
 * native UI can't draw the lane graph the webview does, so this is a flat commit
 * list; each commit expands to its changed files, which open real diff editors.
 */
export type CommitTreeNode =
  | { kind: 'commit'; info: CommitInfo }
  | {
      kind: 'file';
      commitHash: string;
      parentHash: string;
      status: string;
      path: string;
    }
  | { kind: 'section'; label: string; children: CommitTreeNode[] }
  /** Trailing "Load more commits…" row, shown while more history exists
   *  (tree views get no scroll events, so paging is click-driven). */
  | { kind: 'loadMore' };

/** An active branch comparison rendered by the Commits tree. */
interface CompareView {
  base: string;
  target: string;
  result: CompareResult;
}

/**
 * The right-hand Commits tree, scoped to the focused branch. Commit rows show
 * subject + short hash + author/date and expand (lazily) to their changed files;
 * clicking a file opens a commit-vs-parent diff. In compare mode the tree shows
 * the comparison instead: a changed-files section whose files open
 * merge-base-vs-target diffs, plus the ahead/behind commit sections.
 */
export class CommitsProvider implements vscode.TreeDataProvider<CommitTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private commits: CommitInfo[] = [];
  private compare: CompareView | undefined;
  /** More history exists beyond the loaded commits (shows the Load more row). */
  private hasMore = false;
  /** The next page is in flight (the Load more row shows a spinner). */
  private loadingMore = false;

  constructor(
    private readonly getFiles: (hash: string) => Promise<{ status: string; path: string }[]>
  ) {}

  setCommits(commits: CommitInfo[], hasMore = false): void {
    this.commits = commits;
    this.hasMore = hasMore;
    this.loadingMore = false;
    this.compare = undefined;
    this._onDidChange.fire();
  }

  /** Append the next history page (requested via the Load more row). */
  appendCommits(commits: CommitInfo[], hasMore: boolean): void {
    this.commits = [...this.commits, ...commits];
    this.hasMore = hasMore;
    this.loadingMore = false;
    this._onDidChange.fire();
  }

  /** Mark the next page as in flight, disabling the Load more row meanwhile. */
  setLoadingMore(): void {
    this.loadingMore = true;
    this._onDidChange.fire();
  }

  /** Switch the tree to compare mode (cleared by the next setCommits). */
  setCompare(base: string, target: string, result: CompareResult): void {
    this.compare = { base, target, result };
    this._onDidChange.fire();
  }

  getTreeItem(node: CommitTreeNode): vscode.TreeItem {
    if (node.kind === 'loadMore') {
      const item = new vscode.TreeItem(
        this.loadingMore ? 'Loading more commits…' : 'Load more commits…',
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon(this.loadingMore ? 'loading~spin' : 'ellipsis');
      item.contextValue = 'gbv.loadMore';
      if (!this.loadingMore) {
        item.command = {
          command: 'gitBranchView.native.loadMore',
          title: 'Load More Commits',
        };
      }
      return item;
    }
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = 'gbv.section';
      return item;
    }
    if (node.kind === 'commit') {
      const c = node.info;
      const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${c.shortHash}  ${c.authorName} · ${formatDate(c.authorDate)}`;
      item.tooltip = this.commitTooltip(c);
      item.iconPath = new vscode.ThemeIcon('git-commit');
      item.contextValue = 'gbv.commit';
      return item;
    }

    const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.None);
    item.description = node.status;
    item.resourceUri = vscode.Uri.file(node.path);
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'gbv.file';
    item.command = {
      command: 'gitBranchView.native.openCommitFile',
      title: 'Open Changes',
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: CommitTreeNode): Promise<CommitTreeNode[]> {
    if (!node) {
      if (this.compare) {
        return this.compareSections(this.compare);
      }
      const nodes: CommitTreeNode[] = this.commits.map((info) => ({ kind: 'commit', info }));
      if (this.hasMore) {
        nodes.push({ kind: 'loadMore' });
      }
      return nodes;
    }
    if (node.kind === 'section') {
      return node.children;
    }
    if (node.kind === 'commit') {
      const files = await this.getFiles(node.info.hash);
      const parentHash = node.info.parents[0] ?? EMPTY_TREE;
      return files.map((f) => ({
        kind: 'file',
        commitHash: node.info.hash,
        parentHash,
        status: f.status,
        path: f.path,
      }));
    }
    return [];
  }

  /**
   * Compare mode's top level. The file nodes diff merge-base vs. target — the
   * same baseline as the three-dot file list — through the regular
   * openCommitFile command (parentHash = merge-base, commitHash = target).
   */
  private compareSections({ base, target, result }: CompareView): CommitTreeNode[] {
    const commitNodes = (commits: CommitInfo[]): CommitTreeNode[] =>
      commits.map((info) => ({ kind: 'commit', info }));
    return [
      {
        kind: 'section',
        label: `Files changed (${result.files.length})`,
        children: result.files.map((f) => ({
          kind: 'file',
          commitHash: target,
          parentHash: result.mergeBase,
          status: f.status,
          path: f.path,
        })),
      },
      {
        kind: 'section',
        label: `In ${target}, not in ${base} (${result.ahead.length})`,
        children: commitNodes(result.ahead),
      },
      {
        kind: 'section',
        label: `In ${base}, not in ${target} (${result.behind.length})`,
        children: commitNodes(result.behind),
      },
    ];
  }

  private commitTooltip(c: CommitInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    // Commit metadata is untrusted (it comes from the repository). Escape it
    // before composing markdown so a crafted subject/author can't inject a link
    // or image — which the tooltip would render, leaking a hover to an
    // attacker-controlled URL (tracking/phishing). The markdown structure
    // (bold/code) is ours; only the interpolated values are escaped.
    md.appendMarkdown(`**${escapeMarkdown(c.subject)}**\n\n`);
    md.appendMarkdown(`\`${escapeMarkdown(c.hash)}\`\n\n`);
    md.appendMarkdown(`${escapeMarkdown(`${c.authorName} <${c.authorEmail}>`)}\n\n`);
    md.appendText(formatDateTime(c.authorDate));
    return md;
  }
}

/**
 * Backslash-escape the markdown/CommonMark metacharacters that could turn
 * untrusted text into links, images, code, emphasis, autolinks, or raw HTML.
 * Used for repository-derived strings rendered through MarkdownString.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>&!|#~]/g, '\\$&');
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

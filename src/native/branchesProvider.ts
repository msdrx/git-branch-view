import * as vscode from 'vscode';
import { BranchInfo } from '../git/gitService';

/**
 * A node in the Branches tree: either a heading ("Local", or a remote name) or a
 * branch. Remote groups carry their remote name so children can be filtered.
 */
export type BranchTreeNode =
  | { kind: 'group'; label: string; remote?: string }
  | { kind: 'branch'; info: BranchInfo; focused: boolean };

/**
 * The left-hand Branches tree — the native counterpart of the webview's branch
 * pane. Locals sit under a "Local" heading; remote-tracking branches are grouped
 * by remote. The current branch carries a check icon; ahead/behind counts and a
 * "viewing" marker (for the focused ref) show in the item description.
 */
export class BranchesProvider implements vscode.TreeDataProvider<BranchTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private branches: BranchInfo[] = [];
  private focused: string | undefined;

  setBranches(branches: BranchInfo[], focused: string | undefined): void {
    this.branches = branches;
    this.focused = focused;
    this._onDidChange.fire();
  }

  getTreeItem(node: BranchTreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'gbv.group';
      item.iconPath = new vscode.ThemeIcon(node.remote ? 'cloud' : 'repo');
      return item;
    }

    const b = node.info;
    const item = new vscode.TreeItem(this.branchLabel(b), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      b.isHead ? 'check' : b.kind === 'remote' ? 'cloud' : 'git-branch'
    );
    const bits: string[] = [];
    if (b.ahead) {
      bits.push(`↑${b.ahead}`);
    }
    if (b.behind) {
      bits.push(`↓${b.behind}`);
    }
    if (node.focused && !b.isHead) {
      bits.push('viewing');
    }
    item.description = bits.join(' ');
    item.tooltip = this.tooltip(b);
    // Distinct context values drive the right-click menu `when` clauses: the
    // current branch can't be checked out/merged/deleted, and only locals delete.
    item.contextValue = b.isHead
      ? 'gbv.branch.local.current'
      : b.kind === 'remote'
        ? 'gbv.branch.remote'
        : 'gbv.branch.local';
    // Single click views this branch's history (without checking it out).
    item.command = {
      command: 'gitBranchView.native.focusBranch',
      title: 'View History',
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: BranchTreeNode): BranchTreeNode[] {
    if (!node) {
      return this.groups();
    }
    if (node.kind === 'group') {
      const inGroup = node.remote
        ? this.branches.filter((b) => b.kind === 'remote' && this.remoteOf(b) === node.remote)
        : this.branches.filter((b) => b.kind === 'local');
      return inGroup.map((info) => ({
        kind: 'branch',
        info,
        focused: this.focused === info.refName || this.focused === info.name,
      }));
    }
    return [];
  }

  private groups(): BranchTreeNode[] {
    const out: BranchTreeNode[] = [];
    if (this.branches.some((b) => b.kind === 'local')) {
      out.push({ kind: 'group', label: 'Local' });
    }
    const remotes = new Set<string>();
    for (const b of this.branches) {
      if (b.kind === 'remote') {
        remotes.add(this.remoteOf(b));
      }
    }
    for (const r of [...remotes].sort()) {
      out.push({ kind: 'group', label: r, remote: r });
    }
    return out;
  }

  private remoteOf(b: BranchInfo): string {
    return b.name.split('/')[0];
  }

  private branchLabel(b: BranchInfo): string {
    if (b.kind === 'remote') {
      const remote = this.remoteOf(b);
      return b.name.startsWith(remote + '/') ? b.name.slice(remote.length + 1) : b.name;
    }
    return b.name;
  }

  private tooltip(b: BranchInfo): string {
    const lines = [b.name, b.commit.slice(0, 12)];
    if (b.upstream) {
      lines.push(`upstream: ${b.upstream}`);
    }
    if (b.ahead || b.behind) {
      lines.push(`ahead ${b.ahead ?? 0}, behind ${b.behind ?? 0}`);
    }
    if (b.isHead) {
      lines.push('(current branch)');
    }
    return lines.join('\n');
  }
}

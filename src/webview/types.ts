/**
 * Shared types for the webview. The data shapes mirror what the extension host
 * sends (see src/git/gitService.ts and src/panel/branchViewPanel.ts) — the
 * two processes share no code at runtime, only this message contract.
 */

export interface Branch {
  /** Full ref name, e.g. refs/heads/main or refs/remotes/origin/main. */
  refName: string;
  /** Short, human-friendly name, e.g. main or origin/main. */
  name: string;
  commit: string;
  kind: 'local' | 'remote';
  upstream?: string;
  ahead?: number;
  behind?: number;
  isHead: boolean;
  /** Full-ref selection identity in the tree (computed webview-side). */
  refShort: string;
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601 author date. */
  authorDate: string;
  subject: string;
  /** Decoration refs attached to this commit (branch names). */
  refs: string[];
}

export interface Tracking {
  ahead: number;
  behind: number;
  upstream?: string;
}

export interface FileChange {
  status: string;
  /** New/current path. For renames/copies, this is the destination path. */
  path: string;
  /** Original path for rename/copy records. */
  oldPath?: string;
}

export interface CommitDetail {
  commit: Commit;
  body: string;
  files: FileChange[];
}

export interface CompareResult {
  /** Commits in `target` not in `base`. */
  ahead: Commit[];
  /** Commits in `base` not in `target`. */
  behind: Commit[];
  files: FileChange[];
  /**
   * Merge-base of the two refs. The file list is a three-dot diff
   * (base...target), so per-file diffs use this as their left side.
   */
  mergeBase: string;
}

export type PullStrategy = 'merge' | 'rebase' | 'ff-only';

/** How commit dates render in the Date column (`gitBranchView.dateFormat`). */
export type DateFormat = 'relative' | 'iso' | 'local';

/** Human labels for the pull strategies, keyed by the stored config value. */
export const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'ff-only': 'Fast-forward only',
};

export type ColumnKey = 'branch' | 'message' | 'author' | 'date' | 'id';
export type ColumnWidths = Partial<Record<ColumnKey, number>>;

// ---------------------------------------------------------------- messages

/** Host → webview. */
export type HostMessage =
  | {
      type: 'data';
      branches: Omit<Branch, 'refShort'>[];
      commits: Commit[];
      tracking: Tracking;
      current: string;
      focused: string | null;
      pullStrategy?: PullStrategy;
      dateFormat?: DateFormat;
      columnWidths?: ColumnWidths;
      /** True when more history exists beyond the commits sent. */
      hasMore?: boolean;
    }
  | { type: 'branchCommits'; ref: string; commits: Commit[]; hasMore?: boolean }
  /**
   * Next page of the focused ref's history (response to `moreCommits`). `ref`
   * is the history scope the page belongs to (the focused ref, or null when
   * following `--all`); the webview drops the page if that scope no longer
   * matches the list it currently holds.
   */
  | { type: 'moreCommits'; ref: string | null; skip: number; commits: Commit[]; hasMore: boolean }
  | { type: 'commitDetail'; detail: CommitDetail }
  | { type: 'compareResult'; base: string; target: string; result: CompareResult }
  | { type: 'repo'; root: string }
  | { type: 'error'; message: string };

/** Webview → host. */
export type WebviewMessage =
  /** `pageSize` is the viewport-derived page (≈2× visible rows); the host
   *  remembers it for every later load. */
  | { type: 'ready'; reset?: boolean; pageSize?: number }
  | { type: 'refresh' }
  | { type: 'selectBranch'; ref: string }
  /**
   * Ask for the next page of the focused history, starting at `skip`. `ref`
   * is the history scope currently shown, so the host fetches the same history
   * even if the user switches branches before this message is handled.
   */
  | { type: 'moreCommits'; ref: string | null; skip: number }
  | { type: 'commitDetail'; hash: string }
  | { type: 'openFileDiff'; hash: string; parent: string | null; path: string; oldPath?: string }
  | { type: 'compare'; base: string; target: string }
  | { type: 'checkout'; branch: string }
  | { type: 'createBranch'; startPoint?: string }
  | { type: 'deleteBranch'; branch: string }
  | { type: 'merge'; branch: string }
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push' }
  | { type: 'setPullStrategy'; strategy: PullStrategy }
  | { type: 'setColumnWidths'; widths: ColumnWidths };

/**
 * The webview's single state container + reducer. Host messages and UI
 * interactions are both expressed as actions, so the whole data flow is a
 * pure function that unit tests can drive without React.
 */
import type {
  Branch,
  ColumnWidths,
  Commit,
  CommitDetail,
  CompareResult,
  DateFormat,
  HostMessage,
  PullStrategy,
  Tracking,
} from './types';

export interface MenuPosition {
  x: number;
  y: number;
}

/** What a context menu was opened on; the menu component builds items from it. */
export type MenuTarget =
  | { type: 'branch'; branch: Branch }
  | { type: 'commit'; commit: Commit }
  | { type: 'pullStrategy' };

export interface MenuState extends MenuPosition {
  target: MenuTarget;
}

/** An active branch comparison: files in the left Changes pane, ahead/behind
 *  commits in the right list (replacing the focused branch's history). */
export type CompareState = {
  base: string;
  target: string;
  result: CompareResult;
};

interface PendingCompare {
  base: string;
  target: string;
}

export interface AppState {
  branches: Branch[];
  commits: Commit[];
  tracking: Tracking;
  current: string;
  /** Full ref name of the selected tree node (see Branch.refShort). */
  selectedRef: string | null;
  /** Plain ref name of the selected branch (shown in the right header). */
  selectedName: string | null;
  selectedHash: string | null;
  /**
   * Ref scope the currently loaded `commits` belong to (the focused ref, or
   * null when following `--all`). Mirrors the host's notion of the focused
   * history so a late `moreCommits` page for a now-abandoned branch is dropped
   * instead of being appended to the wrong list.
   */
  historyRef: string | null;
  /** Commit detail request currently in flight, used to drop stale responses. */
  pendingCommitHash: string | null;
  /** Collapsed tree groups, keyed by group key. */
  collapsed: Record<string, boolean>;
  /** Base ref while compare mode is armed, else null. */
  compareBase: string | null;
  /** Compare request currently in flight, used to drop stale host responses. */
  pendingCompare: PendingCompare | null;
  pullStrategy: PullStrategy;
  /** How commit dates render in the Date column (from the host config). */
  dateFormat: DateFormat;
  columnWidths: ColumnWidths;
  menu: MenuState | null;
  /** Active branch comparison, or null when showing branch history. */
  compare: CompareState | null;
  /** Detail of the selected commit, shown as a file tree in the left pane. */
  commitFiles: CommitDetail | null;
  /** Path of the selected file in the changed-files tree. */
  selectedFile: string | null;
  /** True when more history exists beyond the loaded commits. */
  hasMore: boolean;
  /** True while the next page is in flight (suppresses duplicate requests). */
  loadingMore: boolean;
  error: string | null;
}

export const initialState: AppState = {
  branches: [],
  commits: [],
  tracking: { ahead: 0, behind: 0 },
  current: '',
  selectedRef: null,
  selectedName: null,
  selectedHash: null,
  historyRef: null,
  pendingCommitHash: null,
  collapsed: {},
  compareBase: null,
  pendingCompare: null,
  pullStrategy: 'merge',
  dateFormat: 'local',
  columnWidths: {},
  menu: null,
  compare: null,
  commitFiles: null,
  selectedFile: null,
  hasMore: false,
  loadingMore: false,
  error: null,
};

export type Action =
  | { type: 'host'; msg: HostMessage }
  | { type: 'ui/selectBranch'; branch: Branch }
  | { type: 'ui/selectCommit'; hash: string }
  | { type: 'ui/toggleGroup'; key: string }
  | { type: 'ui/setCompareBase'; base: string | null }
  | { type: 'ui/requestCompare'; base: string; target: string }
  | { type: 'ui/openMenu'; menu: MenuState }
  | { type: 'ui/closeMenu' }
  | { type: 'ui/closeCompare' }
  | { type: 'ui/selectFile'; path: string }
  | { type: 'ui/closeFiles' }
  | { type: 'ui/setColumnWidths'; widths: ColumnWidths }
  /** The next history page was requested from the host. */
  | { type: 'ui/loadingMore' };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'host':
      return handleHostMessage(state, action.msg);
    case 'ui/selectBranch':
      // Picking a branch returns to its history view, ending any comparison.
      // Paging pauses (hasMore false) until the new history's first page
      // arrives, so a late scroll can't append the old branch's commits.
      // The header's incoming/outgoing counts move to the picked branch right
      // away, from its own tracking data (the same for-each-ref counts the host
      // sends in `data`), instead of lingering on the previous branch until the
      // next full refresh.
      return {
        ...state,
        selectedRef: action.branch.refShort,
        selectedName: action.branch.name,
        // The history scope moves to the picked branch immediately so a late
        // page for the previous branch is rejected even before its first page
        // (branchCommits) arrives.
        historyRef: action.branch.refName,
        tracking: {
          ahead: action.branch.ahead ?? 0,
          behind: action.branch.behind ?? 0,
          upstream: action.branch.upstream,
        },
        selectedHash: null,
        pendingCommitHash: null,
        compare: null,
        commitFiles: null,
        selectedFile: null,
        pendingCompare: null,
        hasMore: false,
        loadingMore: false,
      };
    case 'ui/selectCommit':
      return {
        ...state,
        selectedHash: action.hash,
        pendingCommitHash: action.hash,
        commitFiles: null,
        selectedFile: null,
      };
    case 'ui/toggleGroup':
      return {
        ...state,
        collapsed: { ...state.collapsed, [action.key]: !state.collapsed[action.key] },
      };
    case 'ui/setCompareBase':
      return { ...state, compareBase: action.base, pendingCompare: null };
    case 'ui/requestCompare':
      return { ...state, pendingCompare: { base: action.base, target: action.target } };
    case 'ui/openMenu':
      return { ...state, menu: action.menu };
    case 'ui/closeMenu':
      return state.menu ? { ...state, menu: null } : state;
    case 'ui/closeCompare':
      // Dismiss the whole comparison (Escape): files pane and commit sections.
      return state.compare
        ? { ...state, compare: null, commitFiles: null, selectedFile: null }
        : state;
    case 'ui/selectFile':
      return { ...state, selectedFile: action.path };
    case 'ui/closeFiles':
      // ✕ on the Changes pane: drop a commit's files first (falling back to
      // the compare files underneath, if any), else end the comparison.
      if (state.commitFiles) {
        return { ...state, commitFiles: null, selectedFile: null };
      }
      return state.compare ? { ...state, compare: null, selectedFile: null } : state;
    case 'ui/setColumnWidths':
      return { ...state, columnWidths: action.widths };
    case 'ui/loadingMore':
      return { ...state, loadingMore: true };
    default:
      return state;
  }
}

function handleHostMessage(state: AppState, msg: HostMessage): AppState {
  switch (msg.type) {
    case 'data': {
      // Pre-compute a stable ref identifier for selection tracking.
      const branches: Branch[] = msg.branches.map((b) => ({
        ...b,
        refShort: b.refName,
      }));
      const next: AppState = {
        ...state,
        branches,
        commits: msg.commits,
        // This payload's commits are the focused history; adopt its scope so
        // later pages are matched against the right ref.
        historyRef: msg.focused,
        tracking: msg.tracking,
        current: msg.current,
        pullStrategy: msg.pullStrategy ?? state.pullStrategy,
        dateFormat: msg.dateFormat ?? state.dateFormat,
        columnWidths: msg.columnWidths ?? state.columnWidths,
        hasMore: msg.hasMore ?? false,
        loadingMore: false,
        error: null,
      };
      // Move the tree highlight and right-side header onto the ref whose
      // history is shown (the current branch by default, or one just checked
      // out — including from a terminal).
      if (msg.focused) {
        const fb = branches.find((b) => b.refName === msg.focused || b.name === msg.focused);
        next.selectedRef = fb ? fb.refShort : null;
        next.selectedName = fb ? fb.name : msg.focused;
        next.selectedHash = null;
      }
      return next;
    }
    case 'branchCommits':
      if (state.selectedRef !== msg.ref) {
        return { ...state, loadingMore: false };
      }
      return {
        ...state,
        commits: msg.commits,
        // This branch's first page defines the scope for its later pages.
        historyRef: msg.ref,
        hasMore: msg.hasMore ?? false,
        loadingMore: false,
        selectedHash: null,
        pendingCommitHash: null,
        commitFiles: null,
        selectedFile: null,
        error: null,
      };
    case 'moreCommits':
      // Append the next page. A stale page is dropped instead of corrupting the
      // graph — either its `skip` doesn't line up with the commits we hold (the
      // list was replaced while it was in flight) or its `ref` scope no longer
      // matches the focused history (the user switched branches, possibly to one
      // with the same loaded length).
      if (msg.skip !== state.commits.length || msg.ref !== state.historyRef) {
        return { ...state, loadingMore: false };
      }
      return {
        ...state,
        commits: [...state.commits, ...msg.commits],
        hasMore: msg.hasMore,
        loadingMore: false,
        error: null,
      };
    case 'commitDetail':
      if (state.pendingCommitHash !== msg.detail.commit.hash) {
        return state;
      }
      // Shown as the changed-files tree under the branch tree; selecting a
      // file there opens its diff in a split editor beside the panel. A newly
      // selected commit resets the file selection.
      return { ...state, commitFiles: msg.detail, selectedFile: null, pendingCommitHash: null };
    case 'compareResult':
      if (
        !state.pendingCompare ||
        state.pendingCompare.base !== msg.base ||
        state.pendingCompare.target !== msg.target
      ) {
        return state;
      }
      // Enter compare mode: the files render in the left Changes pane, the
      // ahead/behind commits replace the right list. Any commit detail shown
      // before is dropped so the pane shows the comparison's files.
      return {
        ...state,
        compare: { base: msg.base, target: msg.target, result: msg.result },
        compareBase: null,
        pendingCompare: null,
        commitFiles: null,
        selectedFile: null,
        selectedHash: null,
        pendingCommitHash: null,
        // hasMore is left alone: the underlying branch history (and its
        // paging) comes back when the comparison is dismissed. The scroll
        // handler doesn't request pages while compare mode is showing.
      };
    case 'error':
      return { ...state, error: msg.message };
    case 'repo':
    default:
      return state;
  }
}

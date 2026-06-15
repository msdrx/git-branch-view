import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialState, reducer, type MenuTarget } from './state';
import type { Branch, Commit, ColumnWidths, FileChange, HostMessage } from './types';
import { post } from './vscodeApi';
import { ROW_H } from './graph';
import { Toolbar } from './components/Toolbar';
import { BranchPane, type ChangesView } from './components/BranchPane';
import { RightHeader } from './components/RightHeader';
import { CommitList } from './components/CommitList';
import { ContextMenu } from './components/ContextMenu';
import { displayRefName } from './format';

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Latest compare base for handlers that outlive a render.
  const compareBaseRef = useRef(state.compareBase);
  compareBaseRef.current = state.compareBase;

  // ----------------------------------------------------- host message bridge
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      dispatch({ type: 'host', msg: event.data });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Tell the extension we're ready for the first data payload. The page size
  // (≈2× the rows that fit the window) tells the host how much history to
  // load up front and per scroll page.
  useEffect(() => {
    post({ type: 'ready', pageSize: commitPageSize() });
  }, []);

  // Reload whenever the user clicks/focuses back into the panel. This is the
  // one trigger that catches changes made outside the panel while VS Code
  // stays put — e.g. a `git checkout` in the integrated terminal: the window
  // never loses OS focus and the panel stays visible, so the host's
  // onDidChangeWindowState/onDidChangeViewState never fire. The webview
  // window, however, does receive a focus event when you click back into it.
  useEffect(() => {
    let lastRefresh = Date.now(); // suppress a duplicate right after initial load
    const requestRefresh = () => {
      const now = Date.now();
      if (now - lastRefresh < 300) {
        return; // throttle rapid focus/blur toggling
      }
      lastRefresh = now;
      post({ type: 'refresh' });
    };
    window.addEventListener('focus', requestRefresh);
    return () => window.removeEventListener('focus', requestRefresh);
  }, []);

  // Relative date labels ("just now", "5 minutes ago") are derived from
  // Date.now() at render time, so without a periodic nudge they freeze at the
  // value computed when the data last arrived. While that format is active,
  // tick once a minute to re-render and refresh them. Absolute formats never go
  // stale, so they get no timer.
  const [, tickClock] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (state.dateFormat !== 'relative') {
      return;
    }
    const id = window.setInterval(tickClock, 60_000);
    return () => window.clearInterval(id);
  }, [state.dateFormat]);

  // Close the context menu on any click or scroll, the compare+menu on Escape.
  useEffect(() => {
    const closeMenu = () => dispatch({ type: 'ui/closeMenu' });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'ui/closeMenu' });
        dispatch({ type: 'ui/closeCompare' });
      }
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeMenu, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // ------------------------------------------------------------ interactions
  const openMenu = useCallback((e: React.MouseEvent, target: MenuTarget) => {
    dispatch({ type: 'ui/openMenu', menu: { x: e.clientX, y: e.clientY, target } });
  }, []);

  const onSelectBranch = useCallback((b: Branch) => {
    // While compare mode is armed, clicking another branch runs the compare.
    const base = compareBaseRef.current;
    if (base && b.refName !== base) {
      dispatch({ type: 'ui/requestCompare', base, target: b.refName });
      post({ type: 'compare', base, target: b.refName });
      return;
    } else if (base) {
      dispatch({ type: 'ui/setCompareBase', base: null });
      return;
    }
    dispatch({ type: 'ui/selectBranch', branch: b });
    post({ type: 'selectBranch', ref: b.refName });
  }, []);

  // Selecting a commit asks the host for its detail; the response fills the
  // changed-files tree below the branch tree.
  const onSelectCommit = useCallback((c: Commit) => {
    dispatch({ type: 'ui/selectCommit', hash: c.hash });
    post({ type: 'commitDetail', hash: c.hash });
  }, []);

  // Latest changed-files detail / comparison for the stable file-click handler.
  const commitFilesRef = useRef(state.commitFiles);
  commitFilesRef.current = state.commitFiles;
  const compareRef = useRef(state.compare);
  compareRef.current = state.compare;

  // Latest list/selection for the arrow-key handler (it outlives a render).
  const commitsRef = useRef(state.commits);
  commitsRef.current = state.commits;
  const selectedHashRef = useRef(state.selectedHash);
  selectedHashRef.current = state.selectedHash;
  const selectedFileRef = useRef(state.selectedFile);
  selectedFileRef.current = state.selectedFile;

  // Up/Down arrows move the commit selection (instead of scrolling the list);
  // in compare mode they walk the ahead+behind sections as one list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }
      if (selectedFileRef.current !== null) {
        return; // a selected changed file hands the arrows to the Changes pane
      }
      const compare = compareRef.current;
      const list = compare
        ? [...compare.result.ahead, ...compare.result.behind]
        : commitsRef.current;
      if (!list.length) {
        return;
      }
      e.preventDefault();
      const idx = list.findIndex((c) => c.hash === selectedHashRef.current);
      // No selection yet (idx -1): either arrow starts at the first commit.
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(list.length - 1, idx + 1)
          : Math.max(0, idx === -1 ? 0 : idx - 1);
      const next = list[nextIdx];
      if (next && next.hash !== selectedHashRef.current) {
        onSelectCommit(next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSelectCommit]);

  // Selecting a changed file opens VS Code's real diff editor in a split
  // beside the panel, host-side: commit vs. first parent for a commit's
  // files, merge-base vs. target for a comparison's files.
  const onSelectFile = useCallback((f: FileChange) => {
    const detail = commitFilesRef.current;
    const compare = compareRef.current;
    dispatch({ type: 'ui/selectFile', path: f.path });
    if (detail) {
      post({
        type: 'openFileDiff',
        hash: detail.commit.hash,
        parent: detail.commit.parents[0] ?? null,
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      });
    } else if (compare) {
      post({
        type: 'openFileDiff',
        hash: compare.target,
        parent: compare.result.mergeBase,
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      });
    }
  }, []);

  const onCommitMenu = useCallback(
    (e: React.MouseEvent, c: Commit) => {
      dispatch({ type: 'ui/selectCommit', hash: c.hash });
      openMenu(e, { type: 'commit', commit: c });
    },
    [openMenu]
  );

  const onToggleCompare = useCallback(() => {
    dispatch({
      type: 'ui/setCompareBase',
      base: compareBaseRef.current ? null : selectedOrCurrentRef.current,
    });
  }, []);
  // selected ref ?? current branch, kept in a ref for the stable toolbar callback.
  const selectedOrCurrentRef = useRef('');
  selectedOrCurrentRef.current =
    state.selectedRef || state.branches.find((b) => b.isHead && b.name === state.current)?.refName || state.current;

  const onColumnWidths = useCallback((widths: ColumnWidths) => {
    dispatch({ type: 'ui/setColumnWidths', widths });
    post({ type: 'setColumnWidths', widths });
  }, []);

  // Latest paging state for the stable scroll handler.
  const pagingRef = useRef({ hasMore: state.hasMore, loadingMore: state.loadingMore });
  pagingRef.current = { hasMore: state.hasMore, loadingMore: state.loadingMore };

  // Scroll approached the bottom of the commit list: page in more history.
  const onLoadMore = useCallback(() => {
    const { hasMore, loadingMore } = pagingRef.current;
    if (!hasMore || loadingMore) {
      return;
    }
    dispatch({ type: 'ui/loadingMore' });
    post({ type: 'moreCommits', skip: commitsRef.current.length });
  }, []);

  // Left/right split drag.
  const leftWrapRef = useRef<HTMLDivElement>(null);
  const startDividerDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const left = leftWrapRef.current?.querySelector<HTMLElement>('#left');
      if (left) {
        left.style.width = `${Math.max(150, Math.min(600, ev.clientX))}px`;
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // Whether the viewed ref is the checked-out branch — gates the HEAD-only
  // Pull/Push/Sync actions. Match on the *full* ref of the head branch, not the
  // short name: a local branch and a remote branch can share a short name (e.g.
  // a local `origin/main` vs `refs/remotes/origin/main`), and a short-name match
  // would wrongly enable those actions while a different ref is on screen. With
  // no branch node selected (selectedRef null) the header shows the current
  // branch, so fall back to the name check there.
  const headRef = state.branches.find((b) => b.isHead)?.refShort ?? null;
  const isViewingCurrentBranch =
    !state.compare &&
    (state.selectedRef !== null
      ? state.selectedRef === headRef
      : !state.selectedName || state.selectedName === state.current);

  // What the left Changes pane shows: a clicked commit's files take
  // precedence; underneath them sit the active comparison's files.
  const changes: ChangesView | null = state.commitFiles
    ? {
        label: (
          <>
            <span className="mono">{state.commitFiles.commit.shortHash}</span>{' '}
            {state.commitFiles.commit.subject}
          </>
        ),
        tooltip: `${state.commitFiles.commit.shortHash} ${state.commitFiles.commit.subject}`,
        files: state.commitFiles.files,
      }
    : state.compare
      ? {
          label: `${displayRefName(state.compare.base)} ⇄ ${displayRefName(state.compare.target)}`,
          tooltip: `Compare ${displayRefName(state.compare.base)} ⇄ ${displayRefName(
            state.compare.target
          )}`,
          files: state.compare.result.files,
        }
      : null;

  return (
    <div id="app">
      <Toolbar
        compareBase={state.compareBase}
        pullStrategy={state.pullStrategy}
        onToggleCompare={onToggleCompare}
        onPullStrategyMenu={(e) => {
          e.stopPropagation(); // keep the document click handler from closing it
          openMenu(e, { type: 'pullStrategy' });
        }}
      />
      <div id="split" ref={leftWrapRef}>
        <BranchPane
          branches={state.branches}
          selectedRef={state.selectedRef}
          collapsed={state.collapsed}
          changes={changes}
          selectedFile={state.selectedFile}
          onToggleGroup={(key) => dispatch({ type: 'ui/toggleGroup', key })}
          onSelect={onSelectBranch}
          onBranchMenu={(e, b) => openMenu(e, { type: 'branch', branch: b })}
          onSelectFile={onSelectFile}
          onCloseFiles={() => dispatch({ type: 'ui/closeFiles' })}
        />
        <div id="divider" onMouseDown={startDividerDrag} />
        <div id="right">
          <RightHeader
            branchName={state.selectedName || state.current}
            tracking={state.tracking}
            compare={state.compare}
            isCurrentBranch={isViewingCurrentBranch}
          />
          <CommitList
            commits={state.commits}
            current={state.current}
            selectedHash={state.selectedHash}
            columnWidths={state.columnWidths}
            dateFormat={state.dateFormat}
            compare={state.compare}
            error={state.error}
            hasMore={state.hasMore}
            loadingMore={state.loadingMore}
            onSelectCommit={onSelectCommit}
            onCommitMenu={onCommitMenu}
            onColumnWidths={onColumnWidths}
            onLoadMore={onLoadMore}
          />
        </div>
      </div>
      <ContextMenu
        menu={state.menu}
        current={state.current}
        pullStrategy={state.pullStrategy}
        onClose={() => dispatch({ type: 'ui/closeMenu' })}
        onCompareFrom={(base) => dispatch({ type: 'ui/setCompareBase', base })}
      />
    </div>
  );
}

/**
 * Commits per history page: twice the rows that fit the window, so the
 * initial load fills the viewport with headroom and each scroll page stays
 * cheap. The window height stands in for the list's own (the list isn't laid
 * out yet when `ready` is sent). The Refresh button's `ready` omits the page
 * size — the host keeps the one sent here.
 */
function commitPageSize(): number {
  return Math.max(50, Math.ceil(window.innerHeight / ROW_H) * 2);
}

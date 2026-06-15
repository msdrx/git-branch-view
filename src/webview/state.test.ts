import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppState } from './state';
import type { Branch, Commit, HostMessage } from './types';

const branch = (over: Partial<Omit<Branch, 'refShort'>>): Omit<Branch, 'refShort'> => {
  const name = over.name ?? 'main';
  const kind = over.kind ?? 'local';
  return {
    refName: over.refName ?? (kind === 'remote' ? `refs/remotes/${name}` : `refs/heads/${name}`),
    name,
    commit: 'abc',
    kind,
    isHead: false,
    ...over,
  };
};

const commit = (hash: string): Commit => ({
  hash,
  shortHash: hash.slice(0, 8),
  parents: [],
  authorName: 'A',
  authorEmail: 'a@example.com',
  authorDate: '2026-01-01T00:00:00+00:00',
  subject: 's',
  refs: [],
});

const dataMsg = (over: Partial<Extract<HostMessage, { type: 'data' }>> = {}) =>
  ({
    type: 'data',
    branches: [branch({ name: 'main', isHead: true }), branch({ name: 'dev' })],
    commits: [commit('c1')],
    tracking: { ahead: 1, behind: 2 },
    current: 'main',
    focused: 'main',
    ...over,
  }) as HostMessage;

const host = (state: AppState, msg: HostMessage) => reducer(state, { type: 'host', msg });

describe('reducer: host messages', () => {
  it('adopts a data payload and computes refShort identifiers', () => {
    const s = host(initialState, dataMsg());
    expect(s.branches.map((b) => b.refShort)).toEqual(['refs/heads/main', 'refs/heads/dev']);
    expect(s.current).toBe('main');
    expect(s.tracking).toEqual({ ahead: 1, behind: 2 });
    expect(s.commits).toHaveLength(1);
  });

  it('moves the selection onto the focused ref', () => {
    const s = host(initialState, dataMsg({ focused: 'dev' }));
    expect(s.selectedRef).toBe('refs/heads/dev');
    expect(s.selectedName).toBe('dev');
    expect(s.selectedHash).toBeNull();
  });

  it('keeps the focused name even when no branch matches (e.g. detached ref)', () => {
    const s = host(initialState, dataMsg({ focused: 'gone' }));
    expect(s.selectedRef).toBeNull();
    expect(s.selectedName).toBe('gone');
  });

  it('preserves the previous selection when focused is null', () => {
    let s = host(initialState, dataMsg({ focused: 'dev' }));
    s = host(s, dataMsg({ focused: null }));
    expect(s.selectedName).toBe('dev');
  });

  it('keeps pullStrategy/columnWidths when the payload omits them', () => {
    let s = host(initialState, dataMsg({ pullStrategy: 'rebase', columnWidths: { date: 200 } }));
    s = host(s, dataMsg());
    expect(s.pullStrategy).toBe('rebase');
    expect(s.columnWidths).toEqual({ date: 200 });
  });

  it('clears a previous error on fresh data', () => {
    let s = host(initialState, { type: 'error', message: 'boom' });
    expect(s.error).toBe('boom');
    s = host(s, dataMsg());
    expect(s.error).toBeNull();
  });

  it('replaces commits on branchCommits without touching branches', () => {
    let s = host(initialState, dataMsg());
    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    s = host(s, { type: 'branchCommits', ref: 'refs/heads/dev', commits: [commit('x'), commit('y')] });
    expect(s.commits).toHaveLength(2);
    expect(s.branches).toHaveLength(2);
  });

  it('clears stale commit detail when branchCommits replaces the history', () => {
    let s = host(initialState, dataMsg());
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    s = reducer(s, { type: 'ui/selectFile', path: 'src/a.ts' });

    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    s = host(s, { type: 'branchCommits', ref: 'refs/heads/dev', commits: [commit('x')] });

    expect(s.selectedHash).toBeNull();
    expect(s.commitFiles).toBeNull();
    expect(s.selectedFile).toBeNull();
  });

  it('tracks hasMore from data and branchCommits payloads', () => {
    let s = host(initialState, dataMsg({ hasMore: true }));
    expect(s.hasMore).toBe(true);
    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    s = host(s, { type: 'branchCommits', ref: 'refs/heads/dev', commits: [commit('x')] });
    expect(s.hasMore).toBe(false); // omitted means no more pages
  });

  it('appends a moreCommits page and clears the in-flight flag', () => {
    let s = host(initialState, dataMsg({ hasMore: true }));
    s = reducer(s, { type: 'ui/loadingMore' });
    expect(s.loadingMore).toBe(true);
    s = host(s, { type: 'moreCommits', skip: 1, commits: [commit('x'), commit('y')], hasMore: true });
    expect(s.commits.map((c) => c.hash)).toEqual(['c1', 'x', 'y']);
    expect(s.hasMore).toBe(true);
    expect(s.loadingMore).toBe(false);
  });

  it('drops a stale moreCommits page whose skip does not match the loaded list', () => {
    let s = host(initialState, dataMsg({ hasMore: true }));
    s = reducer(s, { type: 'ui/loadingMore' });
    // The list was replaced (length 1) while a page for skip=50 was in flight.
    s = host(s, { type: 'moreCommits', skip: 50, commits: [commit('x')], hasMore: true });
    expect(s.commits.map((c) => c.hash)).toEqual(['c1']);
    expect(s.loadingMore).toBe(false);
  });

  it('pauses paging while a branch switch is in flight', () => {
    let s = host(initialState, dataMsg({ hasMore: true }));
    s = reducer(s, {
      type: 'ui/selectBranch',
      branch: { ...branch({ name: 'dev' }), refShort: 'local:dev' },
    });
    expect(s.hasMore).toBe(false);
    s = host(s, { type: 'branchCommits', ref: 'local:dev', commits: [commit('x')], hasMore: true });
    expect(s.hasMore).toBe(true);
  });

  it('drops branchCommits that do not match the current selected ref', () => {
    let s = host(initialState, dataMsg());
    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    s = host(s, {
      type: 'branchCommits',
      ref: 'refs/heads/main',
      commits: [commit('stale')],
      hasMore: true,
    });
    expect(s.commits.map((c) => c.hash)).toEqual(['c1']);
    expect(s.loadingMore).toBe(false);
  });

  it('fills the changed-files pane on commitDetail and resets the file selection', () => {
    let s = reducer(initialState, { type: 'ui/selectFile', path: 'stale.txt' });
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    expect(s.commitFiles?.commit.hash).toBe('c1');
    expect(s.commitFiles?.files).toEqual([{ status: 'M', path: 'src/a.ts' }]);
    expect(s.selectedFile).toBeNull();
  });

  it('drops commitDetail responses that do not match the pending request', () => {
    let s = reducer(initialState, { type: 'ui/selectCommit', hash: 'c1' });
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c2' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'stale.ts' }] },
    });
    expect(s.commitFiles).toBeNull();
    expect(s.selectedHash).toBe('c2');
  });

  it('keeps an in-flight commit detail request across a data refresh', () => {
    let s = host(initialState, dataMsg());
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, dataMsg({ focused: null }));
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    expect(s.commitFiles?.commit.hash).toBe('c1');
  });

  it('enters compare mode and disarms the compare base on compareResult', () => {
    let s = reducer(initialState, { type: 'ui/setCompareBase', base: 'main' });
    s = reducer(s, { type: 'ui/requestCompare', base: 'main', target: 'dev' });
    s = host(s, {
      type: 'compareResult',
      base: 'main',
      target: 'dev',
      result: { ahead: [commit('a1')], behind: [], files: [], mergeBase: 'mb' },
    });
    expect(s.compare?.base).toBe('main');
    expect(s.compare?.target).toBe('dev');
    expect(s.compare?.result.mergeBase).toBe('mb');
    expect(s.compareBase).toBeNull();
  });

  it('drops compareResult responses that do not match the pending compare', () => {
    let s = reducer(initialState, {
      type: 'ui/requestCompare',
      base: 'refs/heads/main',
      target: 'refs/heads/newer',
    });
    s = host(s, {
      type: 'compareResult',
      base: 'refs/heads/main',
      target: 'refs/heads/older',
      result: { ahead: [commit('old')], behind: [], files: [], mergeBase: 'mb' },
    });
    expect(s.compare).toBeNull();
    expect(s.pendingCompare).toEqual({
      base: 'refs/heads/main',
      target: 'refs/heads/newer',
    });
  });

  it('keeps an in-flight compare request across a data refresh', () => {
    let s = reducer(initialState, {
      type: 'ui/requestCompare',
      base: 'refs/heads/main',
      target: 'refs/heads/dev',
    });
    s = host(s, dataMsg({ focused: null }));
    s = host(s, {
      type: 'compareResult',
      base: 'refs/heads/main',
      target: 'refs/heads/dev',
      result: { ahead: [], behind: [commit('b1')], files: [], mergeBase: 'mb' },
    });
    expect(s.compare?.base).toBe('refs/heads/main');
    expect(s.compare?.target).toBe('refs/heads/dev');
  });

  it('drops a previously shown commit detail when a comparison arrives', () => {
    let s = reducer(initialState, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    s = reducer(s, { type: 'ui/selectFile', path: 'src/a.ts' });
    s = reducer(s, { type: 'ui/requestCompare', base: 'main', target: 'dev' });
    s = host(s, {
      type: 'compareResult',
      base: 'main',
      target: 'dev',
      result: { ahead: [], behind: [], files: [], mergeBase: 'mb' },
    });
    expect(s.commitFiles).toBeNull();
    expect(s.selectedFile).toBeNull();
  });
});

describe('reducer: UI actions', () => {
  it('selects a branch and clears the commit selection', () => {
    let s = host(initialState, dataMsg());
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c1' });
    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    expect(s.selectedRef).toBe('refs/heads/dev');
    expect(s.selectedHash).toBeNull();
  });

  it('toggles tree groups', () => {
    let s = reducer(initialState, { type: 'ui/toggleGroup', key: 'remote:origin' });
    expect(s.collapsed['remote:origin']).toBe(true);
    s = reducer(s, { type: 'ui/toggleGroup', key: 'remote:origin' });
    expect(s.collapsed['remote:origin']).toBe(false);
  });

  it('opens and closes the context menu', () => {
    let s = reducer(initialState, {
      type: 'ui/openMenu',
      menu: { x: 10, y: 20, target: { type: 'pullStrategy' } },
    });
    expect(s.menu?.x).toBe(10);
    s = reducer(s, { type: 'ui/closeMenu' });
    expect(s.menu).toBeNull();
  });

  it('closes the comparison on closeCompare (Escape)', () => {
    let s = reducer(initialState, { type: 'ui/requestCompare', base: 'main', target: 'dev' });
    s = host(s, {
      type: 'compareResult',
      base: 'main',
      target: 'dev',
      result: { ahead: [], behind: [], files: [], mergeBase: 'mb' },
    });
    expect(s.compare).not.toBeNull();
    s = reducer(s, { type: 'ui/closeCompare' });
    expect(s.compare).toBeNull();
  });

  it('selecting a branch ends the comparison', () => {
    let s = host(initialState, dataMsg());
    s = host(s, {
      type: 'compareResult',
      base: 'main',
      target: 'dev',
      result: { ahead: [], behind: [], files: [], mergeBase: 'mb' },
    });
    s = reducer(s, { type: 'ui/selectBranch', branch: s.branches[1] });
    expect(s.compare).toBeNull();
  });

  it('closeFiles peels a commit detail first, then the comparison', () => {
    let s = reducer(initialState, { type: 'ui/requestCompare', base: 'main', target: 'dev' });
    s = host(s, {
      type: 'compareResult',
      base: 'main',
      target: 'dev',
      result: { ahead: [], behind: [], files: [{ status: 'M', path: 'a.ts' }], mergeBase: 'mb' },
    });
    // Clicking a compare commit shows its files on top of the comparison.
    s = reducer(s, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    s = reducer(s, { type: 'ui/closeFiles' });
    expect(s.commitFiles).toBeNull();
    expect(s.compare).not.toBeNull(); // back to the comparison's files
    s = reducer(s, { type: 'ui/closeFiles' });
    expect(s.compare).toBeNull();
  });

  it('tracks the selected changed file', () => {
    let s = reducer(initialState, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    s = reducer(s, { type: 'ui/selectFile', path: 'src/a.ts' });
    expect(s.selectedFile).toBe('src/a.ts');
  });

  it('closes the changed-files pane and clears the file selection', () => {
    let s = reducer(initialState, { type: 'ui/selectCommit', hash: 'c1' });
    s = host(s, {
      type: 'commitDetail',
      detail: { commit: commit('c1'), body: '', files: [{ status: 'M', path: 'src/a.ts' }] },
    });
    s = reducer(s, { type: 'ui/selectFile', path: 'src/a.ts' });
    s = reducer(s, { type: 'ui/closeFiles' });
    expect(s.commitFiles).toBeNull();
    expect(s.selectedFile).toBeNull();
  });
});

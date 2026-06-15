/**
 * Behavioural tests for the full webview flow: host messages arrive through
 * the window message bridge, user gestures go out through `post`. Exercises
 * the click → changed-files tree → in-pane file diff path end to end (with
 * the extension host mocked at the message boundary).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import type { Commit, HostMessage } from './types';

vi.mock('./vscodeApi', () => ({ post: vi.fn() }));
import { post } from './vscodeApi';
const postMock = vi.mocked(post);

const commit = (hash: string, subject: string, parents: string[] = []): Commit => ({
  hash,
  shortHash: hash.slice(0, 8),
  parents,
  authorName: 'Ada Lovelace',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-01T00:00:00+00:00',
  subject,
  refs: [],
});

/** Deliver a host → webview message the way the extension host does. */
const hostSends = (msg: HostMessage) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });

const dataMsg: HostMessage = {
  type: 'data',
  branches: [
    { refName: 'refs/heads/main', name: 'main', commit: 'aaaa', kind: 'local', isHead: true },
  ],
  commits: [commit('dc3b7844ee2809b74e7ef1', 'Refactor engine core', ['24be8a91ff00aa11bb22'])],
  tracking: { ahead: 0, behind: 0 },
  current: 'main',
  focused: 'main',
};

const compareDataMsg: HostMessage = {
  ...dataMsg,
  branches: [
    ...(dataMsg as Extract<HostMessage, { type: 'data' }>).branches,
    {
      refName: 'refs/heads/feature/payments',
      name: 'feature/payments',
      commit: 'bbbb',
      kind: 'local',
      isHead: false,
    },
  ],
};

const detailMsg: HostMessage = {
  type: 'commitDetail',
  detail: {
    commit: commit('dc3b7844ee2809b74e7ef1', 'Refactor engine core', ['24be8a91ff00aa11bb22']),
    body: 'Split the engine into smaller units.',
    files: [
      { status: 'M', path: 'src/engine.js' },
      { status: 'A', path: 'docs/notes.md' },
    ],
  },
};

beforeEach(() => {
  postMock.mockClear();
});
afterEach(cleanup);

describe('App: commit click → changed files → diff editor beside', () => {
  it('announces readiness to the host on mount, with a viewport-derived page size', () => {
    render(<App />);
    expect(postMock).toHaveBeenCalledWith({
      type: 'ready',
      pageSize: expect.any(Number),
    });
    const { pageSize } = postMock.mock.calls[0][0] as { pageSize: number };
    expect(pageSize).toBeGreaterThanOrEqual(50);
  });

  it('clicking a commit selects it and requests its detail from the host', () => {
    render(<App />);
    hostSends(dataMsg);
    postMock.mockClear();
    fireEvent.click(screen.getByText('Refactor engine core'));
    expect(postMock).toHaveBeenCalledWith({
      type: 'commitDetail',
      hash: 'dc3b7844ee2809b74e7ef1',
    });
    expect(document.querySelector('.commit-row.selected')).toBeTruthy();
  });

  it('renders the changed-files tree below the branch tree when the detail arrives', () => {
    render(<App />);
    hostSends(dataMsg);
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends(detailMsg);

    const changes = document.querySelector('#changes')!;
    expect(changes).toBeTruthy();
    expect(changes.previousElementSibling?.id).toBe('tree'); // below the branch tree
    expect(changes.textContent).toContain('Changes (2)');
    expect(changes.textContent).toContain('dc3b7844');
    // No overlay — the detail lives in the left pane now.
    expect(document.querySelector('#overlay')).toBeNull();
  });

  it('clicking a changed file asks the host to open the diff editor and marks it selected', () => {
    render(<App />);
    hostSends(dataMsg);
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends(detailMsg);
    postMock.mockClear();

    fireEvent.click(screen.getByText('engine.js'));
    expect(postMock).toHaveBeenCalledWith({
      type: 'openFileDiff',
      hash: 'dc3b7844ee2809b74e7ef1',
      parent: '24be8a91ff00aa11bb22',
      path: 'src/engine.js',
    });
    expect(document.querySelector('#changes .file-node.selected .label')?.textContent).toBe(
      'engine.js'
    );
    // The diff opens in a split editor host-side — the commit list stays put.
    expect(document.querySelector('#rows')).toBeTruthy();
    expect(screen.getByText('Refactor engine core')).toBeTruthy();
  });

  it('passes a null parent for a root commit', () => {
    render(<App />);
    hostSends(dataMsg);
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends({
      ...detailMsg,
      detail: {
        ...detailMsg.detail,
        commit: commit('dc3b7844ee2809b74e7ef1', 'Refactor engine core', []),
      },
    } as HostMessage);
    postMock.mockClear();

    fireEvent.click(screen.getByText('engine.js'));
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openFileDiff', parent: null })
    );
  });

  it('the ✕ button closes the changed-files tree', () => {
    render(<App />);
    hostSends(dataMsg);
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends(detailMsg);
    fireEvent.click(screen.getByTitle('Close changed files'));
    expect(document.querySelector('#changes')).toBeNull();
    expect(screen.getByText('Refactor engine core')).toBeTruthy();
  });
});

describe('App: scroll paging of the commit list', () => {
  /** Make #graphWrap look like a scrollable element near its bottom. */
  const scrollNearBottom = (el: Element) => {
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 590, configurable: true, writable: true });
    fireEvent.scroll(el);
  };

  it('requests the next page when scrolling near the bottom and appends it', () => {
    render(<App />);
    hostSends({ ...dataMsg, hasMore: true } as HostMessage);
    postMock.mockClear();

    scrollNearBottom(document.querySelector('#graphWrap')!);
    expect(postMock).toHaveBeenCalledWith({ type: 'moreCommits', skip: 1 });
    expect(screen.getByText('Loading more commits…')).toBeTruthy();

    // A second scroll while the page is in flight must not re-request.
    postMock.mockClear();
    scrollNearBottom(document.querySelector('#graphWrap')!);
    expect(postMock).not.toHaveBeenCalled();

    hostSends({
      type: 'moreCommits',
      skip: 1,
      commits: [commit('24be8a91ff00aa11bb22', 'Older work')],
      hasMore: false,
    });
    expect(screen.getByText('Older work')).toBeTruthy();
    expect(screen.queryByText('Loading more commits…')).toBeNull();

    // No more pages: scrolling again stays quiet.
    postMock.mockClear();
    scrollNearBottom(document.querySelector('#graphWrap')!);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('does not page when the host reports no more history', () => {
    render(<App />);
    hostSends(dataMsg); // hasMore omitted
    postMock.mockClear();
    scrollNearBottom(document.querySelector('#graphWrap')!);
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('App: arrow-key commit navigation', () => {
  const threeCommits: HostMessage = {
    ...dataMsg,
    commits: [
      commit('aaaa000000000000000000', 'First commit', ['bbbb000000000000000000']),
      commit('bbbb000000000000000000', 'Second commit', ['cccc000000000000000000']),
      commit('cccc000000000000000000', 'Third commit', []),
    ],
  } as HostMessage;

  const selectedSubject = () =>
    document.querySelector('.commit-row.selected .msg')?.textContent;

  it('ArrowDown moves the selection to the next commit and requests its detail', () => {
    render(<App />);
    hostSends(threeCommits);
    fireEvent.click(screen.getByText('First commit'));
    postMock.mockClear();

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('Second commit');
    expect(postMock).toHaveBeenCalledWith({
      type: 'commitDetail',
      hash: 'bbbb000000000000000000',
    });
  });

  it('ArrowUp moves back and stops at the first commit', () => {
    render(<App />);
    hostSends(threeCommits);
    fireEvent.click(screen.getByText('Second commit'));

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowUp' });
    });
    expect(selectedSubject()).toBe('First commit');

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowUp' });
    });
    expect(selectedSubject()).toBe('First commit'); // clamped at the top
  });

  it('ArrowDown stops at the last commit and selects the first when nothing is selected', () => {
    render(<App />);
    hostSends(threeCommits);

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('First commit');

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('Third commit');

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('Third commit'); // clamped at the bottom
  });

  it('prevents the default scroll so the list does not scroll instead', () => {
    render(<App />);
    hostSends(threeCommits);

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('in compare mode the arrows walk the ahead and behind sections as one list', () => {
    render(<App />);
    hostSends({ ...compareDataMsg, commits: threeCommits.commits } as HostMessage);
    fireEvent.click(screen.getByText('Compare'));
    fireEvent.click(screen.getByText('feature/payments'));
    hostSends({
      type: 'compareResult',
      base: 'refs/heads/main',
      target: 'refs/heads/feature/payments',
      result: {
        ahead: [commit('a1a1a1a1a1a1a1a1a1a1', 'Add payments')],
        behind: [commit('b2b2b2b2b2b2b2b2b2b2', 'Fix typo on main')],
        files: [],
        mergeBase: 'feedc0defeedc0defeed',
      },
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('Add payments');

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedSubject()).toBe('Fix typo on main'); // crossed into "behind"
  });
});

describe('App: arrow-key navigation inside the changed-files tree', () => {
  /** Commit selected, detail shown, engine.js clicked: file nav is active. */
  const showFilesAndSelectEngine = () => {
    render(<App />);
    hostSends(dataMsg);
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends(detailMsg);
    fireEvent.click(screen.getByText('engine.js'));
    postMock.mockClear();
  };

  const selectedFileName = () =>
    document.querySelector('#changes .file-node.selected .label')?.textContent;

  it('ArrowDown moves the file selection and opens the next diff, not the commit list', () => {
    showFilesAndSelectEngine();

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedFileName()).toBe('notes.md');
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openFileDiff', path: 'docs/notes.md' })
    );
    // The commit selection must not have moved.
    expect(postMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'commitDetail' }));
    expect(document.querySelector('.commit-row.selected .msg')?.textContent).toBe(
      'Refactor engine core'
    );
  });

  it('clamps at the first and last file', () => {
    showFilesAndSelectEngine();

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowUp' });
    });
    expect(selectedFileName()).toBe('engine.js'); // clamped at the top

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedFileName()).toBe('notes.md'); // clamped at the bottom
  });

  it('skips files hidden inside a collapsed directory', () => {
    showFilesAndSelectEngine();

    // Collapse src/, hiding the selected engine.js; ArrowDown restarts at the
    // first visible file.
    fireEvent.click(screen.getByText('src'));
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    expect(selectedFileName()).toBe('notes.md');
  });

  it('selecting another commit hands the arrows back to the commit list', () => {
    showFilesAndSelectEngine();

    // The new commit's detail resets the file selection.
    fireEvent.click(screen.getByText('Refactor engine core'));
    hostSends(detailMsg);
    postMock.mockClear();

    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
    });
    // Only one commit in the list: the selection stays, but the handler is the
    // commit one again — no file diff was requested.
    expect(postMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openFileDiff' })
    );
    expect(document.querySelector('#changes .file-node.selected')).toBeNull();
  });
});

describe('App: branch compare → changed files → diff editor beside', () => {
  const compareMsg: HostMessage = {
    type: 'compareResult',
    base: 'refs/heads/main',
    target: 'refs/heads/feature/payments',
    result: {
      ahead: [commit('a1a1a1a1a1a1a1a1a1a1', 'Add payments')],
      behind: [commit('b2b2b2b2b2b2b2b2b2b2', 'Fix typo on main')],
      files: [{ status: 'M', path: 'src/engine.js' }],
      mergeBase: 'feedc0defeedc0defeed',
    },
  };

  const requestCompare = () => {
    hostSends(compareDataMsg);
    fireEvent.click(screen.getByText('Compare'));
    fireEvent.click(screen.getByText('feature/payments'));
  };

  it('renders the ahead/behind sections in the commit list and the files in the left pane', () => {
    render(<App />);
    requestCompare();
    hostSends(compareMsg);

    const sections = [...document.querySelectorAll('#rows .compare-section')].map(
      (s) => s.textContent
    );
    expect(sections).toEqual([
      'In feature/payments, not in main (1)',
      'In main, not in feature/payments (1)',
    ]);
    expect(screen.getByText('Add payments')).toBeTruthy();
    expect(screen.getByText('Fix typo on main')).toBeTruthy();

    const changes = document.querySelector('#changes')!;
    expect(changes.textContent).toContain('Changes (1)');
    expect(changes.textContent).toContain('main ⇄ feature/payments');
    expect(changes.textContent).not.toContain('refs/heads');
    expect(changes.querySelector('.file-node')).toBeTruthy();
  });

  it('clicking a compared file asks the host to diff merge-base vs target', () => {
    render(<App />);
    requestCompare();
    hostSends(compareMsg);
    postMock.mockClear();

    fireEvent.click(screen.getByText('engine.js'));
    expect(postMock).toHaveBeenCalledWith({
      type: 'openFileDiff',
      hash: 'refs/heads/feature/payments',
      parent: 'feedc0defeedc0defeed',
      path: 'src/engine.js',
    });
  });

  it('clicking a compare commit shows its own files on top, ✕ returns to the comparison', () => {
    render(<App />);
    requestCompare();
    hostSends(compareMsg);

    fireEvent.click(screen.getByText('Add payments'));
    hostSends({
      ...detailMsg,
      detail: {
        ...detailMsg.detail,
        commit: commit('a1a1a1a1a1a1a1a1a1a1', 'Add payments'),
      },
    } as HostMessage);
    expect(document.querySelector('#changes')!.textContent).toContain('a1a1a1a1');

    fireEvent.click(screen.getByTitle('Close changed files'));
    expect(document.querySelector('#changes')!.textContent).toContain(
      'main ⇄ feature/payments'
    );
  });

  it('Escape dismisses the comparison and restores the branch history', () => {
    render(<App />);
    requestCompare();
    hostSends(compareMsg);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.querySelector('.compare-section')).toBeNull();
    expect(document.querySelector('#changes')).toBeNull();
    expect(screen.getByText('Refactor engine core')).toBeTruthy();
  });
});

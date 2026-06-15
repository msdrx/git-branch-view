import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toolbar } from './Toolbar';
import { BranchPane, buildFileTree, displayPath, type ChangesView } from './BranchPane';
import { CommitList } from './CommitList';
import { ContextMenu } from './ContextMenu';
import type { Branch, Commit } from '../types';
import type { MenuState } from '../state';

// Capture everything the components try to send to the extension host.
vi.mock('../vscodeApi', () => ({ post: vi.fn() }));
import { post } from '../vscodeApi';
const postMock = vi.mocked(post);

beforeEach(() => {
  cleanup();
  postMock.mockClear();
});

const branch = (over: Partial<Branch>): Branch => {
  const name = over.name ?? 'main';
  const kind = over.kind ?? 'local';
  const refName = over.refName ?? (kind === 'remote' ? `refs/remotes/${name}` : `refs/heads/${name}`);
  return {
    refName,
    name,
    commit: 'abc',
    kind,
    isHead: false,
    refShort: refName,
    ...over,
  };
};

const commit = (hash: string, subject: string, refs: string[] = []): Commit => ({
  hash,
  shortHash: hash.slice(0, 8),
  parents: [],
  authorName: 'Ada Lovelace',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-01T00:00:00+00:00',
  subject,
  refs,
});

describe('Toolbar', () => {
  const renderToolbar = (compareBase: string | null = null) =>
    render(
      <Toolbar
        compareBase={compareBase}
        pullStrategy="rebase"
        onToggleCompare={vi.fn()}
        onPullStrategyMenu={vi.fn()}
      />
    );

  it('renders the action buttons and posts on click', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Fetch'));
    fireEvent.click(screen.getByText('Push'));
    expect(postMock.mock.calls.map(([m]) => m.type)).toEqual(['fetch', 'push']);
  });

  it('shows the active pull strategy in the Pull tooltip', () => {
    renderToolbar();
    expect(screen.getByTitle('Pull (Rebase)')).toBeTruthy();
  });

  it('labels the Compare button with the armed base', () => {
    renderToolbar('refs/heads/main');
    expect(screen.getByText(/Comparing: main/)).toBeTruthy();
    expect(screen.queryByText(/refs\/heads\/main/)).toBeNull();
  });

  it('sends a resetting ready message from Refresh', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Refresh'));
    expect(postMock).toHaveBeenCalledWith({ type: 'ready', reset: true });
  });
});

describe('BranchPane', () => {
  const branches = [
    branch({ name: 'main', isHead: true }),
    branch({ name: 'feature/login', refName: 'refs/heads/feature/login' }),
    branch({ name: 'origin/main', kind: 'remote', refName: 'refs/remotes/origin/main' }),
  ];

  const renderPane = (over: Partial<React.ComponentProps<typeof BranchPane>> = {}) =>
    render(
      <BranchPane
        branches={branches}
        selectedRef="refs/heads/main"
        collapsed={{}}
        changes={null}
        selectedFile={null}
        onToggleGroup={vi.fn()}
        onSelect={vi.fn()}
        onBranchMenu={vi.fn()}
        onSelectFile={vi.fn()}
        onCloseFiles={vi.fn()}
        {...over}
      />
    );

  it('groups locals under Branches and remotes under remotes/<name>', () => {
    renderPane();
    const groups = [...document.querySelectorAll('#tree .tree-node.group .label')].map(
      (n) => n.textContent
    );
    expect(groups).toEqual(['Branches', 'remotes/origin']);
    // The remote branch label drops the remote prefix.
    const labels = [...document.querySelectorAll('#tree .tree-node:not(.group) .label')].map(
      (n) => n.textContent
    );
    expect(labels).toEqual(['main', 'feature/login', 'main']);
  });

  it('marks the selected and head nodes', () => {
    renderPane();
    const head = document.querySelector('.tree-node.head.selected .label');
    expect(head?.textContent).toBe('main');
  });

  it('filters branches as the user types', () => {
    renderPane();
    fireEvent.change(screen.getByPlaceholderText('Filter'), { target: { value: 'feature' } });
    const labels = [...document.querySelectorAll('#tree .tree-node:not(.group) .label')].map(
      (n) => n.textContent
    );
    expect(labels).toEqual(['feature/login']);
  });

  it('reports clicks and context menus on branch nodes', () => {
    const onSelect = vi.fn();
    const onBranchMenu = vi.fn();
    renderPane({ onSelect, onBranchMenu });
    fireEvent.click(screen.getByText('feature/login'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'feature/login' }));
    fireEvent.contextMenu(screen.getByText('feature/login'));
    expect(onBranchMenu).toHaveBeenCalled();
  });

  it('hides a collapsed group and reports toggles', () => {
    const onToggleGroup = vi.fn();
    renderPane({ collapsed: { 'remote:origin': true }, onToggleGroup });
    const labels = [...document.querySelectorAll('#tree .tree-node:not(.group) .label')].map(
      (n) => n.textContent
    );
    expect(labels).toEqual(['main', 'feature/login']); // remote hidden
    fireEvent.click(screen.getByText('remotes/origin'));
    expect(onToggleGroup).toHaveBeenCalledWith('remote:origin');
  });

  describe('changed-files tree', () => {
    // What App.tsx derives from a commit detail for the Changes pane.
    const detail: ChangesView = {
      label: 'dc3b7844 Refactor engine core',
      tooltip: 'dc3b7844 Refactor engine core',
      files: [
        { status: 'M', path: 'src/engine.js' },
        { status: 'A', path: 'src/util/log.js' },
        { status: 'D', path: 'README.md' },
      ],
    };

    it('stays hidden until a commit detail arrives', () => {
      renderPane();
      expect(document.querySelector('#changes')).toBeNull();
    });

    it('shows the commit and its files as a directory tree below the branch tree', () => {
      renderPane({ changes: detail });
      const changes = document.querySelector('#changes')!;
      expect(changes).toBeTruthy();
      // The section sits inside the left pane, after the branch tree.
      expect(changes.previousElementSibling?.id).toBe('tree');
      expect(changes.querySelector('.changes-header')?.textContent).toContain('dc3b7844');
      expect(changes.querySelector('.changes-header')?.textContent).toContain(
        'Refactor engine core'
      );
      // Folders become nested nodes; files show their basename + status.
      const dirs = [...changes.querySelectorAll('.file-dir .label')].map((n) => n.textContent);
      expect(dirs).toEqual(['src', 'util']);
      const files = [...changes.querySelectorAll('.file-node .label')].map((n) => n.textContent);
      expect(files).toEqual(['log.js', 'engine.js', 'README.md']);
      expect(changes.querySelector('.file-node .status-D')?.textContent).toBe('D');
    });

    it('reports file clicks and marks the selected file', () => {
      const onSelectFile = vi.fn();
      renderPane({ changes: detail, selectedFile: 'src/engine.js', onSelectFile });
      fireEvent.click(screen.getByText('log.js'));
      expect(onSelectFile).toHaveBeenCalledWith({ status: 'A', path: 'src/util/log.js' });
      expect(document.querySelector('#changes .file-node.selected .label')?.textContent).toBe(
        'engine.js'
      );
    });

    it('collapses a folder on click', () => {
      renderPane({ changes: detail });
      fireEvent.click(screen.getByText('util'));
      const files = [...document.querySelectorAll('#changes .file-node .label')].map(
        (n) => n.textContent
      );
      expect(files).toEqual(['engine.js', 'README.md']); // log.js hidden
    });

    it('closes from the header button', () => {
      const onCloseFiles = vi.fn();
      renderPane({ changes: detail, onCloseFiles });
      fireEvent.click(screen.getByTitle('Close changed files'));
      expect(onCloseFiles).toHaveBeenCalled();
    });

    it('is resizable from the divider above it', () => {
      renderPane({ changes: detail });
      const divider = document.getElementById('hdivider')!;
      expect(divider).toBeTruthy();
      fireEvent.mouseDown(divider, { clientY: 300 });
      fireEvent.mouseMove(window, { clientY: 200 });
      fireEvent.mouseUp(window);
      const pane = document.getElementById('changes')!;
      // jsdom reports zero rects, so the drag lands on the clamped minimum —
      // what matters is that the drag took over the pane's height. (jsdom
      // normalises `flex: none` to its longhand `0 0 auto`.)
      expect(['none', '0 0 auto']).toContain(pane.style.flex);
      expect(pane.style.height).toBe('80px');
    });

    it('places a rename under its new path', () => {
      renderPane({
        changes: {
          ...detail,
          files: [{ status: 'R100', oldPath: 'src/old.js', path: 'src/new.js' }],
        },
      });
      expect(
        [...document.querySelectorAll('#changes .file-node .label')].map((n) => n.textContent)
      ).toEqual(['new.js']);
    });
  });
});

describe('changed-files tree model (buildFileTree / displayPath)', () => {
  it('displayPath returns the path itself, or the new side of a rename', () => {
    expect(displayPath('src/a.ts')).toBe('src/a.ts');
    expect(displayPath({ oldPath: 'src/old.ts', path: 'src/new.ts' })).toBe('src/new.ts');
  });

  it('nests files under their directories and keeps root-level files at the root', () => {
    const tree = buildFileTree([
      { status: 'M', path: 'README.md' },
      { status: 'A', path: 'src/util/log.ts' },
      { status: 'M', path: 'src/app.ts' },
    ]);
    expect(tree.files.map((f) => f.path)).toEqual(['README.md']);
    const src = tree.dirs.get('src')!;
    expect(src.files.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(src.dirs.get('util')!.files.map((f) => f.path)).toEqual(['src/util/log.ts']);
  });

  it('keeps files with the same basename apart in different directories', () => {
    const tree = buildFileTree([
      { status: 'M', path: 'a/index.ts' },
      { status: 'M', path: 'b/index.ts' },
    ]);
    expect(tree.dirs.get('a')!.files).toHaveLength(1);
    expect(tree.dirs.get('b')!.files).toHaveLength(1);
  });

  it('files a rename under its new directory, even across folders', () => {
    const tree = buildFileTree([{ status: 'R100', oldPath: 'old/place.ts', path: 'new/spot.ts' }]);
    expect(tree.dirs.has('old')).toBe(false);
    expect(tree.dirs.get('new')!.files[0]).toMatchObject({
      oldPath: 'old/place.ts',
      path: 'new/spot.ts',
    });
  });

  it('treats unicode and spaced segments as ordinary path parts', () => {
    const tree = buildFileTree([{ status: 'A', path: 'data sets/naïve-ünïcode.txt' }]);
    expect(tree.dirs.get('data sets')!.files[0].path).toBe('data sets/naïve-ünïcode.txt');
  });

  it('returns an empty tree for an empty change list', () => {
    const tree = buildFileTree([]);
    expect(tree.files).toEqual([]);
    expect(tree.dirs.size).toBe(0);
  });
});

describe('CommitList', () => {
  const commits = [commit('aaaa1111', 'Add login form', ['main']), commit('bbbb2222', 'Root')];

  const renderList = (over: Partial<React.ComponentProps<typeof CommitList>> = {}) =>
    render(
      <CommitList
        commits={commits}
        current="main"
        selectedHash={null}
        columnWidths={{}}
        compare={null}
        error={null}
        hasMore={false}
        loadingMore={false}
        onSelectCommit={vi.fn()}
        onCommitMenu={vi.fn()}
        onColumnWidths={vi.fn()}
        onLoadMore={vi.fn()}
        {...over}
      />
    );

  it('renders the column headers and one row per commit', () => {
    renderList();
    expect(['Branch', 'Message', 'Author', 'Date', 'ID'].every((l) => screen.getByText(l))).toBe(
      true
    );
    expect(document.querySelectorAll('#rows .commit-row')).toHaveLength(2);
    expect(document.querySelector('#rows svg')).toBeTruthy();
  });

  it('shows ref chips, marking the current branch chip as head', () => {
    renderList();
    const chip = document.querySelector('.ref-chip.head');
    expect(chip?.textContent).toBe('main');
  });

  it('reports row clicks and marks the selected row', () => {
    const onSelectCommit = vi.fn();
    renderList({ onSelectCommit, selectedHash: 'bbbb2222' });
    fireEvent.click(screen.getByText('Add login form'));
    expect(onSelectCommit).toHaveBeenCalledWith(expect.objectContaining({ hash: 'aaaa1111' }));
    expect(document.querySelector('.commit-row.selected')?.textContent).toContain('Root');
  });

  it('renders the error state instead of rows', () => {
    renderList({ error: 'git exploded' });
    expect(screen.getByText(/git exploded/)).toBeTruthy();
    expect(document.querySelectorAll('.commit-row')).toHaveLength(0);
  });

  it('shows the empty state without commits', () => {
    renderList({ commits: [] });
    expect(screen.getByText('No commits to display.')).toBeTruthy();
  });

  describe('compare mode', () => {
    const compare = {
      base: 'main',
      target: 'dev',
      result: {
        ahead: [commit('aaaa1111', 'Add login form')],
        behind: [],
        files: [],
        mergeBase: 'feedc0de',
      },
    };

    it('renders labelled ahead/behind sections instead of the graph', () => {
      renderList({ compare });
      const sections = [...document.querySelectorAll('.compare-section')].map(
        (s) => s.textContent
      );
      expect(sections).toEqual(['In dev, not in main (1)', 'In main, not in dev (0)']);
      expect(document.querySelectorAll('#rows .commit-row')).toHaveLength(1);
      expect(document.querySelector('#rows svg')).toBeNull();
      // The empty behind side says so.
      expect(screen.getByText('none')).toBeTruthy();
    });

    it('marks each row with its direction and keeps rows clickable', () => {
      const onSelectCommit = vi.fn();
      renderList({ compare, onSelectCommit });
      expect(document.querySelector('.commit-row .graph-cell .dir')?.textContent).toBe('↑');
      fireEvent.click(screen.getByText('Add login form'));
      expect(onSelectCommit).toHaveBeenCalledWith(expect.objectContaining({ hash: 'aaaa1111' }));
    });
  });
});

describe('ContextMenu', () => {
  const open = (menu: MenuState, over: Partial<React.ComponentProps<typeof ContextMenu>> = {}) =>
    render(
      <ContextMenu
        menu={menu}
        current="main"
        pullStrategy="merge"
        onClose={vi.fn()}
        onCompareFrom={vi.fn()}
        {...over}
      />
    );

  it('stays hidden when no menu is open', () => {
    open(null as unknown as MenuState);
    expect(document.querySelector('#contextMenu.hidden')).toBeTruthy();
  });

  it('builds branch items, disabling delete for remote branches', () => {
    open({
      x: 0,
      y: 0,
      target: { type: 'branch', branch: branch({ name: 'origin/dev', kind: 'remote' }) },
    });
    const del = screen.getByText('Delete').closest('.item');
    expect(del?.classList.contains('disabled')).toBe(true);
  });

  it('posts checkout from the branch menu and closes', () => {
    const onClose = vi.fn();
    open({ x: 0, y: 0, target: { type: 'branch', branch: branch({ name: 'dev' }) } }, { onClose });
    fireEvent.click(screen.getByText('Checkout dev'));
    expect(postMock).toHaveBeenCalledWith({ type: 'checkout', branch: 'refs/heads/dev' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not act on disabled items', () => {
    open({
      x: 0,
      y: 0,
      target: { type: 'branch', branch: branch({ name: 'main', isHead: true }) },
    });
    fireEvent.click(screen.getByText('Checkout main'));
    expect(postMock).not.toHaveBeenCalled();
  });

  it('ticks the active pull strategy and posts a change', () => {
    open({ x: 0, y: 0, target: { type: 'pullStrategy' } });
    const active = screen.getByText('Merge').closest('.item');
    expect(active?.querySelector('.icon')?.textContent).toBe('✓');
    fireEvent.click(screen.getByText('Rebase'));
    expect(postMock).toHaveBeenCalledWith({ type: 'setPullStrategy', strategy: 'rebase' });
  });
});

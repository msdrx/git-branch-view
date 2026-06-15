import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Branch, FileChange } from '../types';
import { branchDisplayName } from '../format';

/** What the Changes pane shows: a commit's files or a comparison's files. */
export interface ChangesView {
  /** Header text after "Changes (n) — ", e.g. `a1b2c3d4 Fix things` or `main ⇄ feat`. */
  label: React.ReactNode;
  tooltip: string;
  files: FileChange[];
}

interface BranchPaneProps {
  branches: Branch[];
  selectedRef: string | null;
  collapsed: Record<string, boolean>;
  /** Files shown in the changes section; null hides it. */
  changes: ChangesView | null;
  selectedFile: string | null;
  onToggleGroup(key: string): void;
  onSelect(branch: Branch): void;
  onBranchMenu(e: React.MouseEvent, branch: Branch): void;
  onSelectFile(file: FileChange): void;
  onCloseFiles(): void;
}

/**
 * The left pane: header, filter box, the collapsible branch tree and — once a
 * commit is selected or a comparison is run — the changed files as a
 * directory tree.
 */
export function BranchPane(props: BranchPaneProps) {
  const [filter, setFilter] = useState('');
  const { branches, collapsed, onToggleGroup, changes } = props;

  const needle = filter.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);

  const locals = branches.filter((b) => b.kind === 'local' && match(b.name));
  const remotes = branches.filter((b) => b.kind === 'remote' && match(b.name));

  // Group remotes by remote name (origin, upstream, ...).
  const remoteGroups = new Map<string, Branch[]>();
  for (const r of remotes) {
    const remoteName = r.name.split('/')[0];
    const list = remoteGroups.get(remoteName) ?? [];
    list.push(r);
    remoteGroups.set(remoteName, list);
  }

  const group = (label: string, icon: string, items: Branch[], indent: 1 | 2, key?: string) => {
    const groupKey = key || label;
    const isCollapsed = !!collapsed[groupKey];
    return (
      <React.Fragment key={groupKey}>
        <div className="tree-node group" onClick={() => onToggleGroup(groupKey)}>
          <span className="twisty">{isCollapsed ? '▸' : '▾'}</span>
          <span className="icon">{icon}</span>
          <span className="label">{label}</span>
        </div>
        {!isCollapsed &&
          items.map((b) => <BranchNode key={b.refShort} branch={b} indent={indent} {...props} />)}
      </React.Fragment>
    );
  };

  return (
    <div id="left">
      <div className="pane-header">Branches</div>
      <input
        id="branchFilter"
        className="filter"
        placeholder="Filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div id="tree">
        {group('Branches', '🜉', locals, 1)}
        {[...remoteGroups.entries()].map(([rname, items]) =>
          group(`remotes/${rname}`, '☁', items, 2, `remote:${rname}`)
        )}
      </div>
      {changes ? (
        <ChangesPane
          changes={changes}
          selectedFile={props.selectedFile}
          onSelectFile={props.onSelectFile}
          onClose={props.onCloseFiles}
        />
      ) : null}
    </div>
  );
}

interface BranchNodeProps extends BranchPaneProps {
  branch: Branch;
  indent: 1 | 2;
}

function BranchNode({ branch: b, indent, selectedRef, onSelect, onBranchMenu }: BranchNodeProps) {
  const classes = ['tree-node', `indent-${indent}`];
  if (b.isHead) {
    classes.push('head');
  }
  if (selectedRef === b.refShort) {
    classes.push('selected');
  }
  const showTrack = (b.ahead || b.behind) && b.kind === 'local';
  return (
    <div
      className={classes.join(' ')}
      onClick={() => onSelect(b)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(b);
        onBranchMenu(e, b);
      }}
    >
      <span className="icon">{b.isHead ? '◆' : '⎇'}</span>
      <span className="label">{branchDisplayName(b)}</span>
      {showTrack ? (
        <span className="track-badge">
          ↑{b.ahead || 0} ↓{b.behind || 0}
        </span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------ changed-files tree

/** A directory level of the changed-files tree. */
interface DirNode {
  dirs: Map<string, DirNode>;
  files: FileChange[];
}

/** A rename/copy record lives at its new path. */
export function displayPath(file: Pick<FileChange, 'path' | 'oldPath'> | string): string {
  return typeof file === 'string' ? file : file.path;
}

/** Nest the flat changed-file list into a directory tree. */
export function buildFileTree(files: FileChange[]): DirNode {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const segments = displayPath(f).split('/');
    let node = root;
    for (const seg of segments.slice(0, -1)) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

interface ChangesPaneProps {
  changes: ChangesView;
  selectedFile: string | null;
  onSelectFile(file: FileChange): void;
  onClose(): void;
}

/** The changed files as a collapsible directory tree (`#changes`). */
function ChangesPane({ changes, selectedFile, onSelectFile, onClose }: ChangesPaneProps) {
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => buildFileTree(changes.files), [changes.files]);

  // The files in render order (dirs before files at each level), skipping
  // collapsed subtrees — the order the arrow keys walk.
  const visibleFiles = useMemo(() => {
    const out: FileChange[] = [];
    const walk = (node: DirNode, parentPath: string) => {
      for (const [name, child] of node.dirs) {
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (!collapsedDirs[path]) {
          walk(child, path);
        }
      }
      out.push(...node.files);
    };
    walk(tree, '');
    return out;
  }, [tree, collapsedDirs]);

  // Keep the selected file visible when the selection moves via arrow keys.
  useEffect(() => {
    if (selectedFile !== null) {
      document
        .querySelector('#changes .file-node.selected')
        ?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selectedFile]);

  // Latest selection/order for the arrow-key handler (it outlives a render).
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const visibleFilesRef = useRef(visibleFiles);
  visibleFilesRef.current = visibleFiles;

  // While a changed file is selected, Up/Down arrows move the file selection
  // (opening each file's diff) instead of the commit selection — the commit
  // handler in App.tsx stands down whenever a file is selected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
        return;
      }
      if (selectedFileRef.current === null) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }
      const files = visibleFilesRef.current;
      if (!files.length) {
        return;
      }
      e.preventDefault();
      const idx = files.findIndex((f) => f.path === selectedFileRef.current);
      // Selection hidden inside a collapsed dir (idx -1): restart at the top.
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(files.length - 1, idx + 1)
          : Math.max(0, idx === -1 ? 0 : idx - 1);
      const next = files[nextIdx];
      if (next && next.path !== selectedFileRef.current) {
        onSelectFile(next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSelectFile]);

  // Drag the divider above the pane to trade height with the branch tree
  // (same direct-DOM pattern as the vertical split divider in App.tsx).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const pane = document.getElementById('changes');
    const left = document.getElementById('left');
    if (!pane || !left) {
      return;
    }
    const onMove = (ev: MouseEvent) => {
      const rect = left.getBoundingClientRect();
      const h = Math.max(80, Math.min(rect.bottom - ev.clientY, rect.height - 120));
      pane.style.flex = 'none';
      pane.style.height = `${h}px`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));

  const renderDir = (node: DirNode, parentPath: string, depth: number): React.ReactNode => (
    <>
      {[...node.dirs.entries()].map(([name, child]) => {
        const path = parentPath ? `${parentPath}/${name}` : name;
        const isCollapsed = !!collapsedDirs[path];
        return (
          <React.Fragment key={path}>
            <div
              className="tree-node file-dir"
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => toggleDir(path)}
            >
              <span className="twisty">{isCollapsed ? '▸' : '▾'}</span>
              <span className="icon">🗀</span>
              <span className="label">{name}</span>
            </div>
            {!isCollapsed && renderDir(child, path, depth + 1)}
          </React.Fragment>
        );
      })}
      {node.files.map((f) => {
        const full = displayPath(f);
        const name = full.split('/').pop();
        const classes = ['tree-node', 'file-node'];
        if (selectedFile === f.path) {
          classes.push('selected');
        }
        return (
          <div
            key={f.path}
            className={classes.join(' ')}
            style={{ paddingLeft: 22 + depth * 16 }}
            title={`${f.status}  ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`}
            onClick={() => onSelectFile(f)}
          >
            <span className={`status status-${f.status[0]}`}>{f.status[0]}</span>
            <span className="label">{name}</span>
          </div>
        );
      })}
    </>
  );

  return (
    <div id="changes">
      <div
        id="hdivider"
        title="Drag to resize the changed-files pane"
        onMouseDown={startResize}
      />
      <div className="pane-header changes-header">
        <span className="label" title={changes.tooltip}>
          Changes ({changes.files.length}) — {changes.label}
        </span>
        <button
          className="close-btn"
          title="Close changed files"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="files">
        {changes.files.length ? (
          renderDir(tree, '', 0)
        ) : (
          <div className="empty">No file changes.</div>
        )}
      </div>
    </div>
  );
}

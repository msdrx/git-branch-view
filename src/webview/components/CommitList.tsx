import React, { useEffect, useMemo, useRef } from 'react';
import type { Commit, ColumnKey, ColumnWidths } from '../types';
import type { CompareState } from '../state';
import { computeGraph, edgePath, laneX, rowY, LANE_W, PAD, ROW_H } from '../graph';
import { COLUMN_DEFS, MIN_COL_W, applyColumnTemplate } from '../columns';
import { displayRefName, formatDate, initials } from '../format';

interface CommitListProps {
  commits: Commit[];
  current: string;
  selectedHash: string | null;
  columnWidths: ColumnWidths;
  /** When set, the list shows the comparison's ahead/behind commits instead. */
  compare: CompareState | null;
  error: string | null;
  /** More history exists beyond the loaded commits (scroll pages it in). */
  hasMore: boolean;
  /** The next page is in flight. */
  loadingMore: boolean;
  /** Click: select the commit and load its changed files into the left pane. */
  onSelectCommit(commit: Commit): void;
  onCommitMenu(e: React.MouseEvent, commit: Commit): void;
  onColumnWidths(widths: ColumnWidths): void;
  /** Scroll approached the bottom: request the next history page. */
  onLoadMore(): void;
}

/** The column header row + the lane-drawn commit list (SVG overlay + rows). */
export function CommitList(props: CommitListProps) {
  const { commits, columnWidths, error } = props;

  // Keep the shared `.grid-cols` CSS variables in sync with the persisted
  // widths (the header and every row read them).
  useEffect(() => {
    applyColumnTemplate(columnWidths);
  }, [columnWidths]);

  // Latest widths for the drag handlers (they outlive a render).
  const widthsRef = useRef(columnWidths);
  widthsRef.current = columnWidths;

  const startResize = (e: React.MouseEvent, key: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();
    const resizer = e.currentTarget as HTMLElement;
    const colEl = resizer.parentElement as HTMLElement;
    const startX = e.clientX;
    const startW = colEl.getBoundingClientRect().width;
    document.body.classList.add('col-resizing');
    resizer.classList.add('active');

    let next = widthsRef.current;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_W, Math.round(startW + (ev.clientX - startX)));
      next = { ...widthsRef.current, [key]: w };
      applyColumnTemplate(next); // live update, no re-render churn
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
      resizer.classList.remove('active');
      props.onColumnWidths(next); // persist via the host
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Page in more history when the scroll position nears the bottom (within
  // one viewport height — far enough to usually load before the user gets
  // there). Compare mode doesn't page; stale/duplicate triggers are dropped
  // by the loadingMore guard host-side of the callback.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (props.compare || !props.hasMore || props.loadingMore) {
      return;
    }
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) {
      props.onLoadMore();
    }
  };

  return (
    <div id="graphWrap" onScroll={onScroll}>
      <div id="columns" className="grid-cols">
        {COLUMN_DEFS.map((def) => (
          <div className="col" key={def.key}>
            <span className="col-label">{def.label}</span>
            <span
              className="col-resizer"
              title={`Drag to resize the ${def.label} column`}
              onMouseDown={(e) => startResize(e, def.key)}
            />
          </div>
        ))}
      </div>
      {error ? (
        <div id="rows">
          <div className="empty">⚠ {error}</div>
        </div>
      ) : props.compare ? (
        <CompareRows {...props} compare={props.compare} />
      ) : (
        <Rows {...props} commits={commits} />
      )}
    </div>
  );
}

function Rows(props: CommitListProps) {
  const { commits } = props;

  const graph = useMemo(() => computeGraph(commits), [commits]);
  const graphW = Math.max(160, PAD * 2 + graph.laneCount * LANE_W);

  // The Branch column tracks the computed graph width.
  useEffect(() => {
    document.documentElement.style.setProperty('--graph-col', `${graphW}px`);
  }, [graphW]);

  if (!commits.length) {
    return (
      <div id="rows">
        <div className="empty">No commits to display.</div>
      </div>
    );
  }

  return (
    <div id="rows">
      <svg
        width={graphW}
        height={commits.length * ROW_H}
        style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 1 }}
      >
        {graph.edges.map((e, i) => (
          <path key={i} d={edgePath(e)} fill="none" stroke={e.color} strokeWidth={2} />
        ))}
        {graph.nodes.map((n) => (
          <circle
            key={n.row}
            cx={laneX(n.lane)}
            cy={rowY(n.row)}
            r={5}
            fill={n.color}
            stroke="var(--vscode-editor-background)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      {commits.map((c) => (
        <CommitRow key={c.hash} commit={c} {...props} />
      ))}
      {props.loadingMore ? <div className="load-more">Loading more commits…</div> : null}
    </div>
  );
}

/**
 * Compare mode: no lane graph — the ahead/behind commits render as two
 * labelled sections, each row marked with its direction in the graph column.
 * Rows keep the `.commit-row` contract (click → detail, right-click → menu).
 */
function CompareRows(props: CommitListProps & { compare: CompareState }) {
  const { base, target, result } = props.compare;
  const baseLabel = displayRefName(base);
  const targetLabel = displayRefName(target);

  // The graph column only holds the ↑/↓ marker here; keep it narrow.
  useEffect(() => {
    document.documentElement.style.setProperty('--graph-col', '60px');
  }, []);

  const section = (label: string, marker: string, commits: Commit[]) => (
    <>
      <div className="compare-section">
        {label} ({commits.length})
      </div>
      {commits.length ? (
        commits.map((c) => <CommitRow key={c.hash} commit={c} marker={marker} {...props} />)
      ) : (
        <div className="empty">none</div>
      )}
    </>
  );

  return (
    <div id="rows">
      {section(`In ${targetLabel}, not in ${baseLabel}`, '↑', result.ahead)}
      {section(`In ${baseLabel}, not in ${targetLabel}`, '↓', result.behind)}
    </div>
  );
}

interface CommitRowProps extends CommitListProps {
  commit: Commit;
  /** Compare-mode direction glyph shown in the graph column. */
  marker?: string;
}

function CommitRow({ commit: c, current, selectedHash, marker, onSelectCommit, onCommitMenu }: CommitRowProps) {
  const selected = selectedHash === c.hash;

  // Keep the row visible when selection moves via the arrow keys.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <div
      ref={rowRef}
      className={`commit-row grid-cols${selected ? ' selected' : ''}`}
      style={{ position: 'relative' }}
      onClick={() => onSelectCommit(c)}
      onContextMenu={(e) => {
        e.preventDefault();
        onCommitMenu(e, c);
      }}
    >
      <div className="cell graph-cell">{marker ? <span className="dir">{marker}</span> : null}</div>
      <div className="cell msg">
        {(c.refs || []).map((r) => (
          <span key={r} className={`ref-chip${r === current ? ' head' : ''}`}>
            {r}
          </span>
        ))}
        {c.subject}
      </div>
      <div className="cell author">
        <span className="avatar">{initials(c.authorName)}</span>
        {c.authorName}
      </div>
      <div className="cell mono">{formatDate(c.authorDate)}</div>
      <div className="cell mono">{c.shortHash}</div>
    </div>
  );
}

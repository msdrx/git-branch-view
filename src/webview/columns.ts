/**
 * Commit-list column model + the CSS-variable plumbing that keeps the header
 * and every row pixel-aligned (they all share the `.grid-cols` template).
 */
import type { ColumnKey, ColumnWidths } from './types';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
}

/** Commit-list columns, in display order. `branch` is the graph column. */
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { key: 'branch', label: 'Branch' },
  { key: 'message', label: 'Message' },
  { key: 'author', label: 'Author' },
  { key: 'date', label: 'Date' },
  { key: 'id', label: 'ID' },
];

export const MIN_COL_W = 40;

/**
 * Push column widths into the CSS variables the header and rows share. Unset
 * columns fall back to their defaults; the graph (`Branch`) column never
 * shrinks below the lane width via `max(...)`, and the trailing spacer turns
 * into the flex filler once `Message` is pinned.
 */
export function applyColumnTemplate(
  widths: ColumnWidths,
  root: HTMLElement = document.documentElement
): void {
  const w = widths || {};
  const ds = root.style;
  ds.setProperty(
    '--col-branch',
    w.branch ? `max(var(--graph-col, 160px), ${w.branch}px)` : 'var(--graph-col, 160px)'
  );
  ds.setProperty('--col-message', w.message ? `${w.message}px` : '1fr');
  ds.setProperty('--col-author', w.author ? `${w.author}px` : '140px');
  ds.setProperty('--col-date', w.date ? `${w.date}px` : '120px');
  ds.setProperty('--col-id', w.id ? `${w.id}px` : '90px');
  ds.setProperty('--col-spacer', w.message ? '1fr' : '0px');
}

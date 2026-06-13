/**
 * Validation for the commit-list column widths the webview persists. Kept free
 * of any `vscode` import so it is independently unit-testable.
 */

/** Commit-list columns whose widths the webview may persist. */
export const COLUMN_KEYS = ['branch', 'message', 'author', 'date', 'id'] as const;

/** Bounds a stored column width to a sane pixel range. */
export const MIN_COLUMN_WIDTH = 24;
export const MAX_COLUMN_WIDTH = 2000;

/**
 * Validate column widths coming from the webview (or read back from storage):
 * keep only known columns whose value is a finite, positive number, clamped to
 * a sane pixel range. Anything else is dropped so a corrupt payload can't break
 * the layout or bloat global state.
 */
export function sanitizeColumnWidths(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of COLUMN_KEYS) {
      const value = obj[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[key] = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(value)));
      }
    }
  }
  return out;
}

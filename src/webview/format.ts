/** Small display formatters shared across components. Pure, unit-tested. */
import type { DateFormat } from './types';

export { displayRefName } from '../refName';

/** Up to two initials for the author avatar chip, e.g. "Ada Lovelace" → "AL". */
export function initials(name: string | null | undefined): string {
  return String(name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Render a commit date in the configured style (`gitBranchView.dateFormat`).
 * Echoes the input back when it isn't a valid date and returns '' for missing
 * input, regardless of style. `now` is injectable so the relative format is
 * unit-testable. Defaults to the local format (the historical behaviour).
 */
export function formatDate(
  iso: string | null | undefined,
  format: DateFormat = 'local',
  now: number = Date.now()
): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  switch (format) {
    case 'relative':
      return relativeTime(d.getTime(), now);
    case 'iso':
      return isoLocal(d);
    case 'local':
    default:
      return (
        d.toLocaleDateString() +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      );
  }
}

/** Local-time `YYYY-MM-DD HH:mm` — a stable, sortable, ISO-style rendering. */
function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** Coarse "3 days ago"-style label relative to `now` (both in epoch ms). */
function relativeTime(then: number, now: number): string {
  const sec = Math.round((now - then) / 1000);
  if (sec < 0) {
    return 'in the future';
  }
  const units: [limit: number, secs: number, name: string][] = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
    [Infinity, 31536000, 'year'],
  ];
  if (sec < 45) {
    return 'just now';
  }
  for (const [limit, secs, name] of units) {
    if (sec < limit) {
      const n = Math.round(sec / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Display name for a branch in the tree: remotes drop the remote prefix. */
export function branchDisplayName(b: { kind: 'local' | 'remote'; name: string }): string {
  if (b.kind === 'remote') {
    return b.name.split('/').slice(1).join('/');
  }
  return b.name;
}

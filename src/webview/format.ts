/** Small display formatters shared across components. Pure, unit-tested. */
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

/** Local date + short time; echoes the input back when it isn't a valid date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  return (
    d.toLocaleDateString() +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

/** Display name for a branch in the tree: remotes drop the remote prefix. */
export function branchDisplayName(b: { kind: 'local' | 'remote'; name: string }): string {
  if (b.kind === 'remote') {
    return b.name.split('/').slice(1).join('/');
  }
  return b.name;
}

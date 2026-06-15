import { describe, expect, it } from 'vitest';
import { branchDisplayName, displayRefName, formatDate, initials } from './format';

describe('initials', () => {
  it('takes the first letters of the first two words, uppercased', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace brewster murray hopper')).toBe('GB');
  });

  it('handles single names and missing values', () => {
    expect(initials('linus')).toBe('L');
    expect(initials('')).toBe('?');
    expect(initials(undefined)).toBe('?');
  });
});

describe('formatDate', () => {
  it('returns empty for missing input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
  });

  it('echoes back unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('renders a local date and time for a valid ISO date', () => {
    const out = formatDate('2026-03-04T10:30:00+00:00');
    expect(out).toContain('2026');
    expect(out.split(' ').length).toBeGreaterThanOrEqual(2);
  });

  it('defaults to the local format when none is given', () => {
    expect(formatDate('2026-03-04T10:30:00+00:00')).toBe(
      formatDate('2026-03-04T10:30:00+00:00', 'local')
    );
  });

  it('renders a stable YYYY-MM-DD HH:mm string for the iso format', () => {
    const iso = '2026-03-04T10:30:00Z';
    const out = formatDate(iso, 'iso');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // Rendered in local time — recompute the expectation the same way so the
    // assertion holds in any timezone.
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    expect(out).toBe(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}`
    );
  });

  it('renders coarse relative labels against an injected now', () => {
    const base = Date.parse('2026-03-04T12:00:00Z');
    const ago = (ms: number) => formatDate(new Date(base - ms).toISOString(), 'relative', base);
    expect(ago(10 * 1000)).toBe('just now');
    expect(ago(60 * 1000)).toBe('1 minute ago');
    expect(ago(5 * 60 * 1000)).toBe('5 minutes ago');
    expect(ago(60 * 60 * 1000)).toBe('1 hour ago');
    expect(ago(3 * 24 * 60 * 60 * 1000)).toBe('3 days ago');
    expect(ago(60 * 24 * 60 * 60 * 1000)).toBe('2 months ago');
    expect(ago(800 * 24 * 60 * 60 * 1000)).toBe('2 years ago');
  });

  it('guards against a future date in the relative format', () => {
    const base = Date.parse('2026-03-04T12:00:00Z');
    const future = new Date(base + 60 * 1000).toISOString();
    expect(formatDate(future, 'relative', base)).toBe('in the future');
  });
});

describe('branchDisplayName', () => {
  it('keeps local names as-is', () => {
    expect(branchDisplayName({ kind: 'local', name: 'feature/login' })).toBe('feature/login');
  });

  it('drops the remote prefix from remote refs', () => {
    expect(branchDisplayName({ kind: 'remote', name: 'origin/feature/login' })).toBe(
      'feature/login'
    );
  });
});

describe('displayRefName', () => {
  it('strips full local and remote ref prefixes for user-facing labels', () => {
    expect(displayRefName('refs/heads/main')).toBe('main');
    expect(displayRefName('refs/remotes/origin/feature/login')).toBe('origin/feature/login');
  });

  it('keeps non-ref labels unchanged', () => {
    expect(displayRefName('main')).toBe('main');
    expect(displayRefName('deadbeef')).toBe('deadbeef');
  });
});

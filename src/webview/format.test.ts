import { describe, expect, it } from 'vitest';
import { branchDisplayName, formatDate, initials } from './format';

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

import { describe, expect, it } from 'vitest';
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, sanitizeColumnWidths } from './columnWidths';

describe('sanitizeColumnWidths', () => {
  it('keeps known columns with sane numeric widths, rounded', () => {
    expect(sanitizeColumnWidths({ branch: 200, message: 350.6 })).toEqual({
      branch: 200,
      message: 351,
    });
  });

  it('drops unknown keys and non-numeric values', () => {
    expect(
      sanitizeColumnWidths({ bogus: 100, author: 'wide', date: NaN, id: Infinity, message: -5 })
    ).toEqual({});
  });

  it('clamps to the allowed pixel range', () => {
    expect(sanitizeColumnWidths({ author: 1, date: 999999 })).toEqual({
      author: MIN_COLUMN_WIDTH,
      date: MAX_COLUMN_WIDTH,
    });
  });

  it('tolerates garbage payloads', () => {
    expect(sanitizeColumnWidths(null)).toEqual({});
    expect(sanitizeColumnWidths('x')).toEqual({});
    expect(sanitizeColumnWidths(42)).toEqual({});
  });
});

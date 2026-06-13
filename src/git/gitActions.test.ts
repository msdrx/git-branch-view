import { describe, expect, it } from 'vitest';
import { isNonFastForward } from './gitActions';

describe('isNonFastForward', () => {
  it('matches the common stderr shapes of a rejected push', () => {
    expect(isNonFastForward('! [rejected] main -> main (fetch first)')).toBe(true);
    expect(isNonFastForward('Updates were rejected... hint: fetch first')).toBe(true);
    expect(isNonFastForward('failed to push some refs to origin')).toBe(true);
    expect(isNonFastForward('tip of your current branch is behind (non-fast-forward)')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isNonFastForward('fatal: could not read Username')).toBe(false);
    expect(isNonFastForward('')).toBe(false);
  });
});

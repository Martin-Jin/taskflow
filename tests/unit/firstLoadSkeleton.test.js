/**
 * Coverage for the first-load skeleton gate.
 *
 * The positive case is the boring one. Everything valuable here is a case that
 * must NOT show a placeholder — a skeleton shown at the wrong moment is worse
 * than the empty state it replaced, either flashing over data the user can
 * already see, or spinning forever for a genuinely new user.
 */

import { describe, it, expect } from 'vitest';
import { shouldShowFirstLoadSkeleton } from '../../src/hooks/useFirstLoadSkeleton';

describe('shouldShowFirstLoadSkeleton', () => {
  it('shows one only while a pull is in flight AND there is nothing to show', () => {
    expect(shouldShowFirstLoadSkeleton({ isPullingCloud: true, isEmpty: true })).toBe(true);
  });

  it('never shows one for a genuinely empty account', () => {
    // The important case. Without the isPullingCloud half, a brand-new user
    // watches a placeholder that never resolves.
    expect(shouldShowFirstLoadSkeleton({ isPullingCloud: false, isEmpty: true })).toBe(false);
  });

  it('never covers data that has already arrived', () => {
    // Without the isEmpty half, every background pull would flash a skeleton
    // over a populated page.
    expect(shouldShowFirstLoadSkeleton({ isPullingCloud: true, isEmpty: false })).toBe(false);
  });

  it('never shows one in the steady state', () => {
    expect(shouldShowFirstLoadSkeleton({ isPullingCloud: false, isEmpty: false })).toBe(false);
  });

  it('treats absent flags as false rather than throwing', () => {
    // A signed-out user has no isPullingCloud at all.
    expect(shouldShowFirstLoadSkeleton({})).toBe(false);
    expect(shouldShowFirstLoadSkeleton({ isEmpty: true })).toBe(false);
    expect(shouldShowFirstLoadSkeleton({ isPullingCloud: undefined, isEmpty: true })).toBe(false);
  });
});

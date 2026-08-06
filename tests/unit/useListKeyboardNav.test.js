import { describe, it, expect } from 'vitest';
import { nextIndex } from '../../src/hooks/useListKeyboardNav';

// Pure index-wrap/clamp logic behind useListKeyboardNav's Arrow key
// handling — the hook itself is a thin useState/useEffect wrapper around
// this, so this is the part worth unit-testing directly rather than only
// through a rendered component.
describe('nextIndex — Arrow key index math for useListKeyboardNav', () => {
  it('moves forward/backward within bounds', () => {
    expect(nextIndex(1, 1, 5)).toBe(2);
    expect(nextIndex(1, -1, 5)).toBe(0);
  });

  it('wraps around at both ends when wrap is true (CommandPalette default)', () => {
    expect(nextIndex(4, 1, 5, true)).toBe(0); // last -> first
    expect(nextIndex(0, -1, 5, true)).toBe(4); // first -> last
  });

  it('clamps at both ends when wrap is false (CalendarFilterMenu)', () => {
    expect(nextIndex(4, 1, 5, false)).toBe(4); // stays at last
    expect(nextIndex(0, -1, 5, false)).toBe(0); // stays at first
  });

  it('returns 0 for an empty list regardless of direction or wrap', () => {
    expect(nextIndex(0, 1, 0, true)).toBe(0);
    expect(nextIndex(0, -1, 0, false)).toBe(0);
  });

  it('defaults to wrap: true when unspecified', () => {
    expect(nextIndex(2, 1, 3)).toBe(0);
  });
});

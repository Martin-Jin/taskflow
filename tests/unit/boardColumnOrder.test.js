import { describe, it, expect } from 'vitest';
import { applySavedColumnOrder, moveColumn } from '../../src/utils/boardColumnOrder';

// Board column ordering (src/utils/boardColumnOrder.js): a locally-persisted
// id list layered over Todoist's own synced Section.order. The interesting
// cases are all drift between the two — sections added, removed, or synced in
// after an order was saved.

const s = (id, order) => ({ id, name: id, projectId: 'p1', order });

describe('applySavedColumnOrder', () => {
  it('falls back to natural order when nothing is saved', () => {
    const sections = [s('b', 2), s('a', 1), s('c', 3)];
    expect(applySavedColumnOrder(sections, undefined).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(applySavedColumnOrder(sections, []).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a non-array saved value as absent rather than throwing', () => {
    const sections = [s('a', 1), s('b', 2)];
    expect(applySavedColumnOrder(sections, null).map((x) => x.id)).toEqual(['a', 'b']);
    expect(applySavedColumnOrder(sections, 'nonsense').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('applies a full saved order, overriding natural order', () => {
    const sections = [s('a', 1), s('b', 2), s('c', 3)];
    expect(applySavedColumnOrder(sections, ['c', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends sections missing from the saved order, in natural order', () => {
    // 'd' and 'e' were created (or synced in) after the order was saved — they
    // land at the end, where "Add section" put them, not at the front.
    const sections = [s('a', 1), s('b', 2), s('d', 4), s('e', 5)];
    expect(applySavedColumnOrder(sections, ['b', 'a']).map((x) => x.id)).toEqual(['b', 'a', 'd', 'e']);
  });

  it('ignores saved ids whose sections no longer exist', () => {
    const sections = [s('a', 1), s('c', 3)];
    expect(applySavedColumnOrder(sections, ['c', 'gone', 'a']).map((x) => x.id)).toEqual(['c', 'a']);
  });

  it('does not mutate the input array', () => {
    const sections = [s('b', 2), s('a', 1)];
    const snapshot = sections.map((x) => x.id);
    applySavedColumnOrder(sections, ['a', 'b']);
    expect(sections.map((x) => x.id)).toEqual(snapshot);
  });

  it('handles an empty section list', () => {
    expect(applySavedColumnOrder([], ['a'])).toEqual([]);
  });
});

describe('moveColumn', () => {
  const sections = [s('a', 1), s('b', 2), s('c', 3), s('d', 4)];

  it('moves a column forward, taking the target slot', () => {
    expect(moveColumn(sections, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a column backward, taking the target slot', () => {
    expect(moveColumn(sections, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when dropped on itself', () => {
    expect(moveColumn(sections, 'b', 'b')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is a no-op for unknown ids', () => {
    expect(moveColumn(sections, 'nope', 'b')).toEqual(['a', 'b', 'c', 'd']);
    expect(moveColumn(sections, 'a', 'nope')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('round-trips through applySavedColumnOrder', () => {
    // The persisted result must actually reproduce the intended arrangement
    // when read back — the two functions are only useful as a pair.
    const moved = moveColumn(sections, 'a', 'd');
    expect(applySavedColumnOrder(sections, moved).map((x) => x.id)).toEqual(['b', 'c', 'd', 'a']);
  });
});

/**
 * Coverage for the pure half of Board card ordering. The off-by-one in
 * planBoardReorder (removing the dragged card shifts every later gap) is the
 * kind of thing that reads as correct and lands cards one slot short, so it's
 * pinned here rather than left to a drag-and-drop E2E test to notice.
 */

import { describe, it, expect } from 'vitest';
import { sortByBoardOrder, planBoardReorder } from '../../src/utils/boardCardOrder';

const t = (id, boardOrder) => (boardOrder === undefined ? { id } : { id, boardOrder });

describe('sortByBoardOrder', () => {
  it('orders ranked cards ascending', () => {
    const out = sortByBoardOrder([t('c', 2), t('a', 0), t('b', 1)]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts unranked cards after ranked ones, keeping their incoming order', () => {
    // The state of every column that has never been hand-ranked, and of any
    // card created since one was.
    const out = sortByBoardOrder([t('new1'), t('ranked', 5), t('new2')]);
    expect(out.map((x) => x.id)).toEqual(['ranked', 'new1', 'new2']);
  });

  it('treats boardOrder 0 as a real rank, not as missing', () => {
    const out = sortByBoardOrder([t('unranked'), t('first', 0)]);
    expect(out.map((x) => x.id)).toEqual(['first', 'unranked']);
  });

  it('does not mutate its input', () => {
    const input = [t('b', 1), t('a', 0)];
    sortByBoardOrder(input);
    expect(input.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('handles an empty column', () => {
    expect(sortByBoardOrder([])).toEqual([]);
  });
});

describe('planBoardReorder — within one column', () => {
  const column = [t('a', 0), t('b', 1), t('c', 2), t('d', 3)];

  const applied = (col, writes) => {
    const byId = new Map(writes.map((w) => [w.id, w.boardOrder]));
    return [...col]
      .map((x) => ({ ...x, boardOrder: byId.has(x.id) ? byId.get(x.id) : x.boardOrder }))
      .sort((x, y) => x.boardOrder - y.boardOrder)
      .map((x) => x.id);
  };

  it('moves a card up', () => {
    const writes = planBoardReorder(column, 'd', 1);
    expect(applied(column, writes)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves a card down, compensating for its own removal', () => {
    // Gap index 3 is "between c and d" as displayed. Naively splicing at 3
    // after removing 'a' lands it after 'd' instead.
    const writes = planBoardReorder(column, 'a', 3);
    expect(applied(column, writes)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a card to the very top', () => {
    expect(applied(column, planBoardReorder(column, 'c', 0))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a card to the very bottom', () => {
    expect(applied(column, planBoardReorder(column, 'b', 4))).toEqual(['a', 'c', 'd', 'b']);
  });

  it('writes nothing when a card is dropped back where it started', () => {
    // Both gaps either side of a card mean "leave it alone".
    expect(planBoardReorder(column, 'b', 1)).toEqual([]);
    expect(planBoardReorder(column, 'b', 2)).toEqual([]);
  });

  it('only writes the cards that actually move', () => {
    // Swapping the last two shouldn't rewrite the first two.
    const writes = planBoardReorder(column, 'd', 2);
    expect(writes.map((w) => w.id).sort()).toEqual(['c', 'd']);
  });

  it('clamps an out-of-range insert index instead of producing holes', () => {
    expect(applied(column, planBoardReorder(column, 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    expect(applied(column, planBoardReorder(column, 'd', -5))).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('planBoardReorder — a card arriving from another column', () => {
  const column = [t('a', 0), t('b', 1)];

  it('inserts it at the requested gap and ranks the whole column', () => {
    const writes = planBoardReorder(column, 'newcomer', 1);
    expect(writes).toEqual([
      { id: 'newcomer', boardOrder: 1 },
      { id: 'b', boardOrder: 2 },
    ]);
  });

  it('appends to an empty column', () => {
    expect(planBoardReorder([], 'newcomer', 0)).toEqual([{ id: 'newcomer', boardOrder: 0 }]);
  });
});

describe('planBoardReorder — a column that has never been ranked', () => {
  it('assigns an order to every card, not just the moved one', () => {
    // Otherwise the moved card gets a rank and everything else stays
    // unranked-and-therefore-last, so the move appears to do the opposite.
    const unranked = [t('a'), t('b'), t('c')];
    const writes = planBoardReorder(unranked, 'c', 0);
    expect(writes).toEqual([
      { id: 'c', boardOrder: 0 },
      { id: 'a', boardOrder: 1 },
      { id: 'b', boardOrder: 2 },
    ]);
  });
});

/**
 * ============================================================================
 * BOARD CARD ORDER
 * ============================================================================
 * Hand-ranking of cards WITHIN a Board column, stored as a `boardOrder` number
 * on the Task itself.
 *
 * Deliberately NOT device-local, unlike the sibling column order (see
 * boardColumnOrder.js). That one is local because Sections carry an `order`
 * field owned by Todoist, so persisting a local arrangement would either be
 * clobbered by the next import or leak a view preference into another app.
 * Neither applies here: importFromTodoist's upsert is an explicit allow-list of
 * Todoist-owned fields (see SchedulerContext), so an app-only field on a Task
 * survives a re-import untouched. And a hand-ranked backlog is data the user
 * would be annoyed to lose — it has to be the same on their phone, and it has
 * to be the same for everyone looking at a shared board. Being a Task field, it
 * rides along with `tasks` through BACKUP_FIELDS, computeFingerprint, and the
 * cross-device merge for free.
 *
 * CONCURRENCY: task merge is whole-object last-write-wins on `updatedAt` (see
 * utils/taskMerge.js), so two people reordering the same shared column at once
 * interleave rather than one winning outright. Nothing is lost — every card is
 * still present, just possibly in an order neither person chose. Ordering is
 * cheap to redo and expensive to arbitrate, so that's the right trade here.
 *
 * DENSE, not fractional. A drop rewrites every changed card in the column to
 * 0..N-1 rather than assigning a midpoint between neighbours. Fractional
 * indexing exists to keep a drop to a single write, which matters at thousands
 * of cards per column; at this app's scale it would just be precision-drift
 * bookkeeping (and eventual renormalisation code) in exchange for nothing.
 * ============================================================================
 */

/**
 * Order a column's cards for display.
 *
 * Cards with a `boardOrder` come first, ascending. Cards without one keep their
 * incoming relative order and follow — that's the state of every column before
 * it has ever been hand-ranked, and of any card created since. Array.prototype
 * .sort is stable, so the unranked tail doesn't shuffle between renders.
 *
 * @param {import('../types').Task[]} tasks
 * @returns {import('../types').Task[]} a new sorted array
 */
export function sortByBoardOrder(tasks) {
  return [...tasks].sort((a, b) => {
    const ao = typeof a.boardOrder === 'number' ? a.boardOrder : Infinity;
    const bo = typeof b.boardOrder === 'number' ? b.boardOrder : Infinity;
    return ao - bo;
  });
}

/**
 * Work out the `boardOrder` writes needed to drop `draggedTaskId` at
 * `insertIndex` within `orderedColumnTasks`.
 *
 * `insertIndex` is a GAP index in the column as currently displayed: 0 means
 * "before the first card", `length` means "after the last". The dragged task
 * may or may not already be in this column — the same function covers a
 * reorder and a cross-column move, since both end with "this column now reads
 * top to bottom like so".
 *
 * Returns only the cards whose value actually changes, so dropping a card back
 * where it started writes nothing at all.
 *
 * @param {import('../types').Task[]} orderedColumnTasks the column as displayed
 * @param {string} draggedTaskId
 * @param {number} insertIndex
 * @returns {{id: string, boardOrder: number}[]}
 */
export function planBoardReorder(orderedColumnTasks, draggedTaskId, insertIndex) {
  const current = orderedColumnTasks || [];
  const fromIndex = current.findIndex((t) => t.id === draggedTaskId);

  const without = current.filter((t) => t.id !== draggedTaskId);

  /* Removing the card first shifts every gap after it left by one, so a drop
     into one of those gaps has to compensate. Without this, dragging a card
     downward lands it one position short of where the indicator was. */
  let target = insertIndex;
  if (fromIndex !== -1 && insertIndex > fromIndex) target -= 1;
  target = Math.max(0, Math.min(target, without.length));

  const dragged = current[fromIndex] || { id: draggedTaskId };
  const next = [...without.slice(0, target), dragged, ...without.slice(target)];

  const writes = [];
  next.forEach((task, i) => {
    const existing = orderedColumnTasks.find((t) => t.id === task.id);
    // A task arriving from another column has no order in this one yet, so
    // `existing?.boardOrder` is undefined and every position counts as a change.
    if (existing && existing.boardOrder === i) return;
    writes.push({ id: task.id, boardOrder: i });
  });
  return writes;
}

/**
 * ============================================================================
 * BOARD COLUMN ORDER
 * ============================================================================
 * Board view's section columns can be dragged into a user-chosen order. That
 * order is stored LOCALLY (localStorage, per project) rather than written back
 * onto the Section records themselves, because Sections — and their `order`
 * field — come from Todoist (see todoistService.fetchSections): persisting a
 * local arrangement into `order` would be overwritten by the next sync, and
 * pushing it up to Todoist would reorder the user's sections in another app as
 * a side effect of a view preference. Keeping it device-local also matches how
 * the rest of the app treats view/filter state (see CLAUDE.md's Backups note:
 * deliberately local-only, not part of BACKUP_FIELDS).
 *
 * The saved value is a sparse id list, not a full ordering — sections created,
 * deleted, or renamed elsewhere (or synced in from Todoist later) don't
 * invalidate it, so no migration is needed when the section set drifts.
 * `applySavedColumnOrder` is what reconciles the two.
 * ============================================================================
 */

/** localStorage key (namespaced by utils/persistence). Value: { [projectId]: sectionId[] }. */
export const BOARD_COLUMN_ORDER_KEY = 'boardColumnOrder';

/**
 * Order a project's sections by a saved id list.
 *
 * Sections named in `savedIds` come first, in that order; any section not
 * mentioned (newly added locally, or newly synced from Todoist) keeps its
 * natural `order` and is appended after them. Ids in `savedIds` that no
 * longer exist are ignored. Appending rather than prepending means a brand
 * new section shows up at the end, where "Add section" put it, instead of
 * jumping to the front of an already-arranged board.
 *
 * @param {import('../types').Section[]} sections - Sections for one project.
 * @param {string[]} [savedIds] - Persisted section id order, if any.
 * @returns {import('../types').Section[]} New sorted array (input untouched).
 */
export function applySavedColumnOrder(sections, savedIds) {
  const byNaturalOrder = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!Array.isArray(savedIds) || savedIds.length === 0) return byNaturalOrder;

  const remaining = new Map(byNaturalOrder.map((s) => [s.id, s]));
  const ordered = [];
  for (const id of savedIds) {
    const section = remaining.get(id);
    if (!section) continue; // deleted, or belongs to another project
    ordered.push(section);
    remaining.delete(id);
  }
  // Map preserves insertion order, so the leftovers stay in natural order.
  return [...ordered, ...remaining.values()];
}

/**
 * Move one section to the position of another, returning the resulting id
 * order to persist. Both ids must be in `sections`; anything else (unknown
 * id, or dropping a column onto itself) returns the current order unchanged
 * so callers can skip a redundant write.
 *
 * @param {import('../types').Section[]} sections - Sections in current display order.
 * @param {string} draggedId
 * @param {string} targetId - The column being dropped onto; the dragged one takes its slot.
 * @returns {string[]} Full id order for this project.
 */
export function moveColumn(sections, draggedId, targetId) {
  const ids = sections.map((s) => s.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return ids;
  ids.splice(from, 1);
  ids.splice(to, 0, draggedId);
  return ids;
}

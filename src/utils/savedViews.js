/**
 * ============================================================================
 * SAVED VIEWS
 * ============================================================================
 * A saved view is a NAME plus a search query string — nothing more.
 *
 * That framing is the whole design. The query grammar (utils/searchQuery.js)
 * already expresses project, priority, due date, completion state and
 * missing-field filters, so a saved view needs no filter model of its own and
 * inherits every operator added later for free. The alternative — storing a
 * structured filter object — would need migrating every time the grammar grew.
 *
 * Synced, not device-local. The anonymous view/filter SELECTION next to this is
 * deliberately local (a transient UI choice), but a view someone bothered to
 * name is data they'd be annoyed to lose and would expect on their phone. It's
 * a BACKUP_FIELDS entry with a path through every sync function.
 *
 * RETENTION: capped at MAX_SAVED_VIEWS. Per CLAUDE.md, anything persisted to
 * Firestore needs a documented bound; this one is naturally small (people don't
 * hand-name fifty queries) so the cap exists only to stop a bug or a stuck
 * retry loop growing the synced document without limit.
 * ============================================================================
 */

/** Upper bound on stored views. Generous — a real user has a handful. */
export const MAX_SAVED_VIEWS = 30;

export const MAX_SAVED_VIEW_NAME_LENGTH = 40;

/**
 * Validate and normalise a would-be saved view.
 *
 * @returns {{ok: true, view: {id: string, name: string, query: string, createdAt: number}} | {ok: false, error: string}}
 */
export function buildSavedView({ name, query }, existingViews = []) {
  const trimmedName = (name || '').trim();
  const trimmedQuery = (query || '').trim();

  if (!trimmedName) return { ok: false, error: 'Give the view a name.' };
  if (trimmedName.length > MAX_SAVED_VIEW_NAME_LENGTH) {
    return { ok: false, error: `Keep the name under ${MAX_SAVED_VIEW_NAME_LENGTH} characters.` };
  }
  // An empty query would save a view that matches everything, which is what
  // the unfiltered list already is.
  if (!trimmedQuery) return { ok: false, error: 'Search or filter something first, then save it as a view.' };
  if (existingViews.some((v) => v.name.toLowerCase() === trimmedName.toLowerCase())) {
    return { ok: false, error: 'A view with that name already exists.' };
  }
  if (existingViews.length >= MAX_SAVED_VIEWS) {
    return { ok: false, error: `You can keep up to ${MAX_SAVED_VIEWS} views — delete one to add another.` };
  }

  return {
    ok: true,
    view: { id: crypto.randomUUID(), name: trimmedName, query: trimmedQuery, createdAt: Date.now() },
  };
}

/**
 * Views in display order: alphabetical by name.
 *
 * Deliberately not most-recently-created or most-recently-used. A saved view is
 * something the user goes looking for by name, so a stable position matters
 * more than surfacing the newest — a list that reorders itself as you use it is
 * one you have to re-read every time.
 */
export function sortSavedViews(views) {
  return [...(views || [])].sort((a, b) => a.name.localeCompare(b.name));
}

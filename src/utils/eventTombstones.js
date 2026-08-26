/**
 * ============================================================================
 * EVENT TOMBSTONES — pure decision logic
 * ============================================================================
 * The CalendarEvent counterpart to taskTombstones.js. Backs the per-event
 * cross-device merge (see useCloudSync.js's planRemoteDataMerge/
 * applyRemoteData) that lets TaskFlow's own Firestore sync keep calendar
 * events consistent across devices, independent of whether Google Calendar
 * is connected on either end — see eventMerge.js's module doc for the full
 * story of why events needed this treatment on top of the tombstone-based
 * merge tasks already had.
 *
 * A plain array removal can't tell "this event doesn't exist here because it
 * was never created" apart from "it doesn't exist because it was deleted" —
 * a delete on one device could otherwise be silently undone by a stale edit
 * arriving from another device that never saw the delete. Tombstoning
 * (stamping `deletedAt` and keeping the row instead of removing it) fixes
 * that the same way it already does for tasks.
 *
 * Extracted as pure functions (no Firebase/React/Date.now() side effects
 * beyond an explicit `nowMs`/`nowIso` parameter) so they're unit-testable
 * without mounting SchedulerContext — same precedent as taskTombstones.js.
 * ============================================================================
 */

import { computeCutoffMs } from '../services/dataRetention';

/**
 * Fields cleared on a tombstoned event — the heaviest/most private content
 * fields, with nothing left to show once the event is gone. Everything else
 * (title, date, times, googleEventId, etc.) is left untouched: harmless to
 * keep, and occasionally useful for debugging a sync issue. `title` is kept
 * deliberately (unlike a task's notes/comments) since action toasts and the
 * "Deleted event" undo flow both still need to display it after this runs.
 */
const TOMBSTONE_CLEARED_FIELDS = {
  description: null,
  location: null,
};

/**
 * Transform `events` so every id in `idsToDelete` becomes a tombstone
 * (marked `deletedAt`/`localUpdatedAt`, heavy content fields cleared)
 * instead of being removed from the array.
 *
 * Pure: takes the current events array, the ids to delete, and the timestamp
 * to stamp — the caller (SchedulerContext.deleteEvent) is responsible for
 * everything else deletion does (the Google-side delete call, the deleted-id
 * suppression window, the undo toast) since those are side effects, not
 * state-shape decisions.
 *
 * Unlike tombstoneTasks, there is no `dependsOn`-style cross-reference to
 * scrub — nothing else in a CalendarEvent points at another event's id.
 *
 * @param {import('../types').CalendarEvent[]} events
 * @param {Set<string>|string[]} idsToDelete
 * @param {string} nowIso
 * @returns {import('../types').CalendarEvent[]}
 */
export function tombstoneEvents(events, idsToDelete, nowIso) {
  const ids = idsToDelete instanceof Set ? idsToDelete : new Set(idsToDelete);
  return events.map((e) => {
    if (!ids.has(e.id)) return e;
    return { ...e, ...TOMBSTONE_CLEARED_FIELDS, deletedAt: nowIso, localUpdatedAt: nowIso };
  });
}

/**
 * True if `event` is a tombstone (see tombstoneEvents above) older than
 * `retentionDays`, and therefore eligible for the retention sweep to
 * permanently remove.
 *
 * @param {import('../types').CalendarEvent} event
 * @param {number} retentionDays
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isStaleEventTombstone(event, retentionDays, nowMs = Date.now()) {
  if (!event?.deletedAt) return false;
  const cutoffMs = computeCutoffMs(retentionDays, nowMs);
  return new Date(event.deletedAt).getTime() < cutoffMs;
}

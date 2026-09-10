/**
 * ============================================================================
 * PER-EVENT CROSS-DEVICE MERGE — pure decision logic
 * ============================================================================
 * The CalendarEvent counterpart to taskMerge.js. Gives TaskFlow's calendar
 * events the same cross-device live sync tasks already have, entirely
 * independent of Google Calendar: two devices signed into the same account
 * now converge on calendar events through Firestore even when Google Calendar
 * isn't connected on either one (previously `events` was excluded from live
 * sync altogether — see backupService.js's BACKUP_FIELDS doc comment for the
 * history of why).
 *
 * That original exclusion existed because the OLD design would have synced
 * the whole `events` ARRAY as one blob per device — the same "take one side's
 * entire array" shape `tasks` used to have before mergeTasksByUpdatedAt fixed
 * it (see that file's own doc comment). A stale device pushing its whole
 * array could silently overwrite a newer deletion made on another device
 * purely by writing last. This file avoids that failure mode the identical
 * way tasks already do: merge EVENT BY EVENT using each one's own timestamp,
 * never swap the whole array wholesale.
 *
 * `localUpdatedAt` (not `updatedAt`) is the field being compared — it's the
 * one CalendarEvent already stamps on every local edit (see
 * SchedulerContext.updateEvent), originally added for a future conflict-
 * resolution use that never shipped (see eventSyncService.js's own doc
 * comment on why it doesn't gate anything on the Google side) — this merge is
 * that use.
 *
 * A tombstoned event (`deletedAt` set, see eventTombstones.js) participates in
 * the SAME `localUpdatedAt` comparison as a live event, no special casing —
 * identical reasoning to mergeTasksByUpdatedAt's own doc comment on why a
 * newer delete wins over a stale edit, and a newer edit correctly "undeletes"
 * a stale tombstone.
 *
 * Extracted as a pure function (no Firebase/React/Date.now() side effects) so
 * it's unit-testable in isolation — same precedent as taskMerge.js.
 * ============================================================================
 */

/** Epoch millis for `event.localUpdatedAt`, or null if missing/unparseable. */
function localUpdatedAtMillis(event) {
  if (!event?.localUpdatedAt) return null;
  const ms = new Date(event.localUpdatedAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Per-event merge of two CalendarEvent arrays by `localUpdatedAt`.
 *
 * Semantics (identical to mergeTasksByUpdatedAt's, just keyed on
 * `localUpdatedAt` instead of `updatedAt` — see that function's own doc
 * comment for the full reasoning, summarized here):
 *   - Union of ids across both arrays. An id present on only one side is kept
 *     as-is — most commonly a brand new event created locally and not yet
 *     pushed/pulled by the other device.
 *   - An id present on BOTH sides: keep whichever has the newer
 *     `localUpdatedAt`. Ties keep the local copy (arbitrary, but
 *     deterministic).
 *   - Missing/unparseable `localUpdatedAt` on one side only: the side WITH a
 *     valid value counts as newer (an event predating this field, or a
 *     mock/imported row that never went through updateEvent). If BOTH sides
 *     are missing/invalid, keep local — arbitrary, but must never throw.
 *   - Pure and deterministic: no `Date.now()`, no mutation of either input,
 *     always returns a NEW array.
 *
 * @param {import('../types').CalendarEvent[]} localEvents
 * @param {import('../types').CalendarEvent[]} remoteEvents
 * @returns {import('../types').CalendarEvent[]}
 */
export function mergeEventsByUpdatedAt(localEvents, remoteEvents) {
  const localById = new Map((localEvents || []).map((e) => [e.id, e]));
  const remoteById = new Map((remoteEvents || []).map((e) => [e.id, e]));

  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  const merged = [];

  for (const id of ids) {
    const local = localById.get(id);
    const remote = remoteById.get(id);

    if (local && !remote) {
      merged.push(local);
      continue;
    }
    if (remote && !local) {
      merged.push(remote);
      continue;
    }

    const localMs = localUpdatedAtMillis(local);
    const remoteMs = localUpdatedAtMillis(remote);

    if (localMs === null && remoteMs === null) {
      merged.push(local); // both missing/invalid — arbitrary but deterministic
    } else if (remoteMs === null) {
      merged.push(local); // only local has a valid timestamp
    } else if (localMs === null) {
      merged.push(remote); // only remote has a valid timestamp
    } else if (remoteMs > localMs) {
      merged.push(remote);
    } else {
      merged.push(local); // local newer, or a tie
    }
  }

  return merged;
}

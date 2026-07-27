/**
 * ============================================================================
 * ONE-TIME MIGRATION — SAFE TO DELETE after ~2026-09 once telemetry/support
 * shows no remaining users with `blockedTimeMigrationDone !== true` (see the
 * call site in SchedulerContext.jsx, and the `blockedTimeMigrationDone`
 * persisted flag guarding it).
 *
 * Historically "blocked time" was already just a CalendarEvent with
 * source:'manual' — there is no old data shape to actually transform. This
 * migration exists purely to backfill the new optional fields (description,
 * location, recurrenceRule) onto any pre-existing manual events, so the
 * event edit modal never renders `undefined` for those fields. Once every
 * active user has run this once, the whole file + its call site can be
 * deleted.
 * ============================================================================
 */

/**
 * @param {import('../types').CalendarEvent[]} events
 * @returns {import('../types').CalendarEvent[]} events with missing new fields backfilled on manual events
 */
export function migrateBlockedTimeToEvents(events) {
  if (!Array.isArray(events)) return events;
  return events.map((e) =>
    e.source === 'manual'
      ? { description: '', location: '', recurrenceRule: null, ...e }
      : e
  );
}

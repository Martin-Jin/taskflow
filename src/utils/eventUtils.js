/**
 * Small shared helpers for the `events` array (CalendarEvent[]) that more
 * than one caller needs — currently just dedupe, used by SchedulerContext's
 * boot-time load/migration effects and useCloudSync's remote-apply/backup-
 * restore paths, all of which can end up merging in a duplicate copy of the
 * same event occurrence (see dedupeEventsByOccurrence's own comment).
 */

/**
 * Drops duplicate copies of the same event occurrence — a Google-sourced
 * event is keyed by its googleEventId (stable across merges/pulls), while a
 * manual/mock event (no googleEventId) falls back to an exact date+time+
 * title match. Guards against re-adding duplicates that can creep in from
 * localStorage, a Firestore pull, or a backup restore each independently
 * merging in the same occurrence.
 */
export function dedupeEventsByOccurrence(events) {
  if (!Array.isArray(events)) return events;
  const seen = new Set();
  return events.filter((e) => {
    const key = e.googleEventId ? `g:${e.googleEventId}` : `m:${e.date}|${e.startTime}|${e.endTime}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

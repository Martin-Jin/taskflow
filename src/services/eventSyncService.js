/**
 * ============================================================================
 * EVENT SYNC SERVICE
 * ============================================================================
 * Merge/reconcile policy for folding a freshly-pulled batch of Google
 * Calendar events into the app's existing `events` array. Kept separate
 * from `googleCalendarService.js` (a pure API wrapper with no opinion about
 * local state) — this module is the one place that knows how a pull should
 * be combined with whatever's already in TaskFlow.
 *
 * CONFLICT POLICY (explicit, literal product decision): Google Calendar
 * always wins. If a pulled event corresponds to an existing local
 * Google-sourced record, the pulled version replaces it outright — no
 * timestamp-based "keep local if newer" exception, even if the local copy
 * has a `localUpdatedAt` from an edit that hasn't been pushed yet. The
 * `googleUpdatedAt`/`localUpdatedAt` fields are still stamped/maintained
 * (for potential future use, e.g. avoiding redundant pushes) but never gate
 * this overwrite-on-pull behavior.
 * ============================================================================
 */

/**
 * True if a local Google-sourced event should be looked up against this
 * pull's results at all (as opposed to being left untouched because this
 * pull's date range says nothing about it).
 *
 * A recurring master event's own stored `date` is just its DTSTART, which
 * can be far outside [rangeStartIso, rangeEndIso] even though it still has
 * occurrences INSIDE that range — Google's singleEvents:false fetch returns
 * the master event whenever ANY of its occurrences overlap the queried
 * range, so a recurring master is always "in scope" for a pulled-map lookup
 * regardless of its stored `date`. A non-recurring event's `date` IS its
 * one and only occurrence, so the plain date-in-range check applies.
 */
function isInScopeForPull(event, rangeStartIso, rangeEndIso) {
  if (event.recurrenceRule) return true;
  return event.date >= rangeStartIso && event.date <= rangeEndIso;
}

/**
 * How long a locally-deleted Google event id is suppressed from being
 * resurrected by a pull, after this app instance calls Google's delete API
 * for it. Sized to comfortably outlast realistic Google Calendar API
 * delete-propagation lag (a poll/pull that's already in flight, or starts
 * moments after the delete call returns success on our side, can still see
 * the event as "live" for a short while) without being so long it would mask
 * a legitimate fast re-sync of some OTHER event — the suppression only ever
 * applies to the exact id(s) this instance just deleted anyway (see
 * isRecentlyDeletedLocally), so this window just bounds how long that
 * exception stays open.
 */
export const RECENTLY_DELETED_TTL_MS = 2 * 60 * 1000;

/**
 * True if `googleEventId` was deleted by THIS app instance recently enough
 * that a pull showing it as still live should be treated as stale rather
 * than a legitimate re-sync. `recentlyDeletedGoogleEventIds` maps
 * googleEventId -> the timestamp (ms) the delete was issued; entries older
 * than RECENTLY_DELETED_TTL_MS are ignored (treated as if Google's delete
 * has definitely propagated by now, so a pull showing the event again means
 * it was genuinely re-created).
 */
function isRecentlyDeletedLocally(googleEventId, recentlyDeletedGoogleEventIds, nowMs) {
  const deletedAt = recentlyDeletedGoogleEventIds.get(googleEventId);
  return deletedAt != null && nowMs - deletedAt < RECENTLY_DELETED_TTL_MS;
}

/**
 * Merge freshly-pulled Google events into the existing local `events` array.
 * Policy: Google always wins for anything it returns. Concretely:
 *   - Every non-Google (source:'manual') local event is kept untouched —
 *     fixes a prior bug where a Google pull replaced the ENTIRE events
 *     array, silently deleting all manual events.
 *   - Every local Google-sourced event whose googleEventId appears in the
 *     freshly pulled set is REPLACED by the pulled version (Google wins,
 *     unconditionally — even if the local copy has a newer localUpdatedAt
 *     from an edit that hasn't been pushed yet).
 *   - Every local Google-sourced event whose googleEventId does NOT appear
 *     in the freshly pulled set, but whose `date` falls within
 *     [rangeStartIso, rangeEndIso] (i.e. it WAS in scope for this pull and
 *     is simply gone now), is treated as deleted on Google's side and
 *     dropped from the merged result.
 *   - A local Google-sourced event whose `date` falls OUTSIDE the queried
 *     range is left untouched (this pull says nothing about it either way).
 *   - Any pulled event with no matching local googleEventId is a brand-new
 *     Google event and is simply added.
 *   - EXCEPTION to all of the above: any pulled event whose googleEventId
 *     this app instance itself deleted within the last RECENTLY_DELETED_TTL_MS
 *     is dropped from the pulled batch entirely before any of the above
 *     runs, regardless of what the pull says — see isRecentlyDeletedLocally.
 *     This closes the race where the optimistic local delete
 *     (SchedulerContext.deleteEvent) removes the event from `events`
 *     immediately, but a poll/pull landing before Google's own delete has
 *     propagated still reports the event as live, which would otherwise
 *     silently re-add ("resurrect") the just-deleted event.
 * @param {import('../types').CalendarEvent[]} existingEvents
 * @param {import('../types').CalendarEvent[]} pulledGoogleEvents
 * @param {string} rangeStartIso
 * @param {string} rangeEndIso
 * @param {Map<string, number>} [recentlyDeletedGoogleEventIds] - googleEventId -> delete-issued timestamp (ms); defaults to empty (no suppression)
 * @param {number} [nowMs] - defaults to Date.now(); overridable for testing
 * @returns {import('../types').CalendarEvent[]}
 */
export function mergePulledGoogleEvents(
  existingEvents,
  pulledGoogleEvents,
  rangeStartIso,
  rangeEndIso,
  recentlyDeletedGoogleEventIds = new Map(),
  nowMs = Date.now()
) {
  const freshPulled = pulledGoogleEvents.filter(
    (e) => !isRecentlyDeletedLocally(e.googleEventId, recentlyDeletedGoogleEventIds, nowMs)
  );

  const pulledByGoogleEventId = new Map(freshPulled.map((e) => [e.googleEventId, e]));

  const survivingLocal = existingEvents.filter((e) => {
    if (e.source !== 'google') return true; // manual events are never touched by a Google pull

    if (pulledByGoogleEventId.has(e.googleEventId)) return false; // superseded below by the pulled version

    // Not in the pulled set — either out of scope for this pull (leave
    // alone) or in scope and gone (Google-side delete, drop it).
    return !isInScopeForPull(e, rangeStartIso, rangeEndIso);
  });

  return [...survivingLocal, ...freshPulled];
}

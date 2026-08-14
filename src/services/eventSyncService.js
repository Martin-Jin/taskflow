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
 *
 * RETENTION WINDOW: the routine background sync (see useGoogleCalendarSync's
 * ROUTINE_SYNC_WINDOW_DAYS) only ever covers a small ROLLING window centered
 * on today — this app is a forward-looking scheduler, not a full calendar
 * archive/history. A non-recurring event that ages out of the past edge of
 * that window is actively purged (see isTooOldToRetain), not just left
 * alone — see the merge policy comment below for the distinction from an
 * event that's merely out of scope for one particular pull.
 *
 * That said, the PURGE boundary is deliberately NOT the same thing as any
 * single pull's own rangeStartIso. useGoogleCalendarSync also fetches
 * on-demand whenever the calendar view is scrolled outside the routine
 * window (see its ensureGoogleRangeSynced/computeOnDemandFetchRange), and
 * once fetched that way, an old event is meant to stay put for the rest of
 * the session rather than getting purged again the moment the NEXT routine
 * poll runs its own narrower range. So the purge check takes an explicit
 * `purgeBoundaryIso` — the outer edge of the UNION of every range ever
 * synced (see expandSyncedBounds), not just the current call's own
 * rangeStartIso — falling back to rangeStartIso when the caller has no wider
 * union to offer (e.g. in tests that only care about the base policy).
 * ============================================================================
 */

import { toISODate } from '../utils/dateUtils';
import { computeEffectivePurgeBoundary as centralized_computeEffectivePurgeBoundary } from './dataRetention';

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
 * True if a local Google-sourced, non-recurring event has aged out of the
 * retention window entirely (older than `purgeBoundaryIso` — the trailing
 * edge of the UNION of every range ever synced, not just this call's own
 * rangeStartIso, see this file's module doc) and should be actively purged
 * rather than merely "left untouched because this pull says nothing about
 * it" (see isInScopeForPull's own doc comment, which still governs the
 * FUTURE side of the range: an event beyond the forward horizon is left
 * alone since it'll simply roll into view later).
 *
 * Only ever applies to a plain (non-recurring) event — a recurring master's
 * own stored `date` is just its DTSTART and can be arbitrarily old while the
 * series is still very much active (e.g. a weekly meeting that started
 * months ago); that case is already handled correctly by isInScopeForPull
 * treating any recurring master as always in scope, so if Google stops
 * returning it (its own occurrences have all aged out of the fetch window
 * too) it's already dropped via the normal "in scope but missing from the
 * pull" path below — no separate retention check needed for it.
 */
function isTooOldToRetain(event, purgeBoundaryIso) {
  return !event.recurrenceRule && event.date < purgeBoundaryIso;
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
 * Key format for `recentlyDeletedGoogleEventInstances` below — one entry per
 * (recurring master, single occurrence) pair this app instance issued a
 * `deleteCalendarEventInstance` call for (SchedulerContext.deleteEvent's
 * scope 'this'). Kept as a single string key (rather than a nested Map) to
 * match the plain `Map<string, number>` shape `recentlyDeletedGoogleEventIds`
 * already uses, so both can be pruned/read the same way.
 */
function instanceDeleteKey(masterGoogleEventId, occurrenceDateIso) {
  return `${masterGoogleEventId}::${occurrenceDateIso}`;
}

/**
 * Carry forward the local-only "ignore from scheduler" flag(s) from the
 * existing local event onto its freshly-pulled replacement. `isFreeTime` is
 * TaskFlow-only state (Google Calendar has no concept of it — see
 * SchedulerContext.setEventIgnored), so a pulled event never has it set;
 * without this, every sync silently un-ignores anything the user had
 * marked ignored, since the pulled version otherwise wholesale-replaces the
 * local one below. Covers both the whole-event/series-level flag
 * (`isFreeTime` on the top-level event) and any per-occurrence override
 * (`overrides[date].isFreeTime`) recorded on a recurring master for a
 * single-occurrence ignore.
 */
function preserveIgnoredFlag(localEvent, pulledEvent) {
  let result = pulledEvent;

  if (localEvent.isFreeTime && !pulledEvent.isFreeTime) {
    result = { ...result, isFreeTime: true };
  }

  const localOverrides = localEvent.overrides;
  if (localOverrides) {
    let mergedOverrides = null;
    for (const [date, override] of Object.entries(localOverrides)) {
      if (!override?.isFreeTime) continue;
      if (result.overrides?.[date]?.isFreeTime) continue;
      mergedOverrides = mergedOverrides || { ...(result.overrides || {}) };
      mergedOverrides[date] = { ...mergedOverrides[date], isFreeTime: true };
    }
    if (mergedOverrides) {
      result = { ...result, overrides: mergedOverrides };
    }
  }

  return result;
}

/**
 * Fold "recently instance-deleted" suppression into one pulled master
 * event's `overrides`. Unlike the whole-event suppression above (which drops
 * a pulled event entirely), a single-occurrence delete must still let the
 * rest of the pulled master through — only the specific deleted date's
 * override is forced to `{ deleted: true }`, overriding whatever the fresh
 * pull's own EXDATE-derived overrides say (or don't yet say) for that date.
 * Every other override entry is left exactly as the pull computed it —
 * Google is still authoritative for everything outside the suppression
 * window, exactly mirroring how whole-event suppression expires.
 */
function applyRecentInstanceDeletes(pulledEvent, recentlyDeletedGoogleEventInstances, nowMs) {
  if (!pulledEvent.googleEventId || recentlyDeletedGoogleEventInstances.size === 0) return pulledEvent;

  let mergedOverrides = null;
  for (const [key, deletedAt] of recentlyDeletedGoogleEventInstances) {
    if (nowMs - deletedAt >= RECENTLY_DELETED_TTL_MS) continue;
    const sep = key.lastIndexOf('::');
    const masterId = key.slice(0, sep);
    const occurrenceDate = key.slice(sep + 2);
    if (masterId !== pulledEvent.googleEventId) continue;
    mergedOverrides = mergedOverrides || { ...(pulledEvent.overrides || {}) };
    mergedOverrides[occurrenceDate] = { ...mergedOverrides[occurrenceDate], deleted: true };
  }
  return mergedOverrides ? { ...pulledEvent, overrides: mergedOverrides } : pulledEvent;
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
 *     range is left untouched (this pull says nothing about it either way) —
 *     EXCEPT a non-recurring event older than `rangeStartIso` (the trailing
 *     edge of the fetch window, i.e. it's aged out of the retention window
 *     entirely), which is actively purged rather than left indefinitely —
 *     see isTooOldToRetain.
 *   - Any pulled event with no matching local googleEventId is a brand-new
 *     Google event and is simply added — UNLESS that googleEventId is
 *     already claimed by an existing manual (source:'manual') event, i.e.
 *     one this app instance itself created and fire-and-forget pushed to
 *     Google (see SchedulerContext.addManualEvent). Without this, the very
 *     next pull after that push resolves would see "no local GOOGLE-sourced
 *     row owns this id yet" and add Google's own copy of the event as a
 *     second, duplicate row — the manual row is always the canonical one for
 *     an id it already owns, so the echoed pulled copy is dropped instead.
 *   - EXCEPTION to all of the above: any pulled event whose googleEventId
 *     this app instance itself deleted within the last RECENTLY_DELETED_TTL_MS
 *     is dropped from the pulled batch entirely before any of the above
 *     runs, regardless of what the pull says — see isRecentlyDeletedLocally.
 *     This closes the race where the optimistic local delete
 *     (SchedulerContext.deleteEvent) removes the event from `events`
 *     immediately, but a poll/pull landing before Google's own delete has
 *     propagated still reports the event as live, which would otherwise
 *     silently re-add ("resurrect") the just-deleted event.
 *   - A second, narrower version of that same race: deleting a SINGLE
 *     occurrence of a recurring master (scope 'this') doesn't remove the
 *     master's googleEventId at all, so the whole-event suppression above
 *     doesn't apply — instead, any occurrence date recently deleted this way
 *     (per `recentlyDeletedGoogleEventInstances`) has `overrides[date].deleted`
 *     forced to `true` on the pulled master, even if that pull's own
 *     EXDATE-derived overrides don't (yet) reflect Google's side having
 *     processed the delete — see applyRecentInstanceDeletes.
 * @param {import('../types').CalendarEvent[]} existingEvents
 * @param {import('../types').CalendarEvent[]} pulledGoogleEvents
 * @param {string} rangeStartIso
 * @param {string} rangeEndIso
 * @param {Map<string, number>} [recentlyDeletedGoogleEventIds] - googleEventId -> delete-issued timestamp (ms); defaults to empty (no suppression)
 * @param {Map<string, number>} [recentlyDeletedGoogleEventInstances] - `${masterGoogleEventId}::${occurrenceDateIso}` -> delete-issued timestamp (ms); defaults to empty (no suppression)
 * @param {number} [nowMs] - defaults to Date.now(); overridable for testing
 * @param {string} [purgeBoundaryIso] - trailing edge of the UNION of every range ever synced (see expandSyncedBounds); defaults to rangeStartIso when the caller has no wider union to offer
 * @returns {import('../types').CalendarEvent[]}
 */
export function mergePulledGoogleEvents(
  existingEvents,
  pulledGoogleEvents,
  rangeStartIso,
  rangeEndIso,
  recentlyDeletedGoogleEventIds = new Map(),
  recentlyDeletedGoogleEventInstances = new Map(),
  nowMs = Date.now(),
  purgeBoundaryIso = rangeStartIso
) {
  const manualOwnedGoogleEventIds = new Set(
    existingEvents.filter((e) => e.source === 'manual' && e.googleEventId).map((e) => e.googleEventId)
  );

  const existingByGoogleEventId = new Map(
    existingEvents.filter((e) => e.source === 'google' && e.googleEventId).map((e) => [e.googleEventId, e])
  );

  const freshPulled = pulledGoogleEvents
    .filter(
      (e) =>
        !isRecentlyDeletedLocally(e.googleEventId, recentlyDeletedGoogleEventIds, nowMs) &&
        !manualOwnedGoogleEventIds.has(e.googleEventId)
    )
    .map((e) => applyRecentInstanceDeletes(e, recentlyDeletedGoogleEventInstances, nowMs))
    .map((e) => {
      const local = existingByGoogleEventId.get(e.googleEventId);
      return local ? preserveIgnoredFlag(local, e) : e;
    });

  const pulledByGoogleEventId = new Map(freshPulled.map((e) => [e.googleEventId, e]));

  const survivingLocal = existingEvents.filter((e) => {
    if (e.source !== 'google') return true; // manual events are never touched by a Google pull

    if (pulledByGoogleEventId.has(e.googleEventId)) return false; // superseded below by the pulled version

    // Aged out of the retention window entirely — purge it, don't just leave
    // it untouched (see isTooOldToRetain's own doc comment for why this is
    // NOT the same as the generic "out of scope, leave alone" case below).
    if (isTooOldToRetain(e, purgeBoundaryIso)) return false;

    // Not in the pulled set — either out of scope for this pull (leave
    // alone) or in scope and gone (Google-side delete, drop it).
    return !isInScopeForPull(e, rangeStartIso, rangeEndIso);
  });

  return [...survivingLocal, ...freshPulled];
}

/**
 * Find local `source: 'google'` CalendarEvent rows that represent the SAME
 * logical Google event duplicated across two-or-more distinct, both-real
 * `googleEventId`s — the leftover of a historical duplicate-push bug (see
 * git history around the rewrite/auto-push features), not something
 * `mergePulledGoogleEvents` itself can catch: that function keys everything
 * by `googleEventId`, so two rows with different (but each individually
 * valid) ids never collide there and both survive indefinitely as
 * "legitimate" events.
 *
 * This matters specifically for "rewrite Google Calendar to match TaskFlow"
 * (rewriteGoogleCalendarFromTaskflow in useGoogleCalendarSync.js): without
 * pre-deduping, that feature would see both duplicate rows as independently
 * authoritative and PROTECT both of their Google-side ids from deletion,
 * recreating the exact "duplicate survives a full rewrite" symptom the
 * feature exists to fix.
 *
 * Grouping key is title+date+startTime+endTime+recurrenceRule — the same
 * fields that would make two Google events visually indistinguishable to the
 * user. Within a group of 2+, the row with the most recent `googleUpdatedAt`
 * is kept as canonical; every other row's id in the group is reported as a
 * duplicate local row to drop. The caller doesn't need the duplicates'
 * Google-side ids separately — excluding these rows from whatever it feeds
 * into computeCalendarRewritePlan is enough for that function's own "not
 * claimed by any local item" check to naturally sweep each duplicate's
 * Google-side event into toDelete.
 * @param {import('../types').CalendarEvent[]} events
 * @returns {Set<string>} ids of local CalendarEvent rows that are duplicates to drop
 */
export function findDuplicateGoogleSourcedEvents(events) {
  const key = (e) => `${e.title}|${e.date}|${e.startTime}|${e.endTime}|${e.recurrenceRule || ''}`;
  const byKey = new Map();
  for (const e of events) {
    if (e.source !== 'google') continue;
    const k = key(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const duplicateLocalEventIds = new Set();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [, ...rest] = [...group].sort((a, b) => new Date(b.googleUpdatedAt || 0) - new Date(a.googleUpdatedAt || 0));
    for (const dup of rest) duplicateLocalEventIds.add(dup.id);
  }
  return duplicateLocalEventIds;
}

/**
 * One-time hard reset, run for the first sync after the manual-echo-
 * duplicate fix shipped (see useGoogleCalendarSync's `googleEventsHardReset
 * Done` flag) — an EXPLICIT user-requested tidy-up of accumulated bad local
 * event state (duplicate pairs, orphaned rows, and separately, malformed
 * Google-side instance ids from unrelated recurring-event edge cases) that
 * built up faster than a partial reconcile could reliably chase down.
 *
 * Unlike every other function in this file, this DISCARDS the entire local
 * `events` array — including `source:'manual'` events that were never even
 * pushed to Google — and replaces it wholesale with exactly what this pull
 * returns. This is a deliberate, one-time, user-authorized data loss
 * tradeoff, not a general-purpose merge policy: any purely-local blocked
 * time with no Google counterpart is gone after this runs, and any
 * already-past Google event outside `fetchEvents`' rolling horizon won't
 * come back either (future events roll back into view as the horizon
 * advances day by day; past ones don't). Do not reuse this as a template for
 * a future migration — mergePulledGoogleEvents above is the correct
 * steady-state policy.
 */
export function hardResetEventsFromGoogle(
  pulledGoogleEvents,
  recentlyDeletedGoogleEventIds = new Map(),
  recentlyDeletedGoogleEventInstances = new Map(),
  nowMs = Date.now()
) {
  return pulledGoogleEvents
    .filter((e) => !isRecentlyDeletedLocally(e.googleEventId, recentlyDeletedGoogleEventIds, nowMs))
    .map((e) => applyRecentInstanceDeletes(e, recentlyDeletedGoogleEventInstances, nowMs));
}

/**
 * ============================================================================
 * Synced-range bounds — pure helpers backing useGoogleCalendarSync's
 * "routine 30/30 window, widened on demand by calendar navigation" policy.
 * ============================================================================
 * `bounds` is `{ startIso, endIso }` (or `null` before anything's ever been
 * synced) — the outer edges of the UNION of every range fetched so far, not
 * just the most recent one. Extracted as plain functions (no hook/ref
 * access) so the on-demand-fetch decision and the purge-boundary fix can be
 * unit tested directly, per this repo's convention for cloud-sync's own
 * fingerprint/merge-decision logic (see useCloudSync.js).
 */

/**
 * Folds a freshly-fetched [rangeStartIso, rangeEndIso] into the running
 * union of everything ever synced. The union only ever GROWS — an on-demand
 * fetch that reached further back/forward than the routine window stays
 * "in" for the rest of the session even once a later, narrower routine poll
 * runs (see eventSyncService's module doc for the purge bug this prevents).
 */
export function expandSyncedBounds(bounds, rangeStartIso, rangeEndIso) {
  if (!bounds) return { startIso: rangeStartIso, endIso: rangeEndIso };
  return {
    startIso: rangeStartIso < bounds.startIso ? rangeStartIso : bounds.startIso,
    endIso: rangeEndIso > bounds.endIso ? rangeEndIso : bounds.endIso,
  };
}

/**
 * Given the currently synced union and the date range the calendar view is
 * now showing, returns the additional range that needs fetching to fully
 * cover the view, or `null` if the view already falls entirely within what's
 * synced. Returns the smallest single range covering whatever's missing on
 * either edge (not just the missing sliver) so one fetch call is enough even
 * if the view needs widening on both sides at once — mergePulledGoogleEvents
 * is idempotent for anything it re-fetches, so re-covering already-synced
 * ground alongside the genuinely new part costs nothing but one extra
 * (still single) API round trip.
 */
export function computeOnDemandFetchRange(bounds, viewStartIso, viewEndIso) {
  if (!bounds) return { startIso: viewStartIso, endIso: viewEndIso };
  const needsBack = viewStartIso < bounds.startIso;
  const needsForward = viewEndIso > bounds.endIso;
  if (!needsBack && !needsForward) return null;
  return {
    startIso: needsBack ? viewStartIso : bounds.startIso,
    endIso: needsForward ? viewEndIso : bounds.endIso,
  };
}

/**
 * The effective purge boundary passed to mergePulledGoogleEvents: the LATER
 * (more restrictive, closer to today) of (a) the synced-bounds union's own
 * outer edge and (b) a flat retention ceiling `maxRetentionDays` back from
 * `nowMs`. Once-viewed history (on-demand fetched, see
 * computeOnDemandFetchRange) is meant to stick around for the rest of the
 * session rather than being purged the moment a narrower routine poll comes
 * back around — that's what the synced-bounds union alone would give you.
 * But that union only ever grows outward and never rolls forward with real
 * time, so on its own it would let retention drift past `maxRetentionDays`
 * (e.g. a single on-demand view from 500 days back would keep that stale
 * boundary — and everything back to it — retained forever). Combining it
 * with a retention ceiling that IS recomputed fresh from `nowMs` on every
 * call keeps retention capped at "up to `maxRetentionDays`", not unbounded.
 * ISO date strings compare correctly with plain `<`/`>` (YYYY-MM-DD).
 * @param {string|null} syncedBoundsStartIso - `expandSyncedBounds(...).startIso`, or null if nothing's synced yet
 * @param {number} maxRetentionDays
 * @param {number} [nowMs] - defaults to Date.now(); overridable for testing
 * @returns {string}
 */
// Re-exported from dataRetention.js for backward compatibility. New code should import from dataRetention.js directly.
export const computeEffectivePurgeBoundary = centralized_computeEffectivePurgeBoundary;

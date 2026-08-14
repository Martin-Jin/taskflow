/**
 * ============================================================================
 * googleCalendarService.js — coverage notes
 * ============================================================================
 * Most of this file is a thin wrapper around the live Google Calendar API
 * (`window.gapi`), which isn't practical to unit test without heavy mocking.
 * Two pieces of pure date math were extracted specifically so they could be
 * covered here instead of only by reasoning about a diff:
 *   - `parseExdateToLocalIsoDate` converts one EXDATE value (from a recurring
 *     master event's `recurrence` array) into the local-calendar-date ISO
 *     string `fetchEvents` uses to build that master's `overrides` map,
 *     marking a specific occurrence excluded so expandRecurringEvent doesn't
 *     regenerate a "phantom" occurrence for a date Google has already
 *     cancelled/individually modified.
 *   - `computeFetchTimeRange` converts the inclusive "YYYY-MM-DD" range the
 *     rest of the sync pipeline works in into the `timeMin`/`timeMax`
 *     instants Google's `events.list` expects — see its own doc comment for
 *     a real off-by-one bug this used to have at the inclusive end boundary.
 *   - `instanceMatchesOccurrence` is the pure comparison `resolveInstanceId`
 *     uses to pick the right item out of an `events.instances()` response —
 *     the real, authoritative replacement for a previous client-side-
 *     constructed instance id (`{recurringEventId}_{originalStartTimeUTC}`)
 *     that broke for a master which had itself been split via "this and
 *     following" directly in Google's own UI (a split-off master's own id
 *     already carries a `_R{timestamp}` suffix, so appending a second
 *     constructed suffix on top never matched anything real).
 *   - `planCalendarRewrite` is the pure decision core of "Rewrite Google
 *     Calendar to match TaskFlow" (see its own doc comment in
 *     googleCalendarService.js) — given local authoritative items and
 *     Google's current primary-calendar events, decides delete/insert/update
 *     for each. Covered thoroughly here since it's the single place this
 *     destructive, opt-in feature decides what to delete; the executor
 *     (rewriteGoogleCalendarFromTaskflow in useGoogleCalendarSync.js) that
 *     actually calls the live API isn't unit-testable the same way as the
 *     rest of this file, but its input to this function is.
 *   - `isRateLimitError` is the 429 counterpart to `isAuthError`'s 401 check,
 *     added for this feature's batch executor (see
 *     REWRITE_RATE_LIMIT_BACKOFF_MS in useGoogleCalendarSync.js).
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  parseExdateToLocalIsoDate,
  computeFetchTimeRange,
  isInstanceAlreadyGoneError,
  instanceMatchesOccurrence,
  shouldTreatAsReconnectNeeded,
  planCalendarRewrite,
  isRateLimitError,
} from '../../src/services/googleCalendarService.js';

describe('parseExdateToLocalIsoDate', () => {
  it('parses a UTC ("Z"-suffixed) EXDATE value into its local calendar date', () => {
    // 2026-07-24T20:00:00Z is 2026-07-25 08:00 in a UTC+12 zone, for example —
    // this just asserts it round-trips through Date/toISODate consistently
    // rather than hardcoding a single timezone's expected offset.
    const iso = parseExdateToLocalIsoDate('20260724T200000Z');
    const expected = new Date(Date.UTC(2026, 6, 24, 20, 0, 0));
    const pad2 = (n) => String(n).padStart(2, '0');
    expect(iso).toBe(`${expected.getFullYear()}-${pad2(expected.getMonth() + 1)}-${pad2(expected.getDate())}`);
  });

  it('parses a floating (no "Z") EXDATE value as local wall-clock time', () => {
    expect(parseExdateToLocalIsoDate('20260724T090000')).toBe('2026-07-24');
  });

  it('handles a value with no time component gracefully (defaults to midnight)', () => {
    expect(parseExdateToLocalIsoDate('20260724T000000')).toBe('2026-07-24');
  });

  it('returns null for a value too short to contain a full date', () => {
    expect(parseExdateToLocalIsoDate('202607')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseExdateToLocalIsoDate('not-a-date')).toBeNull();
  });
});

describe('computeFetchTimeRange', () => {
  it('makes timeMax cover all of the inclusive end date, not just its local midnight instant', () => {
    // Regression test: timeMax used to be `fromISODate(endIso).toISOString()`
    // — local midnight at the START of endIso — which is Google's EXCLUSIVE
    // upper bound, so it silently excluded every event actually occurring ON
    // endIso (the horizon's last day). mergePulledGoogleEvents' own
    // `isInScopeForPull` treats that same date as in scope (inclusive), so
    // the mismatch made a still-live event dated exactly on the last day of
    // the sync horizon look Google-side-deleted on every pull.
    const { timeMin, timeMax } = computeFetchTimeRange('2026-08-01', '2026-08-29');
    const localMidnightOfEndIso = new Date(2026, 7, 29, 0, 0, 0).toISOString();
    const localMidnightOfDayAfter = new Date(2026, 7, 30, 0, 0, 0).toISOString();
    expect(timeMax).not.toBe(localMidnightOfEndIso);
    expect(timeMax).toBe(localMidnightOfDayAfter);
    expect(timeMin).toBe(new Date(2026, 7, 1, 0, 0, 0).toISOString());
  });

  it('keeps timeMin/timeMax a single day apart for a one-day range', () => {
    const { timeMin, timeMax } = computeFetchTimeRange('2026-08-01', '2026-08-01');
    expect(new Date(timeMax).getTime() - new Date(timeMin).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('isInstanceAlreadyGoneError', () => {
  // Regression test: an instance delete used to be able to hit a 404 for
  // reasons unrelated to "already deleted" (see instanceMatchesOccurrence's
  // own history below) — a real 410 ("Gone") is the only case that
  // unambiguously confirms a resource existed and was removed.
  it('treats 410 (Gone) as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 410 })).toBe(true);
  });

  it('does NOT treat 404 (Not Found) as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 404 })).toBe(false);
  });

  it('does not treat other errors as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 403 })).toBe(false);
    expect(isInstanceAlreadyGoneError(new Error('network error'))).toBe(false);
  });
});

describe('shouldTreatAsReconnectNeeded', () => {
  // Regression test: the initial silent re-auth effect in
  // useGoogleCalendarSync.js used to disconnect on ANY thrown error from the
  // token refresh step, including transient failures unrelated to a genuine
  // "not connected"/"revoked" state (e.g. a cold-browser-start network
  // hiccup) — this is the extracted decision that now gates that behavior.
  it('treats a confirmed needsReconnect error (Worker 404/409) as reconnect-needed', () => {
    const err = new Error('Google Calendar not yet connected.');
    err.needsReconnect = true;
    expect(shouldTreatAsReconnectNeeded(err)).toBe(true);
  });

  it('does not treat a plain Error (e.g. getFirebaseIdToken throwing) as reconnect-needed', () => {
    expect(shouldTreatAsReconnectNeeded(new Error('Not signed in to Taskflow'))).toBe(false);
  });

  it('does not treat a network failure (TypeError from a failed fetch) as reconnect-needed', () => {
    expect(shouldTreatAsReconnectNeeded(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('does not treat a Worker error without needsReconnect set (e.g. 500) as reconnect-needed', () => {
    const err = new Error('Calendar auth worker refresh failed (HTTP 500).');
    err.needsReconnect = false;
    expect(shouldTreatAsReconnectNeeded(err)).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(shouldTreatAsReconnectNeeded(null)).toBe(false);
    expect(shouldTreatAsReconnectNeeded(undefined)).toBe(false);
  });
});

describe('instanceMatchesOccurrence', () => {
  it('matches an unmodified instance by its plain `start` time', () => {
    const instance = { start: { dateTime: '2026-08-01T20:00:00Z' } };
    // Compare against what that UTC instant actually resolves to locally,
    // rather than hardcoding a single timezone's expected wall-clock time.
    const local = new Date('2026-08-01T20:00:00Z');
    const pad2 = (n) => String(n).padStart(2, '0');
    const localIso = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
    const localHHMM = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
    expect(instanceMatchesOccurrence(instance, localIso, localHHMM)).toBe(true);
  });

  it('matches a moved instance by its ORIGINAL start time, not its new one', () => {
    const instance = {
      originalStartTime: { dateTime: '2026-08-01T20:00:00Z' },
      start: { dateTime: '2026-08-02T09:00:00Z' }, // moved elsewhere
    };
    const local = new Date('2026-08-01T20:00:00Z');
    const pad2 = (n) => String(n).padStart(2, '0');
    const localIso = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
    const localHHMM = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
    expect(instanceMatchesOccurrence(instance, localIso, localHHMM)).toBe(true);
    // And does NOT match the moved-to slot, since that's not this occurrence's original date/time.
    expect(instanceMatchesOccurrence(instance, '2026-08-02', '09:00')).toBe(false);
  });

  it('returns false for a non-matching date/time', () => {
    const instance = { start: { dateTime: '2026-08-01T20:00:00Z' } };
    expect(instanceMatchesOccurrence(instance, '2026-08-03', '08:00')).toBe(false);
  });

  it('returns false when the instance has neither originalStartTime nor start', () => {
    expect(instanceMatchesOccurrence({}, '2026-08-01', '08:00')).toBe(false);
  });
});

describe('planCalendarRewrite', () => {
  // "Rewrite Google Calendar to match TaskFlow" (see googleCalendarService.js's
  // own module doc above planCalendarRewrite) — TaskFlow's local blocks/events
  // become authoritative and Google's PRIMARY calendar is reconciled to match.
  // The single most important property to get right: a subscribed/foreign
  // calendar's events must NEVER be deleted just because they're absent from
  // TaskFlow's local data — that's enforced by this function only ever being
  // handed already-primary-filtered `googleEventsInRange` input (the caller's
  // job, see computeCalendarRewritePlan), so every test here constructs that
  // input as if it already went through that filter.

  it('a local item with no googleEventId is planned as an insert', () => {
    const local = [{ googleEventId: null }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, []);
    expect(toDelete).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({ item: local[0], isUpdate: false });
  });

  it('a local item whose googleEventId still exists on Google is planned as an update', () => {
    const local = [{ googleEventId: 'gcal_1' }];
    const google = [{ id: 'gcal_1' }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({ item: local[0], isUpdate: true });
  });

  it('a local item whose googleEventId is stale/gone from Google falls back to insert, not a doomed update', () => {
    const local = [{ googleEventId: 'gcal_deleted_on_google' }];
    const google = []; // Google no longer has this event — deleted or moved since TaskFlow last saw it
    const { toDelete, toUpsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({ item: local[0], isUpdate: false });
  });

  it('a Google primary-calendar event not present locally at all is scheduled for delete', () => {
    const local = []; // nothing local claims this event
    const google = [{ id: 'gcal_orphaned' }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual(['gcal_orphaned']);
    expect(toUpsert).toEqual([]);
  });

  it('CRITICAL SAFETY: a Google event absent from the pre-filtered primary-calendar input never appears in toDelete', () => {
    // This simulates the caller having already excluded a non-primary/
    // read-only subscribed-calendar event from `googleEventsInRange` (its
    // job, per this function's own doc comment) — planCalendarRewrite never
    // even sees a foreign calendar's event, so it structurally cannot plan a
    // delete for one. Nothing local claims it either (an empty local set),
    // which would normally mean "delete everything Google has" — but since
    // the foreign event was never included in `googleEventsInRange` to begin
    // with, it's simply never a candidate for toDelete at all.
    const local = [];
    const googlePrimaryOnly = [{ id: 'gcal_primary_event' }]; // the foreign-calendar event is NOT in this list
    const { toDelete } = planCalendarRewrite(local, googlePrimaryOnly);
    expect(toDelete).toEqual(['gcal_primary_event']);
    expect(toDelete).not.toContain('gcal_subscribed_calendar_event_should_never_appear');
  });

  it('mixed scenario: insert + update + stale-fallback-to-insert + delete all resolve independently', () => {
    const local = [
      { id: 'new-task', googleEventId: null }, // insert
      { id: 'synced-task', googleEventId: 'gcal_still_there' }, // update
      { id: 'stale-task', googleEventId: 'gcal_long_gone' }, // insert (fallback)
    ];
    const google = [{ id: 'gcal_still_there' }, { id: 'gcal_orphaned_on_google' }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual(['gcal_orphaned_on_google']);
    expect(toUpsert).toHaveLength(3);
    expect(toUpsert.find((u) => u.item.id === 'new-task')).toMatchObject({ isUpdate: false });
    expect(toUpsert.find((u) => u.item.id === 'synced-task')).toMatchObject({ isUpdate: true });
    expect(toUpsert.find((u) => u.item.id === 'stale-task')).toMatchObject({ isUpdate: false });
  });

  it('needsPush: false excludes an item from toUpsert while still protecting its googleEventId from delete', () => {
    // Used by rewriteGoogleCalendarFromTaskflow for events already pulled
    // FROM Google's own primary calendar — they already exist there exactly
    // as-is, so re-pushing them would be a wasted (at best) API call, but
    // they must still count as "claimed" so they aren't deleted.
    const local = [{ id: 'already-synced-event', googleEventId: 'gcal_1', needsPush: false }];
    const google = [{ id: 'gcal_1' }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual([]);
    expect(toUpsert).toEqual([]);
  });

  it('an empty local set plans every in-range primary-calendar Google event for deletion', () => {
    const google = [{ id: 'a' }, { id: 'b' }];
    const { toDelete, toUpsert } = planCalendarRewrite([], google);
    expect(toDelete.sort()).toEqual(['a', 'b']);
    expect(toUpsert).toEqual([]);
  });

  it('an empty Google-side set plans every local item as an insert and nothing to delete', () => {
    const local = [{ googleEventId: null }, { googleEventId: 'gcal_stale' }];
    const { toDelete, toUpsert } = planCalendarRewrite(local, []);
    expect(toDelete).toEqual([]);
    expect(toUpsert.every((u) => u.isUpdate === false)).toBe(true);
  });
});

describe('isRateLimitError', () => {
  it('treats a 429 status as a rate limit error', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it('treats a nested gapi error code of 429 as a rate limit error', () => {
    expect(isRateLimitError({ result: { error: { code: 429 } } })).toBe(true);
  });

  it('does not treat other statuses (e.g. 401, 404, 500) as rate limit errors', () => {
    expect(isRateLimitError({ status: 401 })).toBe(false);
    expect(isRateLimitError({ status: 404 })).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

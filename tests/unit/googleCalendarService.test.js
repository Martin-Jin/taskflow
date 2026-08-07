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
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  parseExdateToLocalIsoDate,
  computeFetchTimeRange,
  isInstanceAlreadyGoneError,
  instanceMatchesOccurrence,
  shouldTreatAsReconnectNeeded,
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

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
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { parseExdateToLocalIsoDate, computeFetchTimeRange } from '../../src/services/googleCalendarService.js';

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

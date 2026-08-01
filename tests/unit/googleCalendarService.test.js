/**
 * ============================================================================
 * parseExdateToLocalIsoDate — coverage notes
 * ============================================================================
 * The only piece of googleCalendarService.js pure enough to unit test
 * without mocking `window.gapi` — everything else in that file is a thin
 * wrapper around the live Google Calendar API. This function converts one
 * EXDATE value (from a recurring master event's `recurrence` array) into
 * the local-calendar-date ISO string `fetchEvents` uses to build that
 * master's `overrides` map, marking a specific occurrence excluded so
 * expandRecurringEvent doesn't regenerate a "phantom" occurrence for a date
 * Google has already cancelled/individually modified. Getting this date
 * math wrong silently reintroduces exactly that bug, so it's covered here
 * per this repo's own convention for date/timezone-sensitive logic.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { parseExdateToLocalIsoDate } from '../../src/services/googleCalendarService.js';

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

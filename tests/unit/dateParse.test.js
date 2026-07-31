import { describe, it, expect } from 'vitest';
import { findDuePhrase, findFixedTimePhrase } from '../../src/utils/dateParse';

// Fixed reference date so tests never depend on the real "today": Friday,
// July 31 2026. Passed explicitly to findDuePhrase (which accepts an
// injectable referenceDate for exactly this reason) so results are
// deterministic regardless of when the suite actually runs.
const REF = new Date(2026, 6, 31); // Friday, 2026-07-31

describe('findDuePhrase', () => {
  it('parses "today" as the reference date itself', () => {
    const result = findDuePhrase('clean the kitchen today', REF);
    expect(result).toEqual({ iso: '2026-07-31', matchedText: 'today', index: 18 });
  });

  it('parses "tomorrow" as reference date + 1 day', () => {
    const result = findDuePhrase('finish report tomorrow', REF);
    expect(result).toEqual({ iso: '2026-08-01', matchedText: 'tomorrow', index: 14 });
  });

  it('parses "yesterday" as reference date - 1 day', () => {
    const result = findDuePhrase('missed the call yesterday', REF);
    expect(result).toEqual({ iso: '2026-07-30', matchedText: 'yesterday', index: 16 });
  });

  it('parses "next <weekday>" as one full week out when today IS that weekday', () => {
    // Reference date is a Friday; "next friday" should skip today entirely
    // and land on the following Friday, not today.
    const result = findDuePhrase('team sync next friday', REF);
    expect(result).toEqual({ iso: '2026-08-07', matchedText: 'next friday', index: 10 });
  });

  it('parses "next <weekday>" as the nearest upcoming occurrence when today is NOT that weekday', () => {
    // Reference date is a Friday; "next monday" should resolve to the coming
    // Monday (3 days out), not skip an extra week.
    const result = findDuePhrase('submit form next monday', REF);
    expect(result).toEqual({ iso: '2026-08-03', matchedText: 'next monday', index: 12 });
  });

  it('parses "this <weekday>" as today itself when today matches', () => {
    const result = findDuePhrase('this friday deadline', REF);
    expect(result).toEqual({ iso: '2026-07-31', matchedText: 'this friday', index: 0 });
  });

  it('parses a bare weekday mention as the next upcoming occurrence', () => {
    const result = findDuePhrase('pay rent sat', REF);
    expect(result).toEqual({ iso: '2026-08-01', matchedText: 'sat', index: 9 });
  });

  it('does not treat a bare weekday right after "every" as a due-date phrase', () => {
    // Reserved for recurrence.js's own weekday-span parser instead.
    const result = findDuePhrase('gym every sat', REF);
    expect(result).toBeNull();
  });

  it('parses "this weekend" as the upcoming Saturday', () => {
    const result = findDuePhrase('road trip this weekend', REF);
    expect(result).toEqual({ iso: '2026-08-01', matchedText: 'this weekend', index: 10 });
  });

  it('parses "next weekend" the same way as "this weekend" (upcoming Saturday)', () => {
    const result = findDuePhrase('road trip next weekend', REF);
    expect(result).toEqual({ iso: '2026-08-01', matchedText: 'next weekend', index: 10 });
  });

  it('parses "end of month" as the last calendar day of the reference month', () => {
    const result = findDuePhrase('renew lease end of month', REF);
    expect(result).toEqual({ iso: '2026-07-31', matchedText: 'end of month', index: 12 });
  });

  it('parses "end of the month" (with "the") the same way', () => {
    const result = findDuePhrase('renew lease end of the month', REF);
    expect(result.iso).toBe('2026-07-31');
    expect(result.matchedText).toBe('end of the month');
  });

  it('parses "end of week" as the upcoming Sunday', () => {
    const result = findDuePhrase('timesheet end of week', REF);
    expect(result).toEqual({ iso: '2026-08-02', matchedText: 'end of week', index: 10 });
  });

  it('parses "in 3 days" as reference date + 3 days', () => {
    const result = findDuePhrase('follow up in 3 days', REF);
    expect(result).toEqual({ iso: '2026-08-03', matchedText: 'in 3 days', index: 10 });
  });

  it('parses "in a couple of weeks" using word-number vocabulary', () => {
    const result = findDuePhrase('check back in a couple of weeks', REF);
    expect(result).toEqual({ iso: '2026-08-14', matchedText: 'in a couple of weeks', index: 11 });
  });

  it('parses "next month" as one calendar month out, same day-of-month', () => {
    const result = findDuePhrase('review budget next month', REF);
    expect(result).toEqual({ iso: '2026-08-31', matchedText: 'next month', index: 14 });
  });

  it('parses "next year" as one calendar year out', () => {
    const result = findDuePhrase('renew passport next year', REF);
    expect(result).toEqual({ iso: '2027-07-31', matchedText: 'next year', index: 15 });
  });

  it('parses an explicit ISO date "2025-03-24" regardless of surrounding text', () => {
    const result = findDuePhrase('meeting 2025-03-24 with client', REF);
    expect(result).toEqual({ iso: '2025-03-24', matchedText: '2025-03-24', index: 8 });
  });

  it('parses a written-out month/day with year ("24 March 2025")', () => {
    const result = findDuePhrase('deadline 24 March 2025', REF);
    // findDuePhrase matches against a lowercased copy of the text, so
    // matchedText comes back lowercase even though the input wasn't.
    expect(result).toEqual({ iso: '2025-03-24', matchedText: '24 march 2025', index: 9 });
  });

  it('parses "March 24th" with no year as the next upcoming March 24 (future when past this year)', () => {
    // Reference date is July 31 2026 — "March 24" with no year has already
    // passed this year, so it should resolve to next year.
    const result = findDuePhrase('deadline March 24th', REF);
    expect(result).toEqual({ iso: '2027-03-24', matchedText: 'march 24th', index: 9 });
  });

  it('parses a numeric day-first date ("24/03/2025")', () => {
    const result = findDuePhrase('invoice due 24/03/2025', REF);
    expect(result).toEqual({ iso: '2025-03-24', matchedText: '24/03/2025', index: 12 });
  });

  it('parses "the 24th" as this month if not yet passed, else next month', () => {
    // Reference date is July 31 — the 24th of this month has already passed,
    // so it should roll to August 24.
    const result = findDuePhrase('pay bill the 24th', REF);
    expect(result).toEqual({ iso: '2026-08-24', matchedText: 'the 24th', index: 9 });
  });

  it('returns null for text with no recognizable date phrase', () => {
    expect(findDuePhrase('buy milk and eggs', REF)).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(findDuePhrase('', REF)).toBeNull();
    expect(findDuePhrase(null, REF)).toBeNull();
    expect(findDuePhrase(undefined, REF)).toBeNull();
  });
});

describe('findFixedTimePhrase', () => {
  it('parses "at 3pm" as 15:00', () => {
    const result = findFixedTimePhrase('call client at 3pm');
    expect(result).toEqual({ time: '15:00', matchedText: 'at 3pm', index: 12 });
  });

  it('parses "at 15:00" (24-hour) as 15:00', () => {
    const result = findFixedTimePhrase('call client at 15:00');
    expect(result).toEqual({ time: '15:00', matchedText: 'at 15:00', index: 12 });
  });

  it('returns null for a fully bare hour with no minutes and no am/pm, even with "at"', () => {
    expect(findFixedTimePhrase('meeting at 9')).toBeNull();
  });

  it('parses "at 17:30" (24-hour, minutes present) as 17:30 with no am/pm required', () => {
    const result = findFixedTimePhrase('meeting at 17:30');
    expect(result).toEqual({ time: '17:30', matchedText: 'at 17:30', index: 8 });
  });

  it('parses "at 12am" as midnight (00:00)', () => {
    const result = findFixedTimePhrase('reminder at 12am');
    expect(result.time).toBe('00:00');
  });

  it('parses "at 12pm" as noon (12:00)', () => {
    const result = findFixedTimePhrase('lunch at 12pm');
    expect(result.time).toBe('12:00');
  });

  it('parses "at 9:30am" including minutes', () => {
    const result = findFixedTimePhrase('call at 9:30am');
    expect(result.time).toBe('09:30');
  });

  it('returns null for an hour out of 12-hour range with am/pm ("at 13pm")', () => {
    expect(findFixedTimePhrase('call at 13pm')).toBeNull();
  });

  it('returns null for an hour out of 24-hour range with no am/pm ("at 24:00")', () => {
    expect(findFixedTimePhrase('call at 24:00')).toBeNull();
  });

  it('returns null for an invalid minute value ("at 3:75")', () => {
    expect(findFixedTimePhrase('call at 3:75')).toBeNull();
  });

  it('parses a standalone time with am/pm even without the "at" trigger word', () => {
    const result = findFixedTimePhrase('meeting 3pm');
    expect(result).toEqual({ time: '15:00', matchedText: '3pm', index: 8 });
  });

  it('parses a standalone time with minutes and am/pm ("9:10pm") without "at"', () => {
    const result = findFixedTimePhrase('call dentist 9:10pm');
    expect(result.time).toBe('21:10');
  });

  it('returns null for a standalone bare 24-hour time with no "at" and no am/pm ("17:30")', () => {
    expect(findFixedTimePhrase('meeting 17:30')).toBeNull();
  });

  it('returns null for a standalone bare hour with no "at" and no am/pm ("9")', () => {
    expect(findFixedTimePhrase('meeting 9')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(findFixedTimePhrase('')).toBeNull();
    expect(findFixedTimePhrase(null)).toBeNull();
  });
});

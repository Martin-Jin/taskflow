import { describe, it, expect } from 'vitest';
import {
  parseRecurrenceRule,
  computeNextDueDate,
  generateTaskOccurrences,
  findRecurrencePhrase,
  buildRecurrenceString,
  MAX_RECURRENCE_COUNT,
} from '../../src/utils/recurrence';

describe('parseRecurrenceRule', () => {
  it('parses a plain weekly rule', () => {
    expect(parseRecurrenceRule('every week')).toEqual({ unit: 'week', count: 1 });
  });

  it('parses a numeric monthly rule', () => {
    expect(parseRecurrenceRule('every 3 months')).toEqual({ unit: 'month', count: 3 });
  });

  it('parses a numeric yearly rule', () => {
    expect(parseRecurrenceRule('every 2 years')).toEqual({ unit: 'year', count: 2 });
  });

  it('parses a specific-weekday-list recurrence ("every mon, wed, fri")', () => {
    expect(parseRecurrenceRule('every mon, wed, fri')).toEqual({ unit: 'week', count: 1, days: [1, 3, 5] });
  });

  it('parses "every N week(s) on <weekday list>" (round-trip shape)', () => {
    expect(parseRecurrenceRule('every 2 weeks on Mon, Wed')).toEqual({ unit: 'week', count: 2, days: [1, 3] });
  });

  it('parses "every other week" as every-2-weeks', () => {
    expect(parseRecurrenceRule('every other week')).toEqual({ unit: 'week', count: 2 });
  });

  it('parses "every weekday" as Mon-Fri', () => {
    expect(parseRecurrenceRule('every weekday')).toEqual({ unit: 'week', count: 1, days: [1, 2, 3, 4, 5] });
  });

  it('parses "every second sunday" as biweekly on Sunday', () => {
    expect(parseRecurrenceRule('every second sunday')).toEqual({ unit: 'week', count: 2, days: [0] });
  });

  it('parses bare adverbial forms with no leading "every"', () => {
    expect(parseRecurrenceRule('monthly')).toEqual({ unit: 'month', count: 1 });
    expect(parseRecurrenceRule('fortnightly')).toEqual({ unit: 'week', count: 2 });
  });

  it('clamps a huge count to MAX_RECURRENCE_COUNT', () => {
    expect(parseRecurrenceRule('every 5000 days')).toEqual({ unit: 'day', count: MAX_RECURRENCE_COUNT });
  });

  it('returns null for an unparseable string', () => {
    expect(parseRecurrenceRule('sometime soon')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseRecurrenceRule(null)).toBeNull();
    expect(parseRecurrenceRule(undefined)).toBeNull();
    expect(parseRecurrenceRule(42)).toBeNull();
  });

  it('returns null when a weekday recurrence phrase is not at the very start of the string', () => {
    // parseRecurrenceRule's contract is "does the WHOLE string represent a
    // recurrence" — a weekday phrase buried later in a longer string (unlike
    // findRecurrencePhrase, which searches anywhere) should not match.
    expect(parseRecurrenceRule('call bob every monday sometime')).toBeNull();
  });

  it('parses a weekday recurrence when it is the whole string', () => {
    expect(parseRecurrenceRule('every monday')).toEqual({ unit: 'week', count: 1, days: [1] });
  });
});

describe('computeNextDueDate', () => {
  it('advances by a plain day count', () => {
    expect(computeNextDueDate('2026-07-31', 'every day')).toBe('2026-08-01');
  });

  it('advances a week correctly across a month boundary', () => {
    expect(computeNextDueDate('2026-07-28', 'every week')).toBe('2026-08-04');
  });

  it('rolls a monthly recurrence from Jan 31 into Feb 28 (non-leap year)', () => {
    expect(computeNextDueDate('2025-01-31', 'every month')).toBe('2025-02-28');
  });

  it('rolls a monthly recurrence from Jan 31 into Feb 29 (leap year)', () => {
    expect(computeNextDueDate('2024-01-31', 'every month')).toBe('2024-02-29');
  });

  it('rolls month-end date over successive months without re-anchoring to the clamped day', () => {
    // Recurrence math should re-derive from the ORIGINAL date each time, not
    // drift downward permanently once clamped into a short month.
    const afterFeb = computeNextDueDate('2025-01-31', 'every month'); // -> 2025-02-28
    const afterMar = computeNextDueDate(afterFeb, 'every month'); // advancing from the (clamped) Feb 28
    expect(afterMar).toBe('2025-03-28');
  });

  it('advances a yearly recurrence, including across a leap day', () => {
    expect(computeNextDueDate('2024-02-29', 'every year')).toBe('2025-02-28');
  });

  it('falls back to +1 day when the recurrence string does not parse', () => {
    expect(computeNextDueDate('2026-07-31', 'not a recurrence')).toBe('2026-08-01');
  });

  it('falls back to +1 day when the recurrence string is missing', () => {
    expect(computeNextDueDate('2026-07-31', null)).toBe('2026-08-01');
  });
});

describe('generateTaskOccurrences', () => {
  it('returns [] when the task has no recurrenceRule', () => {
    expect(generateTaskOccurrences({ dueDate: '2026-07-01' }, '2026-07-01', '2026-07-31')).toEqual([]);
  });

  it('returns [] when the range ends before the first occurrence', () => {
    const task = { dueDate: '2026-08-15', recurrenceRule: { unit: 'day', count: 1 } };
    expect(generateTaskOccurrences(task, '2026-07-01', '2026-07-31')).toEqual([]);
  });

  it('generates every daily occurrence within range, including the range end boundary', () => {
    const task = { dueDate: '2026-07-01', recurrenceRule: { unit: 'day', count: 1 } };
    const occurrences = generateTaskOccurrences(task, '2026-07-01', '2026-07-05');
    expect(occurrences).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']);
  });

  it('generates weekly occurrences for a specific weekday list', () => {
    // dueDate 2026-07-01 is a Wednesday; days [1,3,5] = Mon/Wed/Fri.
    const task = { dueDate: '2026-07-01', recurrenceRule: { unit: 'week', count: 1, days: [1, 3, 5] } };
    const occurrences = generateTaskOccurrences(task, '2026-07-01', '2026-07-14');
    expect(occurrences).toEqual(['2026-07-01', '2026-07-03', '2026-07-06', '2026-07-08', '2026-07-10', '2026-07-13']);
  });

  it('includes the first occurrence (task.dueDate) when it falls exactly on the range start', () => {
    const task = { dueDate: '2026-07-10', recurrenceRule: { unit: 'day', count: 2 } };
    const occurrences = generateTaskOccurrences(task, '2026-07-10', '2026-07-10');
    expect(occurrences).toEqual(['2026-07-10']);
  });

  it('excludes occurrences that fall after the range end', () => {
    const task = { dueDate: '2026-07-01', recurrenceRule: { unit: 'day', count: 3 } };
    // Occurrences would be 07-01, 07-04, 07-07 ... range ends just before 07-07.
    const occurrences = generateTaskOccurrences(task, '2026-07-01', '2026-07-06');
    expect(occurrences).toEqual(['2026-07-01', '2026-07-04']);
  });

  it('handles monthly recurrence rolling from a month-end date into shorter months', () => {
    // NOTE: each occurrence is computed independently from the ORIGINAL
    // anchor date (task.dueDate), not chained from the previous (possibly
    // clamped) occurrence like computeNextDueDate does. So March lands back
    // on the 31st (its own full month) rather than staying clamped at 28 —
    // a real behavioral difference from computeNextDueDate's sequential
    // "complete one at a time" semantics; see final report.
    const task = { dueDate: '2025-01-31', recurrenceRule: { unit: 'month', count: 1 } };
    const occurrences = generateTaskOccurrences(task, '2025-01-01', '2025-04-30');
    expect(occurrences).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
  });

  it('maps a yearly rule onto a 12*count-month interval', () => {
    const task = { dueDate: '2024-02-29', recurrenceRule: { unit: 'year', count: 1 } };
    const occurrences = generateTaskOccurrences(task, '2024-01-01', '2026-12-31');
    expect(occurrences).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
  });
});

describe('findRecurrencePhrase', () => {
  it('finds a recurrence phrase anywhere inside a longer title', () => {
    const result = findRecurrencePhrase('pay rent every month please');
    expect(result).not.toBeNull();
    expect(result.rule).toEqual({ unit: 'month', count: 1 });
    expect(result.matchedText).toBe('every month');
  });

  it('returns null when no recurrence phrase is present', () => {
    expect(findRecurrencePhrase('buy groceries tomorrow')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(findRecurrencePhrase(null)).toBeNull();
  });

  it('finds a bare adverbial form anywhere in the text', () => {
    const result = findRecurrencePhrase('take out trash weekly on Tuesdays');
    expect(result).not.toBeNull();
    expect(result.rule.unit).toBe('week');
  });
});

describe('buildRecurrenceString', () => {
  it('builds a singular day string', () => {
    expect(buildRecurrenceString(1, 'day')).toBe('every 1 day');
  });

  it('builds a plural week string', () => {
    expect(buildRecurrenceString(2, 'week')).toBe('every 2 weeks');
  });

  it('builds a weekday-specific string when days are given', () => {
    expect(buildRecurrenceString(1, 'week', [1, 3, 5])).toBe('every week on Mon, Wed, Fri');
  });

  it('builds a plural weekday-specific string when count > 1', () => {
    expect(buildRecurrenceString(2, 'week', [1, 3])).toBe('every 2 weeks on Mon, Wed');
  });

  it('clamps an out-of-range count when building', () => {
    expect(buildRecurrenceString(0, 'month')).toBe('every 1 month');
    expect(buildRecurrenceString(999999, 'day')).toBe(`every ${MAX_RECURRENCE_COUNT} days`);
  });

  it('round-trips build -> parse for a plain numeric rule', () => {
    const str = buildRecurrenceString(3, 'month');
    expect(parseRecurrenceRule(str)).toEqual({ unit: 'month', count: 3 });
  });

  it('round-trips build -> parse for a weekday-specific rule', () => {
    const str = buildRecurrenceString(2, 'week', [1, 3, 5]);
    expect(parseRecurrenceRule(str)).toEqual({ unit: 'week', count: 2, days: [1, 3, 5] });
  });

  it('round-trips build -> parse -> build for a single-count weekday rule', () => {
    const str = buildRecurrenceString(1, 'week', [0, 6]);
    const rule = parseRecurrenceRule(str);
    expect(rule).toEqual({ unit: 'week', count: 1, days: [0, 6] });
    expect(buildRecurrenceString(rule.count, rule.unit, rule.days)).toBe(str);
  });
});

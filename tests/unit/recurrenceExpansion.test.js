import { describe, it, expect } from 'vitest';
import {
  parseRRule,
  buildRRuleString,
  generateRuleOccurrences,
  truncateRuleUntil,
  ruleEndDate,
  rebaseRuleForSplit,
  expandRecurringEvent,
  expandEventsForRange,
} from '../../src/utils/recurrenceExpansion';

describe('parseRRule', () => {
  it('parses a simple daily rule with defaults', () => {
    expect(parseRRule('FREQ=DAILY')).toEqual({ freq: 'DAILY', interval: 1, byDay: null, count: null, until: null });
  });

  it('parses INTERVAL, BYDAY, COUNT, and UNTIL together', () => {
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10;UNTIL=20261231')).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      byDay: [1, 3],
      count: 10,
      until: '2026-12-31',
    });
  });

  it('parses a UNTIL with a time component, keeping only the date portion', () => {
    const rule = parseRRule('FREQ=DAILY;UNTIL=20261231T235959Z');
    expect(rule.until).toBe('2026-12-31');
  });

  it('returns null for a missing FREQ', () => {
    expect(parseRRule('INTERVAL=2')).toBeNull();
  });

  it('returns null for an unsupported FREQ (e.g. YEARLY)', () => {
    expect(parseRRule('FREQ=YEARLY')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseRRule(null)).toBeNull();
    expect(parseRRule(undefined)).toBeNull();
  });

  it('drops unrecognized BYDAY codes but keeps the valid ones', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,XX,FR').byDay).toEqual([1, 5]);
  });
});

describe('buildRRuleString — inverse of parseRRule, for the event-creation UI', () => {
  it('builds a bare daily rule with no extras', () => {
    expect(buildRRuleString({ freq: 'DAILY' })).toBe('FREQ=DAILY');
  });

  it('omits INTERVAL when it is 1 (the default), includes it otherwise', () => {
    expect(buildRRuleString({ freq: 'WEEKLY', interval: 1 })).toBe('FREQ=WEEKLY');
    expect(buildRRuleString({ freq: 'WEEKLY', interval: 3 })).toBe('FREQ=WEEKLY;INTERVAL=3');
  });

  it('includes BYDAY only for WEEKLY, ignoring it for DAILY/MONTHLY', () => {
    expect(buildRRuleString({ freq: 'WEEKLY', byDay: [1, 3] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(buildRRuleString({ freq: 'MONTHLY', byDay: [1, 3] })).toBe('FREQ=MONTHLY');
  });

  it('prefers COUNT over UNTIL when both are given', () => {
    expect(buildRRuleString({ freq: 'DAILY', count: 5, until: '2026-12-31' })).toBe('FREQ=DAILY;COUNT=5');
  });

  it('builds UNTIL with dashes stripped, matching parseRRule\'s expected format', () => {
    expect(buildRRuleString({ freq: 'DAILY', until: '2026-12-31' })).toBe('FREQ=DAILY;UNTIL=20261231');
  });

  it('round-trips through parseRRule for a full rule', () => {
    const rule = { freq: 'WEEKLY', interval: 2, byDay: [1, 3], count: 10, until: null };
    expect(parseRRule(buildRRuleString(rule))).toEqual(rule);
  });
});

describe('generateRuleOccurrences', () => {
  it('includes an occurrence that falls exactly on the range start boundary', () => {
    const rule = { freq: 'DAILY', interval: 1, byDay: null, count: null };
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-03', '2026-07-10');
    expect(dates[0]).toBe('2026-07-03');
  });

  it('includes an occurrence that falls exactly on the range end (hardStop) boundary', () => {
    const rule = { freq: 'DAILY', interval: 1, byDay: null, count: null };
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-01', '2026-07-05');
    expect(dates[dates.length - 1]).toBe('2026-07-05');
  });

  it('excludes an occurrence that falls one day after hardStop', () => {
    const rule = { freq: 'DAILY', interval: 2, byDay: null, count: null };
    // Occurrences: 07-01, 07-03, 07-05, 07-07 ... hardStop at 07-06 should exclude 07-07.
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-01', '2026-07-06');
    expect(dates).toEqual(['2026-07-01', '2026-07-03', '2026-07-05']);
  });

  it('honors COUNT relative to DTSTART even when rangeStart is later (occurrences before rangeStart still count against COUNT)', () => {
    const rule = { freq: 'DAILY', interval: 1, byDay: null, count: 3 };
    // COUNT=3 means occurrences 07-01, 07-02, 07-03 total; querying from 07-02 should only surface the remaining 2.
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-02', '2026-07-31');
    expect(dates).toEqual(['2026-07-02', '2026-07-03']);
  });

  it('generates WEEKLY+BYDAY occurrences, excluding BYDAY matches before DTSTART in its own week', () => {
    // 2026-07-01 is a Wednesday. BYDAY=MO,WE,FR: Monday of that week (06-29) is before DTSTART and must be excluded.
    const rule = { freq: 'WEEKLY', interval: 1, byDay: [1, 3, 5], count: null };
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-01', '2026-07-10');
    expect(dates).toEqual(['2026-07-01', '2026-07-03', '2026-07-06', '2026-07-08', '2026-07-10']);
  });

  it('generates WEEKLY+BYDAY with COUNT, counting every matched weekday not every week', () => {
    const rule = { freq: 'WEEKLY', interval: 1, byDay: [1, 3, 5], count: 4 };
    const dates = generateRuleOccurrences('2026-07-01', rule, '2026-07-01', '2026-12-31');
    expect(dates).toEqual(['2026-07-01', '2026-07-03', '2026-07-06', '2026-07-08']);
  });

  it('handles MONTHLY occurrences clamped into shorter months', () => {
    const rule = { freq: 'MONTHLY', interval: 1, byDay: null, count: null };
    const dates = generateRuleOccurrences('2026-01-31', rule, '2026-01-01', '2026-05-31');
    // Each occurrence is computed directly from DTSTART (Jan 31), clamped per-target-month.
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('returns an empty array when the range is entirely before DTSTART', () => {
    const rule = { freq: 'DAILY', interval: 1, byDay: null, count: null };
    const dates = generateRuleOccurrences('2026-07-10', rule, '2026-07-01', '2026-07-05');
    expect(dates).toEqual([]);
  });
});

describe('truncateRuleUntil', () => {
  it('sets UNTIL to the given date and strips any existing UNTIL/COUNT', () => {
    const result = truncateRuleUntil('FREQ=WEEKLY;INTERVAL=2;COUNT=20', '2026-08-15');
    expect(result).toBe('FREQ=WEEKLY;INTERVAL=2;UNTIL=20260815');
  });

  it('strips a pre-existing UNTIL before applying the new one', () => {
    const result = truncateRuleUntil('FREQ=DAILY;UNTIL=20301231', '2026-08-15');
    expect(result).toBe('FREQ=DAILY;UNTIL=20260815');
  });
});

describe('ruleEndDate', () => {
  it('returns null for an open-ended rule (no COUNT or UNTIL)', () => {
    expect(ruleEndDate('2026-07-01', 'FREQ=DAILY')).toBeNull();
  });

  it('returns the UNTIL date directly when no COUNT is present', () => {
    expect(ruleEndDate('2026-07-01', 'FREQ=DAILY;UNTIL=20260901')).toBe('2026-09-01');
  });

  it('resolves a COUNT-bound rule to the actual last occurrence date', () => {
    const result = ruleEndDate('2026-07-01', 'FREQ=DAILY;INTERVAL=1;COUNT=5');
    expect(result).toBe('2026-07-05');
  });

  it('resolves a COUNT-bound WEEKLY+BYDAY rule to its actual last matching weekday', () => {
    // Wed 2026-07-01, BYDAY=MO,WE,FR, COUNT=4 -> 07-01, 07-03, 07-06, 07-08.
    const result = ruleEndDate('2026-07-01', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4');
    expect(result).toBe('2026-07-08');
  });
});

describe('rebaseRuleForSplit', () => {
  it('keeps an open-ended rule open-ended after rebasing', () => {
    const result = rebaseRuleForSplit('FREQ=WEEKLY;INTERVAL=1', '2026-07-01', '2026-08-01');
    expect(result).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  it('reapplies the original end bound as a plain UNTIL when it is still after the new DTSTART', () => {
    const result = rebaseRuleForSplit('FREQ=DAILY;COUNT=10', '2026-07-01', '2026-07-05');
    // Original rule's 10th daily occurrence from 07-01 is 07-10, still after the new DTSTART.
    expect(result).toBe('FREQ=DAILY;UNTIL=20260710');
  });

  it('drops the end bound entirely when it falls before the new DTSTART', () => {
    const result = rebaseRuleForSplit('FREQ=DAILY;COUNT=3', '2026-07-01', '2026-07-10');
    // Original rule's last occurrence (07-03) is before the new DTSTART (07-10).
    expect(result).toBe('FREQ=DAILY');
  });
});

describe('expandRecurringEvent', () => {
  const baseEvent = { id: 'evt1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', recurrenceRule: 'FREQ=DAILY;INTERVAL=1' };

  it('returns the master event unchanged when there is no recurrenceRule', () => {
    const evt = { id: 'evt2', date: '2026-07-01' };
    expect(expandRecurringEvent(evt, '2026-07-01', '2026-07-31')).toEqual([evt]);
  });

  it('returns the master event unchanged when the recurrenceRule is unparseable', () => {
    const evt = { ...baseEvent, recurrenceRule: 'FREQ=YEARLY' };
    expect(expandRecurringEvent(evt, '2026-07-01', '2026-07-31')).toEqual([evt]);
  });

  it('expands into one virtual instance per day, each with a stable ::date-suffixed id', () => {
    const results = expandRecurringEvent(baseEvent, '2026-07-01', '2026-07-03');
    expect(results.map((r) => r.id)).toEqual(['evt1::2026-07-01', 'evt1::2026-07-02', 'evt1::2026-07-03']);
    expect(results.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('applies an override to move a single occurrence to a different date', () => {
    const evt = { ...baseEvent, overrides: { '2026-07-02': { date: '2026-07-15' } } };
    const results = expandRecurringEvent(evt, '2026-07-01', '2026-07-20');
    const moved = results.find((r) => r.id === 'evt1::2026-07-02');
    expect(moved.date).toBe('2026-07-15');
  });

  it('surfaces a moved occurrence whose original date is outside the queried range', () => {
    // Original date 2026-06-15 is before the DTSTART/range; the override moves it into range.
    const evt = { ...baseEvent, date: '2026-07-01', overrides: { '2026-06-15': { date: '2026-07-10' } } };
    const results = expandRecurringEvent(evt, '2026-07-01', '2026-07-31');
    const moved = results.find((r) => r.id === 'evt1::2026-06-15');
    expect(moved).toBeDefined();
    expect(moved.date).toBe('2026-07-10');
  });

  it('drops a deleted single-occurrence override entirely', () => {
    const evt = { ...baseEvent, overrides: { '2026-07-02': { deleted: true } } };
    const results = expandRecurringEvent(evt, '2026-07-01', '2026-07-03');
    expect(results.map((r) => r.id)).toEqual(['evt1::2026-07-01', 'evt1::2026-07-03']);
  });

  it('honors a UNTIL bound narrower than the queried range', () => {
    const evt = { ...baseEvent, recurrenceRule: 'FREQ=DAILY;UNTIL=20260702' };
    const results = expandRecurringEvent(evt, '2026-07-01', '2026-07-10');
    expect(results.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);
  });
});

describe('expandEventsForRange', () => {
  it('passes non-recurring events through untouched regardless of their date', () => {
    const events = [{ id: 'plain1', date: '2099-01-01' }];
    expect(expandEventsForRange(events, '2026-07-01', '2026-07-31')).toEqual(events);
  });

  it('expands recurring events and leaves non-recurring ones alone in the same list', () => {
    const recurring = { id: 'r1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', recurrenceRule: 'FREQ=DAILY' };
    const plain = { id: 'p1', date: '2026-07-02', startTime: '11:00', endTime: '12:00' };
    const results = expandEventsForRange([recurring, plain], '2026-07-01', '2026-07-02');
    expect(results.map((r) => r.id)).toEqual(['r1::2026-07-01', 'r1::2026-07-02', 'p1']);
  });
});

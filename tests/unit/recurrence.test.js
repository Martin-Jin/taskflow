import { describe, it, expect } from 'vitest';
import {
  parseRecurrenceRule,
  computeNextDueDate,
  computeFirstMatchingDueDate,
  computeRecurringRescheduleUpdate,
  computeRecurrenceSyncUpdates,
  generateTaskOccurrences,
  expandTaskOccurrences,
  findRecurrencePhrase,
  buildRecurrenceString,
  MAX_RECURRENCE_COUNT,
} from '../../src/utils/recurrence';
import { isBlockTaskCompleted } from '../../src/utils/missedTasks';

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

  it('advances a Mon/Wed weekday rule from Monday to the same week\'s Wednesday', () => {
    // 2026-08-03 is a Monday.
    expect(computeNextDueDate('2026-08-03', 'every week on Mon, Wed')).toBe('2026-08-05');
  });

  it('advances a Mon/Wed weekday rule from Wednesday to the following week\'s Monday', () => {
    // 2026-08-05 is a Wednesday; next matching day wraps to the following Monday.
    expect(computeNextDueDate('2026-08-05', 'every week on Mon, Wed')).toBe('2026-08-10');
  });

  it('advances an every-2-weeks-on-Monday rule by a full 2-week cycle after wrapping', () => {
    // 2026-08-03 is a Monday; only day in the list, so wrap uses the 2-week interval.
    expect(computeNextDueDate('2026-08-03', 'every 2 weeks on Mon')).toBe('2026-08-17');
  });
});

describe('computeFirstMatchingDueDate', () => {
  it('returns the anchor unchanged for a plain (non-weekday-specific) rule', () => {
    expect(computeFirstMatchingDueDate('2026-08-06', 'every week')).toBe('2026-08-06');
  });

  it('returns the anchor unchanged when it already matches a weekday-specific rule', () => {
    // 2026-08-06 is a Thursday.
    expect(computeFirstMatchingDueDate('2026-08-06', 'every week on Thu')).toBe('2026-08-06');
  });

  it('snaps forward to the nearest matching weekday, same week, when the anchor does not match', () => {
    // 2026-08-06 is a Thursday; "every week on Mon, Wed, Fri" -> next match is Friday 08-07.
    expect(computeFirstMatchingDueDate('2026-08-06', 'every week on Mon, Wed, Fri')).toBe('2026-08-07');
  });

  it('handles a non-consecutive weekday rule like "every Wed and Sun"', () => {
    // 2026-08-06 is a Thursday; "every week on Wed, Sun" -> next match wraps to Sunday 08-09.
    expect(computeFirstMatchingDueDate('2026-08-06', 'every week on Wed, Sun')).toBe('2026-08-09');
  });

  it('falls back to the anchor when the recurrence string does not parse', () => {
    expect(computeFirstMatchingDueDate('2026-08-06', 'not a recurrence')).toBe('2026-08-06');
  });
});

describe('computeRecurringRescheduleUpdate', () => {
  // Regression coverage for the bug where rescheduling a recurring task's
  // (or sub-task's) due date back onto an occurrence already recorded as
  // done left it showing completed forever — see SchedulerContext.updateTask.

  it('drops a completedDates entry on/after the new due date when rescheduling back onto it', () => {
    const task = { isRecurring: true, dueDate: '2026-08-07', completedDates: ['2026-08-06'] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '2026-08-06' })).toEqual({
      completedDates: [],
    });
  });

  it('keeps completedDates entries strictly before the new due date', () => {
    const task = { isRecurring: true, dueDate: '2026-08-10', completedDates: ['2026-08-03', '2026-08-06'] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '2026-08-06' })).toEqual({
      completedDates: ['2026-08-03'],
    });
  });

  it('is a no-op for a non-recurring task', () => {
    const task = { isRecurring: false, dueDate: '2026-08-07', completedDates: ['2026-08-07'] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '2026-08-06' })).toEqual({});
  });

  it('is a no-op when the update does not touch dueDate', () => {
    const task = { isRecurring: true, dueDate: '2026-08-07', completedDates: ['2026-08-07'] };
    expect(computeRecurringRescheduleUpdate(task, { title: 'Renamed' })).toEqual({});
  });

  it('is a no-op when dueDate is set to the same value', () => {
    const task = { isRecurring: true, dueDate: '2026-08-07', completedDates: ['2026-08-07'] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '2026-08-07' })).toEqual({});
  });

  it('falls back to the existing dueDate when the update tries to clear it', () => {
    const task = { isRecurring: true, dueDate: '2026-08-07', completedDates: [] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '' })).toEqual({ dueDate: '2026-08-07' });
    expect(computeRecurringRescheduleUpdate(task, { dueDate: null })).toEqual({ dueDate: '2026-08-07' });
  });

  it('leaves dueDate alone when the recurring task never had one (valid pre-existing state)', () => {
    const task = { isRecurring: true, dueDate: null, completedDates: [] };
    expect(computeRecurringRescheduleUpdate(task, { dueDate: '' })).toEqual({});
  });

  // Regression coverage for the bug where moving a single occurrence of a
  // Mon/Wed/Fri task onto an off-pattern day (e.g. Thursday) re-anchored the
  // WHOLE series onto that day — since generateTaskOccurrences still filters
  // by the same weekdays, the series then generated no nearby occurrences at
  // all, so the scheduler silently dropped it and its remaining hours showed
  // as 0. See rebalanceEngine.js's expandRecurringTasks / expandTaskOccurrences.
  describe('off-pattern single-occurrence moves', () => {
    const mwfTask = {
      isRecurring: true,
      dueDate: '2026-08-07', // Friday
      recurrenceRule: { unit: 'week', count: 1, days: [1, 3, 5] }, // Mon/Wed/Fri
      completedDates: [],
    };

    it('records an override and keeps the series anchored when moved off-pattern', () => {
      expect(computeRecurringRescheduleUpdate(mwfTask, { dueDate: '2026-08-06' })).toEqual({
        dueDate: '2026-08-07',
        overrides: { '2026-08-07': { date: '2026-08-06' } },
      });
    });

    it('merges into any pre-existing overrides rather than replacing them', () => {
      const withOverrides = { ...mwfTask, overrides: { '2026-07-31': { date: '2026-08-01' } } };
      expect(computeRecurringRescheduleUpdate(withOverrides, { dueDate: '2026-08-06' })).toEqual({
        dueDate: '2026-08-07',
        overrides: {
          '2026-07-31': { date: '2026-08-01' },
          '2026-08-07': { date: '2026-08-06' },
        },
      });
    });

    it('re-anchors normally (no override) when moved to an on-pattern date', () => {
      expect(computeRecurringRescheduleUpdate(mwfTask, { dueDate: '2026-08-10' })).toEqual({
        completedDates: [],
      });
    });
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

describe('expandTaskOccurrences', () => {
  it('behaves identically to generateTaskOccurrences when there are no overrides (backward compatible)', () => {
    const task = { dueDate: '2026-07-01', recurrenceRule: { unit: 'day', count: 1 } };
    const occurrences = expandTaskOccurrences(task, '2026-07-01', '2026-07-05');
    expect(occurrences).toEqual([
      { originalDate: '2026-07-01', date: '2026-07-01' },
      { originalDate: '2026-07-02', date: '2026-07-02' },
      { originalDate: '2026-07-03', date: '2026-07-03' },
      { originalDate: '2026-07-04', date: '2026-07-04' },
      { originalDate: '2026-07-05', date: '2026-07-05' },
    ]);
  });

  it('moves a single occurrence off-pattern to its overridden date without touching the others', () => {
    // Mon/Wed/Fri task; move the 2026-07-06 (Monday) occurrence to Thursday 2026-07-09.
    const task = {
      dueDate: '2026-07-01',
      recurrenceRule: { unit: 'week', count: 1, days: [1, 3, 5] },
      overrides: { '2026-07-06': { date: '2026-07-09' } },
    };
    const occurrences = expandTaskOccurrences(task, '2026-07-01', '2026-07-10');
    expect(occurrences).toEqual([
      { originalDate: '2026-07-01', date: '2026-07-01' },
      { originalDate: '2026-07-03', date: '2026-07-03' },
      { originalDate: '2026-07-08', date: '2026-07-08' },
      { originalDate: '2026-07-06', date: '2026-07-09' },
      { originalDate: '2026-07-10', date: '2026-07-10' },
    ]);
  });

  it('includes an occurrence moved INTO the requested range even though its original date is outside it', () => {
    const task = {
      dueDate: '2026-07-01',
      recurrenceRule: { unit: 'day', count: 1 },
      overrides: { '2026-06-29': { date: '2026-07-02' } },
    };
    // 2026-06-29 isn't a valid occurrence of this daily task anchored 2026-07-01
    // anyway, so use a task whose pattern legitimately includes a date outside
    // the query range but moved into it.
    const weekdayTask = {
      dueDate: '2026-07-01',
      recurrenceRule: { unit: 'week', count: 1, days: [3] }, // every Wednesday
      overrides: { '2026-06-24': { date: '2026-07-02' } }, // a Wed before the query range, moved into it
    };
    expect(expandTaskOccurrences(weekdayTask, '2026-07-01', '2026-07-08')).toEqual([
      { originalDate: '2026-07-01', date: '2026-07-01' },
      { originalDate: '2026-06-24', date: '2026-07-02' },
      { originalDate: '2026-07-08', date: '2026-07-08' },
    ]);
  });

  it('excludes an occurrence moved OUT of the requested range', () => {
    const task = {
      dueDate: '2026-07-01',
      recurrenceRule: { unit: 'day', count: 1 },
      overrides: { '2026-07-03': { date: '2026-07-20' } },
    };
    const occurrences = expandTaskOccurrences(task, '2026-07-01', '2026-07-05');
    expect(occurrences).toEqual([
      { originalDate: '2026-07-01', date: '2026-07-01' },
      { originalDate: '2026-07-02', date: '2026-07-02' },
      { originalDate: '2026-07-04', date: '2026-07-04' },
      { originalDate: '2026-07-05', date: '2026-07-05' },
    ]);
  });

  it('drops an occurrence entirely when its override sets deleted: true', () => {
    const task = {
      dueDate: '2026-07-01',
      recurrenceRule: { unit: 'day', count: 1 },
      overrides: { '2026-07-03': { deleted: true } },
    };
    const occurrences = expandTaskOccurrences(task, '2026-07-01', '2026-07-05');
    expect(occurrences).toEqual([
      { originalDate: '2026-07-01', date: '2026-07-01' },
      { originalDate: '2026-07-02', date: '2026-07-02' },
      { originalDate: '2026-07-04', date: '2026-07-04' },
      { originalDate: '2026-07-05', date: '2026-07-05' },
    ]);
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

describe('computeRecurrenceSyncUpdates', () => {
  it('returns an empty map when no tasks are recurring', () => {
    const tasks = [{ id: 'p1' }, { id: 's1', parentId: 'p1' }];
    expect(computeRecurrenceSyncUpdates(tasks).size).toBe(0);
  });

  it('returns an empty map when a parent/sub-task chain already agrees on recurrence', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1', isRecurring: true, recurrenceString: 'every week' },
    ];
    expect(computeRecurrenceSyncUpdates(tasks).size).toBe(0);
  });

  it('propagates a recurring parent\'s cadence down onto a non-recurring sub-task', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.size).toBe(1);
    expect(updates.get('s1')).toEqual({
      isRecurring: true,
      recurrenceString: 'every week',
      recurrenceRule: { unit: 'week', count: 1 },
    });
  });

  it('propagates a recurring sub-task\'s cadence up onto its non-recurring parent', () => {
    const tasks = [
      { id: 'p1' },
      { id: 's1', parentId: 'p1', isRecurring: true, recurrenceString: 'every month' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.size).toBe(1);
    expect(updates.get('p1')).toEqual({
      isRecurring: true,
      recurrenceString: 'every month',
      recurrenceRule: { unit: 'month', count: 1 },
    });
  });

  it('prefers the nearest recurring ANCESTOR over a recurring descendant when both exist', () => {
    // p1 is recurring "every week"; sub-task s1 is not recurring, but its own
    // child gs1 is recurring "every day". s1 should adopt the parent's cadence.
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1' },
      { id: 'gs1', parentId: 's1', isRecurring: true, recurrenceString: 'every day' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.get('s1')).toEqual({
      isRecurring: true,
      recurrenceString: 'every week',
      recurrenceRule: { unit: 'week', count: 1 },
    });
  });

  it('falls back to a recurring descendant when no ancestor is recurring, walking 2 levels deep', () => {
    const tasks = [
      { id: 'p1' },
      { id: 's1', parentId: 'p1' },
      { id: 'gs1', parentId: 's1', isRecurring: true, recurrenceString: 'every 3 days' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.size).toBe(2);
    expect(updates.get('p1').recurrenceString).toBe('every 3 days');
    expect(updates.get('s1').recurrenceString).toBe('every 3 days');
  });

  it('sets isRecurring on a propagated task even when it has no dueDate of its own', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1', dueDate: null },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.get('s1').isRecurring).toBe(true);
  });

  it('propagates the recurring relative\'s dueDate onto the synced task', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week', dueDate: '2026-08-10' },
      { id: 's1', parentId: 'p1' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.get('s1').dueDate).toBe('2026-08-10');
  });

  it('does not set a dueDate when the recurring relative has none of its own', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week', dueDate: null },
      { id: 's1', parentId: 'p1' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.get('s1').dueDate).toBeUndefined();
  });

  it('snaps the propagated dueDate to the first date actually matching a weekday-specific rule', () => {
    // p1's own dueDate (2026-08-06, a Thursday) doesn't itself fall on Wed/Sun
    // -- the sub-task's synced dueDate must land on a day the rule allows.
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week on Wed, Sun', dueDate: '2026-08-06' },
      { id: 's1', parentId: 'p1' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.get('s1').dueDate).toBe('2026-08-09'); // next Sunday
  });

  it('leaves an already-recurring task untouched even if a relative has a different cadence', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1', isRecurring: true, recurrenceString: 'every day' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.size).toBe(0);
  });

  it('does not propagate across unrelated tasks or sibling sub-tasks with no shared recurring relative', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 'p2' },
      { id: 's1', parentId: 'p2' },
    ];
    const updates = computeRecurrenceSyncUpdates(tasks);
    expect(updates.size).toBe(0);
  });

  it('guards against a corrupted parentId cycle instead of looping forever', () => {
    const tasks = [
      { id: 'a', parentId: 'b', isRecurring: true, recurrenceString: 'every day' },
      { id: 'b', parentId: 'a' },
    ];
    expect(() => computeRecurrenceSyncUpdates(tasks)).not.toThrow();
  });

  // Regression coverage: a sub-task migrated from the old embedded-Subtask
  // model (migrateSubtasksToTasks.js) that was `isCompleted: true` at
  // migration time comes out with `remainingHours: 0` and `isRecurring:
  // false`. If its parent later becomes recurring, this sync used to set
  // isRecurring/dueDate but leave remainingHours stuck at 0 forever, since
  // this path isn't completeTask's occurrence-advance (the only other place
  // that resets it) — showing the sub-task (and any parent rolling its hours
  // up, see taskHierarchy.js's getEffectiveRemainingHours) as permanently
  // "0m remaining" even though the new occurrence hasn't started yet.
  describe('resetting a stale remainingHours/isCompleted when a task newly becomes recurring', () => {
    it('resets remainingHours to estimatedHours for a task with remainingHours stuck at 0', () => {
      const tasks = [
        { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
        { id: 's1', parentId: 'p1', estimatedHours: 0.5, remainingHours: 0 },
      ];
      const updates = computeRecurrenceSyncUpdates(tasks);
      expect(updates.get('s1').remainingHours).toBe(0.5);
    });

    it('clears a leftover isCompleted flag and resets remainingHours', () => {
      const tasks = [
        { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
        { id: 's1', parentId: 'p1', estimatedHours: 0.5, remainingHours: 0.5, isCompleted: true },
      ];
      const updates = computeRecurrenceSyncUpdates(tasks);
      expect(updates.get('s1').isCompleted).toBe(false);
      expect(updates.get('s1').remainingHours).toBe(0.5);
    });

    it('leaves remainingHours untouched when it is already a healthy positive value', () => {
      const tasks = [
        { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
        { id: 's1', parentId: 'p1', estimatedHours: 1, remainingHours: 1 },
      ];
      const updates = computeRecurrenceSyncUpdates(tasks);
      expect(updates.get('s1').remainingHours).toBeUndefined();
      expect(updates.get('s1').isCompleted).toBeUndefined();
    });
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

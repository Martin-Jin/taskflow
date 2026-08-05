import { describe, it, expect } from 'vitest';
import {
  parseRecurrenceRule,
  computeNextDueDate,
  computeRecurringDescendantUpdate,
  computeCompletionHistoryUpdate,
  computeRecurrenceSyncUpdates,
  generateTaskOccurrences,
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

describe('computeRecurringDescendantUpdate', () => {
  // Regression coverage for the bug where completing a recurring parent task
  // unconditionally wiped every sub-task's dueDate to null, even when the
  // sub-task was independently recurring with its own dueDate (e.g. after
  // "Apply to all sub-tasks" copied isRecurring/recurrenceString/dueDate down
  // from the parent) — see SchedulerContext.completeTask's recurring branch.

  it('advances an independently-recurring descendant\'s own dueDate, and clears isCompleted', () => {
    const descendant = {
      isRecurring: true,
      recurrenceString: 'every day',
      dueDate: '2026-08-03',
      isCompleted: true,
      estimatedHours: 2,
    };
    expect(computeRecurringDescendantUpdate(descendant, '2026-08-05')).toEqual({
      dueDate: '2026-08-06', // based off today (08-05) since 08-03 is overdue, +1 day
      isCompleted: false,
      remainingHours: 2,
      completedDates: ['2026-08-03'],
      completionHistory: {},
    });
  });

  it('bases the recurring descendant\'s advance off its own dueDate when not overdue', () => {
    const descendant = { isRecurring: true, recurrenceString: 'every week', dueDate: '2026-08-10', estimatedHours: 3 };
    expect(computeRecurringDescendantUpdate(descendant, '2026-08-05')).toEqual({
      dueDate: '2026-08-17',
      isCompleted: false,
      remainingHours: 3,
      completedDates: ['2026-08-10'],
      completionHistory: {},
    });
  });

  it('leaves a non-recurring descendant\'s dueDate untouched (does not null it out)', () => {
    const descendant = { dueDate: '2026-08-03', isCompleted: false };
    expect(computeRecurringDescendantUpdate(descendant, '2026-08-05')).toEqual({
      dueDate: undefined,
      isCompleted: false,
      remainingHours: undefined,
      completedDates: undefined,
      completionHistory: undefined,
    });
  });

  it('leaves a recurring-but-undated descendant untouched (borrows ancestor dueDate for scheduling, not completion)', () => {
    const descendant = { isRecurring: true, recurrenceString: 'every day', dueDate: null, isCompleted: false };
    expect(computeRecurringDescendantUpdate(descendant, '2026-08-05')).toEqual({
      dueDate: undefined,
      isCompleted: false,
      remainingHours: undefined,
      completedDates: undefined,
      completionHistory: undefined,
    });
  });

  it('preserves whatever isCompleted was for a non-recurring descendant instead of forcing it false', () => {
    const descendant = { dueDate: '2026-08-01', isCompleted: true };
    expect(computeRecurringDescendantUpdate(descendant, '2026-08-05')).toEqual({
      dueDate: undefined,
      isCompleted: true,
      remainingHours: undefined,
      completedDates: undefined,
      completionHistory: undefined,
    });
  });

  it('records the closed-out occurrence into completedDates and resets remainingHours, matching the parent branch', () => {
    // Regression coverage for the bug where a recurring sub-task's own
    // completion cascade (via a recurring parent) never updated its
    // completedDates/remainingHours/completionHistory — so isBlockTaskCompleted
    // (missedTasks.js) never recognized its block/agenda entry as done.
    const descendant = {
      id: 'sub-1',
      isRecurring: true,
      recurrenceString: 'every day',
      dueDate: '2026-08-05',
      isCompleted: false,
      estimatedHours: 1.5,
      remainingHours: 0.5, // simulate partial progress before completion
      completedDates: [],
      completionHistory: {},
    };
    const update = computeRecurringDescendantUpdate(descendant, '2026-08-05');
    expect(update.completedDates).toEqual(['2026-08-05']);
    expect(update.remainingHours).toBe(1.5);
    expect(update.completionHistory).toEqual({});

    const updatedDescendant = { ...descendant, ...update };
    const block = { taskId: 'sub-1', date: '2026-08-05' };
    expect(isBlockTaskCompleted(block, updatedDescendant)).toBe(true);
  });

  it('rolls dates older than 7 days into completionHistory instead of keeping them in completedDates', () => {
    const descendant = {
      isRecurring: true,
      recurrenceString: 'every day',
      dueDate: '2026-08-05',
      estimatedHours: 1,
      completedDates: ['2026-07-20'], // >7 days before today
      completionHistory: {},
    };
    const update = computeRecurringDescendantUpdate(descendant, '2026-08-05');
    expect(update.completedDates).toEqual(['2026-08-05']);
    expect(update.completionHistory).toEqual({ '2026-07': 1 });
  });
});

describe('computeCompletionHistoryUpdate', () => {
  it('prepends the occurrence date and keeps dates within the last 7 days', () => {
    expect(computeCompletionHistoryUpdate('2026-08-05', ['2026-08-03'], {}, '2026-08-05')).toEqual({
      completedDates: ['2026-08-05', '2026-08-03'],
      completionHistory: {},
    });
  });

  it('trims dates older than 7 days into completionHistory, aggregated by month', () => {
    expect(computeCompletionHistoryUpdate('2026-08-05', ['2026-07-01', '2026-07-15'], {}, '2026-08-05')).toEqual({
      completedDates: ['2026-08-05'],
      completionHistory: { '2026-07': 2 },
    });
  });

  it('adds to an existing completionHistory month count instead of overwriting it', () => {
    expect(
      computeCompletionHistoryUpdate('2026-08-05', ['2026-07-01'], { '2026-07': 5 }, '2026-08-05')
    ).toEqual({
      completedDates: ['2026-08-05'],
      completionHistory: { '2026-07': 6 },
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

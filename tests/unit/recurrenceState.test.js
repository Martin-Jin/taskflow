import { describe, it, expect } from 'vitest';
import {
  occurrenceOnOrAfter,
  occurrenceAfter,
  lastOccurrenceOnOrBefore,
  normalizeOccurrences,
  mergeRecurringState,
  deriveRecurringFields,
  planOccurrenceCompletion,
  planSeriesReanchor,
  planOccurrenceCompaction,
  applyRecurringCompletion,
  computeRecurringDescendantState,
  ensureRecurrenceAnchor,
  planOccurrenceUncompletion,
  planSubtaskOccurrenceCompletion,
  hasRecurrenceState,
  reanchorRecurringEnforceDueDateUpdates,
} from '../../src/utils/recurrenceState';
import { computeNextDueDate, deriveRecurrenceRule } from '../../src/utils/recurrence';

/** Build a migrated recurring task with sensible defaults for these tests. */
function task(overrides = {}) {
  const recurrenceString = overrides.recurrenceString ?? 'every day';
  return {
    id: 't1',
    isRecurring: true,
    recurrenceString,
    recurrenceRule: deriveRecurrenceRule(recurrenceString),
    recurrenceAnchor: '2026-08-01',
    completedOccurrences: [],
    skippedThrough: null,
    completionHistoryArchive: {},
    dueDate: '2026-08-01',
    ...overrides,
  };
}

describe('occurrence walking', () => {
  it('resolves the anchor itself when searching from before the series starts', () => {
    expect(occurrenceOnOrAfter('2026-08-01', { unit: 'day', count: 1 }, '2026-07-01')).toBe('2026-08-01');
  });

  it('steps by the rule count for a multi-day cadence', () => {
    const rule = { unit: 'day', count: 3 };
    expect(occurrenceOnOrAfter('2026-08-01', rule, '2026-08-02')).toBe('2026-08-04');
    expect(occurrenceAfter('2026-08-01', rule, '2026-08-04')).toBe('2026-08-07');
  });

  it('honours a weekday-specific rule rather than jumping whole weeks', () => {
    // 2026-08-03 is a Monday. "every week on Mon, Wed" must give Wed, not next Mon.
    const rule = { unit: 'week', count: 1, days: [1, 3] };
    expect(occurrenceAfter('2026-08-03', rule, '2026-08-03')).toBe('2026-08-05');
  });

  it('walks monthly and yearly cadences', () => {
    expect(occurrenceAfter('2026-01-31', { unit: 'month', count: 1 }, '2026-01-31')).toBe('2026-02-28');
    expect(occurrenceAfter('2026-08-01', { unit: 'year', count: 1 }, '2026-08-01')).toBe('2027-08-01');
  });

  it('finds the last occurrence on or before a date, and nothing before the anchor', () => {
    const rule = { unit: 'day', count: 7 };
    expect(lastOccurrenceOnOrBefore('2026-08-01', rule, '2026-08-20')).toBe('2026-08-15');
    expect(lastOccurrenceOnOrBefore('2026-08-01', rule, '2026-07-31')).toBeNull();
  });

  it('stays cheap for an anchor years in the past (no per-occurrence walk)', () => {
    const started = Date.now();
    expect(occurrenceOnOrAfter('2000-01-01', { unit: 'day', count: 1 }, '2026-08-06')).toBe('2026-08-06');
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('normalizeOccurrences', () => {
  it('dedupes, sorts ascending and drops non-strings', () => {
    expect(normalizeOccurrences(['2026-08-03', '2026-08-01', '2026-08-03', null, 5, ''])).toEqual([
      '2026-08-01',
      '2026-08-03',
    ]);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeOccurrences(undefined)).toEqual([]);
    expect(normalizeOccurrences('nope')).toEqual([]);
  });
});

describe('mergeRecurringState — the convergence guarantee', () => {
  const a = { completedOccurrences: ['2026-08-01'], skippedThrough: '2026-07-20' };
  const b = { completedOccurrences: ['2026-08-02'], skippedThrough: '2026-07-25' };

  it('is commutative', () => {
    expect(mergeRecurringState(a, b)).toEqual(mergeRecurringState(b, a));
  });

  it('is idempotent', () => {
    expect(mergeRecurringState(a, a)).toEqual({
      completedOccurrences: ['2026-08-01'],
      skippedThrough: '2026-07-20',
    });
  });

  it('is associative', () => {
    const c = { completedOccurrences: ['2026-08-03'], skippedThrough: null };
    expect(mergeRecurringState(mergeRecurringState(a, b), c)).toEqual(
      mergeRecurringState(a, mergeRecurringState(b, c))
    );
  });

  it('unions completions and takes the later skip watermark', () => {
    expect(mergeRecurringState(a, b)).toEqual({
      completedOccurrences: ['2026-08-01', '2026-08-02'],
      skippedThrough: '2026-07-25',
    });
  });

  it('tolerates missing/empty sides', () => {
    expect(mergeRecurringState(null, b)).toEqual({
      completedOccurrences: ['2026-08-02'],
      skippedThrough: '2026-07-25',
    });
    expect(mergeRecurringState({}, {})).toEqual({ completedOccurrences: [], skippedThrough: null });
  });
});

describe('deriveRecurringFields — dueDate', () => {
  it('is the anchor itself when nothing has been completed', () => {
    expect(deriveRecurringFields(task(), '2026-08-01').dueDate).toBe('2026-08-01');
  });

  it('advances past completed occurrences', () => {
    const t = task({ completedOccurrences: ['2026-08-01', '2026-08-02'] });
    expect(deriveRecurringFields(t, '2026-08-03').dueDate).toBe('2026-08-03');
  });

  it('does NOT clamp an overdue task forward — a stale due date still reads as overdue', () => {
    // Never completed, anchored well in the past: must stay overdue, exactly as
    // the pre-existing model behaved.
    const t = task({ recurrenceAnchor: '2026-07-01', dueDate: '2026-07-01' });
    expect(deriveRecurringFields(t, '2026-08-06').dueDate).toBe('2026-07-01');
  });

  it('starts after skippedThrough rather than at the anchor', () => {
    const t = task({ recurrenceAnchor: '2026-07-01', skippedThrough: '2026-08-05' });
    expect(deriveRecurringFields(t, '2026-08-06').dueDate).toBe('2026-08-06');
  });

  it('skips an occurrence dropped by a `deleted` override, agreeing with expandTaskOccurrences', () => {
    const t = task({ overrides: { '2026-08-01': { deleted: true } } });
    expect(deriveRecurringFields(t, '2026-08-01').dueDate).toBe('2026-08-02');
  });

  it('is unaffected by a plain move override, which keeps the series anchored', () => {
    // An off-pattern move records `{date}` and deliberately leaves dueDate on
    // the pattern date — see computeRecurringRescheduleUpdate.
    const t = task({ overrides: { '2026-08-01': { date: '2026-08-04' } } });
    expect(deriveRecurringFields(t, '2026-08-01').dueDate).toBe('2026-08-01');
  });

  it('leaves the stored dueDate alone when the rule or anchor is missing', () => {
    const unparseable = task({ recurrenceString: 'sometimes', recurrenceRule: null, dueDate: '2026-08-04' });
    expect(deriveRecurringFields(unparseable, '2026-08-06').dueDate).toBe('2026-08-04');
    const unanchored = task({ recurrenceAnchor: null, dueDate: '2026-08-04' });
    expect(deriveRecurringFields(unanchored, '2026-08-06').dueDate).toBe('2026-08-04');
  });

  it('trusts a stored dueDate that is AHEAD of the derived one (old client advanced it)', () => {
    // Mixed-version device: pre-migration code advanced dueDate directly and
    // recorded no occurrence. Re-deriving backwards would undo its work.
    const t = task({ dueDate: '2026-08-09' });
    expect(deriveRecurringFields(t, '2026-08-06').dueDate).toBe('2026-08-09');
  });

  it('does not let a stored dueDate BEHIND the derived one drag the series back', () => {
    const t = task({ completedOccurrences: ['2026-08-01', '2026-08-02'], dueDate: '2026-08-01' });
    expect(deriveRecurringFields(t, '2026-08-03').dueDate).toBe('2026-08-03');
  });
});

describe('deriveRecurringFields — completedDates / completionHistory', () => {
  it('exposes the trailing 7-day window newest-first, as the old field did', () => {
    const t = task({ completedOccurrences: ['2026-08-01', '2026-08-04', '2026-08-05'] });
    expect(deriveRecurringFields(t, '2026-08-06').completedDates).toEqual([
      '2026-08-05',
      '2026-08-04',
      '2026-08-01',
    ]);
  });

  it('rolls anything older than the window into the monthly aggregate', () => {
    const t = task({ completedOccurrences: ['2026-06-10', '2026-06-20', '2026-08-05'] });
    const { completedDates, completionHistory } = deriveRecurringFields(t, '2026-08-06');
    expect(completedDates).toEqual(['2026-08-05']);
    expect(completionHistory).toEqual({ '2026-06': 2 });
  });

  it('adds the frozen archive baseline on top, so migrated history is never lost', () => {
    const t = task({
      completedOccurrences: ['2026-06-10'],
      completionHistoryArchive: { '2026-05': 12, '2026-06': 3 },
    });
    expect(deriveRecurringFields(t, '2026-08-06').completionHistory).toEqual({
      '2026-05': 12,
      '2026-06': 4,
    });
  });

  it('cannot double-count under repeated derivation (it is a pure function, not an increment)', () => {
    const t = task({ completedOccurrences: ['2026-06-10'] });
    const once = deriveRecurringFields(t, '2026-08-06').completionHistory;
    const twice = deriveRecurringFields(t, '2026-08-06').completionHistory;
    expect(once).toEqual(twice);
    expect(once).toEqual({ '2026-06': 1 });
  });
});

describe('planOccurrenceCompletion', () => {
  it('records the occurrence and advances the derived due date by one step', () => {
    const t = task({ dueDate: '2026-08-01' });
    const plan = planOccurrenceCompletion(t, '2026-08-01', '2026-08-01');
    expect(plan.addedOccurrence).toBe('2026-08-01');
    expect(deriveRecurringFields({ ...t, ...plan }, '2026-08-01').dueDate).toBe('2026-08-02');
  });

  it('is IDEMPOTENT — completing the same occurrence twice advances nothing', () => {
    const t = task({ dueDate: '2026-08-01' });
    const first = { ...t, ...planOccurrenceCompletion(t, '2026-08-01', '2026-08-01') };
    const repeat = planOccurrenceCompletion(first, '2026-08-01', '2026-08-01');
    expect(repeat.addedOccurrence).toBeNull();
    expect(repeat.completedOccurrences).toEqual(first.completedOccurrences);
    expect(deriveRecurringFields({ ...first, ...repeat }, '2026-08-01').dueDate).toBe('2026-08-02');
  });

  it('rolls an overdue task forward past today instead of building a backlog', () => {
    // The behaviour completeTask's `baseDate = dueDate < today ? today : dueDate`
    // produces today: completing a 30-day-overdue daily task jumps to tomorrow.
    const t = task({ recurrenceAnchor: '2026-07-07', dueDate: '2026-07-07' });
    const plan = planOccurrenceCompletion(t, '2026-07-07', '2026-08-06');
    const derived = deriveRecurringFields({ ...t, ...plan }, '2026-08-06');
    expect(derived.dueDate).toBe('2026-08-07');
    expect(derived.dueDate).toBe(computeNextDueDate('2026-08-06', 'every day'));
  });

  it('counts the skipped backlog as skipped, NOT as completed', () => {
    const t = task({ recurrenceAnchor: '2026-07-07', dueDate: '2026-07-07' });
    const plan = planOccurrenceCompletion(t, '2026-07-07', '2026-08-06');
    // One completion recorded, not thirty — streaks/stats must not be inflated.
    expect(plan.completedOccurrences).toEqual(['2026-07-07']);
    expect(plan.skippedThrough).toBe('2026-08-06');
  });

  it('does not touch skippedThrough when completing the current occurrence on time', () => {
    const t = task({ dueDate: '2026-08-01' });
    expect(planOccurrenceCompletion(t, '2026-08-01', '2026-08-01').skippedThrough).toBeNull();
  });

  it('never lowers an existing skip watermark', () => {
    const t = task({ recurrenceAnchor: '2026-07-01', skippedThrough: '2026-09-01' });
    expect(planOccurrenceCompletion(t, '2026-07-05', '2026-08-06').skippedThrough).toBe('2026-09-01');
  });
});

describe('concurrent completion — the bugs this model exists to fix', () => {
  it('does not lose a completion when two people complete different occurrences', () => {
    // Alice completes 08-01. Bob, from a snapshot that never saw it, completes
    // 08-02. Under the old whole-document last-write-wins, Bob's write replaced
    // Alice's array and 08-01 vanished.
    const base = task({ dueDate: '2026-08-01' });
    const alice = planOccurrenceCompletion(base, '2026-08-01', '2026-08-01');
    const bob = planOccurrenceCompletion(base, '2026-08-02', '2026-08-02');
    const merged = mergeRecurringState(alice, bob);
    expect(merged.completedOccurrences).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('converges to identical state regardless of arrival order', () => {
    const base = task({ dueDate: '2026-08-01' });
    const alice = planOccurrenceCompletion(base, '2026-08-01', '2026-08-01');
    const bob = planOccurrenceCompletion(base, '2026-08-02', '2026-08-02');
    const aliceFirst = { ...base, ...mergeRecurringState(alice, bob) };
    const bobFirst = { ...base, ...mergeRecurringState(bob, alice) };
    expect(aliceFirst).toEqual(bobFirst);
    expect(deriveRecurringFields(aliceFirst, '2026-08-03').dueDate).toBe(
      deriveRecurringFields(bobFirst, '2026-08-03').dueDate
    );
  });

  it('does not double-advance when two people tick the same occurrence', () => {
    // The old model advanced dueDate per click: 08-01 -> 08-02 -> 08-03, so the
    // 08-02 occurrence was skipped without anyone doing it.
    const base = task({ dueDate: '2026-08-01' });
    const alice = planOccurrenceCompletion(base, '2026-08-01', '2026-08-01');
    const bob = planOccurrenceCompletion(base, '2026-08-01', '2026-08-01');
    const merged = { ...base, ...mergeRecurringState(alice, bob) };
    expect(merged.completedOccurrences).toEqual(['2026-08-01']);
    expect(deriveRecurringFields(merged, '2026-08-01').dueDate).toBe('2026-08-02');
  });
});

describe('planOccurrenceUncompletion', () => {
  it('reopens the occurrence and rolls the due date back to it', () => {
    const t = task({ dueDate: '2026-08-01' });
    const completed = { ...t, ...applyRecurringCompletion(t, '2026-08-01', '2026-08-01') };
    expect(completed.dueDate).toBe('2026-08-02');
    const reopened = { ...completed, ...planOccurrenceUncompletion(completed, '2026-08-01', '2026-08-01') };
    expect(reopened.completedOccurrences).toEqual([]);
    expect(reopened.dueDate).toBe('2026-08-01');
    expect(reopened.completedDates).toEqual([]);
  });

  it('round-trips: complete then uncomplete restores the original derived state', () => {
    const t = task({ dueDate: '2026-08-01' });
    const before = deriveRecurringFields(t, '2026-08-01');
    const completed = { ...t, ...applyRecurringCompletion(t, '2026-08-01', '2026-08-01') };
    const reopened = { ...completed, ...planOccurrenceUncompletion(completed, '2026-08-01', '2026-08-01') };
    const after = deriveRecurringFields(reopened, '2026-08-01');
    expect(after).toEqual(before);
  });

  it('leaves other completions untouched', () => {
    const t = task({ completedOccurrences: ['2026-07-30', '2026-08-01'] });
    const plan = planOccurrenceUncompletion(t, '2026-08-01', '2026-08-01');
    expect(plan.completedOccurrences).toEqual(['2026-07-30']);
  });

  it('clears a skip watermark that would keep the due date parked past the reopened occurrence', () => {
    // The overdue case: completing late set skippedThrough to today, so simply
    // dropping the occurrence would leave the due date stuck in the future.
    const t = task({ recurrenceAnchor: '2026-07-07', dueDate: '2026-07-07' });
    const completed = { ...t, ...applyRecurringCompletion(t, '2026-07-07', '2026-08-06') };
    expect(completed.skippedThrough).toBe('2026-08-06');
    const reopened = { ...completed, ...planOccurrenceUncompletion(completed, '2026-07-07', '2026-08-06') };
    expect(reopened.dueDate).toBe('2026-07-07');
  });

  it('is a no-op for an occurrence that was never completed', () => {
    const t = task({ completedOccurrences: ['2026-08-01'] });
    expect(planOccurrenceUncompletion(t, '2026-08-05', '2026-08-05').completedOccurrences).toEqual(['2026-08-01']);
  });
});

describe('planSeriesReanchor', () => {
  it('re-anchors to the chosen date and drops completions on/after it', () => {
    const t = task({ completedOccurrences: ['2026-07-30', '2026-08-05'], dueDate: '2026-08-06' });
    const plan = planSeriesReanchor(t, '2026-08-04');
    expect(plan.recurrenceAnchor).toBe('2026-08-04');
    expect(plan.completedOccurrences).toEqual(['2026-07-30']);
    expect(deriveRecurringFields({ ...t, ...plan }, '2026-08-06').dueDate).toBe('2026-08-04');
  });

  it('clears a stale skip watermark that would push the chosen date forward again', () => {
    const t = task({ skippedThrough: '2026-09-01' });
    const plan = planSeriesReanchor(t, '2026-08-04');
    expect(plan.skippedThrough).toBeNull();
    expect(deriveRecurringFields({ ...t, ...plan }, '2026-08-04').dueDate).toBe('2026-08-04');
  });

  it('keeps a skip watermark that is still safely in the past', () => {
    const t = task({ recurrenceAnchor: '2026-07-01', skippedThrough: '2026-07-15' });
    expect(planSeriesReanchor(t, '2026-08-04').skippedThrough).toBe('2026-07-15');
  });

  it('(d) dragging a fully-advanced group back onto today does not resurrect stale completed styling', () => {
    // Parent already rolled forward past today (08-06 completed, now due 08-07),
    // with completedDates still carrying 08-06 in its trailing window.
    const rolled = task({
      completedOccurrences: ['2026-08-06'],
      dueDate: '2026-08-07',
    });
    const rolledDerived = deriveRecurringFields(rolled, '2026-08-06');
    expect(rolledDerived.completedDates).toEqual(['2026-08-06']);

    // User drags it back onto today (08-06) — updateTask's reschedule path
    // (SchedulerContext.jsx) re-anchors via planSeriesReanchor rather than
    // just overwriting dueDate, dropping the on/after-date completion.
    const reanchored = { ...rolled, ...planSeriesReanchor(rolled, '2026-08-06') };
    expect(reanchored.completedOccurrences).toEqual([]); // 08-06 completion dropped — it's being reopened, not relabeled
    const finalDerived = deriveRecurringFields(reanchored, '2026-08-06');
    expect(finalDerived.dueDate).toBe('2026-08-06');
    expect(finalDerived.completedDates).toEqual([]); // no stale "done" entry survives the reanchor
  });
});

describe('reanchorRecurringEnforceDueDateUpdates', () => {
  it('(a) re-anchors a recurring descendant instead of just overwriting dueDate, clearing a stale skip watermark that now sits on/after the new anchor', () => {
    // Descendant is recurring, already rolled forward with a completion
    // (correctly kept — it's before the new anchor, a real closed-out
    // occurrence) and a skip watermark that sits ON/AFTER the new cascaded
    // date — an unmodified computeEnforceDueDateSyncUpdates output would
    // leave the watermark stale, so the very next completion/reschedule
    // would immediately push the freshly cascaded date forward again.
    const tasks = [
      { id: 'p1', enforceDueDate: true, dueDate: '2026-08-17' },
      task({
        id: 's1',
        parentId: 'p1',
        dueDateInherited: true,
        dueDate: '2026-08-10',
        recurrenceAnchor: '2026-08-01',
        completedOccurrences: ['2026-08-01'],
        skippedThrough: '2026-08-20',
      }),
    ];
    const rawUpdates = new Map([['s1', { dueDate: '2026-08-17' }]]);
    const reanchored = reanchorRecurringEnforceDueDateUpdates(tasks, rawUpdates);
    expect(reanchored.get('s1')).toEqual({
      recurrenceAnchor: '2026-08-17',
      completedOccurrences: ['2026-08-01'], // real closed-out occurrence, before the new anchor — kept
      skippedThrough: null, // stale watermark (on/after the new anchor) cleared, matching planSeriesReanchor's own rule
      dueDate: '2026-08-17',
    });
    // Sanity: the re-anchored task derives back to the cascaded date, not a
    // stale value pulled from the old anchor.
    const merged = { ...tasks[1], ...reanchored.get('s1') };
    expect(deriveRecurringFields(merged, '2026-08-17').dueDate).toBe('2026-08-17');
  });

  it('(a) preserves dueDateInherited across the re-anchor', () => {
    const tasks = [
      { id: 'p1', enforceDueDate: true, dueDate: '2026-08-10' },
      task({ id: 's1', parentId: 'p1', dueDate: null }),
    ];
    // Simulates the "no dueDate yet" cascade branch, which also sets dueDateInherited: true.
    const rawUpdates = new Map([['s1', { dueDate: '2026-08-10', dueDateInherited: true }]]);
    const reanchored = reanchorRecurringEnforceDueDateUpdates(tasks, rawUpdates);
    expect(reanchored.get('s1')).toMatchObject({ dueDate: '2026-08-10', dueDateInherited: true });
  });

  it('(b) leaves a non-recurring descendant update untouched (regression guard)', () => {
    const tasks = [
      { id: 'p1', enforceDueDate: true, dueDate: '2026-08-17' },
      { id: 's1', parentId: 'p1', isRecurring: false, dueDateInherited: true, dueDate: '2026-08-10' },
    ];
    const rawUpdates = new Map([['s1', { dueDate: '2026-08-17' }]]);
    const reanchored = reanchorRecurringEnforceDueDateUpdates(tasks, rawUpdates);
    expect(reanchored.get('s1')).toEqual({ dueDate: '2026-08-17' });
  });

  it('(c) leaves updates with no dueDate (e.g. just enforceDueDate:true) untouched even for a recurring task', () => {
    const tasks = [
      { id: 'p1', enforceDueDate: true, dueDate: '2026-08-10' },
      task({ id: 's1', parentId: 'p1', dueDate: '2026-08-05' }),
    ];
    const rawUpdates = new Map([['s1', { enforceDueDate: true }]]);
    const reanchored = reanchorRecurringEnforceDueDateUpdates(tasks, rawUpdates);
    expect(reanchored.get('s1')).toEqual({ enforceDueDate: true });
  });

  it('returns the same empty map unchanged when there is nothing to re-anchor', () => {
    const updates = new Map();
    expect(reanchorRecurringEnforceDueDateUpdates([], updates)).toBe(updates);
  });
});

describe('planOccurrenceCompaction', () => {
  it('returns null when there is nothing old enough to fold', () => {
    const t = task({ completedOccurrences: ['2026-08-01'], dueDate: '2026-08-06' });
    expect(planOccurrenceCompaction(t, '2026-08-06')).toBeNull();
    expect(planOccurrenceCompaction(task(), '2026-08-06')).toBeNull();
  });

  it('declines to compact a task with no due date (nothing proves what is resolved)', () => {
    const t = task({ completedOccurrences: ['2020-01-01'], dueDate: null });
    expect(planOccurrenceCompaction(t, '2026-08-06')).toBeNull();
  });

  it('folds old occurrences into the archive and keeps recent ones raw', () => {
    const t = task({
      recurrenceAnchor: '2024-01-01',
      completedOccurrences: ['2024-03-01', '2024-03-15', '2026-08-01'],
      dueDate: '2026-08-06',
    });
    const plan = planOccurrenceCompaction(t, '2026-08-06');
    expect(plan.completedOccurrences).toEqual(['2026-08-01']);
    expect(plan.completionHistoryArchive).toEqual({ '2024-03': 2 });
    expect(plan.skippedThrough).toBe('2024-03-15');
  });

  it('PRESERVES the derived dueDate exactly — the core correctness constraint', () => {
    const t = task({
      recurrenceAnchor: '2024-01-01',
      completedOccurrences: ['2024-03-01', '2024-03-15', '2026-08-01', '2026-08-02'],
      dueDate: '2026-08-03',
    });
    const before = deriveRecurringFields(t, '2026-08-06').dueDate;
    const after = deriveRecurringFields({ ...t, ...planOccurrenceCompaction(t, '2026-08-06') }, '2026-08-06');
    expect(after.dueDate).toBe(before);
  });

  it('never leaps the watermark over an uncompleted occurrence before the due date', () => {
    // Daily task abandoned in 2020: 01-01 and 01-05 completed, 01-02..04 not.
    // dueDate is therefore 2020-01-02, and compaction must not advance it to
    // 2020-01-06 by dropping 01-05 and raising the watermark past the gap.
    const t = task({
      recurrenceAnchor: '2020-01-01',
      completedOccurrences: ['2020-01-01', '2020-01-05'],
      dueDate: '2020-01-02',
    });
    const plan = planOccurrenceCompaction(t, '2026-08-06');
    expect(plan.completedOccurrences).toEqual(['2020-01-05']);
    expect(plan.skippedThrough).toBe('2020-01-01');
    expect(deriveRecurringFields({ ...t, ...plan }, '2026-08-06').dueDate).toBe('2020-01-02');
  });

  it('preserves the total completion count across compaction', () => {
    const t = task({
      recurrenceAnchor: '2024-01-01',
      completedOccurrences: ['2024-03-01', '2024-03-15', '2024-04-02', '2026-08-01'],
      dueDate: '2026-08-06',
    });
    const totalOf = (history) => Object.values(history).reduce((sum, n) => sum + n, 0);
    const before = deriveRecurringFields(t, '2026-08-06');
    const compacted = { ...t, ...planOccurrenceCompaction(t, '2026-08-06') };
    const after = deriveRecurringFields(compacted, '2026-08-06');
    expect(totalOf(after.completionHistory) + after.completedDates.length).toBe(
      totalOf(before.completionHistory) + before.completedDates.length
    );
  });

  it('is stable — compacting an already-compacted task is a no-op', () => {
    const t = task({
      recurrenceAnchor: '2024-01-01',
      completedOccurrences: ['2024-03-01', '2026-08-01'],
      dueDate: '2026-08-06',
    });
    const once = { ...t, ...planOccurrenceCompaction(t, '2026-08-06') };
    expect(planOccurrenceCompaction(once, '2026-08-06')).toBeNull();
  });
});

describe('ensureRecurrenceAnchor', () => {
  it('seeds the anchor from the due date, so deriving is a no-op', () => {
    const t = { isRecurring: true, dueDate: '2026-08-06', recurrenceString: 'every day' };
    const anchored = { ...t, ...ensureRecurrenceAnchor(t), recurrenceRule: deriveRecurrenceRule('every day') };
    expect(anchored.recurrenceAnchor).toBe('2026-08-06');
    expect(deriveRecurringFields(anchored, '2026-08-06').dueDate).toBe('2026-08-06');
  });

  it('does nothing for a non-recurring task, an undated one, or an already-anchored one', () => {
    expect(ensureRecurrenceAnchor({ isRecurring: false, dueDate: '2026-08-06' })).toEqual({});
    expect(ensureRecurrenceAnchor({ isRecurring: true, dueDate: null })).toEqual({});
    expect(ensureRecurrenceAnchor({ isRecurring: true, dueDate: '2026-08-06', recurrenceAnchor: '2026-01-01' })).toEqual({});
  });
});

describe('applyRecurringCompletion', () => {
  it('returns the source fields and the refreshed derived views together', () => {
    const t = task({ dueDate: '2026-08-01' });
    const rolled = applyRecurringCompletion(t, '2026-08-01', '2026-08-01');
    expect(rolled.completedOccurrences).toEqual(['2026-08-01']);
    expect(rolled.dueDate).toBe('2026-08-02');
    expect(rolled.completedDates).toEqual(['2026-08-01']);
    expect(rolled.isCompleted).toBe(false);
    expect(rolled.remainingHours).toBe(t.estimatedHours);
  });

  it('anchors an un-migrated recurring task on the way through', () => {
    const legacy = { isRecurring: true, recurrenceString: 'every day', recurrenceRule: deriveRecurrenceRule('every day'), dueDate: '2026-08-01' };
    const rolled = applyRecurringCompletion(legacy, '2026-08-01', '2026-08-01');
    expect(rolled.recurrenceAnchor).toBe('2026-08-01');
    expect(rolled.dueDate).toBe('2026-08-02');
  });

  it('leaves history uncompacted by default', () => {
    const t = task({ recurrenceAnchor: '2024-01-01', completedOccurrences: ['2024-03-01'], dueDate: '2026-08-06' });
    expect(applyRecurringCompletion(t, '2026-08-06', '2026-08-06').completedOccurrences).toContain('2024-03-01');
  });

  it('compacts when asked, without moving the due date', () => {
    const t = task({ recurrenceAnchor: '2024-01-01', completedOccurrences: ['2024-03-01'], dueDate: '2026-08-06' });
    const plain = applyRecurringCompletion(t, '2026-08-06', '2026-08-06');
    const compacted = applyRecurringCompletion(t, '2026-08-06', '2026-08-06', { compact: true });
    expect(compacted.completedOccurrences).not.toContain('2024-03-01');
    expect(compacted.completionHistoryArchive).toEqual({ '2024-03': 1 });
    expect(compacted.dueDate).toBe(plain.dueDate);
    // The user-visible views must be identical either way — compaction is a
    // storage concern, never a behavioural one.
    expect(compacted.completionHistory).toEqual(plain.completionHistory);
    expect(compacted.completedDates).toEqual(plain.completedDates);
  });
});

describe('planSubtaskOccurrenceCompletion', () => {
  it('marks today done (completedDates includes it) but pins dueDate to the current occurrence', () => {
    const t = task({ dueDate: '2026-08-01' });
    const plan = planSubtaskOccurrenceCompletion(t, '2026-08-01', '2026-08-01');
    expect(plan.completedOccurrences).toEqual(['2026-08-01']);
    expect(plan.completedDates).toEqual(['2026-08-01']);
    // The core behaviour this exists for: unlike applyRecurringCompletion,
    // dueDate does NOT advance to the next occurrence.
    expect(plan.dueDate).toBe('2026-08-01');
  });

  it('still rolls a backlog through skippedThrough when completed late, without moving dueDate off today', () => {
    // Completed 5 days late: the backlog closes out (skippedThrough), but the
    // sub-task itself must not jump to a future occurrence — it stays pinned
    // on the occurrence date passed in (mirrors completeTask's baseDate=today handling).
    const t = task({ recurrenceAnchor: '2026-07-01', dueDate: '2026-07-27' });
    const plan = planSubtaskOccurrenceCompletion(t, '2026-07-27', '2026-08-01');
    expect(plan.skippedThrough).toBe('2026-08-01');
    expect(plan.dueDate).toBe('2026-07-27');
  });

  it('anchors an un-migrated recurring sub-task on the way through, same as applyRecurringCompletion', () => {
    const legacy = { isRecurring: true, recurrenceString: 'every day', recurrenceRule: deriveRecurrenceRule('every day'), dueDate: '2026-08-01', parentId: 'p1' };
    const plan = planSubtaskOccurrenceCompletion(legacy, '2026-08-01', '2026-08-01');
    expect(plan.recurrenceAnchor).toBe('2026-08-01');
    expect(plan.dueDate).toBe('2026-08-01');
  });

  it('is idempotent — completing the same occurrence twice changes nothing further', () => {
    const t = task({ dueDate: '2026-08-01' });
    const once = { ...t, ...planSubtaskOccurrenceCompletion(t, '2026-08-01', '2026-08-01') };
    const twice = planSubtaskOccurrenceCompletion(once, '2026-08-01', '2026-08-01');
    expect(twice.completedOccurrences).toEqual(once.completedOccurrences);
    expect(twice.dueDate).toBe(once.dueDate);
  });
});

describe('computeRecurringDescendantState', () => {
  it('rolls an independently-recurring sub-task forward', () => {
    const child = task({ id: 'c1', dueDate: '2026-08-01', recurrenceAnchor: '2026-08-01' });
    const update = computeRecurringDescendantState(child, '2026-08-01');
    expect(update.dueDate).toBe('2026-08-02');
    expect(update.completedDates).toEqual(['2026-08-01']);
  });

  it('returns null for a sub-task that is not independently recurring', () => {
    expect(computeRecurringDescendantState({ isRecurring: false, dueDate: '2026-08-01' }, '2026-08-01')).toBeNull();
    expect(computeRecurringDescendantState({ isRecurring: true, dueDate: null }, '2026-08-01')).toBeNull();
  });
});

describe('hasRecurrenceState', () => {
  it('distinguishes a migrated recurring task from one that predates the model', () => {
    expect(hasRecurrenceState(task())).toBe(true);
    expect(hasRecurrenceState(task({ recurrenceAnchor: null }))).toBe(false);
    expect(hasRecurrenceState({ isRecurring: false, recurrenceAnchor: '2026-08-01' })).toBe(false);
    expect(hasRecurrenceState(null)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { rebalance } from '../../src/algorithms/rebalanceEngine';
import { allocateTasks } from '../../src/algorithms/allocator';
import { computeHorizonCapacity } from '../../src/algorithms/capacityEngine';

const baseRules = {
  workDayStart: '09:00',
  workDayEnd: '17:00',
  maxDailyDeepWorkHours: 8,
  minGapBetweenBlocksMins: 0,
  horizonWeeks: 1,
};

// 2026-07-01 is a Wednesday.
const today = '2026-07-01';

describe('rebalance', () => {
  it('preserves a completed non-recurring task\'s unlocked block for today instead of clearing it', () => {
    const tasks = [
      { id: 't1', title: 'Done today', isCompleted: true, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b1', taskId: 't1', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b1')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it('preserves a completed recurring occurrence\'s block for today', () => {
    const tasks = [
      {
        id: 't2',
        title: 'Recurring done today',
        isRecurring: true,
        isCompleted: false,
        completedDates: [today],
        estimatedHours: 1,
        dueDate: today,
      },
    ];
    const existingBlocks = [
      { id: 'b2', taskId: 't2', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b2')).toBe(true);
  });

  it('still clears an unlocked, unfinished task\'s block for today', () => {
    const tasks = [
      { id: 't3', title: 'Not done', isCompleted: false, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b3', taskId: 't3', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.stats.blocksCleared).toBe(1);
  });

  it("preserves a completed task's PAST (historical) unlocked block instead of clearing it", () => {
    const yesterday = '2026-06-30';
    const tasks = [
      { id: 't4', title: 'Done yesterday', isCompleted: true, estimatedHours: 1, dueDate: yesterday },
    ];
    const existingBlocks = [
      { id: 'b4', taskId: 't4', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b4')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it("clears an incomplete task's stale PAST block and frees its hours so it can be rescheduled onto a future enforced due date", () => {
    const yesterday = '2026-06-30';
    const tomorrow = '2026-07-02';
    const tasks = [
      {
        id: 't5',
        title: 'Stale, moved out',
        isCompleted: false,
        estimatedHours: 1,
        dueDate: tomorrow,
        enforceDueDate: true,
      },
    ];
    const existingBlocks = [
      { id: 'b5', taskId: 't5', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    // Stale past block is gone...
    expect(result.blocks.some((b) => b.id === 'b5')).toBe(false);
    // ...and a fresh block was placed on the real (future) due date instead.
    expect(result.blocks.some((b) => b.taskId === 't5' && b.date === tomorrow)).toBe(true);
    expect(result.overflow.length).toBe(0);
  });

  it('preserves a LOCKED past block even though its task is not completed', () => {
    const yesterday = '2026-06-30';
    const tasks = [
      { id: 't6', title: 'Locked past, not done', isCompleted: false, estimatedHours: 1, dueDate: yesterday },
    ];
    const existingBlocks = [
      { id: 'b6', taskId: 't6', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: true },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b6')).toBe(true);
  });

  it('falls back to later same-day capacity (no conflict reported) when a fixedTime, single-day task collides with an event but the rest of the day is free', () => {
    const tasks = [
      { id: 't7', title: 'Standup prep', isCompleted: false, estimatedHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '09:00' },
    ];
    const events = [{ id: 'ev1', date: today, startTime: '09:00', endTime: '10:00', title: 'Team Standup' }];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events, rules: baseRules, fromDate: today });
    // The 09:00 pinned slot collides with the standup, but the work day runs
    // until 17:00 — a real conflict at the fixed slot only rules out THAT
    // slot, not the rest of the day, so the leftover hour should land
    // elsewhere today instead of being reported as unschedulable.
    expect(result.overflow).toHaveLength(0);
    const block = result.blocks.find((b) => b.taskId === 't7');
    expect(block).toBeTruthy();
    expect(block.startTime).not.toBe('09:00');
  });

  it('reports a dependency_blocked reason (naming the blocking task) for a task whose dependency is incomplete', () => {
    const tasks = [
      { id: 't8', title: 'Blocker task', isCompleted: false, estimatedHours: 8, dueDate: today },
      { id: 't9', title: 'Waiting task', isCompleted: false, estimatedHours: 1, dueDate: today, dependsOn: ['t8'] },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    const blocked = result.overflow.find((o) => o.taskId === 't9');
    expect(blocked).toMatchObject({
      reason: { type: 'dependency_blocked', blockingDependencies: [{ id: 't8', title: 'Blocker task' }] },
    });
    expect(result.stats.blockedByDependencies).toBe(1);
  });

  it('reports a no_capacity reason (not fixed_time_conflict) when a non-fixedTime task simply runs out of room', () => {
    const tasks = [
      { id: 't10', title: 'Too much work', isCompleted: false, estimatedHours: 100, dueDate: today, enforceDueDate: true },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    const overflowEntry = result.overflow.find((o) => o.taskId === 't10');
    expect(overflowEntry.reason).toEqual({ type: 'no_capacity' });
  });

  // Regression test: a task with isRecurring=true but no resolvable
  // recurrenceRule/recurrenceString isn't eligible for expandRecurringTasks's
  // per-occurrence expansion, so tasksWithRemaining must use the same
  // resolveTaskRecurrenceRule gate rather than the bare isRecurring flag —
  // otherwise it wrongly skips subtracting this task's already-spent hours
  // (a treatment meant only for tasks actually going through per-occurrence
  // expansion), so a task with lots of historical/locked hours already
  // logged keeps reporting its FULL estimatedHours as still remaining. The
  // allocator then tries to fit that inflated remainder into one
  // single-window day and spuriously reports no_capacity even though the
  // task is nearly done and what's left easily fits.
  it('subtracts already-spent hours for a recurring-flagged task with no resolvable recurrence rule, instead of re-demanding its full estimatedHours', () => {
    const tasks = [
      { id: 't11', title: 'Recurring but unparseable', isRecurring: true, isCompleted: false, estimatedHours: 2, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b11', taskId: 't11', date: '2026-06-30', startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: true },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: { ...baseRules, bufferDays: 1 }, fromDate: today });
    expect(result.overflow.find((o) => o.taskId === 't11')).toBeUndefined();
    const newBlock = result.blocks.find((b) => b.taskId === 't11' && b.id !== 'b11');
    expect(newBlock?.durationHours).toBe(1);
  });

  // Regression test: maxDailyDeepWorkHours used to be enforced by physically
  // truncating computeDayCapacity's freeIntervals from the FRONT of the day
  // (e.g. a 06:00-23:59 open day with an 8-hour cap became "06:00-14:00
  // only"), deleting every later time-of-day slot from the allocator's view
  // regardless of whether anything had actually been scheduled into it yet.
  // That broke a fixedTime task (e.g. a bedtime "Sleep routine") needing a
  // slot LATER in the day than the cap's cutoff, even on a day with nothing
  // else scheduled — it spuriously reported `no_capacity` even though the
  // real calendar had that time completely free. The cap is now enforced as
  // a running per-day budget as blocks are actually placed (allocator.js's
  // dailyBudgetMins), so it only holds a day back once ITS hours are truly
  // spent, never by pre-deleting unclaimed time-of-day slots.
  it("places a fixedTime task's block late in the day even when maxDailyDeepWorkHours would have truncated that slot under the old front-trimming behavior", () => {
    const tasks = [
      { id: 't12', title: 'Sleep routine', isCompleted: false, estimatedHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '22:00', minChunkHours: 1, maxChunkHours: 1 },
    ];
    const rules = { ...baseRules, workDayStart: '06:00', workDayEnd: '23:59', maxDailyDeepWorkHours: 2 };
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules, fromDate: today });
    expect(result.overflow.find((o) => o.taskId === 't12')).toBeUndefined();
    const block = result.blocks.find((b) => b.taskId === 't12');
    expect(block).toMatchObject({ startTime: '22:00', endTime: '23:00' });
  });
});

// Regression coverage for a false "no free time left" report on a recurring,
// fixedTime task (e.g. "Piano" at a fixed practice time, or "Practice
// questions" today) whose per-occurrence virtual task collapses its window to
// a single day (rebalanceEngine's expandRecurringTasks sets enforceDueDate)
// AND whose fixed time-of-day slot isn't available that day — either because
// nowClamp has pushed the work day's start past it (the slot already "came
// and went" earlier today) or because it simply falls outside the work day.
// A single-day window means fixedTime's normal "just try again tomorrow"
// fallback (see placeFixedTimeInDay's doc comment) has no other day to use,
// so before this fix the task's whole remaining duration was reported as
// no_capacity even on a day with hours of otherwise-visible free time. These
// tests exercise allocateTasks directly (rather than nowClamp's real
// wall-clock gating in rebalance(), which would make a test
// depend on what time it's actually run) by building a capacity map whose
// free interval simply starts after the fixed time, exactly like nowClamp
// would produce.
describe('allocateTasks: fixedTime + single-day window fallback', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '22:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('falls back to placing a fixedTime task later the same day when its pinned slot has already passed (nowClamp-style)', () => {
    // Simulates "now" being 16:30 on a recurring task ("Practice questions")
    // whose fixed practice time was 09:00 — long gone — but the rest of the
    // day (16:30-22:00) is completely free.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], events: [], blocks: [], rules,
      nowClamp: { date: '2026-07-01', minutes: 16 * 60 + 30 },
    });
    const task = {
      id: 'occ1', title: 'Practice questions', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    // Placed somewhere in the still-open remainder of the day, not at the
    // (now unavailable) 09:00 fixed time.
    expect(blocks[0].startTime >= '16:30').toBe(true);
    expect(blocks[0].durationHours).toBe(1);
  });

  it('falls back to later same-day capacity (no conflict reported) when a real event occupies the fixed slot but the rest of the day is free', () => {
    // A genuine collision at the pinned slot only rules out THAT slot — it
    // says nothing about the rest of the day. With hours of open capacity
    // still left (10:00-22:00 here), the task should relocate there instead
    // of being reported as unschedulable while the calendar is visibly free.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Piano lesson' }],
    });
    const task = {
      id: 'occ2', title: 'Piano', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startTime >= '10:00').toBe(true);
    expect(blocks[0].durationHours).toBe(1);
  });

  it('still reports fixed_time_conflict when a real event occupies the fixed slot AND the rest of the day has no room left', () => {
    // Genuine conflict at the pinned slot, and nothing else free that day —
    // this is the one case that should still surface as unschedulable.
    const tightRules = { ...rules, workDayStart: '09:00', workDayEnd: '10:00' };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules: tightRules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Piano lesson' }],
    });
    const task = {
      id: 'occ2', title: 'Piano', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, tightRules, '2026-07-01');
    expect(blocks).toHaveLength(0);
    expect(overflow).toEqual([{
      taskId: 'occ2',
      unplacedHours: 1,
      reason: {
        type: 'fixed_time_conflict',
        conflictingItem: { id: 'ev1', type: 'event', label: 'Piano lesson', start: '09:00', end: '10:00' },
      },
      dueDate: '2026-07-01',
    }]);
  });

  it('does NOT apply the same-day fallback to a normal multi-day fixedTime task (it still just tries again on a later day)', () => {
    // Sanity check that the fallback is scoped to single-day windows only —
    // a normal fixedTime task with several days of runway should behave
    // exactly as before: skip a day whose fixed slot is blocked and place on
    // a later day instead, never relocating within the blocked day itself.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Meeting' }],
    });
    const task = {
      id: 't13', title: 'Multi-day fixedTime', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-03', fixedTime: '09:00',
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    // Placed on 07-02 (or 07-03) at the fixed time, NOT relocated to later on 07-01.
    expect(blocks[0].date).not.toBe('2026-07-01');
    expect(blocks[0].startTime).toBe('09:00');
  });
});

describe('allocateTasks: last-resort splitting when no continuous block fits', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '18:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('splits a task across several small non-contiguous gaps when no single gap can hold the full remaining duration', () => {
    // Three 1-hour meetings carve the day into four 45-min-or-shorter gaps —
    // none individually big enough for a continuous 1.75-hour block, but they
    // sum to well over that. A continuous placement is genuinely impossible,
    // so the task should still fully place by splitting across several of
    // these gaps, as long as it doesn't exceed its chunk-count budget
    // (round(105/30) = 4 chunks — see maxChunksFor in allocator.js) and no
    // individual chunk drops below the 5-minute floor (MIN_CHUNK_HOURS).
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:45', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev2', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev3', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    // Free gaps: 09:00-09:45 (45m), 10:45-11:15 (30m), 12:15-12:45 (30m), 13:45-18:00 (4h15m).
    // 1.75h is fully absorbed by the first three gaps (0.75+0.5+0.5), so this
    // never even needs to reach into the wide-open fourth gap.
    const task = {
      id: 'tsplit', title: 'Deep work', estimatedHours: 1.75, remainingHours: 1.75,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(1.75, 5);
    expect(blocks.length).toBeLessThanOrEqual(4);
  });

  it('fully places a task even when its chunks must go below 30 minutes, as long as the chunk-count cap and 5-minute floor are respected', () => {
    // Same fragmented day as above. A 2-hour task's chunk budget is
    // round(120/30) = 4 -- exactly enough to use all three fragmented gaps
    // (0.75+0.5+0.5 = 1.75h) plus a fourth chunk from the wide-open remainder
    // for the last 0.25h. Unlike the old flat 30-minute floor (which used to
    // force this 0.25h into overflow), a sub-30-minute final chunk is fine
    // here since it's still >= the 5-minute floor and the chunk count is
    // within budget.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:45', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev2', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev3', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    const task = {
      id: 'tsplit2', title: 'Deep work', estimatedHours: 2, remainingHours: 2,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(2, 5);
    expect(blocks.length).toBeLessThanOrEqual(4);
  });

  it('overflows the remainder once the chunk-count cap is exhausted, even though free time is visibly still available', () => {
    // Five small/medium gaps this time -- 09:00-09:20 (20m), 09:45-09:55
    // (10m), 10:45-11:15 (30m), 12:15-12:45 (30m), then a wide-open
    // 13:45-18:00. A 1-hour task's chunk budget is round(60/30) = 2, and
    // first-fit placement claims the FIRST two gaps it reaches (20m + 10m =
    // 30m) rather than skipping ahead to the wide-open one -- so 30 minutes
    // is left over with its chunk budget already spent, even though the
    // calendar visibly still has plenty of free time later that day. This is
    // the intended behavior: the chunk-count cap limits fragmentation even
    // when doing so leaves some capacity unused, rather than fragmenting
    // further to fully place the task.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:20', endTime: '09:45' },
        { id: 'ev2', date: '2026-07-01', startTime: '09:55', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev3', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev4', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    const task = {
      id: 'tcap', title: 'Deep work', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(blocks.length).toBeLessThanOrEqual(2);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(0.5, 5);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].unplacedHours).toBeCloseTo(0.5, 5);
  });

  it('still prefers a single continuous block when one is available, and does not fragment unnecessarily', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules, events: [],
    });
    const task = {
      id: 'tcontig', title: 'Deep work', estimatedHours: 2, remainingHours: 2,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].durationHours).toBe(2);
  });

  it('reports genuine no_capacity when the day truly cannot fit the remaining hours even split', () => {
    const tightRules = { ...rules, workDayStart: '09:00', workDayEnd: '10:00' };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules: tightRules, events: [],
    });
    const task = {
      id: 'tnone', title: 'Deep work', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { overflow } = allocateTasks([task], capacityMap, tightRules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('no_capacity');
    expect(overflow[0].unplacedHours).toBeCloseTo(4, 5);
  });
});

// Regression coverage: horizonEnd (the last date in capacityMap, e.g. "3
// weeks out" by default) is a display/computation window, not the task's
// real deadline. A task whose resolved due date is beyond horizonEnd still
// has genuine runway past the visible horizon, so running out of capacity
// WITHIN the horizon must not be reported as a false 'no_capacity' conflict
// — see allocator.js's final overflow push in allocateTasks.
describe('allocateTasks: no false no_capacity overflow when due date is beyond the horizon', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '10:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('does not report no_capacity for a task due beyond the horizon even though it cannot fit within the visible window', () => {
    // Only a 3-day horizon (1 hour/day = 3 hours total capacity), but the
    // task is due well beyond it and needs more than those 3 hours.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], events: [], blocks: [], rules,
    });
    const task = {
      id: 'tfar', title: 'Long-runway task', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-08-15', // far beyond the 2026-07-01..2026-07-03 horizon
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
  });

  it('still reports no_capacity for a task due WITHIN the horizon that genuinely cannot fit', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], events: [], blocks: [], rules,
    });
    const task = {
      id: 'tnear', title: 'Due within horizon', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-07-03', enforceDueDate: true,
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('no_capacity');
  });

  it('still reports fixed_time_conflict (untouched by the horizon suppression) for a task due WITHIN the horizon whose pinned slot is genuinely occupied', () => {
    // Sanity check that the new due-date-vs-horizon suppression is scoped to
    // the no_capacity case only, per the fix's own requirement — a real
    // fixed_time_conflict within the horizon must keep reporting exactly as
    // before.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Meeting' }],
    });
    const task = {
      id: 'tfixed', title: 'Fixed, due within horizon', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00',
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('fixed_time_conflict');
  });
});

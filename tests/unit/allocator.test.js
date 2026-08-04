import { describe, it, expect } from 'vitest';
import { allocateTasks } from '../../src/algorithms/allocator';
import { computeHorizonCapacity } from '../../src/algorithms/capacityEngine';

const baseRules = {
  workDayStart: '09:00',
  workDayEnd: '17:00',
  maxDailyDeepWorkHours: 8,
  minGapBetweenBlocksMins: 0,
  horizonWeeks: 1,
  bufferDays: 0,
};

// Regression coverage for a "MPC slides"-style bug: placeHoursInDay's
// last-resort "allowUndersizedChunks" pass (used only once every earlier
// pass has already failed to fit a task's leftover hours into a continuous
// chunk clearing minChunkHours) computed `takeMins = Math.round(takeHours *
// 60)`. When `takeHours` was itself a sub-minute floating-point residue left
// over from an earlier placement in the SAME call (interval 1 consumed
// cleanly, leaving `hoursToPlace` at a tiny fractional-minute remainder
// before interval 2 is even considered), that rounded down to 0 minutes —
// producing a placement with start === end that became a real ScheduledBlock
// with identical startTime/endTime in the UI. The fix skips any placement
// whose rounded duration is <= 0 minutes instead of pushing a zero-length one.
describe('allocateTasks: no zero-duration blocks from last-resort splitting', () => {
  it('drops a sub-minute rounding residue instead of producing a start === end block', () => {
    // Two short meetings carve the day into three free intervals:
    //   09:00-09:20 (20min) -- below the default 30min minChunkHours floor,
    //     so only the last-resort split pass (allowUndersizedChunks) will
    //     ever consider it.
    //   09:25-10:00 (35min) -- clears the floor, consumed by the normal
    //     (pass 1) placement.
    //   10:01-17:00 -- wide open.
    // remainingHours is picked so that after pass 1 claims the 35-minute
    // interval, the last-resort pass's single placeHoursInDay call takes the
    // 20-minute interval first, leaving hoursToPlace at a ~0.1-minute
    // floating-point residue before it ever reaches the wide-open third
    // interval -- exactly the scenario that used to round to a 0-minute
    // block there.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:20', endTime: '09:25' },
      { id: 'ev2', date: '2026-07-01', startTime: '10:00', endTime: '10:01' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const middleIntervalHours = 35 / 60;
    const firstIntervalHours = 20 / 60;
    const residueHours = 0.1 / 60; // 0.1 minute -- rounds to 0 when isolated
    const task = {
      id: 't1',
      title: 'Sliver regression',
      estimatedHours: middleIntervalHours + firstIntervalHours + residueHours,
      remainingHours: middleIntervalHours + firstIntervalHours + residueHours,
      dueDate: '2026-07-01',
      minChunkHours: 0.5,
      maxChunkHours: 4,
    };

    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    // No block should ever have zero duration (start === end).
    for (const block of blocks) {
      expect(block.startTime).not.toBe(block.endTime);
      expect(block.durationHours).toBeGreaterThan(0);
    }
  });
});

// Regression coverage for the chunk-count-cap + 5-minute-floor rule
// (replacing the old, incorrect flat 30-minute-per-chunk floor): a task may
// be split into at most round(durationMinutes / 30) chunks -- this caps chunk
// COUNT, not individual chunk size. Individual chunks have no minimum other
// than 5 minutes, except a task whose entire remaining duration is itself
// <=5 minutes may still be placed as a single (shorter) chunk.
describe('allocateTasks: chunk-count cap and 5-minute minimum chunk floor', () => {
  it('caps a 1-hour task at 2 max chunks (round(60/30))', () => {
    // One small 15-minute gap, then the rest of the day wide open. A 1-hour
    // task's chunk budget is exactly 2, which is exactly enough to use the
    // 15-minute sliver as one chunk and take the remaining 45 minutes as a
    // second, continuous chunk from the open remainder -- this is the exact
    // shape of the original bug report (a 1-hour "Piano" task should be able
    // to use a real 15-minute leftover slot instead of discarding it).
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:15', endTime: '09:30' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't2', title: '1-hour task', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01',
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(blocks.length).toBeLessThanOrEqual(2);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('allows a 1h20m task up to 3 max chunks (round(80/30))', () => {
    // Two small 15-minute gaps, then the rest of the day wide open. Max
    // chunks = round(80/30) = 3, exactly enough to use both slivers as two
    // chunks and take the remaining 50 minutes as a third, continuous chunk.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:15', endTime: '09:30' },
      { id: 'ev2', date: '2026-07-01', startTime: '09:45', endTime: '10:00' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't3', title: '1h20m task', estimatedHours: 80 / 60, remainingHours: 80 / 60, dueDate: '2026-07-01',
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(blocks.length).toBeLessThanOrEqual(3);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(80 / 60, 5);
  });

  it('caps a 1h10m task at 2 max chunks (round(70/30))', () => {
    const task = {
      id: 't4', title: '1h10m task', estimatedHours: 70 / 60, remainingHours: 70 / 60, dueDate: '2026-07-01',
    };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });

    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(blocks.length).toBeLessThanOrEqual(2);
  });

  it('places a chunk smaller than 30 minutes (down to the 5-minute floor) as long as the chunk-count cap allows it', () => {
    // A single 15-minute gap, immediately followed by a wide-open remainder
    // of the day. A 1-hour task's max-chunks budget is 2, so it may place a
    // sub-30-minute 15-minute chunk here and take the rest (45min) from the
    // open remainder -- this is exactly the bug scenario described (a 1-hour
    // "Piano" task should be able to use a real 15-minute leftover slot).
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:15', endTime: '09:30' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't5', title: 'Piano', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01',
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(1, 5);
    // At least one placed chunk should be the small 15-minute leftover slot.
    expect(blocks.some((b) => Math.abs(b.durationHours - 15 / 60) < 1e-9)).toBe(true);
  });

  // Regression coverage for the "piano" bug: the scheduler's greedy first-fit
  // used to always bite into the EARLIEST free interval first, even a tiny
  // one, which could burn a task's LAST available chunk on a small partial
  // placement while leaving genuine unplaced time -- even though a LATER
  // interval that same day was big enough to hold the whole remainder as one
  // continuous block. placeHoursInDay now looks ahead: on the task's last
  // available chunk, if the current interval can't fit the full remainder
  // but a later one can, it skips ahead to the later interval instead of
  // fragmenting.
  it('prefers a later interval that fits the whole remainder over spending the last chunk on a partial slot', () => {
    // maxChunksFor(1h) = 2. A single early 15-minute gap (09:00-09:15) uses
    // up chunk #1, leaving 45 minutes remaining on the task's LAST chunk.
    // Without the lookahead, that last chunk would be forced into the next
    // gap the front-to-back walk reaches -- 09:30-10:00 (30min), too small
    // to finish the task, leaving 15 unplaceable minutes even though
    // 19:00-22:00 is wide open. With the lookahead, the last chunk skips the
    // undersized 09:30 gap and takes the whole 45-minute remainder from the
    // 19:00 opening instead, as one continuous block.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:15', endTime: '09:30' },
      { id: 'ev2', date: '2026-07-01', startTime: '10:00', endTime: '19:00' },
    ];
    const rules = { ...baseRules, workDayStart: '09:00', workDayEnd: '22:00' };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules, events });

    const task = {
      id: 't_piano', title: 'Piano', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01', enforceDueDate: true,
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(1, 5);
    // The last chunk should be a single continuous 45-minute block starting
    // at 19:00 (the wide-open remainder), not fragmented further.
    expect(blocks.some((b) => b.startTime === '19:00' && Math.abs(b.durationHours - 45 / 60) < 1e-9)).toBe(true);
    expect(blocks).toHaveLength(2);
  });

  it('reports no_capacity when only the 15-minute slot exists and no other free time is available', () => {
    const tightRules = { ...baseRules, workDayStart: '09:00', workDayEnd: '09:30' };
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:15', endTime: '09:20' },
    ];
    // Free time: 09:00-09:15 (15m) + 09:20-09:30 (10m) = 25 minutes total,
    // nowhere near enough for a 1-hour task.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: tightRules, events });

    const task = {
      id: 't6', title: 'Piano', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01', enforceDueDate: true,
    };

    const { overflow } = allocateTasks([task], capacityMap, tightRules, '2026-07-01');

    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('no_capacity');
  });

  it('never fragments a task whose entire remaining time is already <=5 minutes', () => {
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:10', endTime: '09:35' },
      { id: 'ev2', date: '2026-07-01', startTime: '09:45', endTime: '10:10' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't7', title: 'Tiny task', estimatedHours: 5 / 60, remainingHours: 5 / 60, dueDate: '2026-07-01',
    };

    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(blocks.length).toBe(1);
    expect(blocks[0].durationHours).toBeCloseTo(5 / 60, 5);
  });

  it('has no maximum chunk-size floor beyond MIN_CHUNK_HOURS -- a large continuous gap is used as one chunk, not needlessly split', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const task = {
      id: 't8', title: 'Deep work', estimatedHours: 2, remainingHours: 2, dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].durationHours).toBe(2);
  });
});

// Regression coverage for a "partial placement stranded" bug: a task whose
// maxChunksFor budget rounds down to 1 (any task <=30min) used to be able to
// burn its ONLY chunk on a tiny sliver on day 1, then find its chunk budget
// exhausted for every later pass -- silently overflowing the rest even
// though later days in the same window had ample free capacity. Fixed via a
// cross-day whole-block lookahead (hasLaterFullFitDay), the multi-day
// counterpart to placeHoursInDay's existing same-day lookahead.
describe('allocateTasks: unplaced remainder is pushed to a later day with room, not stranded', () => {
  it('pushes a whole 30-minute no-due-date task to day 2 instead of splitting a 5-minute sliver into day 1 and overflowing the rest', () => {
    // Day 1: only a 5-minute gap (09:00-09:05), the rest of the day busy.
    // Day 2 onward: wide open. No due date at all -- getTaskWindow already
    // gives this task the full horizon as its window.
    const events = [{ id: 'ev1', date: '2026-07-01', startTime: '09:05', endTime: '17:00' }];
    const rules = { ...baseRules, horizonWeeks: 1 };
    const capacityMap = computeHorizonCapacity('2026-07-01', 7, { routines: [], blocks: [], rules, events });
    const task = {
      id: 'no_due', title: '30 min task', estimatedHours: 0.5, remainingHours: 0.5,
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    // The whole 30 minutes lands as ONE continuous block on day 2 -- not
    // fragmented into day 1's 5-minute sliver plus a stranded remainder.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].date).toBe('2026-07-02');
    expect(blocks[0].durationHours).toBeCloseTo(0.5, 5);
  });

  it('still reports overflow (not a horizon spill) for an enforceDueDate single-day task that only partially fits', () => {
    // Same shape (5-minute gap, task <=30min so maxChunksFor=1), but this
    // task's due date IS enforced -- its window collapses to that single day
    // (see getTaskWindow), so the fix must NOT push the remainder to day 2 or
    // any other day. The 5-minute gap is genuinely all there is on the one
    // day this task is allowed to use.
    const events = [{ id: 'ev1', date: '2026-07-01', startTime: '09:05', endTime: '17:00' }];
    const rules = { ...baseRules, horizonWeeks: 1 };
    const capacityMap = computeHorizonCapacity('2026-07-01', 7, { routines: [], blocks: [], rules, events });
    const task = {
      id: 'enforced', title: '30 min task, enforced', estimatedHours: 0.5, remainingHours: 0.5,
      dueDate: '2026-07-01', enforceDueDate: true,
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');

    // Single-day window -- the cross-day lookahead must not apply here, so
    // the 5-minute gap is used (there's nothing else to skip ahead to
    // anyway) and the remaining 25 minutes genuinely overflow.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].date).toBe('2026-07-01');
    expect(blocks[0].durationHours).toBeCloseTo(5 / 60, 5);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].taskId).toBe('enforced');
    expect(overflow[0].unplacedHours).toBeCloseTo(25 / 60, 2);
  });

  it('spills a non-enforced due-date task past its due date to the horizon when the due-date-bounded window has no room', () => {
    // Due date is 07-02 (soft, not enforced) -- windowEnd lands on/near the
    // due date. Every day up to and including the due date is fully busy;
    // 07-03 (past the due date, still within the horizon) is wide open. With
    // enforceDueDate false, the remainder should still land somewhere in the
    // horizon rather than overflowing just because it's past the soft due
    // date.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '00:00', endTime: '23:59' },
      { id: 'ev2', date: '2026-07-02', startTime: '00:00', endTime: '23:59' },
    ];
    const rules = { ...baseRules, horizonWeeks: 1, bufferDays: 0 };
    const capacityMap = computeHorizonCapacity('2026-07-01', 7, { routines: [], blocks: [], rules, events });
    const task = {
      id: 'soft_due', title: '1h task, soft due date', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-02',
    };

    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(blocks.some((b) => b.date === '2026-07-03')).toBe(true);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

// Regression coverage for the fixedTime pre-pass: a fixedTime task's pinned
// slot must always win against a competing task, regardless of the other
// task's priority/urgency score -- a fixed time commitment is a real-world
// clock-time commitment, not just a preference. Before this pre-pass existed,
// allocateTasks placed every task (fixedTime or not) in one single
// priority-sorted pass, so a higher-scored non-fixedTime task could claim a
// fixedTime task's exact slot first.
describe('allocateTasks: fixedTime pre-pass (priority immunity for the exact pinned slot)', () => {
  it("a low-priority fixedTime task keeps its exact slot even though a same-day urgent non-fixedTime task scores far higher", () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const fixedTask = {
      id: 'low_fixed', title: 'Low-priority fixed', priority: 'low', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };
    // Urgent, high-scoring, due the same day -- would normally place FIRST
    // and could otherwise grab 10:00-11:00 for itself.
    const urgentTask = {
      id: 'urgent_flex', title: 'Urgent flexible', priority: 'urgent', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true,
    };

    const { blocks, overflow } = allocateTasks([urgentTask, fixedTask], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    const fixedBlock = blocks.find((b) => b.taskId === 'low_fixed');
    expect(fixedBlock.startTime).toBe('10:00');
    // The urgent flexible task should have been placed elsewhere (not
    // 10:00-11:00, since that slot was carved out by the pre-pass already).
    const urgentBlock = blocks.find((b) => b.taskId === 'urgent_flex');
    expect(urgentBlock.startTime).not.toBe('10:00');
  });

  it('among two competing fixedTime tasks for the same slot, the higher-priority/urgency one still wins (pre-pass sorts by score too)', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const lowFixed = {
      id: 'low', title: 'Low fixed', priority: 'low', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };
    const urgentFixed = {
      id: 'urgent', title: 'Urgent fixed', priority: 'urgent', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };

    const { blocks, overflow } = allocateTasks([lowFixed, urgentFixed], capacityMap, baseRules, '2026-07-01');

    // The urgent one claims 10:00; the low-priority one has no other day to
    // retry on (enforceDueDate) and no fallback slot configured here beyond
    // ordinary first-fit -- it should still get scheduled elsewhere same day
    // via the same-day fallback (single-day window), just not at 10:00.
    const urgentBlock = blocks.find((b) => b.taskId === 'urgent');
    expect(urgentBlock.startTime).toBe('10:00');
    const lowBlock = blocks.find((b) => b.taskId === 'low');
    expect(lowBlock).toBeTruthy();
    expect(lowBlock.startTime).not.toBe('10:00');
    expect(overflow).toHaveLength(0);
  });

  it('a passive fixedTime task is excluded from the pre-pass and can overlap a non-passive task at the same slot', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const passiveFixed = {
      id: 'laundry', title: 'Laundry', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01',
      enforceDueDate: true, fixedTime: '10:00', isPassive: true,
    };
    const nonPassive = {
      id: 'meeting', title: 'Meeting', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-01',
      enforceDueDate: true, fixedTime: '10:00',
    };

    const { blocks, overflow } = allocateTasks([passiveFixed, nonPassive], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    const laundryBlock = blocks.find((b) => b.taskId === 'laundry');
    const meetingBlock = blocks.find((b) => b.taskId === 'meeting');
    // Both land at 10:00 -- passive tasks are allowed to overlap, and since
    // laundry never competed in the pre-pass, the non-passive task still got
    // first crack at 10:00 in the normal pass with nothing carved out yet.
    expect(laundryBlock.startTime).toBe('10:00');
    expect(meetingBlock.startTime).toBe('10:00');
  });
});

// Regression coverage for Change 2: a fixedTime task's same-day fallback
// (allowSameDayFallback, only possible with a single-day/enforceDueDate
// window) must be flagged to the caller even when it fully succeeds --
// landing at an unrequested time-of-day is worth surfacing regardless of
// whether every hour got placed.
describe('allocateTasks: timeShifted -- fixed-time same-day fallback is always flagged', () => {
  it('flags a fixedTime task in timeShifted when the fallback engages and fully places the leftover hours elsewhere', () => {
    // 09:00-10:00 busy (an event), so the 10:00 fixedTime slot is actually
    // free -- instead conflict it directly: an event sits ON the fixed time.
    const events = [{ id: 'ev1', date: '2026-07-01', startTime: '10:00', endTime: '10:30' }];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });
    const task = {
      id: 'fixed1', title: 'Fixed task', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };

    const { blocks, overflow, timeShifted } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    // Fully placed -- not in overflow.
    expect(overflow).toHaveLength(0);
    const total = blocks.reduce((s, b) => s + b.durationHours, 0);
    expect(total).toBeCloseTo(1, 5);
    // But NOT at 10:00 (the event occupies it), so it must be flagged.
    expect(blocks.every((b) => b.startTime !== '10:00')).toBe(true);
    expect(timeShifted).toHaveLength(1);
    expect(timeShifted[0].taskId).toBe('fixed1');
    expect(timeShifted[0].reason.type).toBe('fixed_time_shifted');
    expect(timeShifted[0].reason.conflictingItem.id).toBe('ev1');
  });

  it('does not flag a fixedTime task in timeShifted when it places cleanly at its pinned time', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const task = {
      id: 'fixed2', title: 'Fixed task', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };

    const { blocks, overflow, timeShifted } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(timeShifted).toHaveLength(0);
    expect(blocks[0].startTime).toBe('10:00');
  });

  it('does not flag a multi-day (non-single-day-window) fixedTime task -- the fallback only ever engages for a single-day window', () => {
    // Multi-day window (no enforceDueDate): day 1 is entirely busy (an
    // all-day event), so the task's pacing never even attempts a placement
    // there. remainingHours is kept under PACING_SHARE_THRESHOLD_HOURS's
    // per-day ideal-share gate (0.5h) so pass 1 doesn't fragment a sliver
    // onto day 2 at the fixed time either -- it's fully claimed there in one
    // continuous chunk by the sweep pass instead. No same-day fallback (that
    // only ever applies to a single-day/enforceDueDate window) should engage.
    const events = [{ id: 'ev1', date: '2026-07-01', startTime: '00:00', endTime: '23:59' }];
    const capacityMap = computeHorizonCapacity('2026-07-01', 2, { routines: [], blocks: [], rules: baseRules, events });
    const task = {
      id: 'fixed3', title: 'Fixed task', estimatedHours: 0.4, remainingHours: 0.4,
      dueDate: '2026-07-02', fixedTime: '10:00',
    };

    const { blocks, overflow, timeShifted } = allocateTasks([task], capacityMap, { ...baseRules, bufferDays: 0 }, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(timeShifted).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].date).toBe('2026-07-02');
    expect(blocks[0].startTime).toBe('10:00');
  });
});

// Regression coverage: a fixedTime slot outside working hours entirely (not
// occupied by anything -- just never in bounds) must be reported as a
// distinct, specific reason instead of falling through to generic
// no_capacity, so the UI can say "outside your working hours" rather than a
// vague capacity message.
describe('allocateTasks: fixed_time_outside_hours', () => {
  it('reports fixed_time_outside_hours when the pinned time is before the work day starts', () => {
    // A multi-day window (dueDate two days out, no enforceDueDate) where
    // EVERY day's pinned time is outside working hours -- windowStart !==
    // windowEnd, so the same-day fallback (Change 2, single-day-window only)
    // never engages, and the task genuinely can't be placed anywhere in its
    // window: a clean `overflow`-reported `fixed_time_outside_hours`.
    const capacityMap = computeHorizonCapacity('2026-07-01', 2, { routines: [], blocks: [], rules: baseRules, events: [] });
    const task = {
      id: 'early', title: 'Too early', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-02', fixedTime: '06:00', // workDayStart is 09:00
    };

    const { overflow } = allocateTasks([task], capacityMap, { ...baseRules, bufferDays: 0 }, '2026-07-01');

    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('fixed_time_outside_hours');
  });

  it('reports fixed_time_outside_hours when the pinned time is at/after the work day ends', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 2, { routines: [], blocks: [], rules: baseRules, events: [] });
    const task = {
      id: 'late', title: 'Too late', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-02', fixedTime: '18:00', // workDayEnd is 17:00
    };

    const { overflow } = allocateTasks([task], capacityMap, { ...baseRules, bufferDays: 0 }, '2026-07-01');

    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('fixed_time_outside_hours');
  });

  it('still reports fixed_time_conflict (not outside_hours) when the pinned time IS within working hours but occupied', () => {
    const events = [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '17:00' }]; // whole day busy
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });
    const task = {
      id: 'occupied', title: 'Occupied slot', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '10:00',
    };

    const { overflow } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('fixed_time_conflict');
    expect(overflow[0].reason.conflictingItem.id).toBe('ev1');
  });

  it('a single-day-window fixedTime task with an outside-hours pinned time still gets rescued by the same-day fallback and reported as fixed_time_shifted, not overflow', () => {
    // Single-day window (today === dueDate under a 1-day horizon) DOES allow
    // the same-day fallback to engage (see allowSameDayFallback) regardless
    // of WHY the pinned slot failed -- an outside-hours bounds issue is no
    // different from an occupied-slot conflict here. So this ends up fully
    // placed (via ordinary first-fit) and flagged via `timeShifted`, not
    // reported as unplaced `overflow`.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const task = {
      id: 'early_singleday', title: 'Too early, single day', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', fixedTime: '06:00',
    };

    const { blocks, overflow, timeShifted } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(timeShifted).toHaveLength(1);
    expect(timeShifted[0].reason.type).toBe('fixed_time_shifted');
  });
});

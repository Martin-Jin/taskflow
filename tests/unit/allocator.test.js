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

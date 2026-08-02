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

// Regression coverage for the 30-minute split floor: a task at or under 30
// minutes total must never be fragmented into multiple blocks, even as a
// last resort, and any task large enough to be split must never produce a
// chunk smaller than 30 minutes -- even when the task's own minChunkHours
// asks for something smaller.
describe('allocateTasks: 30-minute minimum split chunk', () => {
  it('never splits a task whose entire remaining time is <=30 minutes, even across fragmented free time', () => {
    // Two short meetings fragment the day into slivers no single one of
    // which can hold the whole 20-minute task on its own until the last
    // (wide-open) interval -- if splitting were still allowed, the old
    // last-resort pass would have scattered pieces across the earlier slivers.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:10', endTime: '09:35' },
      { id: 'ev2', date: '2026-07-01', startTime: '09:45', endTime: '10:10' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't2',
      title: 'Short task',
      estimatedHours: 20 / 60,
      remainingHours: 20 / 60,
      dueDate: '2026-07-01',
      minChunkHours: 0.25,
      maxChunkHours: 4,
    };

    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    expect(blocks.length).toBe(1);
    expect(blocks[0].durationHours).toBeCloseTo(20 / 60, 5);
  });

  it('never produces a split chunk smaller than 30 minutes, even when the task requests a smaller minChunkHours', () => {
    // A single 40-minute free gap, immediately followed by a 20-minute gap.
    // A 1-hour task asking for a 0.25h minChunkHours would, pre-fix, be
    // allowed to split 40min + 20min across the two gaps. The 30-minute
    // floor should instead force the 20-minute gap to be skipped as too
    // small, leaving the remainder to overflow/spill rather than producing
    // a sub-30-minute block.
    const events = [
      { id: 'ev1', date: '2026-07-01', startTime: '09:40', endTime: '10:00' },
      { id: 'ev2', date: '2026-07-01', startTime: '10:20', endTime: '17:00' },
    ];
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, { routines: [], blocks: [], rules: baseRules, events });

    const task = {
      id: 't3',
      title: 'Task needing a floored split',
      estimatedHours: 1,
      remainingHours: 1,
      dueDate: '2026-07-01',
      minChunkHours: 0.25,
      maxChunkHours: 4,
    };

    const { blocks } = allocateTasks([task], capacityMap, baseRules, '2026-07-01');

    for (const block of blocks) {
      expect(block.durationHours).toBeGreaterThanOrEqual(0.5 - 1e-9);
    }
  });
});

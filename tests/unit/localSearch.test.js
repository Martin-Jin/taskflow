import { describe, it, expect } from 'vitest';
import { allocateTasks, resolveDueDate } from '../../src/algorithms/allocator';
import { computeHorizonCapacity } from '../../src/algorithms/capacityEngine';
import { runLocalSearch } from '../../src/algorithms/localSearch';
import { evaluatePlacementCost } from '../../src/algorithms/placementCost';
import { timeToMinutes } from '../../src/utils/dateUtils';

const baseRules = {
  workDayStart: '09:00',
  workDayEnd: '17:00',
  maxDailyDeepWorkHours: 8,
  minGapBetweenBlocksMins: 0,
  horizonWeeks: 2,
  bufferDays: 0,
};

const today = '2026-07-01'; // Wednesday

/** Run the greedy seed, then local search, for a given task list + capacity map. Returns everything a test might want. */
function seedAndSearch(tasks, capacityMap, rules = baseRules, taskById, options) {
  const fullTaskById = taskById || new Map(tasks.map((t) => [t.id, t]));
  const { blocks: seedBlocks, overflow, timeShifted } = allocateTasks(tasks, capacityMap, rules, today, fullTaskById);
  const movableTaskIds = new Set(tasks.filter((t) => !t.fixedTime && !t.isPassive).map((t) => t.id));
  const movableBlocks = seedBlocks.filter((b) => movableTaskIds.has(b.taskId));
  const immovableBlocks = seedBlocks.filter((b) => !movableTaskIds.has(b.taskId));
  const seedCost = evaluatePlacementCost(seedBlocks, tasks, (t) => resolveDueDate(t, fullTaskById)).total;
  const result = runLocalSearch({
    movableBlocks,
    immovableBlocks,
    tasks,
    taskById: fullTaskById,
    capacityMap,
    rules,
    today,
    resolveDueDateFn: (t) => resolveDueDate(t, fullTaskById),
    options,
  });
  const finalBlocks = [...result.blocks, ...immovableBlocks];
  const finalCost = evaluatePlacementCost(finalBlocks, tasks, (t) => resolveDueDate(t, fullTaskById)).total;
  return { seedBlocks, finalBlocks, seedCost, finalCost, overflow, timeShifted, searchResult: result };
}

describe('runLocalSearch: never worse than the seed', () => {
  it('returns a placement whose total cost is <= the seed cost across a range of scenarios', () => {
    const scenarios = [
      // Scenario A: several fragmentable multi-hour tasks with a wide-open horizon -- lots of room to improve.
      () => {
        const tasks = [
          { id: 'a1', title: 'A', priority: 'medium', estimatedHours: 3, remainingHours: 3, dueDate: '2026-07-10' },
          { id: 'a2', title: 'B', priority: 'high', estimatedHours: 2, remainingHours: 2, dueDate: '2026-07-05' },
          { id: 'a3', title: 'C', priority: 'low', estimatedHours: 4, remainingHours: 4, dueDate: '2026-07-12' },
        ];
        const capacityMap = computeHorizonCapacity(today, 14, { routines: [], blocks: [], rules: baseRules, events: [] });
        return { tasks, capacityMap };
      },
      // Scenario B: tight capacity, little room to move anything -- search should still never make things worse.
      () => {
        const events = [{ id: 'ev1', date: today, startTime: '09:30', endTime: '16:30' }];
        const tasks = [{ id: 'b1', title: 'Tight', priority: 'urgent', estimatedHours: 1, remainingHours: 1, dueDate: today, enforceDueDate: true }];
        const capacityMap = computeHorizonCapacity(today, 1, { routines: [], blocks: [], rules: baseRules, events });
        return { tasks, capacityMap };
      },
      // Scenario C: a single task with no due date spread across a long horizon.
      () => {
        const tasks = [{ id: 'c1', title: 'Undated-ish', priority: 'low', estimatedHours: 6, remainingHours: 6, dueDate: '2026-07-20' }];
        const capacityMap = computeHorizonCapacity(today, 14, { routines: [], blocks: [], rules: baseRules, events: [] });
        return { tasks, capacityMap };
      },
    ];

    for (const build of scenarios) {
      const { tasks, capacityMap } = build();
      const { seedCost, finalCost } = seedAndSearch(tasks, capacityMap);
      expect(finalCost).toBeLessThanOrEqual(seedCost + 1e-6);
    }
  });

  it('falls back to the seed unchanged when the search has zero time budget (cannot possibly improve)', () => {
    const tasks = [
      { id: 'a1', title: 'A', priority: 'medium', estimatedHours: 3, remainingHours: 3, dueDate: '2026-07-10' },
      { id: 'a2', title: 'B', priority: 'high', estimatedHours: 2, remainingHours: 2, dueDate: '2026-07-05' },
    ];
    const capacityMap = computeHorizonCapacity(today, 14, { routines: [], blocks: [], rules: baseRules, events: [] });
    const { seedBlocks, finalBlocks, seedCost, finalCost } = seedAndSearch(tasks, capacityMap, baseRules, undefined, { timeBudgetMs: 0, maxIterations: 0 });

    expect(finalCost).toBeCloseTo(seedCost, 9);
    // Same blocks (by id/date/time), not just equal cost -- confirms the seed truly passed through untouched.
    const seedKey = seedBlocks.map((b) => `${b.id}|${b.date}|${b.startTime}`).sort();
    const finalKey = finalBlocks.map((b) => `${b.id}|${b.date}|${b.startTime}`).sort();
    expect(finalKey).toEqual(seedKey);
  });

  it('never moves a fixed-time task\'s block, and never moves a passive task\'s block', () => {
    const capacityMap = computeHorizonCapacity(today, 1, { routines: [], blocks: [], rules: baseRules, events: [] });
    const tasks = [
      { id: 'fixed1', title: 'Fixed', priority: 'low', estimatedHours: 1, remainingHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '10:00' },
      { id: 'passive1', title: 'Laundry', priority: 'low', estimatedHours: 1, remainingHours: 1, dueDate: today, enforceDueDate: true, isPassive: true },
      { id: 'flex1', title: 'Flexible', priority: 'urgent', estimatedHours: 1, remainingHours: 1, dueDate: today, enforceDueDate: true },
    ];
    const { seedBlocks, finalBlocks } = seedAndSearch(tasks, capacityMap);

    const fixedSeed = seedBlocks.find((b) => b.taskId === 'fixed1');
    const fixedFinal = finalBlocks.find((b) => b.taskId === 'fixed1');
    expect(fixedFinal).toEqual(fixedSeed);

    const passiveSeed = seedBlocks.find((b) => b.taskId === 'passive1');
    const passiveFinal = finalBlocks.find((b) => b.taskId === 'passive1');
    expect(passiveFinal).toEqual(passiveSeed);
  });
});

describe('runLocalSearch: dependency ordering is never violated', () => {
  it('never places a single-hop dependent task\'s block before its dependency\'s last block ends', () => {
    const capacityMap = computeHorizonCapacity(today, 5, { routines: [], blocks: [], rules: baseRules, events: [] });
    const tasks = [
      { id: 'dep', title: 'Dependency', priority: 'medium', estimatedHours: 2, remainingHours: 2, dueDate: '2026-07-03' },
      { id: 'dependent', title: 'Dependent', priority: 'urgent', estimatedHours: 2, remainingHours: 2, dueDate: '2026-07-04', dependsOn: ['dep'] },
    ];
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const { finalBlocks } = seedAndSearch(tasks, capacityMap, baseRules, taskById, { maxIterations: 500, timeBudgetMs: 200 });

    const depLastEnd = latestEnd(finalBlocks.filter((b) => b.taskId === 'dep'));
    const dependentBlocks = finalBlocks.filter((b) => b.taskId === 'dependent');
    for (const b of dependentBlocks) {
      expect(isAfterOrEqual({ date: b.date, minutes: timeToMinutes(b.startTime) }, depLastEnd)).toBe(true);
    }
  });

  it('never violates ordering across a 3-hop transitive chain (A <- B <- C), even after many search iterations', () => {
    const capacityMap = computeHorizonCapacity(today, 10, { routines: [], blocks: [], rules: baseRules, events: [] });
    const tasks = [
      { id: 'A', title: 'A', priority: 'low', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-15' },
      { id: 'B', title: 'B', priority: 'medium', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-15', dependsOn: ['A'] },
      { id: 'C', title: 'C', priority: 'urgent', estimatedHours: 1, remainingHours: 1, dueDate: '2026-07-15', dependsOn: ['B'] },
    ];
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    // NOTE: allocateTasks itself has no dependency awareness (that filtering normally happens in rebalanceEngine
    // upstream) -- this test exercises localSearch's OWN dependency enforcement directly, independent of whether
    // the greedy seed happened to already respect it, by running many iterations with a generous time budget so
    // the search has every opportunity to explore (and correctly reject) an ordering-violating move.
    const { finalBlocks } = seedAndSearch(tasks, capacityMap, baseRules, taskById, { maxIterations: 3000, timeBudgetMs: 300 });

    const aEnd = latestEnd(finalBlocks.filter((b) => b.taskId === 'A'));
    const bBlocks = finalBlocks.filter((b) => b.taskId === 'B');
    const bEnd = latestEnd(bBlocks);
    const cBlocks = finalBlocks.filter((b) => b.taskId === 'C');

    for (const b of bBlocks) {
      expect(isAfterOrEqual({ date: b.date, minutes: timeToMinutes(b.startTime) }, aEnd)).toBe(true);
    }
    for (const c of cBlocks) {
      expect(isAfterOrEqual({ date: c.date, minutes: timeToMinutes(c.startTime) }, bEnd)).toBe(true);
      expect(isAfterOrEqual({ date: c.date, minutes: timeToMinutes(c.startTime) }, aEnd)).toBe(true);
    }
  });
});

/** Latest {date, minutes} end-point across a set of blocks (for dependency-ordering assertions). */
function latestEnd(blocks) {
  let result = { date: '0000-00-00', minutes: 0 };
  for (const b of blocks) {
    const minutes = timeToMinutes(b.endTime);
    if (b.date > result.date || (b.date === result.date && minutes > result.minutes)) {
      result = { date: b.date, minutes };
    }
  }
  return result;
}

/** True if {date,minutes} A is at or after B. */
function isAfterOrEqual(a, b) {
  if (a.date > b.date) return true;
  if (a.date < b.date) return false;
  return a.minutes >= b.minutes;
}

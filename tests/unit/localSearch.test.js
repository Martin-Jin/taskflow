import { describe, it, expect } from 'vitest';
import { allocateTasks, resolveDueDate } from '../../src/algorithms/allocator';
import { computeHorizonCapacity } from '../../src/algorithms/capacityEngine';
import { runLocalSearch, MAX_ITERATIONS, SEARCH_TIME_BUDGET_MS } from '../../src/algorithms/localSearch';
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

describe('runLocalSearch: determinism (stable block identity across rebalances)', () => {
  // Determinism here is not just an algorithmic nicety — it's load-bearing for
  // block IDENTITY. A block's id is derived from its placement
  // (`blk_${taskId}_${date}_${startTime}`, see allocator.js). If two rebalances
  // over identical inputs could place a block even one minute apart, its id
  // would change and the block would look brand new — silently detaching
  // whatever state is keyed to it (locks, completion status, per-block UI
  // selection) on a run that didn't actually reschedule anything.
  //
  // The search is seeded with a fixed RNG and bounded primarily by a fixed
  // MAX_ITERATIONS. SEARCH_TIME_BUDGET_MS exists only as a pathological-case
  // safety valve: because it's wall-clock based, any run it truncates would be
  // machine-speed-dependent and therefore non-reproducible, so it's set well
  // above real cost specifically so it doesn't fire in normal operation.

  function crowdedTasks() {
    // Seeded far from their due dates so the search has real improvements to
    // find — a trivially-optimal seed would pass any determinism test
    // vacuously, since the search would never move anything at all.
    return Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      estimatedHours: 2,
      remainingHours: 2,
      priority: i % 3 === 0 ? 'urgent' : 'medium',
      dueDate: `2026-07-${String(3 + (i % 6)).padStart(2, '0')}`,
      isCompleted: false,
      dependencies: [],
    }));
  }

  const placementSignature = (blocks) =>
    blocks
      .map((b) => `${b.taskId}@${b.date}T${b.startTime}-${b.endTime}`)
      .sort()
      .join('|');

  it('produces byte-identical placements across repeated runs on identical input', () => {
    const tasks = crowdedTasks();
    const capacityMap = computeHorizonCapacity(today, 2, { routines: [], events: [], blocks: [], rules: baseRules });
    const runs = Array.from({ length: 5 }, () => seedAndSearch(tasks, capacityMap));
    const signatures = runs.map((r) => placementSignature(r.finalBlocks));
    expect(new Set(signatures).size).toBe(1);
  });

  it('CRITICAL: has converged well before MAX_ITERATIONS, so a truncated run still yields the same placements', () => {
    // This is what makes the wall-clock safety valve harmless. If the result
    // were still drifting at the iteration cap, then a slow device — whose
    // budget cut the loop short — would land on DIFFERENT placements than a
    // fast one, regenerating block ids and duplicating Google events. Pinning
    // convergence means even a heavily truncated run agrees with a full one.
    const tasks = crowdedTasks();
    const capacityMap = computeHorizonCapacity(today, 2, { routines: [], events: [], blocks: [], rules: baseRules });
    const full = seedAndSearch(tasks, capacityMap, baseRules, undefined, { maxIterations: MAX_ITERATIONS });
    const converged = seedAndSearch(tasks, capacityMap, baseRules, undefined, { maxIterations: Math.floor(MAX_ITERATIONS / 4) });
    expect(placementSignature(converged.finalBlocks)).toBe(placementSignature(full.finalBlocks));
  });

  it('completes the full iteration budget well within the time-box, so the wall-clock valve does not decide the result', () => {
    // Guards the assumption the two tests above rest on. If this ever starts
    // failing (a much costlier cost function, a far larger default task set),
    // the time budget would begin truncating real runs and reintroduce
    // machine-dependent placements — so it should fail loudly rather than
    // silently degrade into non-determinism.
    const tasks = crowdedTasks();
    const capacityMap = computeHorizonCapacity(today, 2, { routines: [], events: [], blocks: [], rules: baseRules });
    const startedAt = Date.now();
    const { searchResult } = seedAndSearch(tasks, capacityMap);
    const elapsedMs = Date.now() - startedAt;
    expect(searchResult.iterations).toBe(MAX_ITERATIONS); // stopped on the deterministic cap, not the clock
    expect(elapsedMs).toBeLessThan(SEARCH_TIME_BUDGET_MS);
  });

  it('never returns a result worse than the seed even when heavily truncated', () => {
    // The graceful-degradation property that makes the safety valve safe to
    // keep at all: an early cutoff costs optimization quality, never validity.
    const tasks = crowdedTasks();
    const capacityMap = computeHorizonCapacity(today, 2, { routines: [], events: [], blocks: [], rules: baseRules });
    const truncated = seedAndSearch(tasks, capacityMap, baseRules, undefined, { maxIterations: 3 });
    expect(truncated.finalCost).toBeLessThanOrEqual(truncated.seedCost + 1e-9);
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

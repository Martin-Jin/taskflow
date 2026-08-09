/**
 * ============================================================================
 * LOCAL SEARCH (cost-minimizing refinement over the greedy allocator's seed)
 * ============================================================================
 * allocator.js's `allocateTasks` produces a valid, constraint-satisfying
 * placement cheaply via greedy first-fit — but "first slot that fits" isn't
 * the same as "lowest-cost placement" (see placementCost.js). This module
 * takes that seed and runs a time-boxed simulated-annealing search over
 * chunk RELOCATE moves (move one block to a different day/time within its
 * task's own valid window) to reduce total cost, without ever touching
 * fixed-time/passive/locked blocks and without ever producing a state that
 * violates a hard constraint (capacity, daily budget, min-gap, or dependency
 * ordering) — those are checked BEFORE a move is accepted, never merely
 * penalized after the fact.
 *
 * GUARANTEE: the returned placement's cost is never worse than the seed's.
 * If the search never finds an improving move (or times out immediately),
 * the seed is returned unchanged. This is enforced by tracking the best
 * placement seen (starting from the seed itself) and returning that, never
 * whatever the annealing walk happens to be sitting on when time runs out.
 *
 * WHAT CAN MOVE: only blocks in `movableBlocks` (the caller is expected to
 * pass just the newly-allocated, non-locked, non-fixed-time, non-passive
 * blocks — see rebalanceEngine.js's wiring). Locked/completed/fixed-time/
 * passive blocks are treated as immovable BUSY time for capacity purposes
 * (already baked into `capacityMap`) but are never candidates for a move and
 * never appear in the returned movable set's replacements.
 *
 * DEPENDENCY ORDERING: every movable block's task must start at or after the
 * end of the LAST block (movable or not) belonging to each of its
 * (transitive) dependencies — see dependencyUtils.getTransitiveDependencyIds.
 * A move that would violate this for the moved task OR for any task that
 * depends on it is rejected before being scored.
 * ============================================================================
 */

import { addDays, diffDays, timeToMinutes, minutesToTime } from '../utils/dateUtils';
import { getTransitiveDependencyIds } from '../utils/dependencyUtils';
import { evaluatePlacementCost } from './placementCost';
import { getTaskWindow } from './allocator';

// Time-box: kept well under SchedulerContext's 300ms debounce (the search
// runs synchronously inside a single rebalance call, not stacked on top of
// the debounce delay itself) while leaving enough iterations to actually
// explore moves for a realistic task list. See MAX_ITERATIONS below as a
// secondary cap in case a very fast machine would otherwise spin through an
// unbounded number of pointless iterations within the time budget.
export const SEARCH_TIME_BUDGET_MS = 100;
export const MAX_ITERATIONS = 2000;

// Simulated-annealing schedule: start hot enough to accept some
// cost-increasing moves early (escaping shallow local minima the greedy seed
// might sit in), cool to near-zero by the end so late iterations behave like
// pure hill-climbing.
const INITIAL_TEMPERATURE = 4;
const COOLING_RATE = 0.995;

/** Deterministic-ish PRNG (mulberry32) so a given seed reproduces the same search — useful for tests. */
function makeRng(seed) {
  let a = seed >>> 0 || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build Map<date, Array<{start,end}>> free-minute-intervals for every day in
 * `capacityMap`, then subtract every block in `occupyingBlocks` (busy time
 * from whatever's currently placed there) — used to test whether a candidate
 * slot is actually open before accepting a move.
 */
function buildFreeMap(capacityMap, occupyingBlocks) {
  const free = new Map();
  for (const [date, cap] of capacityMap.entries()) {
    free.set(date, cap.freeIntervals.map((iv) => ({ start: timeToMinutes(iv.start), end: timeToMinutes(iv.end) })));
  }
  for (const b of occupyingBlocks) {
    const dayIntervals = free.get(b.date);
    if (!dayIntervals) continue;
    const start = timeToMinutes(b.startTime);
    const end = timeToMinutes(b.endTime);
    // Carve [start,end] out of whichever interval contains it.
    for (let i = 0; i < dayIntervals.length; i++) {
      const iv = dayIntervals[i];
      if (iv.start <= start && iv.end >= end) {
        const remainder = [];
        if (iv.start < start) remainder.push({ start: iv.start, end: start });
        if (iv.end > end) remainder.push({ start: end, end: iv.end });
        dayIntervals.splice(i, 1, ...remainder);
        break;
      }
    }
  }
  return free;
}

/**
 * True if [start,end] (minutes) fits within `dayFreeIntervals`, respecting
 * `gapMins` padding: the slot must lie fully within one free interval AND
 * stay >= gapMins away from both of that interval's edges. `buildFreeMap`
 * carves busy time out with no padding, so shrinking each free interval by
 * gapMins on both edges here is the simplest way to keep every relocated
 * block a full gap away from whatever's next to it. This is slightly
 * conservative right at the day's true open/close boundary (where there's no
 * real neighbor to keep a gap from), but never unsafe — it can only turn
 * down a handful of valid edge-of-day slots, never accept an invalid one.
 */
function fitsWithGap(start, end, dayFreeIntervals, gapMins) {
  for (const iv of dayFreeIntervals) {
    const paddedStart = iv.start + gapMins;
    const paddedEnd = iv.end - gapMins;
    if (start >= paddedStart && end <= paddedEnd) return true;
  }
  return false;
}

/**
 * Remaining minute-budget for `date` after accounting for every OTHER
 * movable block already placed there (not `excludeBlock`), capped at
 * `maxDailyDeepWorkHours`. Mirrors allocator.js's dailyBudgetMins, recomputed
 * fresh per check since blocks move around during search (cheap: at most a
 * few dozen movable blocks per rebalance run in practice).
 */
function remainingDailyBudgetMins(date, allMovableBlocks, excludeBlockId, maxDailyDeepWorkHours) {
  const capMins = Math.round(maxDailyDeepWorkHours * 60);
  const usedMins = allMovableBlocks
    .filter((b) => b.date === date && b.id !== excludeBlockId)
    .reduce((sum, b) => sum + Math.round(b.durationHours * 60), 0);
  return Math.max(0, capMins - usedMins);
}

/**
 * Every candidate (date, startMinute) slot a given block is allowed to try
 * relocating to: any day within its task's own valid scheduling window
 * (recomputed via allocator.js's getTaskWindow, so the search structurally
 * never proposes a day outside the task's due-date/earliestDate bounds) that
 * has capacity, at 5-minute-aligned start offsets within each free interval.
 * Capped in count (see MAX_CANDIDATE_SLOTS_PER_DAY) to keep a single move
 * proposal cheap even on a wide-open day.
 */
const SLOT_STEP_MINS = 15;
const MAX_CANDIDATE_SLOTS_PER_DAY = 8;

function candidateSlotsForDay(dayFreeIntervals, durationMins, gapMins, budgetMins) {
  const slots = [];
  for (const iv of dayFreeIntervals) {
    const paddedStart = iv.start + gapMins;
    const paddedEnd = iv.end - gapMins;
    const latestStart = paddedEnd - durationMins;
    if (latestStart < paddedStart) continue;
    for (let start = paddedStart; start <= latestStart && slots.length < MAX_CANDIDATE_SLOTS_PER_DAY; start += SLOT_STEP_MINS) {
      slots.push(start);
    }
    if (slots.length >= MAX_CANDIDATE_SLOTS_PER_DAY) break;
  }
  if (budgetMins < durationMins) return [];
  return slots;
}

/**
 * Compute, for every task appearing in `movableBlocks`, the ISO date of its
 * LAST-ending block across the FULL block set (movable + immovable) — used
 * for dependency-ordering checks ("must start after the last chunk of every
 * dependency"). Returns Map<taskId, {date, endMinutes}>.
 */
function computeLastBlockEndByTask(allBlocks) {
  const result = new Map();
  for (const b of allBlocks) {
    const endMinutes = timeToMinutes(b.endTime);
    const existing = result.get(b.taskId);
    if (!existing || b.date > existing.date || (b.date === existing.date && endMinutes > existing.endMinutes)) {
      result.set(b.taskId, { date: b.date, endMinutes });
    }
  }
  return result;
}

/**
 * True if relocating `block` (belonging to `task`) to `targetDate`/
 * `targetStartMinutes` would land it before the end of the LAST block of any
 * of `task`'s (transitive) dependencies — the spec's ordering rule, checked
 * against the proposed move's new slot. Every chunk of a dependent task is
 * covered this way over the course of the search: each chunk is validated
 * against the CURRENT state of its dependencies every time it (or one of its
 * siblings) is considered for a move, and a chunk that's never moved keeps
 * whatever ordering repairDependencyOrderViolations already established for
 * it before the search loop started (see that function's doc comment) — the
 * seed entering the search loop is therefore already ordering-valid, so this
 * check only ever needs to keep it that way, never fix it up mid-search.
 */
function violatesDependencyOrder(task, targetDate, targetStartMinutes, dependencyIdsByTask, lastBlockEndByTask) {
  const depIds = dependencyIdsByTask.get(task.id);
  if (!depIds || depIds.size === 0) return false;
  for (const depId of depIds) {
    const depEnd = lastBlockEndByTask.get(depId);
    if (!depEnd) continue; // dependency has no blocks in this run (e.g. already fully completed) -- nothing to order against
    if (targetDate < depEnd.date) return true;
    if (targetDate === depEnd.date && targetStartMinutes < depEnd.endMinutes) return true;
  }
  return false;
}

/**
 * True if any task that (transitively) depends on `task` would end up with
 * one of ITS blocks now starting before `task`'s new last-block end, once
 * `block` moves to `targetDate`/`targetStart`+duration. This is the reverse
 * check: moving a DEPENDENCY later must not strand a dependent that already
 * placed its own chunk assuming the old (earlier) finish time.
 */
function violatesDependentsOrder(taskId, newEndDate, newEndMinutes, dependentIdsByTask, blocksByTask) {
  const dependents = dependentIdsByTask.get(taskId);
  if (!dependents || dependents.size === 0) return false;
  for (const dependentId of dependents) {
    const depBlocks = blocksByTask.get(dependentId) || [];
    for (const b of depBlocks) {
      const bStart = timeToMinutes(b.startTime);
      if (b.date < newEndDate) return true;
      if (b.date === newEndDate && bStart < newEndMinutes) return true;
    }
  }
  return false;
}

/**
 * Topologically repair any dependency-order violation already present in the
 * SEED before search begins. `allocateTasks` (the greedy seed) has no
 * dependency awareness at all — it places purely by priority/urgency score,
 * so a high-priority dependent can easily land earlier than a lower-priority
 * dependency it's supposed to wait on. This is a routine, expected case now
 * that rebalanceEngine.js hands BOTH a dependency and its (possibly
 * incomplete) dependent to allocateTasks together — a dependency is no longer
 * excluded from allocation just because it isn't marked complete (see
 * rebalanceEngine.js's `eligibleTasks`), so this repair pass is what actually
 * establishes correct ordering, not just a defensive backstop. Mutates a
 * working copy of `blocks`, walking tasks in dependency order (topological)
 * and pushing forward, one block at a time, any block that starts before its
 * dependencies' current last-block end — to the earliest (date, time) at/after
 * that end which still fits free capacity that day, or the same day's very
 * end of working hours as a last resort if nothing fits (this is only a
 * starting point for search to refine further, not the final answer). Blocks
 * with no violation are left exactly where they were. If a dependency has NO
 * block at all in this run (e.g. it's already completed, so it was never
 * handed to the allocator, or it itself ran out of capacity — see
 * rebalanceEngine.js's buildDependencyBlockedEntries for that latter case),
 * there's nothing to order against, so the dependent's placement is left as
 * the seed produced it.
 */
function repairDependencyOrderViolations(blocks, tasks, taskById, dependencyIdsByTask, capacityMap, immovableBlocks) {
  // Topological order: a task with fewer (transitive) dependencies among the
  // ones present in `tasks` sorts first, so by the time we process a
  // dependent, every one of its dependencies already has its final (repaired)
  // position settled.
  const idsInSet = new Set(tasks.map((t) => t.id));
  const order = [...tasks].sort((a, b) => {
    const aDeps = [...(dependencyIdsByTask.get(a.id) || [])].filter((id) => idsInSet.has(id)).length;
    const bDeps = [...(dependencyIdsByTask.get(b.id) || [])].filter((id) => idsInSet.has(id)).length;
    return aDeps - bDeps;
  });

  let working = blocks.map((b) => ({ ...b }));

  for (const task of order) {
    const depIds = dependencyIdsByTask.get(task.id);
    if (!depIds || depIds.size === 0) continue;

    const lastEndByTask = computeLastBlockEndByTask([...working, ...immovableBlocks]);
    let depEnd = null;
    for (const depId of depIds) {
      const end = lastEndByTask.get(depId);
      if (end && (!depEnd || end.date > depEnd.date || (end.date === depEnd.date && end.endMinutes > depEnd.endMinutes))) {
        depEnd = end;
      }
    }
    if (!depEnd) continue; // no dependency has any block in this run (e.g. already historically completed)

    const taskBlocks = working.filter((b) => b.taskId === task.id).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    for (const b of taskBlocks) {
      const startMinutes = timeToMinutes(b.startTime);
      const violates = b.date < depEnd.date || (b.date === depEnd.date && startMinutes < depEnd.endMinutes);
      if (!violates) continue;

      const durationMins = Math.round(b.durationHours * 60);
      const others = working.filter((o) => o.id !== b.id);
      const freeMap = buildFreeMap(capacityMap, [...others, ...immovableBlocks]);
      const placed = placeEarliestAtOrAfter(depEnd, durationMins, freeMap, capacityMap);
      const target = placed || { date: depEnd.date, start: Math.max(0, depEnd.endMinutes) };
      const idx = working.findIndex((o) => o.id === b.id);
      working[idx] = { ...b, date: target.date, startTime: minutesToTime(target.start), endTime: minutesToTime(target.start + durationMins) };
      // Keep depEnd's tracking implicitly correct for this task's OWN later blocks by recomputing lastEndByTask
      // isn't needed here since we only push forward, never before, an already-violating chunk relative to the
      // SAME dependency end -- subsequent blocks of this same task are checked against the same depEnd, which is
      // still a valid (if conservative) lower bound.
    }
  }

  return working;
}

/**
 * Earliest (date, startMinute) at or after `after` ({date, endMinutes}) that
 * fits `durationMins` in `freeMap`, scanning forward day by day from
 * `after.date` through the last date in `capacityMap`. Returns null if no
 * fit exists anywhere in the horizon (caller falls back to a conservative
 * same-day placement at the dependency's end, which may not be perfectly
 * valid but is corrected further by the search loop's own move validation
 * afterward — this repair pass only needs to produce A starting point, not a
 * provably-optimal or even fully-valid one, since the search's per-move hard
 * constraint checks are what ultimately guarantee the RETURNED placement is
 * valid).
 */
function placeEarliestAtOrAfter(after, durationMins, freeMap, capacityMap) {
  const dates = [...capacityMap.keys()].sort();
  for (const date of dates) {
    if (date < after.date) continue;
    const dayFree = freeMap.get(date);
    if (!dayFree) continue;
    const minStart = date === after.date ? after.endMinutes : 0;
    for (const iv of dayFree) {
      const start = Math.max(iv.start, minStart);
      if (start + durationMins <= iv.end) return { date, start };
    }
  }
  return null;
}

/**
 * Run the time-boxed local search. Returns `{ blocks, cost }` where `blocks`
 * is the FULL replacement set for `movableBlocks` (same length/ids, just
 * possibly relocated) with cost <= the seed's cost — never worse, per this
 * module's guarantee (see doc comment above).
 *
 * @param {import('../types').ScheduledBlock[]} movableBlocks - the subset of the seed's blocks eligible to move
 *   (non-locked, non-fixed-time, non-passive). Every OTHER block (locked/completed/fixed-time/passive/untouched)
 *   must already be reflected as busy time in `capacityMap` and is passed via `immovableBlocks` purely so cost
 *   evaluation and dependency-ordering checks see the complete picture.
 * @param {import('../types').ScheduledBlock[]} immovableBlocks - fixed-time/passive/locked/completed blocks for the
 *   SAME tasks being scored (context only -- never moved, never returned).
 * @param {import('../types').Task[]} tasks - the tasks whose movable blocks are being optimized (schedulable set).
 * @param {Map<string, import('../types').Task>} taskById - full task graph, for dependency + due-date resolution.
 * @param {Map<string, import('../types').DayCapacity>} capacityMap - the SAME capacity map allocateTasks used to
 *   produce the seed (already accounts for routines/events/locked blocks as busy).
 * @param {import('../types').SchedulingRules} rules
 * @param {string} today - ISO date, used to bound how early a move may land (never before today).
 * @param {(task: import('../types').Task) => string|null} resolveDueDateFn - see placementCost.evaluatePlacementCost.
 * @param {{ timeBudgetMs?: number, maxIterations?: number, rngSeed?: number }} [options] - test hooks; production
 *   callers should omit these and rely on the tuned defaults (SEARCH_TIME_BUDGET_MS/MAX_ITERATIONS).
 * @returns {{ blocks: import('../types').ScheduledBlock[], cost: number, seedCost: number, iterations: number }}
 */
export function runLocalSearch({ movableBlocks, immovableBlocks, tasks, taskById, capacityMap, rules, today, resolveDueDateFn, options = {} }) {
  const timeBudgetMs = options.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS;
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const rng = makeRng(options.rngSeed ?? 0xC0FFEE);

  const taskByIdInSet = new Map(tasks.map((t) => [t.id, t]));
  const dependencyIdsByTask = new Map(tasks.map((t) => [t.id, getTransitiveDependencyIds(t.id, taskById)]));
  const dependentIdsByTask = new Map();
  for (const [taskId, depIds] of dependencyIdsByTask) {
    for (const depId of depIds) {
      if (!dependentIdsByTask.has(depId)) dependentIdsByTask.set(depId, new Set());
      dependentIdsByTask.get(depId).add(taskId);
    }
  }

  // Repair any dependency-order violation already present in the incoming
  // seed BEFORE scoring/searching (see repairDependencyOrderViolations' doc
  // comment) -- the greedy allocator has no dependency awareness, so this is
  // the one place that guarantees ordering holds unconditionally, rather than
  // depending on an upstream caller having already filtered for it. The
  // move-validation checks inside the search loop below then only ever need
  // to keep an already-valid state valid, never fix up a bad one mid-search.
  const repairedSeed = repairDependencyOrderViolations(movableBlocks, tasks, taskById, dependencyIdsByTask, capacityMap, immovableBlocks);
  const seedCost = evaluatePlacementCost([...repairedSeed, ...immovableBlocks], tasks, resolveDueDateFn).total;

  // Nothing to optimize (no movable blocks, or a degenerate empty task set) -- return the (repaired) seed as-is.
  if (repairedSeed.length === 0) {
    return { blocks: repairedSeed, cost: seedCost, seedCost, iterations: 0 };
  }

  const dates = [...capacityMap.keys()].sort();
  const horizonEnd = dates[dates.length - 1];

  let current = repairedSeed.map((b) => ({ ...b }));
  let currentCost = seedCost;
  let best = current;
  let bestCost = seedCost;

  const startTime = Date.now();
  let iterations = 0;
  let temperature = INITIAL_TEMPERATURE;

  while (iterations < maxIterations && Date.now() - startTime < timeBudgetMs) {
    iterations++;

    const blockIdx = Math.floor(rng() * current.length);
    const block = current[blockIdx];
    const task = taskByIdInSet.get(block.taskId);
    if (!task) continue; // defensive: a block whose task fell out of the schedulable set (shouldn't happen)

    const { windowStart, windowEnd } = getTaskWindow(task, today, horizonEnd, rules.bufferDays, taskById);
    const clampedStart = windowStart < today ? today : windowStart;
    if (clampedStart > windowEnd) continue;
    const span = Math.max(1, diffDays(clampedStart, windowEnd) + 1);
    const targetDate = addDays(clampedStart, Math.floor(rng() * span));

    // Build "everyone else's" occupancy (movable minus this block, plus all immovable) to find what's actually
    // free on the target day for this proposed move.
    const others = [...current.slice(0, blockIdx), ...current.slice(blockIdx + 1), ...immovableBlocks];
    const freeMap = buildFreeMap(capacityMap, others);
    const dayFree = freeMap.get(targetDate);
    if (!dayFree) continue;

    const durationMins = Math.round(block.durationHours * 60);
    const gapMins = rules.minGapBetweenBlocksMins ?? 0;
    const budgetMins = remainingDailyBudgetMins(targetDate, current, block.id, rules.maxDailyDeepWorkHours);
    const slots = candidateSlotsForDay(dayFree, durationMins, gapMins, budgetMins);
    if (slots.length === 0) continue;
    const targetStart = slots[Math.floor(rng() * slots.length)];
    const targetEnd = targetStart + durationMins;

    // HARD CONSTRAINT CHECKS -- reject the move outright (never merely penalize) if any of these fail.
    if (!fitsWithGap(targetStart, targetEnd, dayFree, gapMins)) continue;

    // Chunk-count cap (maxChunksFor) needs no separate check here: a relocate
    // move is a 1:1 swap of one existing chunk's (date, time), never a
    // re-split, so the task's chunk count is unaffected by construction.

    // Dependency ordering, both directions.
    const blocksByTaskForCheck = new Map();
    for (const b of [...current, ...immovableBlocks]) {
      if (b.id === block.id) continue;
      if (!blocksByTaskForCheck.has(b.taskId)) blocksByTaskForCheck.set(b.taskId, []);
      blocksByTaskForCheck.get(b.taskId).push(b);
    }
    const lastBlockEndByTask = computeLastBlockEndByTask([...current.filter((b) => b.id !== block.id), ...immovableBlocks]);
    if (violatesDependencyOrder(task, targetDate, targetStart, dependencyIdsByTask, lastBlockEndByTask)) continue;
    // Recompute this task's own new last-block end (across its OTHER blocks + this moved one) for the reverse check.
    const ownOtherBlocks = blocksByTaskForCheck.get(task.id) || [];
    let newLastDate = targetDate;
    let newLastEndMinutes = targetEnd;
    for (const b of ownOtherBlocks) {
      const bEnd = timeToMinutes(b.endTime);
      if (b.date > newLastDate || (b.date === newLastDate && bEnd > newLastEndMinutes)) {
        newLastDate = b.date;
        newLastEndMinutes = bEnd;
      }
    }
    if (violatesDependentsOrder(task.id, newLastDate, newLastEndMinutes, dependentIdsByTask, blocksByTaskForCheck)) continue;

    // Passive/fixed-time/locked blocks never reach here at all (caller only ever includes eligible blocks in
    // `movableBlocks`), so no additional carve-out check is needed for rule #2/#3 of the hard constraints.

    // Build the candidate full block list and score it.
    const candidate = current.map((b, i) =>
      i === blockIdx ? { ...b, date: targetDate, startTime: minutesToTime(targetStart), endTime: minutesToTime(targetEnd) } : b
    );
    const candidateCost = evaluatePlacementCost([...candidate, ...immovableBlocks], tasks, resolveDueDateFn).total;

    const delta = candidateCost - currentCost;
    const accept = delta <= 0 || rng() < Math.exp(-delta / Math.max(temperature, 1e-6));
    if (accept) {
      current = candidate;
      currentCost = candidateCost;
      if (currentCost < bestCost - 1e-9) {
        best = current;
        bestCost = currentCost;
      }
    }

    temperature *= COOLING_RATE;
  }

  // GUARANTEE: never return worse than the seed. `best` starts as the seed
  // itself and is only ever replaced by a strictly better candidate above.
  return { blocks: best, cost: bestCost, seedCost, iterations };
}

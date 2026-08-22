/**
 * ============================================================================
 * PLACEMENT COST FUNCTION
 * ============================================================================
 * Pure cost-evaluation for a candidate block placement, used by localSearch.js
 * to score whether a proposed move improves on the greedy allocator's seed.
 * This module has NO side effects and never mutates its inputs — it only
 * reads a candidate set of blocks (for the tasks under consideration) and
 * returns a total cost (lower is better) plus a per-task breakdown for
 * debuggability/testing.
 *
 * See TODO.md's "Scheduler overhaul" entry / the design spec in the PR that
 * introduced this file for the full rationale. Summary of what's scored:
 *
 *   1. FRAGMENTATION — a task spread across more days, or split into tiny
 *      slivers, costs more. Two additive components (not either/or):
 *        (a) (daysUsed - 1) * FRAG_DAY_PENALTY * priorityMultiplier
 *        (b) one SMALL_CHUNK_PENALTY * priorityMultiplier per chunk under
 *            SMALL_CHUNK_THRESHOLD_MINS
 *   2. DUE-DATE — reward for finishing early (linear in slack days), penalty
 *      that ESCALATES (quadratic) the further past the due date a task's
 *      last chunk lands. Both scaled by priorityMultiplier.
 *   3. TIME-OF-DAY — for a task with a `preferredTimeOfDay`, a penalty per
 *      hour placed outside that window. Soft by design: it nudges this
 *      search, it never constrains the allocator (see utils/timeOfDay.js).
 *
 * Priority is a MULTIPLIER on those two terms, never an independent cost —
 * there is deliberately no separate "this task is unplaced" cost line here;
 * an unplaced/under-placed task already shows up as the worst case of the
 * due-date term (see missing-hours handling below) and as `overflow`
 * reporting one layer up (rebalanceEngine.js) — including a `dependency_blocked`
 * entry for a dependent whose own dependency ended up unplaced — unchanged.
 * ============================================================================
 */

import { diffDays, timeToMinutes } from '../utils/dateUtils';
import { minutesOutsidePreference } from '../utils/timeOfDay';

/**
 * Tunable per-priority cost multiplier. Fractional (not integer weights like
 * allocator.js's PRIORITY_WEIGHT, which drives placement ORDER, not cost) so
 * the gap between tiers is gentler — a low-priority task's fragmentation/
 * lateness still counts, just weighted down, rather than being treated as
 * nearly free. Values chosen so:
 *   - medium is the neutral baseline (1.0)
 *   - urgent is weighted up enough to meaningfully outrank a medium task's
 *     cost in a close call, without swamping every other term (1.4)
 *   - low is weighted down but never zeroed — a low-priority task's own
 *     fragmentation still discourages the search from carelessly shredding it
 *     just because nothing else cares (0.8)
 * Easy to retune: this is the ONLY place these numbers live.
 */
export const PRIORITY_MULTIPLIER = { urgent: 1.4, high: 1.2, medium: 1.0, low: 0.8 };

function priorityMultiplier(task) {
  return PRIORITY_MULTIPLIER[task?.priority] ?? PRIORITY_MULTIPLIER.medium;
}

// Per-task fragmentation cost for each extra day beyond the first that a
// task's work is spread across. Kept as a named constant (rather than a
// magic number inline) so it's easy to retune independently of the due-date
// term's own constants below.
export const FRAG_DAY_PENALTY = 3;

/**
 * Cost per HOUR of a task's work placed outside its preferred time of day.
 *
 * Deliberately weaker than FRAG_DAY_PENALTY (3 per extra day): a preference is
 * a preference, so it should decide a close call and lose to a real scheduling
 * concern. At 1.0/hour a typical 1-2 hour block in the wrong half of the day
 * costs less than spreading that task across one extra day, so the search will
 * never shred a task chasing a nicer hour. The two only cross over at 3+ hours
 * of misplaced work, where preferring the right window genuinely is the bigger
 * win — that crossover is intended, not an accident of the numbers.
 *
 * An earlier 1.5 made a 2-hour block exactly equal to one day of
 * fragmentation, and an exact tie is the one value to avoid: it's resolved by
 * whichever move the search happens to try first.
 */
export const TIME_OF_DAY_PENALTY_PER_HOUR = 1.0;

// Any individual chunk shorter than this (minutes) incurs an additional
// small-chunk penalty on top of the day-count term above — a task split into
// five 10-minute slivers on ONE day still costs more than one continuous
// 50-minute block, which the day-count term alone wouldn't capture.
export const SMALL_CHUNK_THRESHOLD_MINS = 15;
export const SMALL_CHUNK_PENALTY = 2;

// Due-date term: reward per day of slack before the due date (finishing
// earlier costs less/negative — a small constant, since this is a mild
// preference, not the dominant term). Escalation past the due date uses
// LATE_PENALTY_PER_DAY^2 * dayslate (quadratic) so being 4 days late costs
// 16x a single day late, not a flat per-day rate — a genuinely stuck task's
// cost visibly runs away rather than plateauing.
export const EARLY_REWARD_PER_DAY = 0.5;
export const LATE_PENALTY_PER_DAY_SQUARED = 4;

/**
 * Group a task's blocks and return the set of distinct dates used and the
 * ISO date of its LAST-ending block (i.e. when the task's work actually
 * completes) — null if the task has no blocks at all (fully unplaced).
 */
function summarizeTaskBlocks(taskBlocks) {
  if (taskBlocks.length === 0) return { days: new Set(), lastDate: null };
  const days = new Set(taskBlocks.map((b) => b.date));
  // Pick the block with the latest (date, endTime) key -- "HH:MM" strings
  // compare correctly lexicographically since they're zero-padded 24h time.
  let last = taskBlocks[0];
  for (const b of taskBlocks) {
    if (b.date > last.date || (b.date === last.date && b.endTime > last.endTime)) last = b;
  }
  return { days, lastDate: last.date };
}

/**
 * Fragmentation cost for one task's placement: (a) day-count term + (b)
 * small-chunk term, both scaled by the same priorityMultiplier and summed
 * (not either/or — see module doc comment).
 */
function fragmentationCost(task, taskBlocks, days) {
  if (taskBlocks.length === 0) return 0; // an unplaced task has no fragmentation to speak of -- it's captured by the due-date term instead
  const mult = priorityMultiplier(task);
  const dayTerm = Math.max(0, days.size - 1) * FRAG_DAY_PENALTY * mult;
  const smallChunkCount = taskBlocks.filter((b) => b.durationHours * 60 < SMALL_CHUNK_THRESHOLD_MINS - 1e-6).length;
  const smallChunkTerm = smallChunkCount * SMALL_CHUNK_PENALTY * mult;
  return dayTerm + smallChunkTerm;
}

/**
 * Due-date cost for one task: negative (reward) for finishing with slack
 * remaining before the due date, escalating (quadratic) penalty for
 * finishing after it. A task with no resolvable due date, or with no blocks
 * placed at all, contributes 0 here — an undated task was never schedulable
 * in the first place (rebalanceEngine excludes it upstream), and a fully
 * unplaced task's absence is already visible via `overflow` one layer up, not
 * something this cost function should separately invent a penalty for (see
 * module doc comment: no standalone "unplaced" cost term).
 */
function dueDateCost(task, lastDate, dueDate) {
  if (!dueDate || !lastDate) return 0;
  const mult = priorityMultiplier(task);
  const slackDays = diffDays(lastDate, dueDate); // positive if lastDate is BEFORE dueDate
  if (slackDays >= 0) {
    return -slackDays * EARLY_REWARD_PER_DAY * mult;
  }
  const daysLate = -slackDays;
  return LATE_PENALTY_PER_DAY_SQUARED * daysLate * daysLate * mult;
}

/**
 * Time-of-day cost for one task: penalty per hour placed outside its preferred
 * window. Zero for the overwhelmingly common case of no preference set, so
 * this term costs nothing for tasks that don't use it.
 *
 * Charged on real overlap rather than "does the block start in the window", so
 * a long block that straddles the boundary pays only for the part that spills
 * — otherwise a 3-hour morning task starting at 11:00 would score the same as
 * one starting at 20:00, and the search would have no gradient to follow.
 */
function timeOfDayCost(task, taskBlocks) {
  if (!task?.preferredTimeOfDay || taskBlocks.length === 0) return 0;
  const mult = priorityMultiplier(task);
  let outsideMins = 0;
  for (const b of taskBlocks) {
    outsideMins += minutesOutsidePreference(
      { startMinute: timeToMinutes(b.startTime), endMinute: timeToMinutes(b.endTime) },
      task.preferredTimeOfDay
    );
  }
  return (outsideMins / 60) * TIME_OF_DAY_PENALTY_PER_HOUR * mult;
}

/**
 * Evaluate the total cost of a candidate placement.
 *
 * @param {import('../types').ScheduledBlock[]} blocks - ALL blocks under consideration for this evaluation (only
 *   blocks whose taskId is in `tasks` are scored; extras are ignored so callers can pass a superset safely).
 * @param {import('../types').Task[]} tasks - the tasks being scored. Each must resolve a due date via `resolveDueDateFn`
 *   for the due-date term to apply (undated tasks just get fragmentation-only cost).
 * @param {(task: import('../types').Task) => string|null} resolveDueDateFn - resolves a task's effective due date
 *   (own or borrowed from an ancestor) — pass allocator.js's `resolveDueDate` bound to the caller's `taskById`, or
 *   any equivalent. Kept as an injected function rather than importing allocator.js directly, to avoid a circular
 *   dependency between allocator.js and this module.
 * @returns {{ total: number, byTask: Map<string, {fragmentation: number, dueDate: number, timeOfDay: number, total: number}> }}
 */
export function evaluatePlacementCost(blocks, tasks, resolveDueDateFn) {
  const blocksByTask = new Map();
  for (const b of blocks) {
    if (!blocksByTask.has(b.taskId)) blocksByTask.set(b.taskId, []);
    blocksByTask.get(b.taskId).push(b);
  }

  const byTask = new Map();
  let total = 0;
  for (const task of tasks) {
    const taskBlocks = blocksByTask.get(task.id) || [];
    const { days, lastDate } = summarizeTaskBlocks(taskBlocks);
    const fragmentation = fragmentationCost(task, taskBlocks, days);
    const dueDate = resolveDueDateFn ? resolveDueDateFn(task) : task.dueDate || null;
    const due = dueDateCost(task, lastDate, dueDate);
    const timeOfDay = timeOfDayCost(task, taskBlocks);
    const taskTotal = fragmentation + due + timeOfDay;
    byTask.set(task.id, { fragmentation, dueDate: due, timeOfDay, total: taskTotal });
    total += taskTotal;
  }

  return { total, byTask };
}

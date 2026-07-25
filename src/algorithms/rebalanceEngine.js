/**
 * ============================================================================
 * REBALANCE ENGINE
 * ============================================================================
 * The orchestration layer sitting above capacityEngine + allocator. This is
 * what the "Re-balance / Reschedule" button in the UI actually calls.
 *
 * Responsibilities:
 *   1. Partition existing ScheduledBlocks into LOCKED (never touched) and
 *      UNLOCKED (eligible to be wiped and re-planned).
 *   2. Recompute each task's `remainingHours` from what's still unlocked
 *      (locked hours already "count" as committed progress).
 *   3. Run capacityEngine using locked blocks + calendar events + routines
 *      as busy time (so the allocator never double-books over a locked
 *      block).
 *   4. Run the allocator over the remaining unlocked work — excluding any
 *      task whose `dependsOn` list isn't fully completed yet (see step 4
 *      below for details).
 *   5. Merge locked blocks + newly generated blocks into the final result.
 *
 * This guarantees "recalibrates future days without destroying manually
 * locked task blocks" from the requirements.
 *
 * TASKS WITH NO DUE DATE ARE NEVER SCHEDULED HERE. They still show up
 * normally in the Tasks list and Board view (see todoistService.fetchTasks
 * + AddTaskModal), but an undated task has no real deadline to plan
 * against — think a running checklist item like "Eggs" or "Meat" on a
 * shopping list, as opposed to time-blocked work. Handing one to the
 * allocator without a due date used to make it fall back to "spread
 * across the whole planning horizon" (see allocator.js's getTaskWindow),
 * which silently put grocery-list-style items on the calendar as if they
 * were real work blocks — not what a due-date-less task means. So the
 * eligibility filter below explicitly requires `dueDate` before a task is
 * ever handed to the allocator; any existing blocks for an undated task
 * are otherwise left alone (locked ones are always preserved; unlocked
 * ones are cleared like any other unlocked block, and since the task is
 * never re-eligible it simply won't be replaced).
 * ============================================================================
 */

import { computeHorizonCapacity } from './capacityEngine';
import { allocateTasks } from './allocator';
import { toISODate, dateRange } from '../utils/dateUtils';
import { areDependenciesMet } from '../utils/dependencyUtils';

/**
 * @param {Object} params
 * @param {import('../types').Task[]} params.tasks
 * @param {import('../types').ScheduledBlock[]} params.existingBlocks
 * @param {import('../types').FixedRoutine[]} params.routines
 * @param {import('../types').CalendarEvent[]} params.events
 * @param {import('../types').SchedulingRules} params.rules
 * @param {string} [params.fromDate] - Defaults to today; days before this are never touched.
 * @returns {{ blocks: import('../types').ScheduledBlock[], overflow: Array<{taskId:string,unplacedHours:number}>, stats: Object }}
 */
export function rebalance({ tasks, existingBlocks, routines, events, rules, fromDate }) {
  const today = fromDate || toISODate(new Date());

  // 1. Partition blocks. Anything before "today" is historical and left
  //    untouched regardless of lock state (we don't rewrite the past).
  //    From today onward: locked blocks survive, unlocked ones are cleared
  //    and re-planned.
  // "Historical" is relative to `today` (which may be a simulated fromDate,
  // not the real wall-clock date) — NOT real-world isPast(), so a rebalance
  // pinned to a past/future fromDate still treats everything before it as
  // untouchable history, per this function's documented contract above.
  const historicalBlocks = existingBlocks.filter((b) => b.date < today);
  const futureBlocks = existingBlocks.filter((b) => b.date >= today);
  const lockedBlocks = futureBlocks.filter((b) => b.isLocked);
  const clearedBlockIds = new Set(futureBlocks.filter((b) => !b.isLocked).map((b) => b.id));

  // 2. Recompute remainingHours per task: estimatedHours minus hours already
  //    "spent" in historical + locked blocks (i.e. committed, immovable work).
  const spentHoursByTask = new Map();
  for (const b of [...historicalBlocks, ...lockedBlocks]) {
    spentHoursByTask.set(b.taskId, (spentHoursByTask.get(b.taskId) || 0) + b.durationHours);
  }

  const tasksWithRemaining = tasks.map((t) => {
    const spent = spentHoursByTask.get(t.id) || 0;
    const remaining = t.isLocked
      ? 0 // fully locked tasks are excluded from re-allocation entirely
      : Math.max(0, t.estimatedHours - spent);
    return { ...t, remainingHours: remaining };
  });

  // 3. Compute capacity treating locked blocks as busy (via events-like
  //    busy accounting inside capacityEngine — we pass lockedBlocks as
  //    "blocks" so they're subtracted from free time).
  //
  //    nowClamp: only meaningful when `today` is the actual current date
  //    (i.e. this is a live run, not a re-run pinned to a past/future
  //    `fromDate`) — it tells capacityEngine to never open up capacity
  //    before the current wall-clock time on that one day, so re-balancing
  //    at 5pm doesn't schedule anything at, say, 9am today.
  const now = new Date();
  const nowClamp = !fromDate || fromDate === toISODate(now) ? { date: today, minutes: now.getHours() * 60 + now.getMinutes() } : null;
  const horizonDays = rules.horizonWeeks * 7;
  const capacityMap = computeHorizonCapacity(today, horizonDays, {
    routines,
    events,
    blocks: lockedBlocks,
    rules,
    nowClamp,
  });

  // 4. Allocate remaining work for unlocked, incomplete, DATED tasks only.
  //    A task with no `dueDate` is a checklist-style item, not schedulable
  //    work — see the module doc comment above for why it's excluded here
  //    rather than just left to the allocator's own window logic.
  //
  //    A task with unfinished dependencies (task.dependsOn) is also excluded
  //    entirely — it simply doesn't get a slot until every task it depends
  //    on is marked complete, which is what "must be completed first"
  //    ordering means for a scheduler that plans in hours-per-day rather
  //    than fixed start times. Lookups use the FULL `tasks` list (not just
  //    the schedulable subset) since a dependency might be locked, undated,
  //    or otherwise ineligible for allocation while still being relevant to
  //    check for completion.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const schedulable = tasksWithRemaining.filter(
    (t) => !t.isLocked && !t.isCompleted && t.remainingHours > 0 && !!t.dueDate
  );
  const eligibleTasks = schedulable.filter((t) => areDependenciesMet(t, taskById));
  const blockedByDependencies = schedulable.length - eligibleTasks.length;
  const { blocks: newBlocks, overflow } = allocateTasks(eligibleTasks, capacityMap, rules, today);

  // 5. Merge: historical (untouched) + locked (untouched) + freshly allocated.
  const finalBlocks = [...historicalBlocks, ...lockedBlocks, ...newBlocks];

  const stats = {
    tasksRescheduled: eligibleTasks.length,
    blocksCleared: clearedBlockIds.size,
    blocksCreated: newBlocks.length,
    blocksPreservedLocked: lockedBlocks.length,
    overflowTaskCount: overflow.length,
    blockedByDependencies,
  };

  return { blocks: finalBlocks, overflow, stats };
}

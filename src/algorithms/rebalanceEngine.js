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
 * A TOP-LEVEL TASK WITH NO DUE DATE IS NEVER SCHEDULED HERE. It still shows
 * up normally in the Tasks list and Board view (see todoistService.fetchTasks
 * + AddTaskModal), but an undated top-level task has no real deadline to plan
 * against — think a running checklist item like "Eggs" or "Meat" on a
 * shopping list, as opposed to time-blocked work. Handing one to the
 * allocator without a due date used to make it fall back to "spread
 * across the whole planning horizon" (see allocator.js's getTaskWindow),
 * which silently put grocery-list-style items on the calendar as if they
 * were real work blocks — not what a due-date-less task means. So the
 * eligibility filter below excludes an undated TOP-LEVEL task from ever
 * being handed to the allocator; any existing blocks for one are otherwise
 * left alone (locked ones are always preserved; unlocked ones are cleared
 * like any other unlocked block, and since the task is never re-eligible it
 * simply won't be replaced).
 *
 * A SUB-TASK (`parentId` set), by contrast, IS schedulable even with no due
 * date of its own — it's a concrete step toward its parent's goal, not a
 * checklist item, so it competes for capacity like any other undated task
 * (see allocator.js's prioritizeTasks/scoreTask; its parent's own due date,
 * if any, feeds in as urgency pressure — see allocator.js's resolveDueDate).
 *
 * A CONTAINER PARENT (any task with ≥1 sub-task of its own, at any depth)
 * is excluded from allocation entirely, regardless of whether it has its
 * own due date — only its leaf sub-tasks ever get calendar blocks. Its own
 * due date instead becomes an input into its children's urgency (see
 * above), and its own estimatedHours/remainingHours become a live rollup of
 * its children's — see utils/taskHierarchy.js — rather than something the
 * allocator ever schedules directly.
 * ============================================================================
 */

import { computeHorizonCapacity } from './capacityEngine';
import { allocateTasks } from './allocator';
import { toISODate, dateRange, addDays } from '../utils/dateUtils';
import { areDependenciesMet } from '../utils/dependencyUtils';
import { generateTaskOccurrences, deriveRecurrenceRule } from '../utils/recurrence';

/**
 * A recurring task is only eligible for the per-occurrence expansion below if
 * it has both a `dueDate` (the anchor occurrence) and a rule that actually
 * parses. `recurrenceRule` is normally cached on the task already (see
 * SchedulerContext's addTask/updateTask), but this also derives it on the fly
 * as a fallback — a task persisted before this field existed (or hand-edited
 * data) shouldn't silently lose real multi-day scheduling just because the
 * cache hasn't been (re)computed yet.
 */
function resolveTaskRecurrenceRule(task) {
  if (!task.isRecurring || !task.dueDate) return null;
  return task.recurrenceRule || deriveRecurrenceRule(task.recurrenceString);
}

/**
 * Splits `eligibleTasks` into normal tasks (unchanged) and a fresh array of
 * VIRTUAL per-occurrence pseudo-tasks for every recurring task, one per
 * occurrence date within [today, horizonEnd] (see utils/recurrence.js's
 * generateTaskOccurrences). Each virtual task reuses allocator.js's existing
 * `enforceDueDate` window-collapse (a single fixed block sized to the task's
 * full estimatedHours, on that exact day — no new allocator logic needed) by
 * setting `dueDate` to the occurrence date and `enforceDueDate: true`. Its id
 * gets a `::occurrenceDate` suffix so distinct occurrences of the same real
 * task don't collide as allocateTasks inputs — callers MUST strip this back
 * off (see stripOccurrenceSuffix below) before any block/overflow entry
 * referencing it reaches persisted state.
 *
 * `spentHoursByTaskDate` (built by the caller from the SAME historical/locked
 * block source it already uses for its whole-task `spentHoursByTask` map, just
 * keyed by `${taskId}::${date}` instead of `taskId`) is what makes each
 * occurrence's remaining hours independent: without it, a locked/historical
 * block sitting on one occurrence's date would otherwise double-count against
 * every other occurrence of the same recurring task, since a plain
 * `estimatedHours - (whole-task spent)` calculation (see tasksWithRemaining
 * below) assumes a single shared window, which is no longer true once each
 * occurrence gets its own independent block. A future occurrence with nothing
 * yet placed on its date naturally comes out fresh at its full estimatedHours.
 *
 * The real (unexpanded) recurring task itself must NOT also be handed to
 * allocateTasks — the caller excludes it from `normal` before merging back,
 * since it's entirely superseded by its virtual occurrences here.
 */
function expandRecurringTasks(eligibleTasks, spentHoursByTaskDate, today, horizonEnd) {
  const normal = [];
  const virtualOccurrences = [];
  for (const task of eligibleTasks) {
    const rule = resolveTaskRecurrenceRule(task);
    if (!rule) {
      normal.push(task);
      continue;
    }
    const recurringTask = task.recurrenceRule ? task : { ...task, recurrenceRule: rule };
    const occurrenceDates = generateTaskOccurrences(recurringTask, today, horizonEnd);
    for (const date of occurrenceDates) {
      const spent = spentHoursByTaskDate.get(`${task.id}::${date}`) || 0;
      const remainingHours = Math.max(0, task.estimatedHours - spent);
      if (remainingHours <= 0) continue; // this occurrence is already fully covered by a locked/historical block
      virtualOccurrences.push({ ...recurringTask, id: `${task.id}::${date}`, dueDate: date, enforceDueDate: true, remainingHours });
    }
  }
  return { normal, virtualOccurrences };
}

/**
 * allocator.js's scoreTask/computeEffectiveDeadlines/computeBlockerIds all
 * resolve a task's urgency by looking it up in `taskById` (see allocator.js's
 * computeEffectiveDeadlines: `taskById ? [...taskById.values()] : tasks`) —
 * without an entry there, a virtual occurrence id would silently score as
 * "no deadline" (baseline urgency) regardless of how close its occurrence
 * date actually is, since the real recurring task is only ever registered
 * under its own plain id. Returns a copy of `taskById` with every virtual
 * occurrence ALSO registered under its own `::date`-suffixed id, so urgency
 * scoring sees each occurrence's own (enforceDueDate-collapsed) deadline
 * correctly.
 */
function withVirtualEntries(taskById, virtualOccurrences) {
  const expanded = new Map(taskById);
  for (const occ of virtualOccurrences) expanded.set(occ.id, occ);
  return expanded;
}

/** Strips a `${realTaskId}::${occurrenceDate}` virtual id back to the real task id — a no-op for a non-virtual id. */
function stripOccurrenceSuffix(id) {
  const sepIdx = id.indexOf('::');
  return sepIdx === -1 ? id : id.slice(0, sepIdx);
}

/**
 * Strip the `::occurrenceDate` virtual-id suffix off every returned block's
 * (and overflow entry's) `taskId` — this must never leak into persisted
 * state. The block's own `date` field (already set to the occurrence date by
 * expandRecurringTasks above) is what distinguishes one occurrence's block
 * from another everywhere else in the app.
 */
function stripVirtualIds(newBlocks, overflow) {
  const blocks = newBlocks.map((b) => (b.taskId.includes('::') ? { ...b, taskId: stripOccurrenceSuffix(b.taskId) } : b));
  const strippedOverflow = overflow.map((o) => (o.taskId.includes('::') ? { ...o, taskId: stripOccurrenceSuffix(o.taskId) } : o));
  return { blocks, overflow: strippedOverflow };
}

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
  // Per (taskId, date) spent hours, from the same untouched blocks — needed
  // for a recurring task's per-occurrence remaining-hours accounting (see
  // expandRecurringTasks above); irrelevant/unused for non-recurring tasks.
  const spentHoursByTaskDate = new Map();
  for (const b of [...historicalBlocks, ...lockedBlocks]) {
    spentHoursByTask.set(b.taskId, (spentHoursByTask.get(b.taskId) || 0) + b.durationHours);
    const dateKey = `${b.taskId}::${b.date}`;
    spentHoursByTaskDate.set(dateKey, (spentHoursByTaskDate.get(dateKey) || 0) + b.durationHours);
  }

  // A recurring task with a usable rule is expanded into independent
  // per-occurrence pseudo-tasks below (see expandRecurringTasks), each with
  // its own remaining-hours accounting keyed to its own date. The flat
  // "estimatedHours minus this task's WHOLE historical+locked spend across
  // every date it's ever had a block on" model just below only makes sense
  // for a single shared window — for a long-lived recurring task (years of
  // historical blocks, one per past occurrence) it would zero out
  // remainingHours almost immediately and wrongly exclude the task from
  // `schedulable` before it ever reaches expansion. So a recurring task
  // always keeps its full estimatedHours here instead.
  const tasksWithRemaining = tasks.map((t) => {
    if (resolveTaskRecurrenceRule(t)) return { ...t, remainingHours: t.isLocked ? 0 : t.estimatedHours };
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

  // 4. Allocate remaining work for unlocked, incomplete, schedulable tasks.
  //    Two eligibility rules beyond the basics (unlocked/incomplete/hours
  //    remaining) — see the module doc comment above for the reasoning
  //    behind both:
  //      - A CONTAINER PARENT (has ≥1 sub-task of its own) is never
  //        directly schedulable, dated or not — only its leaf sub-tasks are.
  //      - A TOP-LEVEL task (no `parentId`) with no `dueDate` is a
  //        checklist-style item, not schedulable work. A SUB-TASK with no
  //        `dueDate` IS schedulable (it borrows its parent's due date as
  //        urgency pressure instead — see allocator.js's resolveDueDate).
  //
  //    A task with unfinished dependencies (task.dependsOn) is also excluded
  //    entirely — it simply doesn't get a slot until every task it depends
  //    on is marked complete, which is what "must be completed first"
  //    ordering means for a scheduler that plans in hours-per-day rather
  //    than fixed start times. Lookups use the FULL `tasks` list (not just
  //    the schedulable subset) since a dependency might be locked, undated,
  //    or otherwise ineligible for allocation while still being relevant to
  //    check for completion. This same full-list map is also threaded into
  //    allocateTasks so it can resolve a sub-task's ancestor due date even
  //    when that ancestor (e.g. a container parent) isn't itself schedulable.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const parentIds = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId));
  const schedulable = tasksWithRemaining.filter(
    (t) =>
      !t.isLocked &&
      !t.isCompleted &&
      t.remainingHours > 0 &&
      !parentIds.has(t.id) &&
      (!!t.dueDate || !!t.parentId)
  );
  const eligibleTasks = schedulable.filter((t) => areDependenciesMet(t, taskById));
  const blockedByDependencies = schedulable.length - eligibleTasks.length;

  // A recurring task (isRecurring && dueDate, already guaranteed once it's
  // schedulable) is expanded into one virtual pseudo-task per occurrence date
  // across the whole horizon instead of being scheduled as a single window —
  // see expandRecurringTasks above. The real task row is excluded from what's
  // handed to allocateTasks; its occurrences supersede it entirely.
  const horizonEnd = addDays(today, horizonDays - 1);
  const { normal: normalEligible, virtualOccurrences } = expandRecurringTasks(eligibleTasks, spentHoursByTaskDate, today, horizonEnd);
  const { blocks: rawBlocks, overflow: rawOverflow } = allocateTasks(
    [...normalEligible, ...virtualOccurrences],
    capacityMap,
    rules,
    today,
    withVirtualEntries(taskById, virtualOccurrences)
  );
  const { blocks: newBlocks, overflow } = stripVirtualIds(rawBlocks, rawOverflow);

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

/**
 * ============================================================================
 * PLAN TODAY
 * ============================================================================
 * A lighter, day-scoped sibling of rebalance() above, for the "Plan today"
 * action: instead of recalibrating the whole visible horizon, it only clears
 * and re-plans TODAY's unlocked blocks, leaving every other day — past AND
 * future — completely untouched (rebalance(), by contrast, wipes and
 * replans every unlocked block from today through the end of the horizon).
 *
 * This deliberately does NOT reuse allocateTasks' normal multi-day pacing:
 * feeding it a single-day capacity map while leaving a task's real (multi-
 * day) due-date window in place would dilute today's placement based on
 * "ideal daily share" math that assumes runway the caller can't actually see
 * here, and would misreport tasks as unschedulable overflow just because
 * their later days aren't in view. Instead this calls allocateTasks with
 * `{ dayScoped: true }` (see allocator.js), which greedily fills today's
 * capacity in priority order for every task, exactly like the allocator's
 * existing "blocker" fast-path.
 *
 * IMPORTANT: because future blocks are left untouched here (unlike
 * rebalance(), which wipes and replans them), their hours must still count
 * as "spent" against a task's remainingHours — otherwise a task with, say,
 * a block already sitting on tomorrow would get its full remaining hours
 * crammed into today ON TOP OF what's already booked later, double-
 * scheduling it.
 *
 * @param {Object} params
 * @param {import('../types').Task[]} params.tasks
 * @param {import('../types').ScheduledBlock[]} params.existingBlocks
 * @param {import('../types').FixedRoutine[]} params.routines
 * @param {import('../types').CalendarEvent[]} params.events
 * @param {import('../types').SchedulingRules} params.rules
 * @param {string} [params.fromDate] - Defaults to today; the one day this touches.
 * @returns {{ blocks: import('../types').ScheduledBlock[], unfitToday: Array<{taskId:string,unplacedHours:number}>, stats: Object }}
 */
export function planToday({ tasks, existingBlocks, routines, events, rules, fromDate }) {
  const today = fromDate || toISODate(new Date());

  // 1. Partition blocks: only TODAY's blocks are ever touched. Every other
  //    date — past (historical) or future — is left alone unconditionally,
  //    regardless of lock state (that's the whole point of "today only").
  const otherBlocks = existingBlocks.filter((b) => b.date !== today);
  const todaysBlocks = existingBlocks.filter((b) => b.date === today);
  const todaysLocked = todaysBlocks.filter((b) => b.isLocked);
  const clearedBlockIds = new Set(todaysBlocks.filter((b) => !b.isLocked).map((b) => b.id));

  // 2. Recompute remainingHours per task: estimatedHours minus hours already
  //    committed elsewhere — historical + future blocks (untouched by this
  //    run, see above) + today's locked blocks. Today's UNLOCKED blocks are
  //    NOT counted as spent since they're about to be cleared and replanned,
  //    same as rebalance()'s treatment of its cleared blocks.
  const spentHoursByTask = new Map();
  // Per (taskId, date) spent hours, from the same untouched blocks — needed
  // for a recurring task's per-occurrence remaining-hours accounting (see
  // rebalanceEngine's expandRecurringTasks above); irrelevant/unused for
  // non-recurring tasks.
  const spentHoursByTaskDate = new Map();
  for (const b of [...otherBlocks, ...todaysLocked]) {
    spentHoursByTask.set(b.taskId, (spentHoursByTask.get(b.taskId) || 0) + b.durationHours);
    const dateKey = `${b.taskId}::${b.date}`;
    spentHoursByTaskDate.set(dateKey, (spentHoursByTaskDate.get(dateKey) || 0) + b.durationHours);
  }

  // See rebalance()'s identical guard (resolveTaskRecurrenceRule) for why a
  // recurring task always keeps its full estimatedHours here instead of the
  // whole-task spent-hours subtraction below.
  const tasksWithRemaining = tasks.map((t) => {
    if (resolveTaskRecurrenceRule(t)) return { ...t, remainingHours: t.isLocked ? 0 : t.estimatedHours };
    const spent = spentHoursByTask.get(t.id) || 0;
    const remaining = t.isLocked ? 0 : Math.max(0, t.estimatedHours - spent);
    return { ...t, remainingHours: remaining };
  });

  // 3. Compute capacity for TODAY ONLY, treating today's locked blocks as
  //    busy. nowClamp mirrors rebalance()'s: only meaningful for a live run
  //    (fromDate unset or equal to the real current date) so planning at
  //    5pm doesn't open up capacity earlier in the day.
  const now = new Date();
  const nowClamp = !fromDate || fromDate === toISODate(now) ? { date: today, minutes: now.getHours() * 60 + now.getMinutes() } : null;
  const capacityMap = computeHorizonCapacity(today, 1, {
    routines,
    events,
    blocks: todaysLocked,
    rules,
    nowClamp,
  });

  // 4. Same eligibility rules as rebalance() (see its step 4 for the
  //    reasoning behind each): container parents and undated top-level
  //    tasks are never directly schedulable, and a task with unmet
  //    dependencies is held back until they're complete.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const parentIds = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId));
  const schedulable = tasksWithRemaining.filter(
    (t) =>
      !t.isLocked &&
      !t.isCompleted &&
      t.remainingHours > 0 &&
      !parentIds.has(t.id) &&
      (!!t.dueDate || !!t.parentId)
  );
  const eligibleTasks = schedulable.filter((t) => areDependenciesMet(t, taskById));
  const blockedByDependencies = schedulable.length - eligibleTasks.length;

  // Same recurring-task expansion as rebalance() (see expandRecurringTasks
  // above), just scoped to a single-day [today, today] range — a recurring
  // task whose recurrence doesn't land on today simply produces no
  // occurrence here, same as any other task not due today.
  const { normal: normalEligible, virtualOccurrences } = expandRecurringTasks(eligibleTasks, spentHoursByTaskDate, today, today);
  const { blocks: rawBlocks, overflow: rawUnfitToday } = allocateTasks(
    [...normalEligible, ...virtualOccurrences],
    capacityMap,
    rules,
    today,
    withVirtualEntries(taskById, virtualOccurrences),
    { dayScoped: true }
  );
  const { blocks: newBlocks, overflow: unfitToday } = stripVirtualIds(rawBlocks, rawUnfitToday);

  // 5. Merge: everything else (untouched) + today's locked (untouched) +
  //    freshly allocated for today.
  const finalBlocks = [...otherBlocks, ...todaysLocked, ...newBlocks];

  const stats = {
    tasksRescheduled: eligibleTasks.length,
    blocksCleared: clearedBlockIds.size,
    blocksCreated: newBlocks.length,
    blocksPreservedLocked: todaysLocked.length,
    // Note: unlike rebalance()'s overflowTaskCount, this does NOT mean "at
    // risk of missing its deadline" — it just means the task didn't fully
    // fit in today's remaining capacity, which may be entirely expected
    // (plenty of runway on later days). Callers must not reuse rebalance's
    // "at risk" copy for this.
    unfitTodayCount: unfitToday.length,
    blockedByDependencies,
  };

  return { blocks: finalBlocks, unfitToday, stats };
}

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
 *   4. Run the allocator over the remaining unlocked work — a task with an
 *      incomplete dependency is scheduled right alongside everything else
 *      (see step 4 below for details); it's `localSearch.js` that enforces
 *      "dependent starts after its dependency's last block ends" — then
 *      refine that greedy seed with a time-boxed cost-minimizing local search
 *      (see localSearch.js/placementCost.js) that tries relocating individual
 *      chunks to reduce total fragmentation/due-date cost, guaranteed never to
 *      end up worse than the seed or to violate a hard constraint along the
 *      way.
 *   5. Merge locked blocks + newly generated blocks into the final result.
 *
 * This guarantees "recalibrates future days without destroying manually
 * locked task blocks" from the requirements.
 *
 * A TASK WITH NO RESOLVABLE DUE DATE IS NEVER SCHEDULED HERE — this applies
 * identically to top-level tasks and sub-tasks; a sub-task's "resolvable due
 * date" is its own `dueDate` if set, otherwise the nearest ancestor's
 * `dueDate` it can borrow (see allocator.js's resolveDueDate/
 * findAncestorDueDate). Neither is scheduled without one. Such a task still
 * shows up normally in the Tasks list and Board view (see
 * todoistService.fetchTasks + AddTaskModal), but has no real deadline to plan
 * against — think a running checklist item like "Eggs" or "Meat" on a
 * shopping list, as opposed to time-blocked work. Handing one to the
 * allocator without a due date used to make it fall back to "spread
 * across the whole planning horizon" (see allocator.js's getTaskWindow),
 * which silently put grocery-list-style items on the calendar as if they
 * were real work blocks — not what a due-date-less task means. So the
 * eligibility filter below excludes any task with no resolvable due date from
 * ever being handed to the allocator; any existing blocks for one are
 * otherwise left alone (locked ones are always preserved; unlocked ones are
 * cleared like any other unlocked block, and since the task is never
 * re-eligible it simply won't be replaced).
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
import { allocateTasks, resolveDueDate } from './allocator';
import { runLocalSearch } from './localSearch';
import { toISODate, dateRange, addDays } from '../utils/dateUtils';
import { getTransitiveDependencyIds } from '../utils/dependencyUtils';
import { expandTaskOccurrences, deriveRecurrenceRule } from '../utils/recurrence';
import { expandEventsForRange } from '../utils/recurrenceExpansion';
import { isBlockTaskCompleted } from '../utils/missedTasks';

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
 * Keyed by the block's actual placed date (`b.date`), so for a moved
 * occurrence that's the MOVED-TO date, not the original pattern date — see
 * the `date` lookup below.
 *
 * The real (unexpanded) recurring task itself must NOT also be handed to
 * allocateTasks — the caller excludes it from `normal` before merging back,
 * since it's entirely superseded by its virtual occurrences here.
 *
 * Uses expandTaskOccurrences (not the plain pattern-only generateTaskOccurrences)
 * so a single occurrence moved off-pattern via `task.overrides` (see
 * types/index.js's Task.overrides) still gets a virtual occurrence placed on
 * its MOVED-TO date, instead of silently vanishing from scheduling — the
 * virtual occurrence's id stays keyed by the occurrence's ORIGINAL (pattern)
 * date (so completedDates lookups elsewhere keep working after a move,
 * exactly like CalendarEvent's `${masterId}::${originalDate}` convention),
 * while its `dueDate`/spentHoursByTaskDate lookup use the actual (moved-to)
 * date, since that's where the occurrence really lives and where any block
 * for it is actually placed.
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
    const occurrences = expandTaskOccurrences(recurringTask, today, horizonEnd);
    for (const { originalDate, date } of occurrences) {
      const spent = spentHoursByTaskDate.get(`${task.id}::${date}`) || 0;
      const remainingHours = Math.max(0, task.estimatedHours - spent);
      if (remainingHours <= 0) continue; // this occurrence is already fully covered by a locked/historical block
      virtualOccurrences.push({ ...recurringTask, id: `${task.id}::${originalDate}`, dueDate: date, enforceDueDate: true, remainingHours });
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
 * A dependency relationship no longer excludes a task from allocation just
 * because the dependency isn't marked complete yet (see `eligibleTasks` in
 * rebalance() below) — both tasks are scheduled normally, and
 * localSearch.js's repairDependencyOrderViolations/move-validation enforce
 * "the dependent starts after the dependency's last block ends." But that
 * ordering enforcement can only order a dependent AGAINST an actual placed
 * block — if a dependency itself came out of allocateTasks with hours still
 * unplaced (capacity overflow, not just "not yet completed"), there's no
 * "end of its last block" to order against, so the dependent structurally
 * can't be given a valid slot either this round. This builds one
 * `dependency_blocked` overflow entry per task in that genuinely-unschedulable
 * situation — found AFTER allocation (`allocatorOverflow`), unlike the old
 * pre-allocation exclusion this replaced.
 */
function buildDependencyBlockedEntries(scheduledTasks, allocatorOverflow, taskById) {
  // allocatorOverflow is already virtual-id-stripped by the caller (see
  // stripVirtualIds), so its taskIds line up directly with real task ids.
  const unplacedTaskIds = new Set(allocatorOverflow.map((o) => o.taskId));
  const entries = [];
  for (const t of scheduledTasks) {
    const depIds = [...getTransitiveDependencyIds(t.id, taskById)];
    const blockingDependencies = depIds
      .filter((depId) => unplacedTaskIds.has(depId))
      .map((depId) => ({ id: depId, title: taskById.get(depId)?.title || 'a task' }));
    if (blockingDependencies.length === 0) continue;
    entries.push({
      taskId: t.id,
      unplacedHours: Math.round(t.remainingHours * 100) / 100,
      reason: { type: 'dependency_blocked', blockingDependencies },
    });
  }
  return entries;
}

/**
 * Resolve a `fixed_time_conflict` (or `fixed_time_shifted`) entry's
 * `conflictingItem.label` when it's `null` — only ever true for a `block`
 * source (see capacityEngine.js's collectBusyIntervals, which has no task
 * lookup of its own), where `conflictingItem.id` is the OWNING TASK's id.
 * Every other source (`event`/`routine`) already carries its real label from
 * capacityEngine and is left untouched. Works generically off
 * `entry.reason?.conflictingItem`, so the same call resolves both `overflow`
 * and `timeShifted` lists (see allocateTasks' doc comment for their shapes).
 */
function resolveConflictLabels(overflow, taskById) {
  return overflow.map((entry) => {
    const item = entry.reason?.conflictingItem;
    if (!item || item.label !== null) return entry;
    return { ...entry, reason: { ...entry.reason, conflictingItem: { ...item, label: taskById.get(item.id)?.title || 'another task' } } };
  });
}

/**
 * Strip the `::occurrenceDate` virtual-id suffix off every returned block's
 * (and overflow/timeShifted entry's) `taskId` — this must never leak into
 * persisted state. The block's own `date` field (already set to the
 * occurrence date by expandRecurringTasks above) is what distinguishes one
 * occurrence's block from another everywhere else in the app.
 */
function stripVirtualIds(newBlocks, overflow, timeShifted) {
  const strip = (o) => (o.taskId.includes('::') ? { ...o, taskId: stripOccurrenceSuffix(o.taskId) } : o);
  const blocks = newBlocks.map((b) => (b.taskId.includes('::') ? { ...b, taskId: stripOccurrenceSuffix(b.taskId) } : b));
  return { blocks, overflow: overflow.map(strip), timeShifted: timeShifted.map(strip) };
}

/**
 * @param {Object} params
 * @param {import('../types').Task[]} params.tasks
 * @param {import('../types').ScheduledBlock[]} params.existingBlocks
 * @param {import('../types').FixedRoutine[]} params.routines
 * @param {import('../types').CalendarEvent[]} params.events
 * @param {import('../types').SchedulingRules} params.rules
 * @param {string} [params.fromDate] - Defaults to today; days before this are never touched.
 * @param {boolean} [params.todayOnly] - Scope the whole run to a single day (`today`/`fromDate`) instead of the
 *   full `rules.horizonWeeks * 7` horizon. Used by SchedulerContext.completeTask so finishing a task early
 *   re-plans the rest of TODAY into the slot it just freed, without reaching into future days at all — see
 *   the "TODAY-ONLY SCOPING" note below for exactly what stays untouched.
 * @returns {{ blocks: import('../types').ScheduledBlock[], overflow: Array<{taskId:string,unplacedHours:number,reason:Object}>, timeShifted: Array<{taskId:string,reason:Object}>, stats: Object }}
 *   `overflow` includes both allocator-reported entries (see allocator.js's allocateTasks) and, layered on top,
 *   `dependency_blocked` entries for a task whose (transitive) dependency itself ended up with unplaced hours in
 *   THIS SAME allocator run — see buildDependencyBlockedEntries. Both kinds of task go through allocateTasks;
 *   `dependency_blocked` is a post-hoc explanation for why a dependent's ordering couldn't be satisfied, not a
 *   pre-allocation exclusion.
 *   `timeShifted` passes through allocateTasks' own `timeShifted` list unchanged (label-resolved/virtual-id-stripped
 *   the same way as `overflow`) — every fixedTime task whose same-day fallback placed it at an unrequested
 *   time-of-day, regardless of whether its hours were fully placed.
 *
 * TODAY-ONLY SCOPING (`todayOnly: true`): the horizon collapses to exactly 1 day (`today`), and any existing
 * block dated AFTER today is excluded from every partition below and passed straight through into the final
 * result unmodified — it's neither cleared, re-evaluated, nor eligible to receive newly allocated hours. This
 * is stricter than just capping the capacity map's horizon: without also excluding those blocks from the
 * lock/complete/clear partitioning, a today-only run would still (correctly, per the historical-block rule)
 * clear a stale unlocked future block, which is out of scope for "today only". A task with hours already
 * committed to one of those untouched future blocks still has those hours excluded from what's handed to
 * the allocator today (see spentHoursByTask below), so today's run can't double-book the same work.
 */
export function rebalance({ tasks, existingBlocks, routines, events, rules, fromDate, todayOnly }) {
  const today = fromDate || toISODate(new Date());

  // TODAY-ONLY SCOPING: blocks dated after `today` never participate in this
  // run at all — carved off before any historical/locked/completed/cleared
  // partitioning below, and merged back into the final result untouched at
  // the end. See the module/function doc comments above.
  const scopedExistingBlocks = todayOnly ? existingBlocks.filter((b) => b.date <= today) : existingBlocks;
  const untouchedFutureBlocks = todayOnly ? existingBlocks.filter((b) => b.date > today) : [];
  // Hours already committed to those untouched future blocks still count as
  // "spent" against the owning task so today's allocator pass doesn't try to
  // re-place the same work — see spentHoursByTask below, which folds this in
  // alongside historical/locked/completed blocks.
  const untouchedFutureSpent = new Map();
  for (const b of untouchedFutureBlocks) {
    untouchedFutureSpent.set(b.taskId, (untouchedFutureSpent.get(b.taskId) || 0) + b.durationHours);
  }

  // 1. Partition blocks. A block dated before "today" is "historical" in the
  //    sense that its DAY is in the past, but that alone doesn't make it
  //    immutable fact — only a LOCKED block, or a block whose task (or
  //    recurring occurrence) is actually completed, represents committed,
  //    already-happened work. An unlocked block for a task that was never
  //    actually done (e.g. a stale block left behind after its due date was
  //    pushed out, or the day was simply missed) is cleared and its hours
  //    are NOT counted as spent — otherwise a never-worked task could get
  //    "remainingHours" driven to 0 by its own stale past block, silently
  //    excluding it from `schedulable` below and leaving that stale block
  //    stuck in place forever since nothing would ever regenerate a fresh
  //    one. From today onward: locked blocks survive, unlocked ones are
  //    cleared and re-planned — same rule, just without the "day" qualifier.
  // "Historical" is relative to `today` (which may be a simulated fromDate,
  // not the real wall-clock date) — NOT real-world isPast(), so a rebalance
  // pinned to a past/future fromDate still treats everything before it under
  // this same rule, per this function's documented contract above.
  const taskByIdForCompletion = new Map(tasks.map((t) => [t.id, t]));
  const historicalBlocks = scopedExistingBlocks.filter((b) => b.date < today);
  const futureBlocks = scopedExistingBlocks.filter((b) => b.date >= today);
  const historicalLocked = historicalBlocks.filter((b) => b.isLocked);
  // See the futureBlocks equivalent below: a historical block whose task (or
  // recurring occurrence) is already completed is preserved as a genuine
  // historical record, same reasoning as completeTask's own preservation.
  const historicalCompleted = historicalBlocks.filter(
    (b) => !b.isLocked && isBlockTaskCompleted(b, taskByIdForCompletion.get(b.taskId))
  );
  const historicalClearedIds = new Set(
    historicalBlocks.filter((b) => !b.isLocked && !isBlockTaskCompleted(b, taskByIdForCompletion.get(b.taskId))).map((b) => b.id)
  );
  const lockedBlocks = futureBlocks.filter((b) => b.isLocked);
  // A block whose task is already completed (or, for a recurring task, whose
  // OWN occurrence date is already completed) is a historical record that
  // must survive rebalance the same way completeTask itself preserves it
  // (see SchedulerContext.completeTask) — otherwise "Re-balance" wipes a
  // just-completed task's block off Today's Agenda and the calendar, since a
  // completed task is never re-eligible for allocation and nothing
  // regenerates it. But that's only true when the block's date is the one
  // that was actually completed:
  //   - Non-recurring: isBlockTaskCompleted just checks task.isCompleted,
  //     with no date awareness — true for EVERY block of a completed task,
  //     including a future-dated one left over from finishing early. That
  //     future slot never happened, so it must be excluded here (fall
  //     through to cleared) even though isBlockTaskCompleted says "yes" —
  //     preservation is restricted to today's block only.
  //   - Recurring: isBlockTaskCompleted checks completedDates for the
  //     block's OWN date, so a future block only matches when that exact
  //     future occurrence genuinely already happened (its own date is in
  //     completedDates) — a real historical record, not a "completed
  //     early" leftover, so it's preserved regardless of date.
  const isGenuineCompletedRecord = (b) => {
    const task = taskByIdForCompletion.get(b.taskId);
    if (!isBlockTaskCompleted(b, task)) return false;
    if (task?.isRecurring) return true; // completedDates already matched b's own date
    return b.date === today; // non-recurring: only today's block is a real record
  };
  const completedBlocks = futureBlocks.filter((b) => !b.isLocked && isGenuineCompletedRecord(b));
  const clearedBlockIds = new Set([
    ...historicalClearedIds,
    ...futureBlocks.filter((b) => !b.isLocked && !isGenuineCompletedRecord(b)).map((b) => b.id),
  ]);

  // 2. Recompute remainingHours per task: estimatedHours minus hours already
  //    "spent" in historical (completed/locked only) + locked blocks (i.e.
  //    committed, immovable or already-done work). A stale, never-completed
  //    historical block's hours are deliberately excluded here too.
  const spentHoursByTask = new Map();
  // Per (taskId, date) spent hours, from the same untouched blocks — needed
  // for a recurring task's per-occurrence remaining-hours accounting (see
  // expandRecurringTasks above); irrelevant/unused for non-recurring tasks.
  const spentHoursByTaskDate = new Map();
  for (const b of [...historicalLocked, ...historicalCompleted, ...lockedBlocks, ...completedBlocks]) {
    spentHoursByTask.set(b.taskId, (spentHoursByTask.get(b.taskId) || 0) + b.durationHours);
    const dateKey = `${b.taskId}::${b.date}`;
    spentHoursByTaskDate.set(dateKey, (spentHoursByTaskDate.get(dateKey) || 0) + b.durationHours);
  }
  // TODAY-ONLY SCOPING: hours already committed to an untouched future block
  // (see untouchedFutureSpent above) still count as "spent" so today's pass
  // doesn't re-place work that's already sitting on a later day's calendar.
  for (const [taskId, hours] of untouchedFutureSpent) {
    spentHoursByTask.set(taskId, (spentHoursByTask.get(taskId) || 0) + hours);
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
  //
  // This must use the SAME gate as expandRecurringTasks
  // (resolveTaskRecurrenceRule, not the bare t.isRecurring flag). A task can
  // have isRecurring=true but no resolvable rule (missing dueDate, or an
  // unparseable recurrenceString) — expandRecurringTasks falls back to
  // treating it as a normal single-window task in that case, and if this
  // full-estimatedHours short-circuit still fired for it, allocateTasks would
  // try to fit the task's ENTIRE remaining hours into one single-occurrence
  // window and spuriously report `no_capacity`, even though nothing is
  // actually wrong with capacity — the task just isn't expandable.
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
  const horizonDays = todayOnly ? 1 : rules.horizonWeeks * 7;
  // A recurring calendar event (e.g. a weekly class synced from Google
  // Calendar) is stored as one master record describing only its first
  // occurrence — capacityEngine's busy-interval check is a plain date match,
  // so without expanding the rule here every occurrence after the first
  // would look like open capacity and get scheduled straight over. See
  // recurrenceExpansion.js's expandEventsForRange.
  const expandedEvents = expandEventsForRange(events, today, addDays(today, horizonDays - 1));
  const capacityMap = computeHorizonCapacity(today, horizonDays, {
    routines,
    events: expandedEvents,
    blocks: [...lockedBlocks, ...completedBlocks],
    rules,
    nowClamp,
  });

  // 4. Allocate remaining work for unlocked, incomplete, schedulable tasks.
  //    Two eligibility rules beyond the basics (unlocked/incomplete/hours
  //    remaining) — see the module doc comment above for the reasoning
  //    behind both:
  //      - A CONTAINER PARENT (has ≥1 sub-task of its own) is never
  //        directly schedulable, dated or not — only its leaf sub-tasks are.
  //      - Any task (top-level or sub-task) with no resolvable due date
  //        (own or borrowed from an ancestor) is a checklist-style item,
  //        not schedulable work — see allocator.js's resolveDueDate.
  //
  //    A task with an incomplete dependency (task.dependsOn) is NOT excluded
  //    here — a dependency only means "the dependent must start after the
  //    dependency's own last scheduled block ends," not "unschedulable until
  //    someone checks the dependency off." Both tasks are handed to
  //    allocateTasks together; localSearch.js's repairDependencyOrderViolations
  //    and its move-validation loop are what actually enforce that ordering
  //    (see localSearch.js's module doc comment). This lookup map uses the
  //    FULL `tasks` list (not just the schedulable subset) since a dependency
  //    might be locked, undated, or otherwise ineligible for allocation while
  //    still being relevant to order against. This same full-list map is also
  //    threaded into allocateTasks so it can resolve a sub-task's ancestor due
  //    date even when that ancestor (e.g. a container parent) isn't itself
  //    schedulable.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const parentIds = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId));
  const eligibleTasks = tasksWithRemaining.filter(
    (t) =>
      !t.isLocked &&
      !t.isCompleted &&
      t.remainingHours > 0 &&
      !parentIds.has(t.id) &&
      // Shared-project tasks never enter the auto-scheduler. This engine
      // computes against ONE person's routines, work hours and calendar, so a
      // task several people share has no single owner's capacity to consume —
      // whichever collaborator's device happened to run a rebalance would
      // place it against their availability and push the result to everyone.
      // Reconciling capacity across collaborators is explicitly out of scope
      // (see TODO.md), so this is made an explicit exclusion rather than
      // silently half-supported. Shared tasks can still be scheduled MANUALLY
      // by dragging them onto a calendar, which produces a block in that one
      // user's own local, unshared blocks array.
      !t.sharedProjectId &&
      // User opted this task out of auto-scheduling entirely (see the Task
      // typedef's excludeFromAutoSchedule doc comment) — it can still be
      // scheduled manually by dragging it onto the calendar.
      !t.excludeFromAutoSchedule &&
      !!resolveDueDate(t, taskById)
  );

  // A recurring task (isRecurring && dueDate, already guaranteed once it's
  // schedulable) is expanded into one virtual pseudo-task per occurrence date
  // across the whole horizon instead of being scheduled as a single window —
  // see expandRecurringTasks above. The real task row is excluded from what's
  // handed to allocateTasks; its occurrences supersede it entirely.
  const horizonEnd = addDays(today, horizonDays - 1);
  const { normal: normalEligible, virtualOccurrences } = expandRecurringTasks(eligibleTasks, spentHoursByTaskDate, today, horizonEnd);
  const allocatedTasks = [...normalEligible, ...virtualOccurrences];
  const taskByIdWithVirtual = withVirtualEntries(taskById, virtualOccurrences);
  const { blocks: seedBlocks, overflow: rawOverflow, timeShifted: rawTimeShifted } = allocateTasks(
    allocatedTasks,
    capacityMap,
    rules,
    today,
    taskByIdWithVirtual
  );
  // Cost-minimizing local search (see localSearch.js): refine the greedy
  // seed above by trying to relocate individual chunks to a lower-total-cost
  // day/time, never worse than the seed and never violating a hard
  // constraint (capacity, gap, daily budget, or dependency ordering) along
  // the way. Only non-fixed-time, non-passive blocks are eligible to move —
  // a fixed-time task's pinned slot and every passive-task block are treated
  // as immovable context here, same carve-out as allocateTasks itself. Runs
  // on the virtual-id-expanded block/task set (BEFORE stripVirtualIds below)
  // so a recurring occurrence's search stays correctly bounded to its own
  // single-day enforceDueDate window, exactly like the seed's placement was.
  const movableTaskIds = new Set(
    allocatedTasks.filter((t) => !t.fixedTime && !t.isPassive).map((t) => t.id)
  );
  const movableBlocks = seedBlocks.filter((b) => movableTaskIds.has(b.taskId));
  const immovableBlocks = seedBlocks.filter((b) => !movableTaskIds.has(b.taskId));
  const { blocks: searchedMovableBlocks } = runLocalSearch({
    movableBlocks,
    immovableBlocks,
    tasks: allocatedTasks,
    taskById: taskByIdWithVirtual,
    capacityMap,
    rules,
    today,
    resolveDueDateFn: (task) => resolveDueDate(task, taskByIdWithVirtual),
  });
  const rawBlocks = [...searchedMovableBlocks, ...immovableBlocks];
  const { blocks: newBlocks, overflow: allocatorOverflow, timeShifted: strippedTimeShifted } = stripVirtualIds(rawBlocks, rawOverflow, rawTimeShifted);
  // A dependency-blocked entry is now a genuinely different, POST-allocation
  // finding — a task whose (transitive) dependency itself came out of
  // allocateTasks with unplaced hours, so there's no valid slot to order the
  // dependent's blocks after this round — see buildDependencyBlockedEntries.
  // Built from `eligibleTasks` (every task actually handed to the allocator)
  // against `allocatorOverflow` (already virtual-id-stripped, so it lines up
  // with the real task ids in `taskById`).
  const dependencyBlockedEntries = buildDependencyBlockedEntries(eligibleTasks, allocatorOverflow, taskById);
  const blockedByDependencies = dependencyBlockedEntries.length;
  const overflow = resolveConflictLabels([...allocatorOverflow, ...dependencyBlockedEntries], taskById);
  const timeShifted = resolveConflictLabels(strippedTimeShifted, taskById);

  // 5. Merge: historical locked/completed (untouched) + locked (untouched) +
  //    completed (untouched) + freshly allocated + (todayOnly runs only) any
  //    future-day block scoped out at the very top, passed through as-is.
  //    A stale, never-completed historical block is deliberately NOT included
  //    here — it's cleared (see step 1) rather than kept, freeing its task up
  //    to be rescheduled.
  const finalBlocks = [...historicalLocked, ...historicalCompleted, ...lockedBlocks, ...completedBlocks, ...newBlocks, ...untouchedFutureBlocks];

  const stats = {
    tasksRescheduled: eligibleTasks.length,
    blocksCleared: clearedBlockIds.size,
    blocksCreated: newBlocks.length,
    blocksPreservedLocked: lockedBlocks.length,
    overflowTaskCount: overflow.length,
    blockedByDependencies,
  };

  return { blocks: finalBlocks, overflow, timeShifted, stats };
}

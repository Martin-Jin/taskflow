/**
 * Small pure derivations that centralize task-field logic which multiple
 * updateTask callers (manual edits, the AI Assistant, future callers) would
 * otherwise each need to replicate.
 */

/**
 * When a task's estimatedHours changes, remainingHours should shift by the
 * same delta rather than staying pinned to its old value — otherwise raising
 * the estimate on an already-fully-scheduled task (remainingHours: 0) would
 * never add any new hours for the scheduler to place, and lowering it could
 * leave remainingHours greater than the new estimate.
 * Clamped to [0, nextEstimatedHours].
 */
export function deriveRemainingHoursOnEstimateChange(currentRemainingHours, currentEstimatedHours, nextEstimatedHours) {
  return Math.min(nextEstimatedHours, Math.max(0, currentRemainingHours + (nextEstimatedHours - currentEstimatedHours)));
}

/** Task fields (besides dueDate/estimatedHours, checked separately) that feed
 * eligibility, placement, or cost in the scheduler (see allocator.js,
 * rebalanceEngine.js, placementCost.js) closely enough that changing them can
 * make an already-placed block stale. Keep in sync with any new Task field
 * that feeds the scheduler. */
const OTHER_SCHEDULING_FIELDS = ['earliestDate', 'enforceDueDate', 'dependsOn', 'priority', 'isPassive', 'fixedTime'];

// excludeFromAutoSchedule is checked separately below (mirroring isLocked)
// rather than through OTHER_SCHEDULING_FIELDS: turning it ON removes the task
// from eligibleTasks entirely, so there's no "existing block" for the usual
// otherSchedulingFieldChanged branch to invalidate — the rebalance itself is
// what has to remove any block it already placed. Turning it OFF is the
// mirror of unlocking a task: newly eligible, needs a rebalance to be placed
// for the first time even if it currently has no block to invalidate.

function isSameSchedulingValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
  }
  return a === b;
}

/**
 * Decide whether editing a task (SchedulerContext's updateTask) should queue
 * a rebalance. Extracted as a pure function so this dirty-check — otherwise a
 * closure inside a React context — can be unit tested; see CLAUDE.md's rule
 * on race-guard/scheduler decisions being error-prone pure logic.
 *
 * `prevTask` is the task's state before this edit; `updates` is the partial
 * patch being applied; `hasUnlockedScheduledBlock` reports whether the task
 * currently has an existing, non-locked ScheduledBlock (locked blocks are
 * left untouched by the rebalance engine, so there's nothing to invalidate).
 */
export function needsRescheduleOnTaskUpdate(prevTask, updates, hasUnlockedScheduledBlock) {
  if (!prevTask) return false;

  const dueDateChanged = 'dueDate' in updates && updates.dueDate !== prevTask.dueDate;
  const durationChanged = 'estimatedHours' in updates && updates.estimatedHours !== prevTask.estimatedHours;
  const otherSchedulingFieldChanged = OTHER_SCHEDULING_FIELDS.some(
    (field) => field in updates && !isSameSchedulingValue(updates[field], prevTask[field])
  );
  // Recurrence pattern changes (e.g. "every day" -> "every week") shift which
  // occurrence dates need blocks even when dueDate itself doesn't change on
  // this edit (a dueDate change on a recurring task re-anchors the series
  // separately and is already covered by dueDateChanged above).
  const recurrenceChanged = 'recurrenceString' in updates && updates.recurrenceString !== prevTask.recurrenceString;

  if ((dueDateChanged || durationChanged || otherSchedulingFieldChanged || recurrenceChanged) && hasUnlockedScheduledBlock) {
    return true;
  }

  // Unlocking a task makes it newly eligible for placement — a locked task
  // has remainingHours forced to 0, so it has no existing block to
  // invalidate; it needs a rebalance to be placed for the first time instead.
  if (prevTask.isLocked && 'isLocked' in updates && updates.isLocked === false) {
    return true;
  }

  // Turning excludeFromAutoSchedule ON needs a rebalance so the engine can
  // drop this task's existing block (if any); turning it OFF needs one so
  // the engine can place it for the first time, mirroring isLocked above.
  if ('excludeFromAutoSchedule' in updates && updates.excludeFromAutoSchedule !== !!prevTask.excludeFromAutoSchedule) {
    return true;
  }

  return false;
}

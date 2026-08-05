/**
 * ============================================================================
 * ONE-TIME MIGRATION — SAFE TO DELETE after ~2026-09 once telemetry/support
 * shows no remaining users with `staleRecurringRemainingHoursMigrationDone
 * !== true` (see the call site in SchedulerContext.jsx, and the
 * `staleRecurringRemainingHoursMigrationDone` persisted flag guarding it).
 *
 * Before computeRecurrenceSyncUpdates (utils/recurrence.js) started resetting
 * remainingHours/isCompleted when a task newly becomes recurring, a task that
 * was `isCompleted: true` (with `remainingHours: 0`) before it — or its
 * parent — became recurring stayed stuck there forever: becoming recurring
 * only ever set isRecurring/dueDate, and the only other place remainingHours
 * resets (completeTask's occurrence-advance) never fires for a "convert to
 * recurring" transition. Most commonly hit via migrateSubtasksToTasks.js,
 * whose migrated sub-tasks get `remainingHours: sub.isCompleted ? 0 : 0.5`
 * and start non-recurring even when their new parent already is — so the
 * (also one-time) recurrence-consistency sync would flip them recurring
 * afterward, without this reset.
 *
 * A stuck task looks exactly like one legitimately mid-occurrence: recurring,
 * remainingHours <= 0. The only way to tell them apart is
 * isCompletedForCurrentOccurrence's own definition (see taskHierarchy.js) —
 * a recurring task is only legitimately "done for now" if its CURRENT
 * dueDate is in completedDates. If it isn't, remainingHours <= 0 has nothing
 * backing it and is stale data, not an in-progress completion.
 *
 * Idempotent: a no-op once every recurring task's remainingHours is
 * consistent with its completedDates, which is every task after the first
 * run (computeRecurrenceSyncUpdates now keeps this correct going forward for
 * anything that flips non-recurring -> recurring).
 *
 * @param {import('../types').Task[]} tasks
 * @returns {import('../types').Task[]} tasks with any stale recurring remainingHours/isCompleted repaired
 */
export function migrateStaleRecurringRemainingHours(tasks) {
  if (!Array.isArray(tasks)) return tasks;
  let changed = false;
  const repaired = tasks.map((t) => {
    if (!t.isRecurring || !t.dueDate) return t;
    if ((t.remainingHours ?? 0) > 0 && !t.isCompleted) return t;
    if (t.completedDates?.includes(t.dueDate)) return t; // legitimately closed out for its current occurrence
    changed = true;
    return { ...t, remainingHours: t.estimatedHours, isCompleted: false };
  });
  return changed ? repaired : tasks;
}

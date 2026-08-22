/**
 * ============================================================================
 * ONE-TIME MIGRATION — recurring task state
 * ============================================================================
 * Adopts utils/recurrenceState.js's convergent model on existing recurring
 * tasks. See that module's header for why the model exists; this file is only
 * concerned with getting current data into it without anyone noticing.
 *
 * THE PROPERTY THIS MIGRATION GUARANTEES: immediately after it runs, every
 * derived value equals what was already stored. A user upgrading sees zero
 * change to any recurring task — same due date, same completed dates, same
 * history. That's asserted directly in tests/unit/migrateRecurrenceState.test.js
 * rather than left as an intention, because a migration that shifts a due date
 * is indistinguishable from the scheduler having done it.
 *
 * The mapping:
 *   recurrenceAnchor          <- the task's current dueDate. It's the series'
 *                                defining occurrence, so deriving from it
 *                                returns that same date straight back.
 *   completedOccurrences      <- the existing completedDates (the raw 7-day
 *                                window), normalized to a sorted unique set.
 *   completionHistoryArchive  <- the existing completionHistory, frozen as a
 *                                baseline. It holds counts for occurrences
 *                                whose raw dates were already discarded by the
 *                                old trimming, so it can't be recomputed —
 *                                keeping it as an archive is what stops the
 *                                migration from destroying long-term history.
 *
 * `dueDate`, `completedDates` and `completionHistory` are deliberately left on
 * the task untouched. They're derived from here on, but they remain real
 * fields with real values, so a device still running pre-migration code (and
 * every existing reader — allocator, Board, Stats, missedTasks) keeps working
 * against them exactly as before.
 *
 * SAFE TO DELETE this file, its test, and the effect that calls it in
 * SchedulerContext once `recurrenceStateMigrationDone` is true for all users
 * — per CLAUDE.md's rule on removing one-time migration code. The three
 * migrations already living alongside this one have the same note.
 * ============================================================================
 */

import { normalizeOccurrences } from '../utils/recurrenceState';

/**
 * @param {import('../types').Task[]} tasks
 * @returns {import('../types').Task[]} the same array reference when nothing
 *   needed migrating, so the caller can skip committing a pointless history
 *   entry (matching migrateRecurrenceConsistency's own contract).
 */
export function migrateRecurrenceState(tasks) {
  if (!Array.isArray(tasks)) return tasks;

  let changed = false;
  const migrated = tasks.map((task) => {
    // Only recurring tasks with a due date have a series to anchor. A
    // recurring task with no due date is a valid pre-existing state (see
    // types/index.js) — it simply has nothing to derive from yet, and
    // ensureRecurrenceAnchor will pick it up if a date is set later.
    if (!task?.isRecurring || !task.dueDate) return task;
    // Already migrated (or created after this shipped) — leave it alone so a
    // re-run can never double-apply.
    if (typeof task.recurrenceAnchor === 'string' && task.recurrenceAnchor.length > 0) return task;

    changed = true;
    return {
      ...task,
      recurrenceAnchor: task.dueDate,
      completedOccurrences: normalizeOccurrences(task.completedDates),
      skippedThrough: null,
      completionHistoryArchive: { ...(task.completionHistory || {}) },
    };
  });

  return changed ? migrated : tasks;
}

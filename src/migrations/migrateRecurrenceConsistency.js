/**
 * ============================================================================
 * ONE-TIME MIGRATION — SAFE TO DELETE after ~2026-09 once telemetry/support
 * shows no remaining users with `recurrenceConsistencyMigrationDone !== true`
 * (see the call site in SchedulerContext.jsx, and the
 * `recurrenceConsistencyMigrationDone` persisted flag guarding it).
 *
 * Before this shipped, a parent task and its sub-tasks could have
 * inconsistent `isRecurring`/`recurrenceString` — e.g. a recurring parent
 * with non-recurring sub-tasks, or a recurring sub-task under a non-recurring
 * parent. Going forward, SchedulerContext's addTask/updateTask keep the two
 * in sync automatically (see utils/recurrence.js's
 * computeRecurrenceSyncUpdates), but existing data needs a one-time backfill
 * to catch up.
 *
 * Idempotent: a no-op once every parent/sub-task chain already agrees on
 * recurrence (which is every task after the first run, since the live
 * addTask/updateTask path now enforces it continuously).
 *
 * @param {import('../types').Task[]} tasks
 * @returns {import('../types').Task[]} tasks with recurrence synced across every parent/sub-task chain
 */
import { computeRecurrenceSyncUpdates } from '../utils/recurrence';

export function migrateRecurrenceConsistency(tasks) {
  if (!Array.isArray(tasks)) return tasks;
  const updates = computeRecurrenceSyncUpdates(tasks);
  if (updates.size === 0) return tasks;
  return tasks.map((t) => (updates.has(t.id) ? { ...t, ...updates.get(t.id) } : t));
}

/**
 * ============================================================================
 * TASK TOMBSTONES — pure decision logic
 * ============================================================================
 * Deletion foundation for the per-task cross-device merge (a later step, see
 * useCloudSync.js's planRemoteDataMerge/applyRemoteData — NOT built here).
 * That merge needs to tell "this task doesn't exist on this device because it
 * was never created" apart from "it doesn't exist because it was deleted" —
 * a plain array removal can't express the second case, so a delete on one
 * device could be silently undone by a stale edit arriving from another
 * device that never saw the delete.
 *
 * Extracted as pure functions (no Firebase/React/Date.now() side effects
 * beyond an explicit `nowMs`/`nowIso` parameter) so they're unit-testable
 * without mounting SchedulerContext — same precedent as useCloudSync.js's
 * computeFingerprint/race-guard functions and sharedTaskSync.js's merge
 * decisions.
 *
 * Blocks are NOT part of this scheme — they're regenerated locally by the
 * scheduler after a task merge, not merged themselves (a separate, already-
 * made design decision), so nothing here touches blocks.
 * ============================================================================
 */

import { isSharedTask } from './sharedTaskSync';
import { computeCutoffMs } from '../services/dataRetention';

/**
 * Fields cleared on a tombstoned task — the heaviest/most private content
 * fields, with nothing left to show once the task is gone. Everything else
 * (title, dueDate, priority, etc.) is left untouched: harmless to keep, and
 * occasionally useful for debugging a sync issue.
 */
const TOMBSTONE_CLEARED_FIELDS = {
  notes: null,
  noteLinks: [],
  comments: [],
  deletedCommentIds: [],
};

/**
 * Transform `tasks` so every id in `idsToDelete` becomes a tombstone (marked
 * `deletedAt`/`updatedAt`, heavy content fields cleared) instead of being
 * removed from the array, and every OTHER task's `dependsOn` has those same
 * ids scrubbed out (unchanged from the pre-tombstone behavior — a dependency
 * on a deleted task must not stay referencing it).
 *
 * Pure: takes the current tasks array, the ids to delete, and the timestamp
 * to stamp — the caller (SchedulerContext.deleteTask) is responsible for
 * everything else deletion does (Storage attachment cleanup, Google Calendar
 * block cleanup, shared-task-deletion notification, actually dropping the
 * task's blocks) since those are side effects, not state-shape decisions.
 *
 * @param {import('../types').Task[]} tasks
 * @param {Set<string>|string[]} idsToDelete
 * @param {string} nowIso
 * @returns {import('../types').Task[]}
 */
export function tombstoneTasks(tasks, idsToDelete, nowIso) {
  const ids = idsToDelete instanceof Set ? idsToDelete : new Set(idsToDelete);
  return tasks.map((t) => {
    if (ids.has(t.id)) {
      return { ...t, ...TOMBSTONE_CLEARED_FIELDS, deletedAt: nowIso, updatedAt: nowIso };
    }
    if (t.dependsOn?.some((id) => ids.has(id))) {
      return { ...t, dependsOn: t.dependsOn.filter((id) => !ids.has(id)), updatedAt: nowIso };
    }
    return t;
  });
}

/**
 * True if `task` is a tombstone (see tombstoneTasks above) older than
 * `retentionDays`, and therefore eligible for the retention sweep to
 * permanently remove. Shared tasks are exempt — mirrors the completed-task
 * retention sweep's own exemption (SchedulerContext.jsx): this is personal
 * housekeeping running on whichever device happens to load first, and
 * applying it to a shared project would delete a tombstone out from under a
 * merge process (or collaborators) that hasn't converged yet.
 *
 * @param {import('../types').Task} task
 * @param {number} retentionDays
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isStaleTombstone(task, retentionDays, nowMs = Date.now()) {
  if (!task?.deletedAt || isSharedTask(task)) return false;
  const cutoffMs = computeCutoffMs(retentionDays, nowMs);
  return new Date(task.deletedAt).getTime() < cutoffMs;
}

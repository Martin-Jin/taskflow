/**
 * ============================================================================
 * PER-TASK CROSS-DEVICE MERGE — pure decision logic
 * ============================================================================
 * The per-task counterpart to taskTombstones.js's deletion foundation. Fixes
 * a real data-loss bug: useCloudSync.js's planRemoteDataMerge used to treat
 * `tasks` as ONE atomic value (pickValid('tasks', remote, local) — take one
 * side's ENTIRE array or the other's). A device that wakes up with a stale
 * local copy and pushes it can arrive at Firestore AFTER a genuinely newer
 * edit from another device, and — because that whole-doc write simply lands
 * "last" — silently overwrite the newer edit even though its own content is
 * older. `isRemoteWriteStale` (useCloudSync.js) guards the same problem at
 * the whole-DOCUMENT level, but can't help here: the stale device's write is
 * itself a "fresh" push, so the doc-level staleness gate can't tell "a fresh
 * write" apart from "a fresh write of stale content" — only a per-task,
 * per-field timestamp comparison can.
 *
 * Extracted as a pure function (no Firebase/React/Date.now() side effects) so
 * it's unit-testable in isolation — same precedent as this file's siblings:
 * useCloudSync.js's computeFingerprint/race-guard functions, and
 * sharedTaskSync.js's mergeSharedTask/mergeComments.
 * ============================================================================
 */

/** Epoch millis for `task.updatedAt`, or null if missing/unparseable. */
function updatedAtMillis(task) {
  if (!task?.updatedAt) return null;
  const ms = new Date(task.updatedAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Per-task merge of two tasks arrays by `updatedAt`, replacing the old
 * "take one side's whole array" behavior.
 *
 * Semantics:
 *   - Union of ids across both arrays. A task id present on only ONE side is
 *     kept as-is — with tombstones now covering "deleted", a task genuinely
 *     missing from one side for long shouldn't normally happen, but a BRAND
 *     NEW task (created locally, not yet pushed/pulled by the other device)
 *     legitimately has this shape and must not be dropped.
 *   - A task id present on BOTH sides: keep whichever has the newer
 *     `updatedAt`. Ties keep the local copy (arbitrary, but deterministic).
 *   - Missing/unparseable `updatedAt` on one side only: the side WITH a
 *     valid `updatedAt` counts as newer (every mutation site stamps it per
 *     the tombstone-foundation step, so a missing value only happens on old
 *     persisted data that predates that — a defensive fallback, not the
 *     common case). If BOTH sides are missing/invalid, keep local — arbitrary,
 *     but must never throw.
 *   - A tombstoned task (`deletedAt` set, see taskTombstones.js) participates
 *     in the SAME `updatedAt` comparison as any live task, with NO special
 *     casing. `tombstoneTasks` stamps `updatedAt` at delete time exactly like
 *     any other mutation does, so the plain comparison already gives the
 *     right answer in both directions: a delete with a newer `updatedAt` than
 *     a stale live edit correctly wins (the deletion sticks), and a live edit
 *     with a newer `updatedAt` than an older tombstone correctly wins too
 *     (the task "un-deletes" — this is CORRECT, not a bug: it's what should
 *     happen for an undo of the delete, or the user deliberately recreating/
 *     restoring similar content after the delete with a later edit timestamp).
 *     Adding an `if (task.deletedAt)` branch here would be redundant at best,
 *     and would risk special-casing away exactly the behavior that makes
 *     deletions and their undos both work correctly through one rule.
 *   - Pure and deterministic: no `Date.now()`, no mutation of either input,
 *     always returns a NEW array.
 *
 * @param {import('../types').Task[]} localTasks
 * @param {import('../types').Task[]} remoteTasks
 * @returns {import('../types').Task[]}
 */
export function mergeTasksByUpdatedAt(localTasks, remoteTasks) {
  const localById = new Map((localTasks || []).map((t) => [t.id, t]));
  const remoteById = new Map((remoteTasks || []).map((t) => [t.id, t]));

  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  const merged = [];

  for (const id of ids) {
    const local = localById.get(id);
    const remote = remoteById.get(id);

    if (local && !remote) {
      merged.push(local);
      continue;
    }
    if (remote && !local) {
      merged.push(remote);
      continue;
    }

    // Present on both sides — keep whichever has the newer updatedAt.
    const localMs = updatedAtMillis(local);
    const remoteMs = updatedAtMillis(remote);

    if (localMs === null && remoteMs === null) {
      merged.push(local); // both missing/invalid — arbitrary but deterministic
    } else if (remoteMs === null) {
      merged.push(local); // only local has a valid timestamp
    } else if (localMs === null) {
      merged.push(remote); // only remote has a valid timestamp
    } else if (remoteMs > localMs) {
      merged.push(remote);
    } else {
      merged.push(local); // local newer, or a tie
    }
  }

  return merged;
}

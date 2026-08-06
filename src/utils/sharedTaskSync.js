/**
 * ============================================================================
 * SHARED TASK SYNC — pure decision logic (Phase 1, Collaborative Projects)
 * ============================================================================
 * Every function here is pure and side-effect-free: no Firebase imports, no
 * Date.now(), no randomness. That's deliberate and follows the precedent set
 * by useCloudSync.js's computeFingerprint/race guards and Phase 0's
 * sharedProjectAccess.js — a concurrency bug found by clicking is found late,
 * so the decisions are extracted here and tested directly.
 *
 * HOW SHARED TASKS LIVE ALONGSIDE PERSONAL ONES
 * ---------------------------------------------
 * A shared task stays in the SAME `state.tasks` array as everything else,
 * tagged with `sharedProjectId`. That's the single most important choice in
 * this file: it means Board, the task list, search, TaskDetailModal, drag-and-
 * drop, dependencies and the Gantt chart all keep working on shared tasks with
 * no changes at all. What differs is only where a shared task PERSISTS, and
 * which subsystems must leave it alone:
 *
 *   - Not written to localStorage, and not pushed through useCloudSync's
 *     users/{uid} document. Firestore is the source of truth for these — the
 *     inverse of the rest of this app (see firestoreSync.js's header). Keeping
 *     both stores would mean two writers reconciling the same data, which is
 *     the bug class this whole phase exists to avoid.
 *   - Excluded from undo/redo. HistoryEntry snapshots the WHOLE task array, so
 *     restoring one would silently revert a collaborator's concurrent edits to
 *     tasks the undoing user never touched. See preserveSharedTasks.
 *   - Excluded from the auto-scheduler and the 30-day completed sweep, both of
 *     which reason about one person's data (see rebalanceEngine's schedulable
 *     filter, and the sweep's own comment in SchedulerContext).
 *
 * CONFLICT POLICY, STATED EXPLICITLY
 * ----------------------------------
 * LAST WRITE WINS PER TASK DOCUMENT. Two people editing the same task's title
 * at once: whoever's write lands second wins the whole document, and the first
 * writer's change is gone with no warning. There is no operational transform
 * and no field-level merge — that's out of scope for v1 per the spec, and
 * per-document Firestore writes give this policy for free.
 *
 * The ONE exception is recurring-task completion state, which is merged rather
 * than overwritten (see utils/recurrenceState.js's mergeRecurringState). LWW is
 * fine for "replace" fields and silently corrupting for accumulators, so the
 * accumulator was made commutative instead. Everything else is replace.
 * ============================================================================
 */

import { mergeRecurringState, deriveRecurringFields } from './recurrenceState';
import { toISODate } from './dateUtils';

/** True if `task` belongs to a shared project rather than this user's own store. */
export function isSharedTask(task) {
  return !!task && typeof task.sharedProjectId === 'string' && task.sharedProjectId.length > 0;
}

/**
 * Split a task list into the personal tasks (which persist locally and sync
 * through users/{uid}) and the shared ones (which live in Firestore). Used by
 * every exclusion point — persistence, cloud sync, backups.
 * @param {import('../types').Task[]} tasks
 * @returns {{personalTasks: import('../types').Task[], sharedTasks: import('../types').Task[]}}
 */
export function partitionTasksBySharing(tasks) {
  const personalTasks = [];
  const sharedTasks = [];
  for (const task of tasks || []) {
    (isSharedTask(task) ? sharedTasks : personalTasks).push(task);
  }
  return { personalTasks, sharedTasks };
}

/**
 * Fields that are LOCAL-ONLY and must never be written to a shared task's
 * Firestore document. `sharedProjectId` is how this client tags the task in its
 * own array — storing it in the document would be redundant (the document's
 * path already says which project it's in) and would resurrect a stale id if a
 * project were ever re-created.
 */
const LOCAL_ONLY_TASK_FIELDS = ['sharedProjectId'];

/**
 * Strip a task down to what actually gets stored in
 * `sharedProjects/{projectId}/tasks/{taskId}`. Also drops `undefined` values,
 * which the Firestore SDK throws on outright (same reason firestoreSync.js has
 * stripUndefined).
 * @param {import('../types').Task} task
 * @returns {object}
 */
export function serializeSharedTask(task) {
  const out = {};
  for (const [key, value] of Object.entries(task || {})) {
    if (value === undefined) continue;
    if (LOCAL_ONLY_TASK_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Rebuild the app-local task shape from a stored document, re-tagging it with the project it came from. */
export function deserializeSharedTask(doc, projectId) {
  return { ...doc, sharedProjectId: projectId };
}

/**
 * Stable comparison of two tasks' SYNCED content — used to decide whether a
 * local change is a genuine edit worth writing, or just an echo of what's
 * already stored. Key order is normalized so an object rebuilt in a different
 * order doesn't read as a change and cause a write loop.
 */
export function sharedTaskFingerprint(task) {
  const serialized = serializeSharedTask(task);
  const keys = Object.keys(serialized).sort();
  return JSON.stringify(keys.map((k) => [k, serialized[k]]));
}

/**
 * Diff the local task array against what's known to be stored, producing the
 * per-document writes to send.
 *
 * WHY A DIFF RATHER THAN HOOKS IN EVERY MUTATION: tasks are mutated through a
 * whole-array `commit()` from a dozen call sites (addTask, updateTask,
 * completeTask, board drag-reorder, the AI plan assistant, label deletion,
 * dependency scrubbing...). Threading a Firestore write through each one would
 * mean every future call site has to remember to do the same. Diffing the
 * resulting array catches all of them, including ones that don't exist yet.
 *
 * DELETES ARE NOT INFERRED. A task missing from the local array is NOT treated
 * as a delete, because "absent" is ambiguous: it might mean the user deleted
 * it, or it might mean the array was replaced wholesale by an undo, a backup
 * restore, or a cloud-sync pull — none of which should destroy a collaborator's
 * data. Deletions are passed in explicitly by the caller, which knows it was a
 * real delete. `knownIds` is what makes creates unambiguous in the same way.
 *
 * @param {object} params
 * @param {import('../types').Task[]} params.tasks - the full local task array
 * @param {string} params.projectId - only tasks tagged with this project are considered
 * @param {Map<string, string>} params.syncedFingerprints - taskId -> fingerprint last known stored
 * @param {string[]} [params.deletedIds] - ids the caller knows were deliberately deleted
 * @returns {{creates: object[], updates: object[], deletes: string[]}}
 */
export function planSharedTaskWrites({ tasks, projectId, syncedFingerprints, deletedIds = [] }) {
  const creates = [];
  const updates = [];

  for (const task of tasks || []) {
    if (task?.sharedProjectId !== projectId) continue;
    const fingerprint = sharedTaskFingerprint(task);
    if (!syncedFingerprints.has(task.id)) {
      creates.push(task);
    } else if (syncedFingerprints.get(task.id) !== fingerprint) {
      updates.push(task);
    }
  }

  // Only delete ids we actually believe exist remotely — a delete for
  // something never synced is a wasted round-trip.
  const deletes = deletedIds.filter((id) => syncedFingerprints.has(id));

  return { creates, updates, deletes };
}

/**
 * Decide how a remote snapshot should be applied on top of local state — the
 * race guard, and the reason this module is unit-tested rather than clicked.
 *
 * THE RACE: the user edits task T locally; the write is in flight; a snapshot
 * that was computed BEFORE that write arrives. Applying it naively reverts T on
 * screen and, worse, overwrites the local copy the pending write was derived
 * from, so the edit is lost entirely rather than merely delayed.
 *
 * THE GUARD: `pending` holds the fingerprint of what we last wrote for each
 * task and hasn't yet seen confirmed. A remote version that doesn't match it is
 * stale and is ignored for that one task; a version that DOES match means the
 * server has caught up, so the task is cleared from `pending` and normal
 * last-write-wins resumes. This is per-task, so one in-flight edit never blocks
 * unrelated collaborators' changes from landing.
 *
 * Recurring completion state is MERGED rather than replaced, per this module's
 * conflict-policy note — see recurrenceState.mergeRecurringState.
 *
 * @param {object} params
 * @param {import('../types').Task[]} params.localTasks - the full local task array
 * @param {object[]} params.remoteTasks - documents from this project's tasks subcollection
 * @param {string} params.projectId
 * @param {Map<string, string|null>} params.pending - taskId -> fingerprint we wrote (null = we wrote a delete)
 * @param {string} [params.todayIso] - ISO date for re-deriving recurring fields on merge; defaults to the real current date (see mergeSharedTask)
 * @returns {{tasks: import('../types').Task[], confirmedIds: string[], removedIds: string[]}}
 *   `confirmedIds` can be dropped from `pending`; `removedIds` are tasks gone remotely (callers prune their blocks).
 */
export function planRemoteTaskApply({ localTasks, remoteTasks, projectId, pending, todayIso }) {
  const localById = new Map((localTasks || []).filter((t) => t?.sharedProjectId === projectId).map((t) => [t.id, t]));
  const remoteById = new Map((remoteTasks || []).map((d) => [d.id, deserializeSharedTask(d, projectId)]));

  const confirmedIds = [];
  const removedIds = [];
  const resolved = new Map();

  for (const [id, remoteTask] of remoteById) {
    const local = localById.get(id);
    const pendingFingerprint = pending?.get(id);

    if (pending?.has(id)) {
      if (pendingFingerprint === null) {
        // We deleted it locally; the server still has it. Keep it deleted here
        // and keep waiting for our delete to land.
        continue;
      }
      if (sharedTaskFingerprint(remoteTask) !== pendingFingerprint) {
        // Stale snapshot, predating our own in-flight write — keep ours.
        if (local) resolved.set(id, local);
        continue;
      }
      confirmedIds.push(id);
    }

    resolved.set(id, mergeSharedTask(local, remoteTask, todayIso));
  }

  // Local tasks the server doesn't have.
  for (const [id, local] of localById) {
    if (remoteById.has(id)) continue;
    if (pending?.has(id) && pending.get(id) !== null) {
      // We created/updated it and the server hasn't echoed it yet — keep it
      // rather than flickering it out of the UI.
      resolved.set(id, local);
      continue;
    }
    if (pending?.has(id) && pending.get(id) === null) {
      confirmedIds.push(id); // our delete landed
    }
    removedIds.push(id);
  }

  // Rebuild the full array: untouched non-project tasks in place, this
  // project's tasks replaced by the resolved set. Order is preserved for
  // tasks that already existed so nothing jumps around in the UI.
  const tasks = [];
  const emitted = new Set();
  for (const task of localTasks || []) {
    if (task?.sharedProjectId !== projectId) {
      tasks.push(task);
      continue;
    }
    if (resolved.has(task.id)) {
      tasks.push(resolved.get(task.id));
      emitted.add(task.id);
    }
    // Otherwise it was removed remotely — drop it.
  }
  for (const [id, task] of resolved) {
    if (!emitted.has(id)) tasks.push(task);
  }

  return { tasks, confirmedIds, removedIds };
}

/**
 * Combine a local and remote version of one task. Last-write-wins (the remote
 * document is taken wholesale) EXCEPT for recurring completion state, which is
 * merged so a completion recorded on either side survives — see this module's
 * conflict-policy note and recurrenceState.mergeRecurringState.
 *
 * The union/max merge only fixes the SOURCE-OF-TRUTH fields
 * (completedOccurrences/skippedThrough); dueDate/completedDates/
 * completionHistory are DERIVED from those and must be recomputed afterward,
 * or they'd keep whatever stale value the remote document happened to carry
 * (e.g. a dueDate that's already in the merged completedOccurrences set —
 * see recurrenceState.deriveRecurringFields). `todayIso` defaults to the real
 * current date rather than being required, since this runs inside a snapshot
 * listener with no natural caller-supplied "today" — tests can still pass one
 * explicitly for determinism.
 *
 * Deriving over `{ ...remote, ...merged }` (rather than local) deliberately
 * keeps `remote.dueDate` as the `storedDueDate` deriveRecurringFields checks
 * against its mixed-version-device guard: a pre-migration client can still
 * legitimately push dueDate ahead of what the merged occurrence set implies,
 * and that must keep winning here too.
 */
export function mergeSharedTask(local, remote, todayIso = toISODate(new Date())) {
  if (!local) return remote;
  if (!remote?.isRecurring && !local.isRecurring) return remote;
  const merged = mergeRecurringState(local, remote);
  const combined = { ...remote, ...merged };
  return { ...combined, ...deriveRecurringFields(combined, todayIso) };
}

/**
 * Restore live shared tasks on top of a task array that came from somewhere
 * which doesn't know about them — an undo/redo snapshot, a backup restore, or
 * a cloud-sync pull.
 *
 * This is the undo/redo landmine fix. HistoryEntry snapshots the ENTIRE task
 * array, so undoing an unrelated action would otherwise restore that snapshot's
 * copy of every shared task — reverting collaborators' concurrent edits to
 * tasks the undoing user never touched, and resurrecting ones they deleted.
 * Keeping the LIVE shared tasks instead scopes undo to the user's own data,
 * which is the only thing they can meaningfully undo.
 *
 * @param {import('../types').Task[]} restoredTasks - the array being applied
 * @param {import('../types').Task[]} liveSharedTasks - current shared tasks, authoritative
 * @returns {import('../types').Task[]}
 */
export function preserveSharedTasks(restoredTasks, liveSharedTasks) {
  const { personalTasks } = partitionTasksBySharing(restoredTasks);
  return [...personalTasks, ...(liveSharedTasks || [])];
}

/** How long after its last heartbeat a viewer is still considered present. */
export const PRESENCE_STALE_MS = 90 * 1000;

/**
 * Which collaborators count as currently viewing a project. A heartbeat is
 * written periodically and simply stops when someone closes the tab — there's
 * no reliable "goodbye" event on the web — so presence is defined by recency
 * rather than by an explicit leave.
 *
 * @param {Array<{uid: string, displayName?: string, photoURL?: string|null, lastSeenAt?: *}>} entries
 * @param {number} nowMs
 * @param {string} [excludeUid] - normally the current user, who isn't shown their own avatar
 * @returns {Array<{uid: string, displayName: string, photoURL: string|null}>}
 */
export function computeActiveViewers(entries, nowMs, excludeUid) {
  return (entries || [])
    .filter((entry) => {
      if (!entry?.uid || entry.uid === excludeUid) return false;
      const seen = toMillis(entry.lastSeenAt);
      return seen != null && nowMs - seen < PRESENCE_STALE_MS;
    })
    .map((entry) => ({
      uid: entry.uid,
      displayName: entry.displayName || 'Someone',
      photoURL: typeof entry.photoURL === 'string' ? entry.photoURL : null,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Millis from whatever timestamp shape shows up — Firestore Timestamp, Date,
 * number, or a serverTimestamp() placeholder that hasn't resolved yet (null).
 * Same duck-typing rationale as sharedProjectAccess.js's expiresAtMillis:
 * deliberately no firebase import.
 */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  return null;
}

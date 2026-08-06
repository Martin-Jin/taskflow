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
 * The exceptions are the two ACCUMULATOR fields, which are merged rather than
 * overwritten: recurring-task completion state (see utils/recurrenceState.js's
 * mergeRecurringState) and the comment thread (see mergeComments below). LWW is
 * fine for "replace" fields and silently corrupting for accumulators, so both
 * accumulators were made commutative instead. Everything else is replace.
 *
 * SECTIONS (Board columns), added after tasks — same policy, one extra note
 * on `order`
 * ----------------------------------------------------------------------
 * Shared Sections mirror shared Tasks exactly: they live in the SAME
 * `state.sections` array as personal sections, tagged with `sharedProjectId`,
 * synced via the same diff/race-guard shape (see `planSharedSectionWrites`/
 * `planRemoteSectionApply` below, siblings of `planSharedTaskWrites`/
 * `planRemoteTaskApply`), and excluded from the same set of places (local
 * persistence, undo/redo, live cloud-sync fingerprint/merge — see
 * `preserveSharedSections`). LAST WRITE WINS PER SECTION DOCUMENT, no
 * exception this time — a Section has no accumulator field like a recurring
 * task's completion state, so plain replace is enough everywhere including
 * `order`.
 *
 * WHY PLAIN LWW ON `order` IS FINE (the one new decision this feature adds):
 * `order` is only ever assigned ONCE, at section-creation time
 * (`addSection`'s `order: sections.length + 1`) — nothing in this app ever
 * writes to an existing section's `order` afterward. Board's own column drag-
 * reorder is deliberately local-only already (see utils/boardColumnOrder.js's
 * header: a per-user, per-project localStorage id list layered on top of the
 * natural `order` at render time, never written back onto the Section
 * record) — that precedent predates sharing and applies unchanged to a shared
 * project's columns, so two collaborators can have their OWN preferred column
 * arrangement without either one's drag ever touching the synced document.
 * The only way `order` conflicts at all, then, is two collaborators creating
 * a new section at nearly the same moment and both computing it from the same
 * stale `sections.length` — a tied/duplicate `order` value. That's a cosmetic
 * tie-break (whichever section's create doc happens to sort first at that
 * value), not a corrupted or "half-applied" reorder — nothing is lost, no
 * document is silently overwritten, and `applySavedColumnOrder` doesn't even
 * require unique orders (a stable sort tie-break is enough). Building
 * fractional indexing or a CRDT to avoid that cosmetic tie is disproportionate
 * for a small personal-scale app, so plain LWW is used, same as everything
 * else here.
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
 * Cap on a shared task's comment TOMBSTONES (Task.deletedCommentIds — see
 * mergeComments), for the same "the whole document is rewritten on every push"
 * reason as SchedulerContext's MAX_COMMENTS_PER_TASK. Tombstones are tiny (one
 * id each) but, unlike comments, are never user-deletable, so a thread churned
 * over years would grow them without limit. Trimming the oldest is safe where
 * trimming a comment wouldn't be: dropping a tombstone can only resurrect its
 * comment if a peer still holds a copy that old AND hasn't synced since, which
 * past this many deletions isn't a real scenario.
 */
export const MAX_COMMENT_TOMBSTONES = 500;

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
 * A SECOND, NARROWER RACE — a task created but not yet pushed: `addTask`
 * tags a new task's `sharedProjectId` synchronously (so it's already a local
 * "shared task" the instant it's created), but the actual write to Firestore
 * is debounced (see useSharedProjectSync's PUSH_DEBOUNCE_MS) and only marks it
 * in `pending` when that debounced push actually fires. Any remote snapshot
 * arriving inside that window — triggered by presence, a section write, or a
 * collaborator's unrelated edit — used to see a task with no `pending` entry
 * and no matching remote document and conclude it must have been deleted
 * remotely, dropping it locally the instant it synced. `knownRemoteIds` is how
 * this is told apart from a REAL remote delete: it's every id this client has
 * ever confirmed exists in Firestore for this project (the caller's running
 * syncedFingerprints map). A local task absent from both `remoteTasks` and
 * `knownRemoteIds` has simply never been seen by the server yet — exactly the
 * ambiguous "absence" this module's header warns deletes must never be
 * inferred from — so it's kept, the same as a `pending` entry would keep it.
 * Once the server confirms it (present in a snapshot, or added to
 * `knownRemoteIds` by the caller), a later real removal is no longer ambiguous
 * and still deletes it as before.
 *
 * Recurring completion state is MERGED rather than replaced, per this module's
 * conflict-policy note — see recurrenceState.mergeRecurringState.
 *
 * @param {object} params
 * @param {import('../types').Task[]} params.localTasks - the full local task array
 * @param {object[]} params.remoteTasks - documents from this project's tasks subcollection
 * @param {string} params.projectId
 * @param {Map<string, string|null>} params.pending - taskId -> fingerprint we wrote (null = we wrote a delete)
 * @param {Iterable<string>} [params.knownRemoteIds] - ids ever confirmed to exist server-side for this project (e.g. the caller's syncedFingerprints keys) — absence from here means "never pushed", not "deleted"
 * @param {string} [params.todayIso] - ISO date for re-deriving recurring fields on merge; defaults to the real current date (see mergeSharedTask)
 * @returns {{tasks: import('../types').Task[], confirmedIds: string[], removedIds: string[]}}
 *   `confirmedIds` can be dropped from `pending`; `removedIds` are tasks gone remotely (callers prune their blocks).
 */
export function planRemoteTaskApply({ localTasks, remoteTasks, projectId, pending, knownRemoteIds, todayIso }) {
  const localById = new Map((localTasks || []).filter((t) => t?.sharedProjectId === projectId).map((t) => [t.id, t]));
  const remoteById = new Map((remoteTasks || []).map((d) => [d.id, deserializeSharedTask(d, projectId)]));
  const knownRemoteIdSet = knownRemoteIds ? new Set(knownRemoteIds) : null;

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
    if (!pending?.has(id) && knownRemoteIdSet && !knownRemoteIdSet.has(id)) {
      // Never confirmed to exist server-side and not (yet) marked pending —
      // this is a task created locally whose debounced push hasn't fired
      // yet, not one the server ever had and lost. Absence alone is never
      // evidence of a delete (see this function's doc comment) — keep it.
      resolved.set(id, local);
      continue;
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
 * Merge two versions of one task's comment thread into their convergent join —
 * the SECOND accumulator exception to this module's last-write-wins policy
 * (recurring completion state is the first; see mergeRecurringState).
 *
 * WHY THIS IS NEEDED. `comments` is appended to, not replaced: addComment
 * computes `[...task.comments, newComment]` from whatever the client currently
 * holds, and the push writes the WHOLE task document with `set` (no merge — see
 * writeSharedTasks). So two collaborators commenting inside one debounce window
 * each push a thread built on a snapshot that predates the other's comment, and
 * the second write silently destroys the first person's comment. Plain LWW is
 * exactly as corrupting here as it would be for completedOccurrences.
 *
 * WHY DELETIONS NEED TOMBSTONES. A naive union can't express deletion: the side
 * that deleted a comment is indistinguishable from a side that simply hasn't
 * received it yet, so the union would resurrect every deleted comment on the
 * next sync. `deletedCommentIds` records the ids instead, and a tombstone always
 * beats a body — delete wins over concurrent re-add, which is the safe direction
 * (a resurrected comment someone deliberately removed is worse than a lost
 * re-add, and comment ids are never reused).
 *
 * The result is commutative, associative and idempotent, like mergeRecurringState:
 * union the bodies by id, union the tombstones, subtract, then order by
 * `createdAt` (id as tie-break) so every client renders the same thread in the
 * same order regardless of which write landed first.
 *
 * Tombstones are capped (MAX_COMMENT_TOMBSTONES) so a thread churned over years
 * can't grow them without limit. The cap is applied here as well as at delete
 * time because a merge unions two lists and could otherwise exceed it. Sorting
 * before trimming keeps the survivors identical on every client — trimming an
 * unsorted union would let two peers keep DIFFERENT subsets and never converge.
 *
 * @param {{comments?: import('../types').Comment[], deletedCommentIds?: string[]}} a
 * @param {{comments?: import('../types').Comment[], deletedCommentIds?: string[]}} b
 * @returns {{comments: import('../types').Comment[], deletedCommentIds: string[]}}
 */
export function mergeComments(a, b) {
  const tombstones = new Set();
  for (const id of a?.deletedCommentIds || []) if (typeof id === 'string' && id) tombstones.add(id);
  for (const id of b?.deletedCommentIds || []) if (typeof id === 'string' && id) tombstones.add(id);
  const keptTombstones = [...tombstones].sort().slice(-MAX_COMMENT_TOMBSTONES);
  const keptTombstoneSet = new Set(keptTombstones);

  // Union by id. On the same id, keep either copy — a comment body is immutable
  // once posted (there's no edit affordance), so the two sides agree by
  // construction and picking one keeps the merge idempotent.
  const byId = new Map();
  for (const comment of [...(a?.comments || []), ...(b?.comments || [])]) {
    if (!comment?.id || keptTombstoneSet.has(comment.id)) continue;
    if (!byId.has(comment.id)) byId.set(comment.id, comment);
  }

  const comments = [...byId.values()].sort((x, y) => {
    const ax = x.createdAt || '';
    const ay = y.createdAt || '';
    if (ax !== ay) return ax < ay ? -1 : 1;
    return (x.id || '') < (y.id || '') ? -1 : 1;
  });
  return { comments, deletedCommentIds: keptTombstones };
}

/**
 * Combine a local and remote version of one task. Last-write-wins (the remote
 * document is taken wholesale) EXCEPT for recurring completion state and the
 * comment thread, both of which are merged so an entry recorded on either side
 * survives — see this module's conflict-policy note,
 * recurrenceState.mergeRecurringState and mergeComments above.
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
  // Comments merge for EVERY shared task, recurring or not — the accumulator
  // problem has nothing to do with recurrence, so this runs before the
  // recurring-only early return below.
  const withComments = { ...remote, ...mergeComments(local, remote) };
  if (!remote?.isRecurring && !local.isRecurring) return withComments;
  const merged = mergeRecurringState(local, remote);
  const combined = { ...withComments, ...merged };
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

/**
 * ============================================================================
 * SHARED SECTIONS — Board columns, mirroring everything above for tasks
 * ============================================================================
 * See this file's header ("SECTIONS (Board columns)...") for the conflict
 * policy and the `order` decision. Every function below is the section
 * equivalent of its task counterpart above; kept in this file (rather than a
 * separate module) so the two features' shared conventions stay visibly in
 * sync as either one changes.
 */

/** True if `section` belongs to a shared project rather than this user's own store. */
export function isSharedSection(section) {
  return !!section && typeof section.sharedProjectId === 'string' && section.sharedProjectId.length > 0;
}

/** Split a section list into personal (local-persisted) and shared (Firestore-backed) — see partitionTasksBySharing. */
export function partitionSectionsBySharing(sections) {
  const personalSections = [];
  const sharedSections = [];
  for (const section of sections || []) {
    (isSharedSection(section) ? sharedSections : personalSections).push(section);
  }
  return { personalSections, sharedSections };
}

/** Local-only field — see LOCAL_ONLY_TASK_FIELDS above for the same reasoning applied to sections. */
const LOCAL_ONLY_SECTION_FIELDS = ['sharedProjectId'];

/** Strip a section down to what's actually stored in `sharedProjects/{projectId}/sections/{sectionId}` — see serializeSharedTask. */
export function serializeSharedSection(section) {
  const out = {};
  for (const [key, value] of Object.entries(section || {})) {
    if (value === undefined) continue;
    if (LOCAL_ONLY_SECTION_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Rebuild the app-local section shape from a stored document, re-tagging it with the project it came from. */
export function deserializeSharedSection(doc, projectId) {
  return { ...doc, sharedProjectId: projectId };
}

/** Stable comparison of a section's synced content — see sharedTaskFingerprint. */
export function sharedSectionFingerprint(section) {
  const serialized = serializeSharedSection(section);
  const keys = Object.keys(serialized).sort();
  return JSON.stringify(keys.map((k) => [k, serialized[k]]));
}

/**
 * Diff the local section array against what's known to be stored — the
 * section equivalent of planSharedTaskWrites. Same rationale: sections are
 * mutated by addSection/renameSection/deleteSection (and, at share time, the
 * bulk upload in shareProject), and diffing the resulting array catches all
 * of them without threading a Firestore write through each call site.
 *
 * Deletes are NOT inferred from absence, for the same reason as tasks — an
 * undo, backup restore, or cloud pull replaces the array wholesale.
 * @param {object} params
 * @param {import('../types').Section[]} params.sections - the full local section array
 * @param {string} params.projectId
 * @param {Map<string, string>} params.syncedFingerprints - sectionId -> fingerprint last known stored
 * @param {string[]} [params.deletedIds]
 * @returns {{creates: object[], updates: object[], deletes: string[]}}
 */
export function planSharedSectionWrites({ sections, projectId, syncedFingerprints, deletedIds = [] }) {
  const creates = [];
  const updates = [];

  for (const section of sections || []) {
    if (section?.sharedProjectId !== projectId) continue;
    const fingerprint = sharedSectionFingerprint(section);
    if (!syncedFingerprints.has(section.id)) {
      creates.push(section);
    } else if (syncedFingerprints.get(section.id) !== fingerprint) {
      updates.push(section);
    }
  }

  const deletes = deletedIds.filter((id) => syncedFingerprints.has(id));

  return { creates, updates, deletes };
}

/**
 * Decide how a remote section snapshot should be applied on top of local
 * state — the section equivalent of planRemoteTaskApply, including the same
 * in-flight-write race guard AND the same "created but not yet pushed" guard
 * (see planRemoteTaskApply's doc comment — `addSection` tags `sharedProjectId`
 * synchronously the same way `addTask` does, so the identical debounce-window
 * hole applies here via `knownRemoteIds`). Unlike tasks there is no
 * recurring-completion merge exception: a section is always taken wholesale
 * from remote once its pending write (if any) is confirmed (see this file's
 * header for why plain LWW is fine for sections).
 * @param {object} params
 * @param {import('../types').Section[]} params.localSections
 * @param {object[]} params.remoteSections
 * @param {string} params.projectId
 * @param {Map<string, string|null>} params.pending
 * @param {Iterable<string>} [params.knownRemoteIds] - ids ever confirmed to exist server-side for this project — see planRemoteTaskApply
 * @returns {{sections: import('../types').Section[], confirmedIds: string[], removedIds: string[]}}
 */
export function planRemoteSectionApply({ localSections, remoteSections, projectId, pending, knownRemoteIds }) {
  const localById = new Map((localSections || []).filter((s) => s?.sharedProjectId === projectId).map((s) => [s.id, s]));
  const remoteById = new Map((remoteSections || []).map((d) => [d.id, deserializeSharedSection(d, projectId)]));
  const knownRemoteIdSet = knownRemoteIds ? new Set(knownRemoteIds) : null;

  const confirmedIds = [];
  const removedIds = [];
  const resolved = new Map();

  for (const [id, remoteSection] of remoteById) {
    const pendingFingerprint = pending?.get(id);

    if (pending?.has(id)) {
      if (pendingFingerprint === null) {
        continue; // we deleted it locally; server still has it, keep waiting
      }
      if (sharedSectionFingerprint(remoteSection) !== pendingFingerprint) {
        const local = localById.get(id);
        if (local) resolved.set(id, local);
        continue; // stale snapshot, predating our own in-flight write
      }
      confirmedIds.push(id);
    }

    resolved.set(id, remoteSection);
  }

  for (const [id, local] of localById) {
    if (remoteById.has(id)) continue;
    if (pending?.has(id) && pending.get(id) !== null) {
      resolved.set(id, local); // created/updated locally, not echoed back yet
      continue;
    }
    if (pending?.has(id) && pending.get(id) === null) {
      confirmedIds.push(id); // our delete landed
    }
    if (!pending?.has(id) && knownRemoteIdSet && !knownRemoteIdSet.has(id)) {
      // Created locally, debounced push hasn't fired yet — never confirmed
      // to exist server-side, so absence isn't evidence of a delete. See
      // planRemoteTaskApply's identical guard.
      resolved.set(id, local);
      continue;
    }
    removedIds.push(id);
  }

  const sections = [];
  const emitted = new Set();
  for (const section of localSections || []) {
    if (section?.sharedProjectId !== projectId) {
      sections.push(section);
      continue;
    }
    if (resolved.has(section.id)) {
      sections.push(resolved.get(section.id));
      emitted.add(section.id);
    }
  }
  for (const [id, section] of resolved) {
    if (!emitted.has(id)) sections.push(section);
  }

  return { sections, confirmedIds, removedIds };
}

/**
 * Restore live shared sections on top of a section array that came from
 * somewhere which doesn't know about them — see preserveSharedTasks for the
 * full rationale (undo/redo's whole-array snapshot problem applies equally
 * here, even though sections don't currently sit in the undo/redo history
 * themselves — see SchedulerContext's setSections vs. commit — this still
 * guards the cloud-sync pull/restore paths, which DO replace `sections`
 * wholesale via setSections).
 * @param {import('../types').Section[]} restoredSections
 * @param {import('../types').Section[]} liveSharedSections
 * @returns {import('../types').Section[]}
 */
export function preserveSharedSections(restoredSections, liveSharedSections) {
  const { personalSections } = partitionSectionsBySharing(restoredSections);
  return [...personalSections, ...(liveSharedSections || [])];
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

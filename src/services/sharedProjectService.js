/**
 * ============================================================================
 * SHARED PROJECT SERVICE — Firestore I/O for collaborative projects
 * ============================================================================
 * The thin Firebase layer under Phase 1's live sync. Every DECISION lives in
 * utils/sharedTaskSync.js and utils/sharedProjectAccess.js (both pure, both
 * unit-tested); this file only performs the reads and writes those decide on,
 * so there's no untested logic hiding behind a network call.
 *
 * HOW THIS DIFFERS FROM firestoreSync.js
 * --------------------------------------
 * firestoreSync.js syncs ONE user's whole dataset as a single users/{uid}
 * document, with localStorage as the always-on source of truth and Firestore
 * as a convergence layer. That model cannot work with concurrent writers, so
 * shared projects invert it:
 *
 *   - Firestore is the SOURCE OF TRUTH. Shared tasks are not persisted to
 *     localStorage and never travel through the users/{uid} document.
 *   - One document PER TASK, not one per user. Two people editing different
 *     tasks never touch the same document, so their writes can't collide at
 *     all — the whole-document last-write-wins policy only ever applies to two
 *     people editing the SAME task.
 *
 * Keeping the two paths separate rather than unified is deliberate (see
 * TODO.md's Phase 1 landmines): they have opposite truth models, and merging
 * them would mean every existing single-user behaviour has to be re-reasoned
 * about under concurrency.
 *
 * SECURITY: nothing here can widen access. Reads/writes are authorized by
 * firestore.rules against the caller's uid and the project's `collaborators`
 * map; a client that asks for a project it isn't a member of is simply denied.
 * Share LINKS are not handled here at all — tokens live in a document no
 * client may read (`sharedProjects/{id}/private/links`), so generating,
 * rotating, revoking or even viewing a link has to go through the server-side
 * join endpoint in Phase 2. See firestore.rules' header comment.
 * ============================================================================
 */

import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import { serializeSharedTask } from '../utils/sharedTaskSync';
import { stripUndefined } from './firestoreSync';

/** Firestore caps a batch at 500 operations; chunk anything larger. */
const MAX_BATCH_OPS = 500;

const projectRef = (projectId) => doc(db, 'sharedProjects', projectId);
const tasksRef = (projectId) => collection(db, 'sharedProjects', projectId, 'tasks');
const taskRef = (projectId, taskId) => doc(db, 'sharedProjects', projectId, 'tasks', taskId);
const presenceRef = (projectId, uid) => doc(db, 'sharedProjects', projectId, 'presence', uid);

/**
 * Create the shared-project document for a project being shared for the first
 * time. `collaborators` MUST start empty — firestore.rules enforces it, so that
 * the map can only ever grow through a verified join, which the entire access
 * model rests on.
 * @returns {Promise<void>}
 */
export async function createSharedProject(projectId, { ownerId, name }) {
  await setDoc(
    projectRef(projectId),
    stripUndefined({
      ownerId,
      name,
      collaborators: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
}

/**
 * Mirror a rename onto the shared document, so collaborators see the new name
 * rather than the one it had when they joined. Deliberately narrow: `ownerId`
 * and `collaborators` are access-control fields that rules only let specific
 * paths touch, so they're not settable from here. (Projects have no `color`
 * field any more — it was removed as an unused Todoist import leftover.)
 */
export async function updateSharedProject(projectId, { name }) {
  await setDoc(
    projectRef(projectId),
    stripUndefined({ name, updatedAt: new Date().toISOString() }),
    { merge: true }
  );
}

/** Delete the project document itself. Owner-only per rules. */
export async function deleteSharedProject(projectId) {
  await deleteDoc(projectRef(projectId));
}

/**
 * Live-subscribe to a shared project document. `onData` receives null if the
 * project is deleted or this user loses access — callers treat that as "drop
 * it from my list" rather than an error, since losing access is a normal
 * outcome (removed by the owner, project deleted).
 * @returns {() => void} unsubscribe
 */
export function subscribeSharedProject(projectId, onData, onError) {
  return onSnapshot(
    projectRef(projectId),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (err) => onError?.(err)
  );
}

/**
 * Live-subscribe to a project's tasks. Fires with the full current task list
 * on every change from any collaborator.
 *
 * Snapshots with pending local writes are skipped, matching
 * firestoreSync.subscribeUserData: an optimistic echo of a write we just made
 * carries nothing the caller doesn't already have, and letting it through would
 * make the in-flight race guard (planRemoteTaskApply) reason about our own
 * unconfirmed data as though it were the server's.
 * @returns {() => void} unsubscribe
 */
export function subscribeSharedTasks(projectId, onTasks, onError) {
  return onSnapshot(
    tasksRef(projectId),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      onTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (err) => onError?.(err)
  );
}

/**
 * Apply a planned set of task writes (see planSharedTaskWrites) as batched
 * per-document operations. Batches are atomic, so a partial apply can't leave
 * the project half-updated.
 *
 * Creates and updates are both `set` without merge: a task document is a
 * complete snapshot of the task, and merging would leave a field that was
 * deliberately CLEARED locally (a removed due date, a dropped label) still
 * present remotely.
 */
export async function writeSharedTasks(projectId, { creates = [], updates = [], deletes = [] }) {
  const ops = [
    ...[...creates, ...updates].map((task) => ({ type: 'set', id: task.id, data: serializeSharedTask(task) })),
    ...deletes.map((id) => ({ type: 'delete', id })),
  ];
  if (ops.length === 0) return;

  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + MAX_BATCH_OPS)) {
      if (op.type === 'delete') batch.delete(taskRef(projectId, op.id));
      else batch.set(taskRef(projectId, op.id), stripUndefined(op.data));
    }
    await batch.commit();
  }
}

/**
 * Record that this user is currently viewing the project. Rules constrain this
 * document to exactly these three fields (see firestore.rules' presence
 * block) — unvalidated, a viewer could write hundreds of KB here, or set a
 * display name impersonating someone else in the avatar strip.
 *
 * `serverTimestamp()` rather than a client clock: presence is judged by
 * recency, and a client with a skewed clock would otherwise appear
 * permanently present or permanently stale to everyone else.
 */
export async function writePresence(projectId, uid, { displayName, photoURL }) {
  await setDoc(presenceRef(projectId, uid), {
    displayName: displayName || 'Someone',
    photoURL: photoURL || null,
    lastSeenAt: serverTimestamp(),
  });
}

/** Remove this user's presence document — best-effort on leaving a project. */
export async function clearPresence(projectId, uid) {
  await deleteDoc(presenceRef(projectId, uid));
}

/**
 * Live-subscribe to who's viewing a project. Staleness is decided by
 * computeActiveViewers, not here — there's no reliable "goodbye" event on the
 * web, so a closed tab simply stops heartbeating and ages out.
 * @returns {() => void} unsubscribe
 */
export function subscribePresence(projectId, onPresence, onError) {
  return onSnapshot(
    collection(db, 'sharedProjects', projectId, 'presence'),
    (snap) => onPresence(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (err) => onError?.(err)
  );
}

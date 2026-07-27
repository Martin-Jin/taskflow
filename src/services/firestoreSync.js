/**
 * ============================================================================
 * FIRESTORE SYNC
 * ============================================================================
 * Cross-device sync for a signed-in user's TaskFlow data. Deliberately
 * simple, matching this app's existing "local storage is the always-on
 * source of truth" model rather than introducing a live realtime store:
 *
 *   - On sign-in, the app's cloud doc (if any) is pulled ONCE and overwrites
 *     local state (see the cloud-sync effects in SchedulerContext /
 *     ThemeContext) — this is what makes a second device pick up the first
 *     device's data instead of keeping its own separate copy.
*    - From then on, local changes are pushed up (debounced) so the cloud doc
 *     stays current, AND a live `onSnapshot` listener (subscribeUserData,
 *     below) watches the same doc so a change pushed from another signed-in
 *     device converges into this tab within moments, without waiting for a
 *     reload or a manual "Sync now". The two calling contexts
 *     (SchedulerContext / ThemeContext) are responsible for telling "a
 *     genuine change from elsewhere" apart from "my own write echoing
 *     back" — see SchedulerContext's `lastSyncedSnapshotRef`.
 *
 * All of a user's data lives in a single doc at users/{uid} so one write
 * covers everything without juggling a subcollection per data type.
 *
 * BACKUPS are deliberately separate from the above: users/{uid} is the live
 * doc that gets silently overwritten every 1500ms debounce, so it can never
 * serve as a "restore to how things were" point-in-time snapshot — a bad
 * write a few seconds ago is already the only copy. Backups live in their
 * own subcollection, users/{uid}/backups/{backupId}, each one an immutable
 * snapshot created once and never touched again (until deleted).
 * ============================================================================
 */

import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

/** One-time fetch of the user's synced data — see subscribeUserData below for live, ongoing updates. 
 * @returns {Promise<object|null>} the user's synced data, or null if they've never synced before. */
export async function pullUserData(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

/** Merge-writes the given fields into the user's doc — never clobbers fields this call doesn't mention. */
export async function pushUserData(uid, data) {
  await setDoc(doc(db, 'users', uid), data, { merge: true });
}

/**
 * Live-subscribes to the user's synced doc so a change pushed from another
 * device (or another tab) converges into this one within moments, instead
 * of only on the next sign-in/reload/manual "Sync now". `onData` fires with
 * the doc's full current data on every server-confirmed change.
 *
 * `includeMetadataChanges: true` is what makes the SDK deliver a second
 * event once a locally-initiated write is acknowledged by the server, on
 * top of the usual "another client changed this" events — both look
 * identical from here, so the caller (SchedulerContext / ThemeContext) is
 * the one that knows how to recognize its own write echoing back and skip
 * re-applying it. The one thing filtered here is the FIRST, optimistic
 * event for a pending local write (before the server has acknowledged it)
 * — that's just an echo of state the caller already has, so there's never
 * anything useful in it.
 * @param {string} uid
 * @param {(data: object) => void} onData
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unsubscribe
 */
export function subscribeUserData(uid, onData, onError) {
  return onSnapshot(
    doc(db, 'users', uid),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      if (!snap.exists()) return;
      onData(snap.data());
    },
    (err) => onError?.(err)
  );
}

const MAX_LISTED_BACKUPS = 20;

/** Creates a new immutable point-in-time backup doc. Returns the new doc's auto-generated id. */
export async function createBackup(uid, data) {
  const ref = await addDoc(collection(db, 'users', uid, 'backups'), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Lists up to MAX_LISTED_BACKUPS most recent backups, newest first, as
 * lightweight `{ id, createdAt, exportedAt }` metadata rather than the full
 * payload each doc carries — the client SDK still downloads the whole doc
 * per the query, but callers (the "pick one to restore" list) only ever
 * need these three fields, so we strip the rest here rather than holding
 * up to 20 full task/block/etc arrays in React state at once.
 */
export async function listBackups(uid) {
  const q = query(collection(db, 'users', uid, 'backups'), orderBy('createdAt', 'desc'), limit(MAX_LISTED_BACKUPS));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, createdAt: d.data().createdAt ?? null, exportedAt: d.data().exportedAt ?? null }));
}

/** Fetches one backup's full payload by id, or null if it's since been deleted. */
export async function getBackup(uid, backupId) {
  const snap = await getDoc(doc(db, 'users', uid, 'backups', backupId));
  return snap.exists() ? snap.data() : null;
}

/** Deletes one backup by id. */
export async function deleteBackup(uid, backupId) {
  await deleteDoc(doc(db, 'users', uid, 'backups', backupId));
}

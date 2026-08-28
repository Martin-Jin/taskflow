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

import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

/** Firestore caps a batch at 500 operations; chunk anything larger. */
const MAX_BATCH_OPS = 500;

/** One-time fetch of the user's synced data — see subscribeUserData below for live, ongoing updates. 
 * @returns {Promise<object|null>} the user's synced data, or null if they've never synced before. */
export async function pullUserData(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Recursively strips `undefined` values out of plain objects/arrays.
 * Firestore's SDK throws synchronously on ANY `undefined` field value
 * anywhere in a write payload (including nested in arrays) — a bad shape
 * upstream (e.g. a task built with an unset optional field) would otherwise
 * turn into a hard "failed to sync" error instead of just omitting that key,
 * matching Firestore's own `setDoc(..., {merge: true})` semantics for a
 * missing field. Defense-in-depth: callers should still avoid producing
 * `undefined` in the first place, but this keeps one bad field from blocking
 * the entire sync.
 */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const result = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      result[key] = stripUndefined(v);
    }
    return result;
  }
  return value;
}

/**
 * Merge-writes the given fields into the user's doc — never clobbers fields
 * this call doesn't mention. Every push also stamps top-level `lastWriteAt`
 * with a fresh `serverTimestamp()`, regardless of which fields `data`
 * contains — this is the doc-level "when was this doc's data last written"
 * signal useCloudSync.js's isRemoteWriteStale gates pulls/live snapshots
 * against, so a stale device's delayed push can't silently look newer than
 * data another device already applied. Deliberately a separate top-level
 * field from `googleCalendarStatus.updatedAt` (a narrow presence signal for
 * a different mismatch check) — this one covers the whole doc.
 */
export async function pushUserData(uid, data) {
  await setDoc(doc(db, 'users', uid), { ...stripUndefined(data), lastWriteAt: serverTimestamp() }, { merge: true });
}

/**
 * Merge-writes this device's Google Calendar connection health onto the
 * user's doc, under its own `googleCalendarStatus` field — a small presence/
 * status signal, NOT a return of `events` (or anything else) to live sync.
 * Lets other signed-in devices notice "my Google Calendar connection
 * disagrees with what another device is reporting" via subscribeUserData's
 * listener (see useCloudSync.js's detectGoogleCalendarStatusMismatch).
 *
 * Deliberately its own field, isolated from every field computeFingerprint/
 * planRemoteDataMerge/applyRemoteData look at — those functions simply don't
 * reference `googleCalendarStatus`, so this write can never be picked up by
 * (or interfere with) the tasks/blocks/settings merge logic. `merge: true`
 * (inherited from pushUserData/setDoc) means this write also never touches
 * any other field in the doc, including another device's own status, task
 * data, etc. — same "each writer only ever mentions its own concern" contract
 * every other pushUserData caller already relies on.
 * @param {string} uid
 * @param {string} deviceId - this device's id (see utils/deviceIdentity.js)
 * @param {boolean} connected - this device's current googleConnected
 * @param {boolean} stale - this device's current googleSyncStale
 */
export async function pushGoogleCalendarStatus(uid, deviceId, connected, stale) {
  await setDoc(
    doc(db, 'users', uid),
    { googleCalendarStatus: { deviceId, connected, stale, updatedAt: serverTimestamp() } },
    { merge: true }
  );
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

// Raised from 20 now that up to 14 automatic backups (see useCloudSync's
// daily auto-backup/prune) can coexist with however many manual ones the
// user has created — this needs enough headroom that manual backups don't
// silently fall out of the "pick one to restore" list once 14+ automatic
// ones exist alongside them.
const MAX_LISTED_BACKUPS = 40;

/**
 * Creates a new immutable point-in-time backup doc. Returns the new doc's
 * auto-generated id. `automatic` tags who created it (the daily auto-backup
 * vs. Settings' "Back up now" button) so pruning can tell them apart —
 * automatic backups are rotated on a retention count, manual ones never are.
 */
export async function createBackup(uid, data, { automatic = false } = {}) {
  const ref = await addDoc(collection(db, 'users', uid, 'backups'), {
    ...stripUndefined(data),
    automatic,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Lists up to MAX_LISTED_BACKUPS most recent backups, newest first, as
 * lightweight `{ id, createdAt, exportedAt, automatic }` metadata rather than
 * the full payload each doc carries — the client SDK still downloads the
 * whole doc per the query, but callers (the "pick one to restore" list, and
 * the auto-backup pruning logic) only ever need these fields, so we strip
 * the rest here rather than holding many full task/block/etc arrays in React
 * state at once. `automatic` defaults to false for backups created before
 * that field existed.
 */
export async function listBackups(uid) {
  const q = query(collection(db, 'users', uid, 'backups'), orderBy('createdAt', 'desc'), limit(MAX_LISTED_BACKUPS));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    createdAt: d.data().createdAt ?? null,
    exportedAt: d.data().exportedAt ?? null,
    automatic: d.data().automatic ?? false,
  }));
}

// Sanity ceiling for listAutomaticBackups below, not a real-world limit —
// automatic backups are already self-limiting to ~AUTO_BACKUP_RETENTION_COUNT
// (14, see useCloudSync's runAutomaticBackupIfDue) in steady state, so this
// only guards against a bug elsewhere (e.g. pruning silently failing for a
// long time) causing an unbounded query.
const MAX_AUTOMATIC_BACKUPS_QUERIED = 200;

/**
 * Lists ALL automatic backups (up to the sanity ceiling above), newest
 * first — unlike listBackups, this is NOT capped to a small "most recent
 * overall" window, because that cap can hide old automatic backups behind
 * enough manual ones to push them out of it, making them permanently
 * un-prunable (see runAutomaticBackupIfDue, which uses this instead of
 * listBackups specifically to avoid that blind spot). Manual backups are
 * excluded by the query itself, not just filtered client-side.
 */
export async function listAutomaticBackups(uid) {
  const q = query(
    collection(db, 'users', uid, 'backups'),
    where('automatic', '==', true),
    orderBy('createdAt', 'desc'),
    limit(MAX_AUTOMATIC_BACKUPS_QUERIED)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    createdAt: d.data().createdAt ?? null,
    exportedAt: d.data().exportedAt ?? null,
    automatic: true,
  }));
}

// Sanity ceiling for listManualBackups below — same reasoning as
// MAX_AUTOMATIC_BACKUPS_QUERIED above, just for the manual pool (also capped
// at its own retention count in steady state, see MANUAL_BACKUP_RETENTION_
// COUNT in useCloudSync.js).
const MAX_MANUAL_BACKUPS_QUERIED = 200;

/**
 * Mirrors listAutomaticBackups, but for manual ("Back up now") backups —
 * needed for the same reason: manual backups now have their own retention
 * cap (independent from automatic backups' cap), and pruning that cap must
 * not be blind-sided by listBackups's "most recent 40 overall" window either.
 * `createBackup` always writes `automatic` (defaulting to false), so
 * `where('automatic', '==', false)` correctly matches every manual backup
 * ever created through this app — the only docs this query could miss are
 * ones from before the `automatic` field existed at all (Firestore's `==`
 * doesn't match a missing field), which is an acceptable, vanishingly rare
 * edge case for backups this old.
 */
export async function listManualBackups(uid) {
  const q = query(
    collection(db, 'users', uid, 'backups'),
    where('automatic', '==', false),
    orderBy('createdAt', 'desc'),
    limit(MAX_MANUAL_BACKUPS_QUERIED)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    createdAt: d.data().createdAt ?? null,
    exportedAt: d.data().exportedAt ?? null,
    automatic: false,
  }));
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

/**
 * Deletes several backups by id as batched writes rather than one `deleteDoc`
 * call per id fired concurrently — a pool that's ballooned past its normal
 * retention count (e.g. after pruning silently failed for a while) could
 * otherwise burst dozens of simultaneous individual writes and exhaust
 * Firestore's client-side write-stream queue (resource-exhausted), which
 * then throttles every OTHER pending write in the app (including the main
 * user-doc push) behind the same backoff. Batches are atomic per chunk, not
 * across chunks — fine here since pruning is best-effort cleanup, not a
 * transactional requirement.
 */
export async function deleteBackups(uid, backupIds) {
  for (let i = 0; i < backupIds.length; i += MAX_BATCH_OPS) {
    const batch = writeBatch(db);
    for (const id of backupIds.slice(i, i + MAX_BATCH_OPS)) {
      batch.delete(doc(db, 'users', uid, 'backups', id));
    }
    await batch.commit();
  }
}

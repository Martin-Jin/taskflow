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
 *   - From then on, local changes are pushed up (debounced) so the cloud doc
 *     stays current for the next device that signs in.
 *   - There's no live listener pushing a change from device A straight into
 *     device B's open tab — picking up another device's edits happens on
 *     next sign-in/reload. That's a deliberate scope cut: this app's whole
 *     state model reads from local storage once at mount, so wiring a live
 *     subscription in would mean restructuring how every piece of state is
 *     seeded, for a "two tabs open at once on two devices" case this app
 *     doesn't otherwise need to handle.
 *
 * All of a user's data lives in a single doc at users/{uid} so one write
 * covers everything without juggling a subcollection per data type.
 * ============================================================================
 */

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

/** @returns {Promise<object|null>} the user's synced data, or null if they've never synced before. */
export async function pullUserData(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

/** Merge-writes the given fields into the user's doc — never clobbers fields this call doesn't mention. */
export async function pushUserData(uid, data) {
  await setDoc(doc(db, 'users', uid), data, { merge: true });
}

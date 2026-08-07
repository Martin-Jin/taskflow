/**
 * ============================================================================
 * GUEST IDENTITY — one localStorage-backed record for every signed-out visitor
 * ============================================================================
 * Every signed-out visitor is a "guest" by default now, whether they just
 * opened the app directly or arrived via a project share link — see the
 * "guest identity by default" TODO this module implements. Previously these
 * were two unrelated things: a plain signed-out visitor had no identity at
 * all (no uid, no name, nothing to show/rename in Settings), while a
 * share-link visitor got a Firebase Anonymous Auth uid but their chosen name
 * lived ONLY denormalized onto `collaborators[uid].displayName` on each
 * shared project they'd joined (see sharedProjectAccess.js's `findOwnGuestName`)
 * — so removing them from every such project silently erased the name they'd
 * picked, and a second join in the same browser had no way to know they'd
 * already chosen one.
 *
 * This module gives BOTH paths one shared home: a single record,
 * `{ uid, displayName }`, persisted under one localStorage key. AuthContext
 * writes `uid` the moment a guest's Firebase Anonymous Auth session exists —
 * whether that session was created proactively on first signed-out load (the
 * new default path) or lazily by the share-join flow (the pre-existing path,
 * see useJoinFlow.js) — and any UI that lets a guest set/change their name
 * (the join flow's one-time name prompt, or Settings' rename control) writes
 * `displayName` here. `resolveGuestDisplayName` is what every reader (guest
 * settings UI, the join flow's "skip the prompt if already named" check)
 * should call instead of reading collaborator entries directly.
 *
 * WHY NOT JUST KEEP READING `collaborators[uid].displayName`
 * ------------------------------------------------------------------------
 * That denormalized copy still exists and is still what other people
 * actually SEE this guest called on a shared project (comments, presence,
 * the collaborator list) — this module doesn't replace it, it exists
 * alongside it as the durable local source of truth a guest's OWN client
 * reads back from. `resolveGuestDisplayName` prefers this local record (it
 * survives the guest being removed from every project), but falls back to
 * scanning `collaborators` for a pre-existing guest who has a project-
 * denormalized name but, because they used the app before this module
 * existed, nothing in the local record yet — that fallback result is also
 * backfilled into the local record so it doesn't need to be looked up again.
 *
 * WHY THIS IS NOT IN BACKUP_FIELDS / LIVE CLOUD SYNC
 * ------------------------------------------------------------------------
 * Per CLAUDE.md's Backups section: this is device-local by nature, the same
 * reasoning that already applies to `anonJoinNames` (the per-token name cache
 * this module supersedes, see below) and to `theme`'s local-only counterpart.
 * A guest's Firebase Anonymous Auth uid is meaningless on another device (it
 * IS the device's identity, there's nothing to restore it as), and the whole
 * point of this record is to survive with no cloud account at all. Once a
 * guest signs in with a real Google account, `linkWithCredential` upgrades
 * their existing uid in place (see AuthContext.jsx) — the guest record simply
 * stops being read for that uid; there's nothing to migrate out of it.
 *
 * SUPERSEDES `anonJoinNames` (joinFlow.js)
 * ------------------------------------------------------------------------
 * The old per-share-token name cache existed for one reason: skip the name
 * prompt on a repeat join. A single unified guest name makes that per-token
 * indirection unnecessary — one name per browser, not one per link — so
 * `loadCachedJoinName`/`saveCachedJoinName`/`renameCachedJoinNames` have been
 * removed in favor of this module's `resolveGuestDisplayName`/`setGuestDisplayName`.
 * ============================================================================
 */

import { loadPersisted, savePersisted } from './persistence';

const GUEST_IDENTITY_KEY = 'guestIdentity';

/**
 * @typedef {{uid: string|null, displayName: string|null}} GuestIdentity
 */

/**
 * Both storage-touching functions below take an optional `storage` pair
 * (same pattern as joinFlow.js's old name cache) so this stays testable
 * under Vitest's `node` environment, which has no `window.localStorage`.
 * @typedef {{load: (key: string, fallback: *) => *, save: (key: string, value: *) => void}} GuestStorage
 */
const defaultStorage = { load: loadPersisted, save: savePersisted };

/** The raw stored record, normalized to always have both keys. Never null. */
function readRecord(storage) {
  const raw = storage.load(GUEST_IDENTITY_KEY, null);
  if (!raw || typeof raw !== 'object') return { uid: null, displayName: null };
  return {
    uid: typeof raw.uid === 'string' && raw.uid ? raw.uid : null,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : null,
  };
}

/**
 * The full local guest identity record, or `{uid: null, displayName: null}`
 * if none has been stored yet.
 * @param {GuestStorage} [storage]
 * @returns {GuestIdentity}
 */
export function loadGuestIdentity(storage = defaultStorage) {
  return readRecord(storage);
}

/**
 * Remember this browser's guest uid, once a Firebase Anonymous Auth session
 * exists for it. Called from AuthContext right after such a session is
 * created or observed on mount — idempotent, so calling it again with the
 * same uid on every reload is harmless.
 *
 * Deliberately does NOT overwrite an existing DIFFERENT stored uid: that
 * would only happen if this browser's Firebase auth state was cleared and a
 * fresh anonymous session was minted, at which point the OLD uid is already
 * gone from Firebase too (nothing still points at it) and the display name
 * is still worth keeping — carried forward under the new uid rather than
 * discarded, since a chosen name is a user preference, not a value that's
 * only meaningful for one specific uid.
 * @param {string} uid
 * @param {GuestStorage} [storage]
 */
export function setGuestUid(uid, storage = defaultStorage) {
  if (!uid || typeof uid !== 'string') return;
  const current = readRecord(storage);
  if (current.uid === uid) return; // Already recorded — avoid a redundant write.
  storage.save(GUEST_IDENTITY_KEY, { uid, displayName: current.displayName });
}

/**
 * Remember this guest's chosen display name — called from both the places a
 * guest can set/change it: the share-join flow's one-time name prompt, and
 * Settings' rename control (see SchedulerContext.jsx's `renameAnonymousSelf`).
 * @param {string} displayName
 * @param {GuestStorage} [storage]
 */
export function setGuestDisplayName(displayName, storage = defaultStorage) {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (!trimmed) return;
  const current = readRecord(storage);
  storage.save(GUEST_IDENTITY_KEY, { uid: current.uid, displayName: trimmed });
}

/**
 * A guest's own chosen display name, preferring this browser's local record
 * and falling back to scanning `collaborators` entries (the pre-existing,
 * project-denormalized source — see this module's header) for a guest who
 * picked a name before this module existed. A fallback hit is opportunistically
 * backfilled into the local record so future calls (and a future project
 * removal) don't need `sharedProjects` at all.
 *
 * `uid` is OPTIONAL: under the lazy-sign-in design (see AuthContext.jsx), a
 * guest who has never joined a share or renamed while a member of one has no
 * Firebase session — and therefore no uid — at all, but may still have set a
 * name via Settings while purely local (see SchedulerContext.jsx's
 * renameAnonymousSelf). The local record itself never needs a uid to be
 * useful, so a missing uid only rules out the `sharedProjects` fallback below
 * (which has nothing to key off), not the local-record read.
 * @param {string|null|undefined} uid
 * @param {Record<string, {collaborators?: Record<string, {displayName?: string}>}>} [sharedProjects]
 * @param {GuestStorage} [storage]
 * @returns {string|null}
 */
export function resolveGuestDisplayName(uid, sharedProjects, storage = defaultStorage) {
  const local = readRecord(storage);
  if (local.displayName) return local.displayName;

  if (!uid || !sharedProjects) return null;
  for (const project of Object.values(sharedProjects)) {
    const name = project?.collaborators?.[uid]?.displayName;
    if (typeof name === 'string' && name.trim()) {
      const trimmed = name.trim();
      storage.save(GUEST_IDENTITY_KEY, { uid: local.uid || uid, displayName: trimmed });
      return trimmed;
    }
  }
  return null;
}

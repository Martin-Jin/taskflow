/**
 * ============================================================================
 * useCloudSync
 * ============================================================================
 * Extracted from SchedulerContext.jsx to reduce that file's size (~2000 lines).
 * Owns all Firestore cloud sync logic: pull/push with debounce, live onSnapshot
 * listener, fingerprint-based echo detection, backup/restore, and auto-backup.
 *
 * Returns the cloud-sync state and callbacks that SchedulerContext merges into
 * its own context value — nothing here talks to Google Calendar or manages
 * non-cloud state.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { usePersistedState } from './usePersistedState';
import { buildBackupPayload, isValidBackupPayload, isValidFieldValue, downloadBackupFile, readBackupFile } from '../services/backupService';
import {
  pullUserData,
  pushUserData,
  subscribeUserData,
  createBackup,
  listBackups,
  listAutomaticBackups,
  listManualBackups,
  getBackup,
  deleteBackup,
  deleteBackups,
  pushGoogleCalendarStatus,
  pushRestoreLock,
  heartbeatRestoreLock,
  clearRestoreLock,
} from '../services/firestoreSync';
import { migrateLinksToNotes } from '../components/Dashboard/notesModel';
import { mergeTasksByUpdatedAt } from '../utils/taskMerge';
import { mergeEventsByUpdatedAt } from '../utils/eventMerge';
import { pickNewerScalar, mergeEntitiesByTimestamp } from '../utils/entityMerge';
import { canonicalStringify } from '../utils/canonicalStringify';
import { getBrowserTimeZone } from '../utils/dateUtils';
import { loadPersisted, savePersisted } from '../utils/persistence.js';
import { getDeviceId } from '../utils/deviceIdentity.js';
import {
  CLOUD_SYNC_EDIT_DEBOUNCE_MS,
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_RETENTION_COUNT_AUTOMATIC,
  BACKUP_RETENTION_COUNT_MANUAL,
  RESTORE_LOCK_HEARTBEAT_MS,
  RESTORE_LOCK_STALE_MS,
} from '../services/dataRetention';

/**
 * Pure retention decision, shared by both backup pools — automatic and
 * manual each have their own independent retention count but the same
 * "keep the N most recent, prune the rest oldest-first" logic applies to both.
 *
 * `wantAutomatic` (default true, preserving this function's original
 * automatic-only behavior for existing callers) selects which pool to prune
 * from `backups` — filtering explicitly on this rather than inferring it
 * from the list's contents means a mixed list (e.g. from listBackups) is
 * still handled correctly: only entries matching `wantAutomatic` are ever
 * candidates, so a manual backup mixed into an automatic-heavy list (or vice
 * versa) is never swept up as the wrong pool. Returns the ids of matching
 * backups beyond `retentionCount` (oldest-first among the excess), ready to
 * delete.
 */
export function planAutoBackupPrune(backups, retentionCount = BACKUP_RETENTION_COUNT_AUTOMATIC, wantAutomatic = true) {
  const pool = backups.filter((b) => Boolean(b.automatic) === wantAutomatic);
  const sorted = [...pool].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return sorted.slice(retentionCount).map((b) => b.id);
}

/** Firestore Timestamps expose `.toMillis()`; a plain number (e.g. in tests) is used as-is. Missing/unknown values sort last (treated as oldest). */
export function toMillis(createdAt) {
  if (createdAt && typeof createdAt.toMillis === 'function') return createdAt.toMillis();
  if (typeof createdAt === 'number') return createdAt;
  return 0;
}

/**
 * `value` if it matches `field`'s expected shape (see backupService's
 * FIELD_TYPES), otherwise `fallback` (always the current in-app value for
 * that field). Guards every field applied by applyRemoteData/
 * applyBackupPayload below against a malformed source — a tampered
 * Firestore doc, corrupted/hand-edited backup file, or partial live-sync
 * write — so one bad field falls back to what's already on screen instead
 * of crashing later at render time (e.g. `sections.map` on a string).
 */
function pickValid(field, value, fallback) {
  return isValidFieldValue(field, value) ? value : fallback;
}

/**
 * Fixes a real bug: restoring a backup (local file, or a cloud snapshot) felt
 * instant on the device that clicked "Restore" — but the moment a SECOND
 * device next synced, that device's older data would silently win and undo
 * the restore, with no error and no warning. Here's why, and what this
 * function does about it.
 *
 * Every task and calendar event carries its own "last changed" timestamp
 * (`updatedAt` for a task, `localUpdatedAt` for a calendar event — see
 * taskMerge.js/eventMerge.js). When two devices disagree about a task, the
 * sync logic doesn't guess — it just keeps whichever copy has the NEWER
 * timestamp. That's the right rule for ordinary editing, but a backup is not
 * an ordinary edit: the tasks and events INSIDE a backup file still carry
 * whatever timestamp they had on the day the backup was originally taken,
 * which could be weeks or months old. From the sync logic's point of view, a
 * just-restored task genuinely looks OLDER than almost anything a second
 * device might later push — even though the person restoring it just told
 * TaskFlow "this is what I want right now." So the second device's stale
 * content would win the timestamp comparison and quietly overwrite the
 * restore soon after it synced.
 *
 * The fix: when a backup is applied, every task and event in it gets its
 * timestamp bumped to the moment of the restore, not left as whatever the
 * backup originally recorded. That makes the restored content look exactly
 * like a fresh edit made right now, so it correctly wins against anything
 * older arriving later from another device — which is what the user actually
 * intended by choosing to restore. This re-stamps EVERY item in the backup,
 * not just ones that differ from what's currently on screen — the whole
 * point of a restore is that all of its content should be treated as
 * current, uniformly.
 *
 * Deliberately NOT used for `applyRemoteData` (actual incoming data pulled
 * from another device or Firestore's live listener) — that data's timestamps
 * must stay exactly as the OTHER device stamped them, or the whole
 * newer-wins comparison this function exists to satisfy would break for
 * every future sync: an incoming pull would always look artificially "just
 * now" and never lose a comparison it legitimately should.
 *
 * Split into one function per array (rather than one function taking both)
 * because `applyBackupPayload` applies `tasks` and `events` at two separate
 * points in the payload, guarded by two separate `'x' in payload` checks —
 * a combined function would force one call site to pass the other's array as
 * empty/undefined for no benefit.
 *
 * @param {import('../types').Task[]} tasks
 * @param {string} nowIso
 * @returns {import('../types').Task[]}
 */
export function restampBackupTasks(tasks, nowIso) {
  return (tasks || []).map((t) => ({ ...t, updatedAt: nowIso }));
}

/** Event counterpart to restampBackupTasks — see that function's doc comment for the full "why". Stamps `localUpdatedAt`, the field mergeEventsByUpdatedAt compares (see eventMerge.js), not `updatedAt`. */
export function restampBackupEvents(events, nowIso) {
  return (events || []).map((e) => ({ ...e, localUpdatedAt: nowIso }));
}

/**
 * Pure decision for the events-fallback-from-backup effect (see its own doc
 * comment on the effect below): whether local `events` is missing with no
 * WORKING live Google Calendar source to repopulate it, so a recent Firestore
 * backup's `events` field should be restored instead. Extracted so this
 * narrow "is restoring even applicable" condition is unit-testable without
 * rendering the hook — separate from `pickValid`'s job of validating the
 * fetched backup payload once one is actually found.
 *
 * "No working live source" covers two cases: Google isn't connected at all,
 * OR it's nominally connected but its fetches have been failing (see
 * `googleSyncStale` in useGoogleCalendarSync) — e.g. a cold start where
 * auth.currentUser wasn't ready, or a network hiccup — which left `events`
 * just as empty as a full disconnection would.
 *
 * The empty-`events` guard is NOT loosened by that: this stays a narrow
 * gap-filler for "nothing usable locally", never a general reconciliation
 * path. Restoring a backup over non-empty live-looking local data could
 * resurrect events the user already deleted, which is exactly why `events`
 * is kept out of the continuously-reconciled live-sync path to begin with.
 */
export function shouldRestoreEventsFromBackup({ events, googleConnected, googleSyncStale }) {
  const noWorkingLiveSource = !googleConnected || !!googleSyncStale;
  return noWorkingLiveSource && (events?.length ?? 0) === 0;
}

/**
 * Pure decision for the cross-device Google-Calendar-status mismatch check
 * (see the live-listener effect below, which calls this on every snapshot).
 *
 * `remoteStatus` is whatever's currently at the synced doc's
 * `googleCalendarStatus` field (see firestoreSync.js's
 * pushGoogleCalendarStatus) — `{ deviceId, connected, stale }` from
 * whichever device wrote it last, or undefined/null if no device has ever
 * written it (a doc from before this feature shipped, or a first-ever sync).
 *
 * Returns:
 *   - `'thisDeviceBehind'` — the remote status is from ANOTHER device and
 *     reports a working connection (connected && !stale), while THIS device
 *     itself is disconnected or stale. The two devices disagree, and this is
 *     the one that should self-heal (trigger its own sync) as well as warn.
 *   - `'otherDeviceBehind'` — the mirror image: this device is
 *     connected-and-fresh, but the last-known status from another device
 *     says otherwise. Nothing for THIS device to fix (it's already fine) —
 *     surfaced only so the user isn't left thinking everything is in sync
 *     when a device sitting elsewhere isn't.
 *   - `null` — no mismatch: either the status is missing/from this same
 *     device (nothing to compare against), or both sides currently agree.
 *
 * Deliberately ignores anything OTHER than connected/stale on both sides —
 * this is a presence/status signal, not a data-merge decision, so it must
 * stay isolated from computeFingerprint/planRemoteDataMerge/applyRemoteData
 * (see pushGoogleCalendarStatus's doc comment) rather than folded into them.
 */
export function detectGoogleCalendarStatusMismatch({ remoteStatus, localDeviceId, localConnected, localSyncStale }) {
  if (!remoteStatus || typeof remoteStatus !== 'object') return null;
  if (!remoteStatus.deviceId || remoteStatus.deviceId === localDeviceId) return null; // nothing to compare against, or our own echo

  const remoteWorking = Boolean(remoteStatus.connected) && !remoteStatus.stale;
  const localWorking = Boolean(localConnected) && !localSyncStale;
  if (remoteWorking === localWorking) return null; // both sides agree — no mismatch

  return localWorking ? 'otherDeviceBehind' : 'thisDeviceBehind';
}

// canonicalStringify itself now lives in utils/canonicalStringify.js (see
// this file's own import above) — so utils/entityMerge.js and
// hooks/usePersistedState.js can use it without creating a circular import
// with this file. Re-exported here (not just imported) so every existing
// `import { canonicalStringify } from '.../useCloudSync.js'` keeps working
// unchanged.
export { canonicalStringify };

/**
 * Hashes/serializes the syncable subset of state so callers can detect "is
 * this remote update just an echo of what I just pushed" by string equality.
 * Pure and stateless — hoisted out of the hook (it never closed over
 * anything) so it can be exported and unit-tested directly.
 *
 * Includes `events` — see backupService.js's BACKUP_FIELDS doc comment for
 * why CalendarEvents now ride this same live cross-device sync: each event
 * merges individually by its own `localUpdatedAt` timestamp (mergeEventsByUpdatedAt)
 * with a real deletion tombstone (eventTombstones.js), the same fix that let
 * `tasks` join this fingerprint safely rather than risking a stale device's
 * whole-array push silently resurrecting a deletion.
 *
 * Uses canonicalStringify, NOT plain JSON.stringify — see that function's own
 * doc comment for why: a fingerprint that's sensitive to key order treats
 * Firestore's own echo of an unchanged nested object as a fresh remote
 * change, forever.
 *
 * Includes `fieldUpdatedAt` — the per-field sidecar timestamp map stamped by
 * useFieldStampedState (usePersistedState.js) for the nine settings-shaped
 * fields below that have no per-row id of their own to hang a timestamp on
 * (routines/rules/soundEnabled/soundVolume/animationsEnabled/
 * notificationSettings/notes/shortcutBindings/sharedProjectIds). Without it
 * here, changing one of those fields alone (with its value ending up
 * identical after a round-trip, or the fingerprint simply never having been
 * told a timestamp changed) could leave the fingerprint unchanged and the
 * new stamp would never actually reach Firestore — see schedulePush's
 * "no change, don't push" check, which relies entirely on this fingerprint.
 */
export function computeFingerprint(source) {
  const relevant = {
    tasks: source.tasks,
    blocks: source.blocks,
    sections: source.sections,
    projects: source.projects,
    labels: source.labels,
    routines: source.routines,
    rules: source.rules,
    soundEnabled: source.soundEnabled,
    soundVolume: source.soundVolume,
    animationsEnabled: source.animationsEnabled,
    notificationSettings: source.notificationSettings,
    notes: source.notes,
    shortcutBindings: source.shortcutBindings,
    savedViews: source.savedViews,
    taskTemplates: source.taskTemplates,
    trash: source.trash,
    sharedProjectIds: source.sharedProjectIds,
    events: source.events,
    fieldUpdatedAt: source.fieldUpdatedAt,
  };
  return canonicalStringify(relevant);
}

/** Ids of every task currently marked completed, as a Set for cheap diffing. */
function completedTaskIds(tasks) {
  const ids = new Set();
  for (const task of tasks || []) {
    if (task.isCompleted) ids.add(task.id);
  }
  return ids;
}

/**
 * True if `nextTasks` marks any task completed that `prevTasks` didn't.
 *
 * Completions bypass the push debounce (see shouldPushImmediately's use in
 * schedulePush) because they're the one edit whose delay has a consequence
 * beyond this device: the notify-worker cron reads Firestore directly, so a
 * completion still sitting in a debounce timer when the tab closes leaves the
 * worker seeing an incomplete, overdue task and emailing about something the
 * user already finished. Every other edit only costs a slightly-late sync.
 *
 * Deliberately one-directional — UN-completing a task (restore) doesn't
 * qualify. That direction's failure mode is a missing notification, not a
 * spurious one, so it doesn't justify giving up the debounce.
 *
 * `prevTasks` is null before the first push of a session, which is not a
 * completion event: the initial snapshot is whatever was already loaded, so
 * treating its existing completed tasks as "just completed" would force an
 * immediate push on mount for no reason.
 */
export function hasNewCompletion(prevTasks, nextTasks) {
  if (prevTasks === null || prevTasks === undefined) return false;
  const before = completedTaskIds(prevTasks);
  for (const task of nextTasks || []) {
    if (task.isCompleted && !before.has(task.id)) return true;
  }
  return false;
}

/**
 * The race guard shared by the live-listener and initial-pull effects: did a
 * local commit land (currentActionId changed) after `baselineActionId` was
 * captured at subscribe/pull-start? Both call sites compare the same shape
 * (a baseline action-id snapshot vs. the latest action-id) even though they
 * capture the baseline at different moments, so one pure comparison covers both.
 */
export function hasLocalEditRaced(baselineActionId, currentActionId) {
  return baselineActionId !== currentActionId;
}

/**
 * Same shape as hasLocalEditRaced, extended to also catch a local edit that
 * bypasses the undo stack entirely (currently: shareProject/joinSharedProject's
 * plain setProjects/setSharedProjectIds calls — see SchedulerContext.jsx's
 * localNonUndoEditIdRef doc comment). Races on EITHER counter moving: a real
 * local edit could be a commit(), a non-undo project/membership write, or
 * both landing in the same async gap.
 */
export function hasAnyLocalEditRaced(baseline, current) {
  return hasLocalEditRaced(baseline.actionId, current.actionId) || hasLocalEditRaced(baseline.nonUndoEditId, current.nonUndoEditId);
}

// How long the visibility/focus-triggered pull (see the effect below) stays
// throttled after firing, so rapid tab/window switching can't cause a
// refresh storm — mirrors useGoogleCalendarSync.js's own REFRESH_THROTTLE_MS
// pattern/magnitude for consistency between the two "came back to the
// foreground" refresh paths.
export const VISIBILITY_PULL_THROTTLE_MS = 20 * 1000;

/**
 * Pure decision for the visibility/focus-triggered pull: has enough time
 * passed since the last such refresh (`lastRefreshAt`, epoch ms; null/undefined
 * if none has ever fired) that a new one is due? Extracted so the throttle
 * math is unit-testable without driving the hook — same precedent as this
 * file's other pure decisions (computeFingerprint, isRemoteWriteStale,
 * hasLocalEditRaced, etc).
 */
export function shouldTriggerVisibilityRefresh(lastRefreshAt, now, throttleMs = VISIBILITY_PULL_THROTTLE_MS) {
  if (lastRefreshAt == null) return true;
  return now - lastRefreshAt >= throttleMs;
}

/**
 * Cross-device staleness gate (distinct from, and orthogonal to,
 * isStaleOwnEcho/hasLocalEditRaced below, which both guard against a
 * DEVICE'S OWN in-flight push racing its own newer local edit). This one
 * guards against a DIFFERENT problem: a whole other device — e.g. a phone
 * that's been asleep for hours with stale in-memory state — waking up and
 * pushing, whose debounced write can otherwise land on the server AFTER a
 * desktop's newer edit and silently overwrite it, purely by virtue of
 * arriving last. `setDoc(..., {merge:true})` has no concept of "older" vs.
 * "newer" data on its own, so this doc's `lastWriteAt` (a `serverTimestamp()`
 * stamped on every push, see firestoreSync.js's pushUserData) is the signal
 * used to reject an incoming snapshot that is provably older than one this
 * device has already observed — on either the pull or live-listener path.
 *
 * `knownLastWriteAtMillis` is the highest `lastWriteAt` this device has ever
 * actually observed coming back FROM the server (via a pull or a live
 * snapshot — never the optimistic pre-ack write, which is filtered out
 * upstream by subscribeUserData/`hasPendingWrites`). It is intentionally NOT
 * "this device's own last push time" — a device that has only ever pushed,
 * but never yet seen its own push's server-confirmed echo, has no observed
 * timestamp yet and must not reject anything (see the null-baseline case
 * below).
 *
 * Deliberately whole-doc, not per-field: this app's sync model is a single
 * merge-written doc (see pushUserData), so one `lastWriteAt` covering the
 * entire doc is the granularity that actually matches how writes land —
 * matching the same all-or-nothing shape `planRemoteDataMerge`'s `skipAll`
 * already uses for the same reason.
 *
 * Two cases are deliberately treated as "not stale" (never reject):
 *   - `remoteLastWriteAt` is missing/absent — an older doc that predates this
 *     field, or (in principle) a same-write race where the read arrives
 *     before the timestamp resolves. Same permissive "absent means don't
 *     drop it" fallback this file already uses per-field elsewhere (see
 *     `'x' in remoteData` checks in planRemoteDataMerge, and the legacy
 *     pinnedLinks->notes migration).
 *   - `knownLastWriteAtMillis` is null/undefined — this device has never yet
 *     observed a server-confirmed timestamp (first-ever pull/subscribe this
 *     session), so there is nothing to compare against and no basis to
 *     reject anything.
 *
 * Uses `<` (strictly older), not `<=`: a remote snapshot carrying the SAME
 * timestamp this device already knows about is this device's own echo
 * arriving back (or a duplicate delivery) — genuinely-equal timestamps are
 * not evidence of staleness, and isStaleOwnEcho/fingerprint-equality already
 * handle the echo case on their own terms.
 */
export function isRemoteWriteStale(remoteLastWriteAt, knownLastWriteAtMillis) {
  if (remoteLastWriteAt === undefined || remoteLastWriteAt === null) return false;
  if (knownLastWriteAtMillis === undefined || knownLastWriteAtMillis === null) return false;
  return toMillis(remoteLastWriteAt) < knownLastWriteAtMillis;
}

/**
 * Pure decision: given the `restoreLock` map read off the shared users/{uid}
 * doc (see firestoreSync.js's RestoreLock typedef), is a DIFFERENT device
 * currently, actively restoring a backup — i.e. should THIS device pause its
 * own pushes and stop merging incoming snapshots until the restore finishes
 * or the lock goes stale?
 *
 * False (not blocked) in every one of these cases:
 *   - No lock at all (an older doc, or nobody's ever restored).
 *   - `state !== 'restoring'` — the lock has already been released.
 *   - `deviceId === localDeviceId` — THIS device is the one holding the
 *     lock; a device never blocks on its own restore (its own restore
 *     sequence handles its own local pausing directly, see
 *     useCloudSync.js's acquireRestoreLock).
 *   - The lock's `heartbeatAt` is missing, or older than `staleMs` —
 *     `toMillis` (this file's own Firestore-Timestamp normalizer) returns 0
 *     for a missing/unparseable value, which always fails the freshness
 *     check below exactly like a genuinely ancient timestamp would, so a
 *     malformed lock is never trusted as active. A real stale heartbeat
 *     means the restoring device most likely crashed or closed its tab
 *     mid-restore, so this device gives up waiting and resumes ordinary
 *     syncing rather than staying wedged forever. Checked against `nowMs` on
 *     a periodic timer by the caller (a listener-only check would never
 *     re-evaluate once the restoring device stops sending snapshots at all,
 *     which is exactly the crash case this guards against).
 *
 * @param {import('../services/firestoreSync').RestoreLock|null|undefined} restoreLock
 * @param {string} localDeviceId
 * @param {number} nowMs
 * @param {number} [staleMs]
 * @returns {boolean}
 */
export function isRestoreLockActive(restoreLock, localDeviceId, nowMs, staleMs = RESTORE_LOCK_STALE_MS) {
  if (!restoreLock || restoreLock.state !== 'restoring') return false;
  if (restoreLock.deviceId === localDeviceId) return false;
  return nowMs - toMillis(restoreLock.heartbeatAt) < staleMs;
}

/**
 * Pure decision for the live listener: should THIS incoming snapshot be
 * dropped entirely rather than merged into local state?
 *
 * This exists because of a real bug (project deletes/shares reverting and
 * needing a second attempt to "stick"): `subscribeUserData` uses
 * `includeMetadataChanges: true`, so a device's OWN push delivers a second
 * snapshot once the server acknowledges it, in addition to the usual
 * "another device changed something" case — both look identical here. The
 * fingerprint-equality echo check right before this runs (`fingerprint ===
 * remoteFingerprint` in the caller) only catches that echo when local state
 * hasn't moved on since the push was sent. If the user made ANOTHER edit
 * (e.g. deleting a project) while that earlier push was still in flight,
 * local state no longer matches the pushed snapshot by the time its ack
 * arrives — so the equality check misses it, and without this guard the
 * stale, pre-edit snapshot gets applied on top of the newer edit, reverting
 * it. The edit only "sticks" on a second attempt because by then the ack has
 * already settled.
 *
 * A snapshot is stale exactly when its fingerprint matches one of THIS
 * device's still-in-flight pushes (`inFlightFingerprints` — every push sent
 * whose echo hasn't arrived yet, see `runPushNow`/`retireInFlightFingerprint`)
 * — i.e. it's provably an echo of a write we already know about, not new
 * information — while local state has since diverged from what was pushed (a
 * real local edit landed in the meantime, which the caller's own
 * fingerprint-equality check already establishes by the time this runs).
 * Nothing is lost by dropping it: the newer local edit hasn't been pushed
 * yet, so it'll reach Firestore on its own via the normal debounced push.
 *
 * A single `lastPushedFingerprint` value is NOT enough here: it's
 * overwritten on every push, so with two pushes in flight (an edit, then
 * another edit before the first one's ack lands) the FIRST push's echo
 * arrives carrying a fingerprint that's already been overwritten by the
 * second push. Checking against every still-unacknowledged push's
 * fingerprint (not just the latest) is what catches that case — see
 * `inFlightPushFingerprintsRef` at the call site.
 *
 * This can also correctly recognize an echo for a fingerprint the app has
 * since legitimately returned to (the user edits A -> B -> A): each push
 * gets its own entry in `inFlightFingerprints`, so the SECOND push of "A"
 * adds a fresh entry regardless of whether an older "A" entry is still
 * present — retiring one matching entry per echo (see
 * `retireInFlightFingerprint`) means a later genuine remote change that
 * happens to match a fingerprint no longer in the in-flight list (because
 * its echo already arrived and was retired) is never mistaken for a stale
 * echo.
 *
 * Deliberately independent of `isFirstSnapshot`/subscribe-time baselines —
 * an own-write echo can arrive as the first snapshot after (re)subscribe or
 * any later one; the ack is a property of THIS write, not of when the
 * listener happened to attach. Combined with `hasLocalEditRaced` at the
 * call site (which still matters for a genuinely different, newer snapshot
 * arriving concurrently with an in-flight local edit — see
 * `localEditLandedFirst` for the initial-pull-shaped case).
 */
export function isStaleOwnEcho(remoteFingerprint, inFlightFingerprints) {
  return Array.isArray(inFlightFingerprints) && inFlightFingerprints.includes(remoteFingerprint);
}

// Safety cap on how many in-flight push fingerprints are tracked at once.
// Note this is NOT a cap on concurrent WRITES — the single-flight guard (see
// computePushSingleFlightDecision) allows only one setDoc on the wire at a
// time, and BOTH write paths respect it: runPushNow coalesces behind it, and
// the manual pushToCloud waits for it. This list can still legitimately hold
// several entries,
// because a fingerprint is only retired when its server ECHO comes back
// through the live listener, which lands some time after the write itself
// resolved and the next push has already started. It exists purely so a
// pathological case (echoes never arriving, e.g. a permanently broken
// listener) can't grow this list forever; the oldest entry is dropped first,
// same "oldest first" policy as retireInFlightFingerprint's consumption order.
const MAX_IN_FLIGHT_FINGERPRINTS = 20;

// How the manual "Push to cloud" button waits out an already-in-flight push
// (see waitForPushWireToClear). A push is one setDoc, so the wait is normally
// zero or a single interval; the timeout only guards against a write that
// never settles at all.
const PUSH_WIRE_WAIT_POLL_MS = 50;
const PUSH_WIRE_WAIT_TIMEOUT_MS = 10000;

/**
 * Appends `fingerprint` to the in-flight queue (a push was just sent whose
 * echo hasn't arrived yet), trimming from the front if it would exceed
 * MAX_IN_FLIGHT_FINGERPRINTS. Pure — returns a new array, doesn't mutate.
 */
export function addInFlightFingerprint(inFlightFingerprints, fingerprint) {
  const next = [...(inFlightFingerprints || []), fingerprint];
  return next.length > MAX_IN_FLIGHT_FINGERPRINTS ? next.slice(next.length - MAX_IN_FLIGHT_FINGERPRINTS) : next;
}

/**
 * Removes exactly ONE occurrence of `fingerprint` from the in-flight queue —
 * the oldest one (first match, since the queue is oldest-first) — once its
 * echo has been recognized by isStaleOwnEcho. Removing only one entry (not
 * every matching one) is what keeps the A -> B -> A case correct: if "A" was
 * pushed twice (still in flight twice), consuming one echo leaves the other
 * entry so a second, later echo for the same fingerprint is still recognized
 * rather than silently falling through to "genuine remote change". Pure —
 * returns a new array, doesn't mutate.
 */
export function retireInFlightFingerprint(inFlightFingerprints, fingerprint) {
  const list = inFlightFingerprints || [];
  const index = list.indexOf(fingerprint);
  if (index === -1) return list;
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * Computes the optimistic-stamp/rollback fingerprint values schedulePush
 * needs, without performing the async Firestore write or mutating any ref.
 * Returns { shouldPush: false } when the fingerprint hasn't changed since the
 * last push (nothing to do). Otherwise returns the fingerprint to stamp
 * before the write, and the previous fingerprint to roll back to if it fails.
 */
export function computePushStampPlan(currentState, lastPushedFingerprint) {
  const fingerprint = computeFingerprint(currentState);
  if (fingerprint === lastPushedFingerprint) {
    return { shouldPush: false };
  }
  return { shouldPush: true, fingerprint, rollbackFingerprint: lastPushedFingerprint };
}

/**
 * Single-flight decision for runPushNow: given whether a push is already on
 * the wire, decide whether this call may proceed or must be coalesced into a
 * follow-up run after the current one finishes.
 *
 * Why this exists: schedulePush resets a debounce timer on every `state`
 * change, but several unrelated paths call runPushNow directly (the
 * immediate-completion path, and the visibilitychange/pagehide/beforeunload
 * flush). Nothing used to stop two of those from both reaching `pushUserData`
 * — a full-document setDoc — with neither awaiting the other. A burst of
 * commits in quick succession (a restore, then a rebalance, then a calendar
 * rewrite, each committing separately) could therefore stack many concurrent
 * full-document writes onto Firestore's write stream and trip its
 * "Write stream exhausted maximum allowed queued writes" error, after which
 * further writes fail until the stream recovers. MAX_IN_FLIGHT_FINGERPRINTS
 * being 20 is a fossil of that era: the echo bookkeeping was sized for up to
 * 20 simultaneous in-flight pushes because that many really were possible.
 *
 * Coalescing rather than dropping is the important part. A skipped push must
 * not be lost — the queued flag makes the in-flight push re-run exactly once
 * when it completes, and because runPushNow re-reads `stateRef.current` fresh
 * on entry, that single follow-up necessarily covers every change made while
 * the wire was busy, no matter how many callers were skipped. So N concurrent
 * callers collapse into at most 2 sequential writes rather than N parallel
 * ones, and the newest state still reaches Firestore.
 *
 * @param {boolean} pushInFlight - is a push currently awaiting its ack?
 * @returns {{ proceed: boolean, queue: boolean }} `proceed` to issue the write
 *   now; `queue` to mark that another run is owed once the current one settles.
 */
export function computePushSingleFlightDecision(pushInFlight) {
  if (pushInFlight) return { proceed: false, queue: true };
  return { proceed: true, queue: false };
}

/**
 * Pure merge-decision for applyRemoteData: given remote data, the current
 * local state (used as per-field fallback via pickValid), and whether the
 * race guard fired, returns a plan describing what to apply. A key is
 * present in the returned plan only when that field should be set (mirrors
 * the `'field' in remoteData` checks below) — the hook still performs the
 * actual setState calls/side effects, this just computes what they should be.
 *
 * `skipAll` (see the initial-pull/live-listener effects) means remoteData is
 * known to be stale relative to a local edit — either a genuinely newer
 * local commit landed while it was in flight, or (live listener only) it's
 * a delayed echo of this device's own earlier push that a newer local edit
 * has since superseded (see isStaleOwnEcho). Applying ANY field from it
 * would silently discard that newer edit — and unlike tasks/blocks (which at
 * least have an undo-stack action id to check), every other field here is
 * plain setState with no "is this local value newer" signal at all, so there
 * is no safe subset to apply. The plan is therefore empty and
 * `stampFingerprint` is false, so the next schedulePush still sees a real
 * change and pushes the newer local edit instead of assuming it's already
 * synced.
 *
 * (Prior to fixing a project-delete/share revert bug, this only gated
 * `tasks`/`blocks` — every other field applied unconditionally even when the
 * race guard had already fired, which is exactly what let a raced remote
 * snapshot stomp a just-deleted/just-shared project back into existence.)
 *
 * `authoritative` (see useCloudSync.js's restore-lock release handling) is
 * the opposite of `skipAll`: instead of applying nothing, it applies
 * EVERYTHING present in `remoteData` WHOLESALE, bypassing every per-item/
 * per-field merge and timestamp comparison entirely — remote simply wins,
 * for every field, unconditionally. This is what makes "the just-finished
 * restore is now the truth on every device" actually true: an ordinary merge
 * only ever compares timestamps, so an item this device holds that the
 * RESTORED backup doesn't contain (e.g. something created here after the
 * backup was taken, or a stale device's own leftover row) would otherwise
 * survive the union step forever — a restore is supposed to make every
 * device look exactly like the backup, including removing what the backup
 * doesn't have, and only a wholesale replace can do that without inventing
 * a whole separate tombstone-synthesis step for fields the backup payload
 * doesn't already track. Shape-validation (pickValid) still applies — a
 * corrupted/malformed field in `remoteData` still falls back to local rather
 * than crashing — but there is no merge/timestamp comparison of any kind. A
 * field ABSENT from `remoteData` is left out of the plan entirely, same as
 * the ordinary path, so an old/partial payload doesn't wipe a field it
 * simply never mentions.
 */
export function planRemoteDataMerge(remoteData, localState, { skipAll = false, authoritative = false } = {}) {
  if (skipAll) return { stampFingerprint: false };

  if (authoritative) {
    const plan = {};
    if ('tasks' in remoteData || 'blocks' in remoteData) {
      plan.tasksBlocks = {
        tasks: pickValid('tasks', remoteData.tasks, localState.tasks),
        blocks: pickValid('blocks', remoteData.blocks, localState.blocks),
      };
      // No merge ran — this IS the wholesale-replace path — so
      // didTaskMergeChangeAnything's "was this a real merge" gate correctly
      // treats it as false and skips the rebalance trigger. The restore's
      // OWN caller is responsible for triggering a rebalance once, after
      // every field has been applied — see useCloudSync.js's restore-lock
      // release handling.
      plan.tasksMerged = false;
    }
    ['sections', 'projects', 'labels', 'routines', 'rules', 'soundEnabled', 'soundVolume', 'animationsEnabled', 'savedViews', 'taskTemplates', 'trash', 'sharedProjectIds', 'events', 'fieldUpdatedAt'].forEach(
      (field) => {
        if (field in remoteData) plan[field] = pickValid(field, remoteData[field], localState[field]);
      }
    );
    // notificationSettings keeps this device's own timezone even in
    // authoritative mode — same reasoning as the ordinary path just below:
    // a restored/another-device's timezone is never what THIS device wants.
    if ('notificationSettings' in remoteData) {
      const notificationSettings = pickValid('notificationSettings', remoteData.notificationSettings, localState.notificationSettings);
      plan.notificationSettings = { ...notificationSettings, timezone: getBrowserTimeZone() };
    }
    // Same legacy-payload fallback as the ordinary path below (see its own
    // comment) — a pre-Notes-feature payload carries `pinnedLinks` instead
    // of `notes`.
    if ('notes' in remoteData) {
      plan.notes = pickValid('notes', remoteData.notes, localState.notes);
    } else if ('pinnedLinks' in remoteData) {
      const migrated = migrateLinksToNotes(remoteData.pinnedLinks);
      if (migrated) plan.notes = migrated;
    }
    if ('shortcutBindings' in remoteData) plan.shortcutBindings = pickValid('shortcutBindings', remoteData.shortcutBindings, localState.shortcutBindings);
    plan.stampFingerprint = true;
    return plan;
  }

  const plan = {};
  // Sidecar timestamps for the nine settings-shaped fields stamped by
  // useFieldStampedState (see that hook's doc comment in usePersistedState.js
  // for the full "why" — no per-row id to hang a timestamp on, so one ISO
  // string per FIELD instead). Built up field-by-field below, alongside each
  // field's own merge decision, then attached to the plan at the end.
  const localFieldStamps = localState.fieldUpdatedAt || {};
  const remoteFieldStamps = remoteData.fieldUpdatedAt || {};
  const nextFieldStamps = { ...localFieldStamps };

  /**
   * Decides one sidecar-stamped field's value using pickNewerScalar, and
   * records the winning side's timestamp into nextFieldStamps so the merged
   * doc keeps whichever stamp actually won — not just whichever field value
   * won, and not a blanket "now" (which would make an old, un-edited remote
   * value look freshly written and incorrectly beat a genuinely newer edit
   * made on a device that HASN'T synced this specific timestamp back yet).
   */
  function pickScalarField(field, remoteValue, localValue) {
    const decision = pickNewerScalar(localFieldStamps[field], remoteFieldStamps[field]);
    if (decision === 'remote' && remoteFieldStamps[field] !== undefined) {
      nextFieldStamps[field] = remoteFieldStamps[field];
    }
    return decision === 'remote' ? remoteValue : localValue;
  }

  if ('tasks' in remoteData || 'blocks' in remoteData) {
    // Shape-validate first: a malformed/corrupted remote `tasks` (wrong
    // type, not an array) still falls back to local WHOLESALE, exactly as
    // before — the per-task merge below only ever runs once remote is known
    // to be a real tasks array. `blocks` keeps its old whole-value
    // shape-validation-only behavior; ScheduledBlocks have no stable id
    // across a rebalance (ids are regenerated wholesale every run) and no
    // `updatedAt`, so per-block merge doesn't make sense — instead, whenever
    // the task merge below actually changes something, applyRemoteData
    // triggers a local rebalance that regenerates `blocks` fresh from the
    // merged tasks, superseding whatever's picked here as a throwaway value.
    const validRemoteTasks = pickValid('tasks', remoteData.tasks, null);
    const tasksMerged = validRemoteTasks !== null;
    plan.tasksBlocks = {
      tasks: tasksMerged ? mergeTasksByUpdatedAt(localState.tasks, validRemoteTasks) : localState.tasks,
      blocks: pickValid('blocks', remoteData.blocks, localState.blocks),
    };
    // Whether a real per-task merge ran (remote tasks were shape-valid), as
    // opposed to falling back to local wholesale — applyRemoteData needs
    // this to decide whether the merged result can safely be fingerprinted
    // against the raw incoming remoteData (see its own comment).
    plan.tasksMerged = tasksMerged;
  }
  // sections/projects/labels: per-entity merge by `updatedAt`, same
  // shape-validate-then-per-item-merge structure as `tasks` above — a
  // malformed/corrupted remote array falls back to local WHOLESALE, and only
  // a shape-valid remote array feeds mergeEntitiesByTimestamp
  // (utils/entityMerge.js). Each collection has stable per-row ids, so a
  // rename on one device and an unrelated add on another both survive
  // instead of one whole-array write clobbering the other — the same fix
  // tasks/events already have via mergeTasksByUpdatedAt/mergeEventsByUpdatedAt.
  // savedViews/taskTemplates/trash stay whole-array "remote wins if
  // shape-valid" for now — see CLAUDE.md's Backups section for why those
  // three are deferred.
  if ('sections' in remoteData) {
    const validRemoteSections = pickValid('sections', remoteData.sections, null);
    plan.sectionsMerged = validRemoteSections !== null;
    plan.sections = plan.sectionsMerged ? mergeEntitiesByTimestamp(localState.sections, validRemoteSections) : localState.sections;
  }
  if ('projects' in remoteData) {
    const validRemoteProjects = pickValid('projects', remoteData.projects, null);
    plan.projectsMerged = validRemoteProjects !== null;
    plan.projects = plan.projectsMerged ? mergeEntitiesByTimestamp(localState.projects, validRemoteProjects) : localState.projects;
  }
  if ('labels' in remoteData) {
    const validRemoteLabels = pickValid('labels', remoteData.labels, null);
    plan.labelsMerged = validRemoteLabels !== null;
    plan.labels = plan.labelsMerged ? mergeEntitiesByTimestamp(localState.labels, validRemoteLabels) : localState.labels;
  }
  // The nine fields below ARE sidecar-timestamped (see fieldUpdatedAt/
  // pickScalarField above) — each resolved by comparing the two devices'
  // OWN last-write timestamp for that specific field, not by which write
  // simply reached Firestore last.
  if ('routines' in remoteData) {
    plan.routines = pickScalarField('routines', pickValid('routines', remoteData.routines, localState.routines), localState.routines);
  }
  if ('rules' in remoteData) {
    plan.rules = pickScalarField('rules', pickValid('rules', remoteData.rules, localState.rules), localState.rules);
  }
  if ('soundEnabled' in remoteData) {
    plan.soundEnabled = pickScalarField(
      'soundEnabled',
      pickValid('soundEnabled', remoteData.soundEnabled, localState.soundEnabled),
      localState.soundEnabled
    );
  }
  if ('soundVolume' in remoteData) {
    plan.soundVolume = pickScalarField(
      'soundVolume',
      pickValid('soundVolume', remoteData.soundVolume, localState.soundVolume),
      localState.soundVolume
    );
  }
  if ('animationsEnabled' in remoteData) {
    plan.animationsEnabled = pickScalarField(
      'animationsEnabled',
      pickValid('animationsEnabled', remoteData.animationsEnabled, localState.animationsEnabled),
      localState.animationsEnabled
    );
  }
  // This device's own browser timezone always wins over whatever timezone
  // the remote doc carries (another device's, possibly stale) — applied
  // AFTER the timestamp-based pick below, same as before the sidecar existed,
  // since the timezone override isn't itself part of what's being timestamped.
  if ('notificationSettings' in remoteData) {
    const notificationSettings = pickScalarField(
      'notificationSettings',
      pickValid('notificationSettings', remoteData.notificationSettings, localState.notificationSettings),
      localState.notificationSettings
    );
    plan.notificationSettings = { ...notificationSettings, timezone: getBrowserTimeZone() };
  }
  if ('notes' in remoteData) {
    plan.notes = pickScalarField('notes', pickValid('notes', remoteData.notes, localState.notes), localState.notes);
  } else if ('pinnedLinks' in remoteData) {
    // legacy remote doc, see notesModel.js migration note
    const migrated = migrateLinksToNotes(remoteData.pinnedLinks);
    if (migrated) plan.notes = migrated;
  }
  if ('shortcutBindings' in remoteData) {
    plan.shortcutBindings = pickScalarField(
      'shortcutBindings',
      pickValid('shortcutBindings', remoteData.shortcutBindings, localState.shortcutBindings),
      localState.shortcutBindings
    );
  }
  if ('savedViews' in remoteData) {
    plan.savedViews = pickValid('savedViews', remoteData.savedViews, localState.savedViews);
  }
  if ('taskTemplates' in remoteData) {
    plan.taskTemplates = pickValid('taskTemplates', remoteData.taskTemplates, localState.taskTemplates);
  }
  if ('trash' in remoteData) {
    plan.trash = pickValid('trash', remoteData.trash, localState.trash);
  }
  if ('sharedProjectIds' in remoteData) {
    plan.sharedProjectIds = pickScalarField(
      'sharedProjectIds',
      pickValid('sharedProjectIds', remoteData.sharedProjectIds, localState.sharedProjectIds),
      localState.sharedProjectIds
    );
  }
  if ('events' in remoteData) {
    // Same shape-validate-then-per-item-merge structure as `tasks` above:
    // a malformed/corrupted remote `events` (wrong type, not an array) falls
    // back to local WHOLESALE, and only a shape-valid remote array feeds the
    // per-event merge. There's no `blocks`-equivalent companion field to
    // carry alongside it (a CalendarEvent is self-contained), and no
    // rebalance trigger is needed the way a task merge needs one to
    // regenerate `blocks` — events don't drive that scheduling engine.
    const validRemoteEvents = pickValid('events', remoteData.events, null);
    const eventsMerged = validRemoteEvents !== null;
    plan.events = eventsMerged ? mergeEventsByUpdatedAt(localState.events, validRemoteEvents) : localState.events;
    // Whether a real per-event merge ran, as opposed to falling back to local
    // wholesale — applyRemoteData needs this for the same reason
    // plan.tasksMerged exists: to decide whether the merged result can
    // safely be fingerprinted against the raw incoming remoteData.
    plan.eventsMerged = eventsMerged;
  }

  // Only attach the sidecar map if this doc actually carries one (or already
  // has local stamps to preserve) — an absent `fieldUpdatedAt` on both sides
  // (e.g. a doc from before this sidecar existed) should leave the plan
  // without the key entirely, same as every other optional field's `'x' in
  // remoteData` guard, rather than writing an empty object over nothing.
  if ('fieldUpdatedAt' in remoteData || Object.keys(localFieldStamps).length > 0) {
    plan.fieldUpdatedAt = nextFieldStamps;
    // The raw incoming value, kept alongside the merged result purely so
    // didFieldStampsMergeChangeAnything can tell "the merge just echoed
    // remote as-is" apart from "the merge kept at least one field local" —
    // see that function's own doc comment. Never applied to state itself.
    plan.remoteFieldUpdatedAt = remoteFieldStamps;
  }

  // Reaching here means skipAll was false, so remoteData was applied as-is —
  // safe to stamp "already synced" (the skipAll===true case returns early
  // above with stampFingerprint: false, before any field is applied).
  plan.stampFingerprint = true;

  return plan;
}

/**
 * Pure decision for applyRemoteData: did the per-task merge (plan.tasksMerged,
 * see planRemoteDataMerge's `tasks` handling) actually produce a task set that
 * differs from what was local a moment ago? Extracted so this narrow
 * before/after comparison is unit-testable without rendering the hook — same
 * precedent as this file's other pure decisions.
 *
 * Answers two questions the hook needs after applying a plan:
 *   1. Should a local rebalance run (so `blocks` regenerates fresh from the
 *      merged tasks, since blocks are never merged themselves)?
 *   2. Is it UNSAFE to fingerprint the applied result against the raw
 *      incoming `remoteData` (see applyRemoteData's own comment) — a real
 *      merge that changed anything produced a combined result that generally
 *      matches neither side's raw array exactly, so treating `remoteData` as
 *      "what's now in sync" would falsely suppress the push that's supposed
 *      to carry the merged result up to Firestore.
 *
 * Both questions share the same answer (`plan.tasksMerged && changed`), so
 * one function covers both call sites instead of duplicating the condition.
 *
 * A cheap JSON-equality check is enough here — this only gates a rebalance
 * trigger and a fingerprint-stamp skip, not correctness of the merge itself
 * (mergeTasksByUpdatedAt already guarantees that on its own).
 */
export function didTaskMergeChangeAnything(plan, localTasksBefore) {
  if (!plan.tasksMerged || !plan.tasksBlocks) return false;
  // canonicalStringify, not plain JSON.stringify — see that function's own
  // doc comment (computeFingerprint's neighbor above) for why: a merge that
  // reconstructs task objects via spreads can produce a different key order
  // than what was local before even when no field actually changed, and a
  // plain JSON.stringify comparison would misreport that as a real change.
  return canonicalStringify(plan.tasksBlocks.tasks) !== canonicalStringify(localTasksBefore);
}

/**
 * Same question as didTaskMergeChangeAnything, for the per-event merge
 * (plan.eventsMerged, see planRemoteDataMerge's `events` handling). Events
 * have no `blocks`-equivalent companion to regenerate, so this only answers
 * the fingerprint-stamp-skip question, not a rebalance-trigger one — but it's
 * kept as its own function (rather than reusing didTaskMergeChangeAnything
 * with different field names threaded through) so each stays a simple,
 * direct read of its own plan shape.
 */
export function didEventMergeChangeAnything(plan, localEventsBefore) {
  if (!plan.eventsMerged) return false;
  return canonicalStringify(plan.events) !== canonicalStringify(localEventsBefore);
}

/**
 * Same question as didTaskMergeChangeAnything/didEventMergeChangeAnything,
 * generalized for a per-entity-merged collection (sections/projects/labels
 * — see mergeEntitiesByTimestamp in planRemoteDataMerge). `field` is the
 * plan/localState key ('sections', 'projects', or 'labels'); `mergedFlag` is
 * the matching `plan.sectionsMerged`/`plan.projectsMerged`/`plan.labelsMerged`
 * key planRemoteDataMerge sets alongside it.
 */
export function didEntityMergeChangeAnything(plan, field, mergedFlag, localValueBefore) {
  if (!plan[mergedFlag]) return false;
  return canonicalStringify(plan[field]) !== canonicalStringify(localValueBefore);
}

/**
 * Same question as didTaskMergeChangeAnything/didEventMergeChangeAnything,
 * for the sidecar-timestamped settings fields (see fieldUpdatedAt/
 * pickScalarField in planRemoteDataMerge): did resolving them per-field by
 * timestamp produce a combined result that differs from remoteData's OWN
 * fieldUpdatedAt map? It will whenever pickScalarField kept even ONE field's
 * LOCAL value because this device's stamp for that field was newer — in
 * which case the merged plan is no longer identical to what's in Firestore,
 * and applyRemoteData must not fingerprint against raw remoteData (that
 * would falsely mark the still-newer local field as "already synced" and
 * permanently suppress the push that's supposed to carry it up) — same
 * reasoning as the task/event equivalents above, just for whole-value fields
 * instead of per-item arrays.
 */
export function didFieldStampsMergeChangeAnything(plan) {
  if (!('fieldUpdatedAt' in plan)) return false;
  return canonicalStringify(plan.fieldUpdatedAt) !== canonicalStringify(plan.remoteFieldUpdatedAt);
}

/**
 * @param {Object} deps
 * @param {Object} deps.state - Current combined syncable state (tasks/blocks/
 *   sections/projects/labels/routines/rules/soundEnabled/soundVolume/
 *   animationsEnabled/notificationSettings/notes/shortcutBindings/savedViews/
 *   taskTemplates/trash/sharedProjectIds/events) — a plain object recomputed
 *   whenever any of those fields changes, purely so the push-scheduling
 *   effect below has something to depend on. `events` joined this bundle
 *   once the per-event timestamp+tombstone merge (eventMerge.js/
 *   eventTombstones.js) made it safe to live-sync the same way `tasks`
 *   already does — see backupService.js's BACKUP_FIELDS doc comment for the
 *   history of why it used to be excluded.
 * @param {React.MutableRefObject} deps.stateRef - Ref mirroring `state`, read
 *   from async callbacks (the debounced push, backup builders) that need the
 *   LATEST snapshot rather than whatever was closed over when they were created.
 * @param {React.MutableRefObject} deps.currentActionIdRef - Ref mirroring
 *   useHistoryState's currentActionId, read by the initial-pull/live-listener
 *   effects below to detect a local commit landing during their async gap
 *   (see their own comments) — same "ref so an async callback sees the
 *   latest value" reasoning as stateRef.
 * @param {React.MutableRefObject} deps.localNonUndoEditIdRef - Counter bumped
 *   automatically by every field below going through SchedulerContext's
 *   useLocalEditTrackedState (see that hook's own doc comment) for local
 *   edits that never go through commit()/overwritePresent — checked
 *   alongside currentActionIdRef by hasAnyLocalEditRaced so those edits are
 *   race-guarded too. The setters this hook receives are deliberately the
 *   RAW/untracked ones (see that same doc comment) so this hook's OWN
 *   application of remote/backup data can never bump this ref itself.
 * @param {Function} deps.setNotification - Toast notification setter
 * @param {Function} deps.commit - useHistoryState's commit (tasks/blocks, undoable)
 * @param {Function} deps.overwritePresent - useHistoryState's overwritePresent
 *   (tasks/blocks, NOT undoable) — used for data arriving from elsewhere
 *   (initial pull, live listener) rather than from a local user action.
 * @param {Function} deps.setSections - RAW/untracked setter for sections
 *   (wrapped as setSectionsGuarded by the caller to also re-merge live shared
 *   sections — see SchedulerContext.jsx)
 * @param {Function} deps.setProjects - RAW/untracked setter for projects
 * @param {Function} deps.setLabels - RAW/untracked setter for labels
 * @param {Function} deps.setRoutines - RAW/untracked setter for routines
 * @param {Function} deps.setRules - RAW/untracked setter for rules
 * @param {Function} deps.setSoundEnabled - RAW/untracked setter for soundEnabled
 * @param {Function} deps.setSoundVolume - RAW/untracked setter for soundVolume
 * @param {Function} deps.setAnimationsEnabled - RAW/untracked setter for animationsEnabled
 * @param {Function} deps.setNotificationSettings - RAW/untracked setter for notificationSettings
 * @param {Function} deps.setNotes - RAW/untracked setter for notes
 * @param {Function} deps.setShortcutBindings - RAW/untracked setter for shortcutBindings
 * @param {Function} deps.setSavedViews - RAW/untracked setter for savedViews
 * @param {Function} deps.setTaskTemplates - RAW/untracked setter for taskTemplates
 * @param {Function} deps.setTrash - RAW/untracked setter for trash
 * @param {Function} deps.setSharedProjectIds - RAW/untracked setter for sharedProjectIds
 * @param {Function} deps.setEventsLive - RAW/untracked setter for the per-event
 *   merge result (see planRemoteDataMerge's `events` handling) — applies an
 *   incoming pull/live-snapshot's merged events the same way setSections/
 *   setProjects/etc. apply their own field, keeping `events` inside
 *   `state`/`stateRef` (see deps.state) rather than the separate backup-only
 *   path `events`/`setEvents` below still cover.
 * @param {*} deps.theme - Current theme (owned live by ThemeContext) — only
 *   read here so a backup payload can capture it (see BACKUP_FIELDS).
 * @param {Function} deps.setTheme - Applies a restored backup's theme.
 * @param {*} deps.accentSeed - Current custom accent seed color (owned live
 *   by ThemeContext, see themePresets.js) — rides the exact same path as
 *   `theme` immediately above: only read here so a backup payload can
 *   capture it, never part of the live-sync `state`/`stateRef` bundle.
 * @param {Function} deps.setAccentSeed - Applies a restored backup's accentSeed.
 * @param {Array} deps.events - Current CalendarEvents. Unlike `theme`, this
 *   IS also part of `state`/`stateRef` now (see deps.state) — it's still
 *   passed as its own param too, but now purely for the two call sites that
 *   need to read/replace it OUTSIDE the debounced live-sync path: the events-
 *   fallback-from-backup effect (reads current `events` directly, not through
 *   `stateRef`, so it can react to it going from empty to populated) and
 *   applyBackupPayload (restoring a backup uses the TRACKED setter below,
 *   same as every other backup-restored field, so it's undoable-adjacent the
 *   way the rest of a restore is).
 * @param {Function} deps.setEvents - Applies a restored backup's events (and
 *   the events-fallback-from-backup effect's own restore) — the TRACKED
 *   setter, matching how every other backup-restored field in this hook is
 *   applied via its own setX in applyBackupPayload.
 * @param {boolean} deps.googleConnected - Whether Google Calendar is
 *   currently connected — gates the events-fallback-from-backup effect (see
 *   its own doc comment) so it only fires when there's no live Google
 *   Calendar connection to repopulate `events` from instead.
 * @param {boolean} deps.googleSyncStale - Whether Google Calendar is
 *   nominally connected but its fetches have been failing (see
 *   useGoogleCalendarSync). Treated the same as "not connected" by the
 *   events-fallback-from-backup effect: either way there's no working live
 *   source to repopulate an empty `events` from. Also pushed (alongside
 *   googleConnected) to the shared Firestore doc's `googleCalendarStatus`
 *   field so other signed-in devices can notice a disagreement — see the
 *   dedicated effect below and detectGoogleCalendarStatusMismatch.
 * @param {Function} [deps.pullFromGoogleCalendar] - useGoogleCalendarSync's
 *   manual pull, called to self-heal THIS device when the cross-device
 *   status-mismatch check (below) finds another device reporting a working
 *   connection while this one is disconnected/stale.
 * @param {Function} deps.runRebalance - Triggers SchedulerContext's local
 *   rebalance/reschedule engine. Called by applyRemoteData after a per-task
 *   merge (see planRemoteDataMerge's `tasks` handling, mergeTasksByUpdatedAt)
 *   actually changes the task set, so `blocks` gets regenerated fresh from
 *   the merged tasks instead of staying a stale/incompatible mix of two
 *   devices' block arrays (blocks are never merged themselves — see
 *   planRemoteDataMerge's comment on why). Must be a STABLE callback (empty
 *   deps) since SchedulerContext.jsx defines the real rebalance function
 *   AFTER calling this hook — see that file's `runRebalanceRef`/
 *   `triggerRebalanceFromMerge` for the forward-reference wiring, matching
 *   the existing `queueDueDateRebalanceRef`/`triggerDueDateRebalance` pattern
 *   already used for the same "needed before it's defined" problem.
 * @returns {Object} Cloud sync state and callbacks
 */
export function useCloudSync({
  state,
  stateRef,
  currentActionIdRef,
  localNonUndoEditIdRef,
  setNotification,
  commit,
  overwritePresent,
  setSections,
  setProjects,
  setLabels,
  setRoutines,
  setRules,
  setSoundEnabled,
  setSoundVolume,
  setAnimationsEnabled,
  setNotificationSettings,
  setNotes,
  setShortcutBindings,
  setSavedViews,
  setTaskTemplates,
  setTrash,
  setSharedProjectIds,
  setEventsLive,
  setFieldUpdatedAt,
  theme,
  setTheme,
  accentSeed,
  setAccentSeed,
  events,
  setEvents,
  // TRACKED counterparts of the RAW setters above, used ONLY by
  // applyBackupPayload (see that function's own comment on why a restore
  // needs the tracked setter and applyRemoteData does not). Passing both the
  // raw and tracked variant for the same piece of state looks redundant, but
  // the two call sites inside this hook have genuinely opposite
  // requirements: applyRemoteData applying an incoming pull/listener
  // snapshot must NOT look like a local edit (see setSections/etc. above),
  // while applyBackupPayload applying a user-initiated restore MUST look
  // like one, so the race-guard/push machinery treats the restored content
  // as the newest thing that happened rather than invisible background
  // bookkeeping.
  setSectionsTracked,
  setProjectsTracked,
  setLabelsTracked,
  setRoutinesTracked,
  setRulesTracked,
  setSoundEnabledTracked,
  setSoundVolumeTracked,
  setAnimationsEnabledTracked,
  setNotificationSettingsTracked,
  setNotesTracked,
  setShortcutBindingsTracked,
  setSavedViewsTracked,
  setTaskTemplatesTracked,
  setTrashTracked,
  setSharedProjectIdsTracked,
  setEventsTracked,
  googleConnected,
  googleSyncStale,
  pullFromGoogleCalendar,
  seedConfirmedGoogleEventIds,
  runRebalance,
}) {
  // ANONYMOUS VISITORS ARE DELIBERATELY NOT A SYNC ACCOUNT.
  //
  // Collaborative Projects (Phase 2) signs a share-link visitor in via Firebase
  // Anonymous Auth so the security rules have a stable uid to authorize their
  // writes against (see firestore.rules' sharedProjects block). That makes
  // `useAuth().user` non-null for someone who never signed in — and every gate
  // in this hook was written as a bare `if (!user)`, which such a visitor
  // passes. Left alone, opening a share link would:
  //
  //   - start pushing that browser's local tasks up to `users/{anonUid}`,
  //     creating a junk document per visitor out of data they never chose to
  //     sync (and, on a shared/public machine, exposing it to whoever clicks
  //     the link next in that same browser profile);
  //   - pull/merge any such document back on the next visit, mixing a stranger's
  //     leftovers into the local workspace;
  //   - run automatic daily cloud BACKUPS for an identity that vanishes the
  //     moment storage is cleared.
  //
  // None of that is what an anonymous joiner asked for: their session exists to
  // participate in ONE shared project, whose data lives in `sharedProjects/{id}`
  // and syncs through useSharedProjectSync (which correctly wants the anonymous
  // user and is unaffected by this). Personal cross-device sync is a
  // real-account feature — an anonymous uid has no second device to sync to.
  //
  // Nulling `user` here, at the single point it enters this hook, rather than
  // auditing ~15 downstream `if (!user)` gates: they all then behave exactly as
  // they do for a signed-out visitor, which is precisely the intended behavior
  // and can't be reintroduced by a future edit adding a new ungated call site.
  const { user: authUser } = useAuth();
  const user = authUser?.isAnonymous ? null : authUser;
  // Defaults to true (rather than requiring an opt-in toggle) so a signed-in
  // user keeps getting the always-on sync this app has always had — nothing
  // in Settings currently surfaces toggleCloudSync as an explicit on/off
  // switch, so defaulting it off would silently stop syncing for everyone.
  const [cloudSynced, setCloudSynced] = usePersistedState('cloudSynced', true);
  const [isPullingCloud, setIsPullingCloud] = useState(false);
  const [isPushingCloud, setIsPushingCloud] = useState(false);
  const [cloudBackups, setCloudBackups] = useState([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  // When the last automatic backup ran (epoch ms), persisted so it survives a
  // reload — see the automatic-backup effect below.
  const [lastAutoBackupAt, setLastAutoBackupAt] = usePersistedState('lastAutoBackupAt', null);

  // Mirrors the latest `runRebalance` prop for applyRemoteData's closure to
  // read — `runRebalance` (passed in as the STABLE `triggerRebalanceFromMerge`
  // wrapper from SchedulerContext.jsx, see this hook's own JSDoc above) never
  // actually changes identity across renders, but mirroring it via a ref (the
  // same "ref kept in sync via its own tiny effect" pattern already used for
  // googleConnectedRef/etc. below) means applyRemoteData doesn't need
  // `runRebalance` in its own dependency array at all.
  const runRebalanceTriggerRef = useRef(runRebalance);
  useEffect(() => {
    runRebalanceTriggerRef.current = runRebalance;
  }, [runRebalance]);

  // This browser's stable id (see utils/deviceIdentity.js) — computed once
  // via useRef's lazy initializer, not useState, since nothing here ever
  // needs to re-render on it changing (it never does after mount).  Used
  // only to tell "this device's own googleCalendarStatus write echoing back"
  // apart from "a different device's write" in the live listener below.
  const deviceIdRef = useRef(null);
  if (deviceIdRef.current === null) deviceIdRef.current = getDeviceId();

  // ---- Restore lock (see firestoreSync.js's RestoreLock typedef) -----------
  // Full lifecycle: acquireAndRunRestoreLock (this device restoring) below;
  // the live-listener effect further down (this device noticing ANOTHER
  // device's lock and blocking) reads/writes the refs/state here.
  //
  // Latest restoreLock object this device has actually seen come back from
  // Firestore — a ref (not state) because it's read by a plain setInterval
  // callback (the staleness re-check) that must always see the CURRENT
  // value, not whatever was closed over when the interval was first set up.
  const restoreLockRef = useRef(null);
  // The generation this device has already converged on (wholesale-applied,
  // see the release-handling branch below) — starts 0 so the very first
  // release this device ever sees (generation >= 1, since acquire always
  // bumps by at least 1) is treated as new.
  const lastAppliedRestoreLockGenerationRef = useRef(0);
  // Cheap boolean another device's lock being active reduces to, read
  // synchronously by runPushNow/schedulePush on every call — recomputed
  // whenever restoreLockRef changes or the staleness timer ticks, rather
  // than calling isRestoreLockActive(restoreLockRef.current, ...) at every
  // call site (which would also need `Date.now()` threaded through).
  const isBlockedByOtherRestoreRef = useRef(false);
  // User-facing overlay state — TWO independent booleans, not one, because
  // "this device is restoring" and "this device is blocked by ANOTHER
  // device's restore" are different situations with different copy (see
  // BlockingProgressOverlay) and must never be conflated: a device can only
  // ever be in one of the two at a time (a device holding the lock is
  // exempt from its own block, see isRestoreLockActive), but they are still
  // tracked separately for clarity at the call site.
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [isBlockedByRestore, setIsBlockedByRestore] = useState(false);

  // Last mismatch kind (see detectGoogleCalendarStatusMismatch) already
  // warned about, so the live listener below only notifies on an actual
  // state TRANSITION rather than re-warning on every snapshot while the
  // mismatch persists (a status doc can re-deliver identical data many times
  // — same "warn once, not per-event" shape as this file's other dedup refs).
  // Reset to null once the mismatch resolves so a LATER, new mismatch is
  // still caught.
  const lastWarnedGoogleStatusMismatchRef = useRef(null);

  // Mirrors of the latest googleConnected/googleSyncStale/pullFromGoogleCalendar
  // for the live-listener effect's closure to read — that effect only
  // re-subscribes on [user, cloudSynced] (resubscribing the whole onSnapshot
  // listener every time Google's connection flickers would be wasteful and
  // risks dropping the "first snapshot" race-guard logic mid-flicker), so it
  // needs a way to see current values without those being in its dep array.
  // Same "ref mirror kept in sync via its own tiny effect" pattern already
  // used elsewhere in this file/useGoogleCalendarSync.js for the same reason.
  const googleConnectedRef = useRef(googleConnected);
  const googleSyncStaleRef = useRef(googleSyncStale);
  const pullFromGoogleCalendarRef = useRef(pullFromGoogleCalendar);
  useEffect(() => {
    googleConnectedRef.current = googleConnected;
    googleSyncStaleRef.current = googleSyncStale;
    pullFromGoogleCalendarRef.current = pullFromGoogleCalendar;
  }, [googleConnected, googleSyncStale, pullFromGoogleCalendar]);

  const pushTimerRef = useRef(null);
  // Seeded from localStorage (not hardcoded null) so a push that Firestore
  // actually confirmed in a PREVIOUS session is still known about after a
  // full reload/tab-kill — see the 'lastPushedFingerprint' persistence below
  // for why this in-memory ref alone isn't enough. Only ever written to
  // localStorage once a push is server-confirmed (never optimistically), so
  // a persisted value is always a real, known-good baseline, not a guess.
  const lastPushedFingerprintRef = useRef(loadPersisted('lastPushedFingerprint', null));
  // Highest doc-level `lastWriteAt` (millis) this device has actually
  // observed coming BACK from the server — via a pull's getDoc, or a live
  // snapshot (subscribeUserData already filters out the optimistic
  // pre-ack event, so every delivery here is server-confirmed). Starts null
  // ("nothing observed yet") so the very first pull/snapshot of a session is
  // never treated as stale — see isRemoteWriteStale's doc comment. Updated
  // unconditionally on every observed snapshot (even one whose data body is
  // otherwise skipped as a stale/echo/raced write) since it's a "what does
  // the server currently know" bookkeeping signal, not tied to whether this
  // particular snapshot's fields were applied.
  const lastKnownWriteAtMillisRef = useRef(null);
  // Widens lastKnownWriteAtMillisRef to `remoteLastWriteAt` if it's newer
  // than (or nothing was recorded yet) what's already known — shared by
  // every call site that observes a server-confirmed snapshot (initial pull,
  // live listener, and the explicit toggleCloudSync/pullFromCloud actions),
  // so the "highest timestamp seen so far" bookkeeping stays one rule
  // instead of copy-pasted at each site. No-ops for a missing/absent
  // timestamp (older doc, see isRemoteWriteStale's doc comment).
  const recordObservedWriteAt = useCallback((remoteLastWriteAt) => {
    if (remoteLastWriteAt == null) return;
    const millis = toMillis(remoteLastWriteAt);
    if (lastKnownWriteAtMillisRef.current == null || millis > lastKnownWriteAtMillisRef.current) {
      lastKnownWriteAtMillisRef.current = millis;
    }
  }, []);
  // Fingerprints of every push sent whose server ack (echo) hasn't arrived
  // yet — see isStaleOwnEcho's doc comment for why lastPushedFingerprintRef
  // alone (overwritten on every push) isn't enough once two pushes can be in
  // flight at once. Entries are added in runPushNow and retired in the live
  // listener once their echo is recognized.
  const inFlightPushFingerprintsRef = useRef([]);
  // The tasks array as of the previous schedulePush call, so a newly-completed
  // task can be spotted and pushed without the debounce (see schedulePush).
  const lastSeenTasksRef = useRef(null);
  const unsubscribeRef = useRef(null);
  // Mirrors lastAutoBackupAt so the periodic check (a setInterval callback
  // captured once per mount, see the automatic-backup effect) always reads
  // the latest value instead of whatever was current when it was created —
  // same reasoning as stateRef elsewhere in this file. Updated directly
  // (not just via the setLastAutoBackupAt state setter) the moment a backup
  // succeeds, so a same-session re-check can't race a stale render.
  const lastAutoBackupAtRef = useRef(lastAutoBackupAt);
  const autoBackupInFlightRef = useRef(false);

  // Single-flight guard for runPushNow — see computePushSingleFlightDecision
  // for the full reasoning. `pushInFlightRef` is true from just before
  // pushUserData is awaited until it settles; `pushQueuedRef` records that at
  // least one further push was requested while it was busy, so exactly one
  // follow-up run happens afterward (against freshly-read state) instead of
  // that request being dropped.
  const pushInFlightRef = useRef(false);
  const pushQueuedRef = useRef(false);
  // runPushNow re-invokes itself for the queued follow-up, which a plain
  // useCallback can't reference from inside its own body — this ref holds the
  // latest instance so the finally block can call it.
  const runPushNowRef = useRef(null);

  // Waits until no push is on the wire, for the one caller that can't simply
  // coalesce itself away: the manual "Push to cloud" button (see pushToCloud).
  // runPushNow's callers are all background/automatic, so being folded into
  // another run is invisible and correct for them; a user-clicked push instead
  // has to actually happen, because it reports its own result. Polling a ref
  // rather than awaiting a shared promise keeps this to a few lines and needs
  // no extra bookkeeping on the hot path — the wait is normally zero or one
  // interval, since a push is a single setDoc.
  //
  // The cap exists so a push that somehow never settles can't leave the button
  // hanging forever; hitting it rejects, and pushToCloud deliberately proceeds
  // anyway (a possible overlap is a better outcome for an explicit user action
  // than silently doing nothing).
  const waitForPushWireToClear = useCallback(
    () =>
      new Promise((resolve, reject) => {
        if (!pushInFlightRef.current) {
          resolve();
          return;
        }
        const startedAt = Date.now();
        const handle = setInterval(() => {
          if (!pushInFlightRef.current) {
            clearInterval(handle);
            resolve();
          } else if (Date.now() - startedAt >= PUSH_WIRE_WAIT_TIMEOUT_MS) {
            clearInterval(handle);
            reject(new Error('Timed out waiting for the in-flight cloud push to finish'));
          }
        }, PUSH_WIRE_WAIT_POLL_MS);
      }),
    []
  );

  // ---- Debounced push to Firestore -----------------------------------------
  // The fingerprint stamp/rollback decision itself lives in the pure,
  // exported computePushStampPlan — this just performs the actual write and
  // ref mutation around it.
  const runPushNow = useCallback(async () => {
    if (!user) return;
    // Another device is actively restoring a backup — this device's own
    // edits during that window are deliberately DISCARDED, not merely
    // delayed (see the listener's own comment on why the armed debounce
    // timer is cleared, not left to fire later): the whole point of the
    // lock is that the restore becomes the truth on every device once it
    // finishes, so queuing this device's pre-restore edits to push right
    // after would just re-introduce the very staleness the lock exists to
    // prevent. `pushQueuedRef` is deliberately NOT set here (unlike the
    // ordinary single-flight-busy case below) for the same reason.
    if (isBlockedByOtherRestoreRef.current) return;
    // Never let two full-document setDocs be on the wire at once — see
    // computePushSingleFlightDecision. Checked before the fingerprint compare
    // deliberately: the in-flight push has already optimistically stamped
    // lastPushedFingerprintRef, so a concurrent caller could otherwise read
    // "no change" and return without arranging for the newer state to be
    // pushed at all.
    const { proceed, queue } = computePushSingleFlightDecision(pushInFlightRef.current);
    if (!proceed) {
      if (queue) pushQueuedRef.current = true;
      return;
    }
    const currentState = stateRef.current;
    const plan = computePushStampPlan(currentState, lastPushedFingerprintRef.current);
    if (!plan.shouldPush) return; // no change
    pushInFlightRef.current = true;
    setIsPushingCloud(true);
    try {
      // Stamp the ref before the write resolves, not after — otherwise a
      // local change made while this push is in flight can race the live
      // listener below, which would mistake the server echo for a genuine
      // remote change and stomp whatever just changed locally.
      lastPushedFingerprintRef.current = plan.fingerprint;
      // Record this push as in-flight BEFORE awaiting the write, so the live
      // listener's echo check (isStaleOwnEcho) can recognize its ack no
      // matter how many other pushes are ALSO in flight at the same time —
      // see isStaleOwnEcho's doc comment for why a single overwritten ref
      // isn't enough.
      inFlightPushFingerprintsRef.current = addInFlightFingerprint(inFlightPushFingerprintsRef.current, plan.fingerprint);
      await pushUserData(user.uid, currentState);
      // Only persist to localStorage once Firestore has actually confirmed
      // this write (i.e. after the await, never before) — this is the
      // durable record that survives a tab kill/reload, unlike the in-memory
      // ref above which is stamped optimistically for the in-session race
      // guard. If the tab dies before this line runs, the persisted value
      // stays at whatever the last CONFIRMED push was, so next launch
      // correctly detects "current local state doesn't match my last known
      // good push" and retries via computePushStampPlan — instead of
      // silently treating this edit as already synced forever.
      savePersisted('lastPushedFingerprint', plan.fingerprint);
    } catch (err) {
      console.warn('[useCloudSync] Push failed', err);
      // Roll back the optimistic stamp — otherwise this fingerprint looks
      // "already pushed" even though the write never landed, so if the
      // user makes no further edit, every future schedulePush sees "no
      // change" and this edit is silently dropped from Firestore forever.
      // Restoring the previous value means the very next state change
      // (including one identical to this failed push) will retry it.
      lastPushedFingerprintRef.current = plan.rollbackFingerprint;
      // A failed write never reaches Firestore, so no echo will ever arrive
      // for it — retire it immediately rather than leaving a phantom entry
      // that could otherwise (implausibly, but not impossibly) match some
      // unrelated later snapshot and cause it to be dropped.
      inFlightPushFingerprintsRef.current = retireInFlightFingerprint(inFlightPushFingerprintsRef.current, plan.fingerprint);
      setNotification({ type: 'error', message: 'Failed to sync to the cloud. Your changes are saved locally and will retry on your next edit.' });
    } finally {
      setIsPushingCloud(false);
      // Release the wire, then run exactly once more if anything was
      // requested while this push was busy. The follow-up re-reads
      // stateRef.current fresh, so one run covers every skipped caller's
      // changes — and if nothing actually changed, its own
      // computePushStampPlan check makes it a no-op rather than a wasted
      // write. Deliberately fire-and-forget: awaiting it here would make this
      // push's promise cover an arbitrary chain of follow-ups, which the
      // tab-close flush path (which can't wait anyway) has no use for.
      pushInFlightRef.current = false;
      if (pushQueuedRef.current) {
        pushQueuedRef.current = false;
        runPushNowRef.current?.();
      }
    }
  }, [user, stateRef, setNotification]);
  runPushNowRef.current = runPushNow;

  // Push completions straight away instead of waiting out the debounce — see
  // hasNewCompletion for why this one edit type earns the exception.
  //
  // `nextTasks` is passed in by the caller rather than read from
  // stateRef.current: that ref is populated by an effect in SchedulerContext,
  // and this runs from an effect too, so reading it here would make
  // correctness depend on effect ordering between the two. The push effect
  // already has `state` as a dependency, so it can just hand over the value
  // it's reacting to.
  //
  // The comparison baseline is the tasks array as of the last scheduling
  // decision, not the last successful push: a failed push leaves
  // lastPushedFingerprint rolled back but shouldn't make the NEXT unrelated
  // edit re-detect the same completion and skip its debounce again.
  //
  // Every OTHER edit still debounces, but only for CLOUD_SYNC_EDIT_DEBOUNCE_MS
  // (200ms) — a deliberate reduction from the 1.5s this used to wait (see
  // that constant's own doc comment in dataRetention.js): a background tab
  // can have its JS execution suspended/throttled shortly after being hidden,
  // and a debounce timer that's still pending when that happens never fires
  // at all — the flush-on-hide effect below is a best-effort catch for that,
  // but per its own doc comment, none of its three events can GUARANTEE an
  // in-flight write survives teardown either. Shrinking the debounce doesn't
  // close that gap (nothing at the browser-API level fully can, short of a
  // sendBeacon-style write path this app doesn't have), but it drastically
  // shrinks how often a real edit is actually sitting in that vulnerable
  // window when the user switches away — 200ms is far too short to
  // realistically catch a deliberate tab switch, while still coalescing a
  // handful of genuinely-simultaneous edits into one write. This does NOT
  // increase Firestore write volume or risk overloading it: the single-flight
  // guard (computePushSingleFlightDecision) still allows only one setDoc on
  // the wire at a time regardless of how often schedulePush is called, and a
  // fingerprint is only ever added to inFlightPushFingerprintsRef when a write
  // actually starts (see runPushNow) — a call that gets coalesced behind an
  // in-flight push never touches that list at all. A shorter debounce only
  // changes how soon the FIRST push in a burst starts, not how many pushes
  // happen overall.
  const schedulePush = useCallback(
    (nextTasks) => {
      const immediate = hasNewCompletion(lastSeenTasksRef.current, nextTasks);
      lastSeenTasksRef.current = nextTasks;

      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      if (immediate) {
        pushTimerRef.current = null;
        runPushNow();
        return;
      }
      pushTimerRef.current = setTimeout(runPushNow, CLOUD_SYNC_EDIT_DEBOUNCE_MS);
    },
    [runPushNow]
  );

  // Flush a pending debounced push immediately when the tab is about to go
  // away (backgrounded or closed) instead of waiting out the full
  // CLOUD_SYNC_EDIT_DEBOUNCE_MS. Without this, an edit made and then quickly followed by
  // switching tabs/closing the browser can lose the write entirely — the
  // debounce timer never fires. Completions no longer depend on this path at
  // all (schedulePush pushes them immediately, see hasNewCompletion), which
  // matters because none of the three events below can actually guarantee an
  // in-flight write completes; this remains a best-effort net for every OTHER
  // edit type, where a late sync is the only cost. Three events are
  // listened for since no single one is reliable everywhere: `visibilitychange`
  // catches backgrounding/tab-close on iOS Safari (which doesn't reliably fire
  // beforeunload/pagehide's async continuation), `pagehide` catches back/
  // forward-cache navigation, and `beforeunload` catches desktop tab/window
  // close cases the other two occasionally miss. None of these guarantee the
  // write lands before teardown (the fetch can still be aborted mid-flight) —
  // this narrows the race, it doesn't close it.
  //
  // KNOWN, DELIBERATELY ACCEPTED LIMITATION (investigated and confirmed via a
  // live multi-device repro): closing a tab/window within seconds of an edit
  // can still occasionally lose that edit, because the underlying Firestore
  // SDK write is an ordinary network request with no guarantee of surviving
  // page teardown once it's already in flight. The one browser mechanism that
  // DOES guarantee delivery through teardown is `navigator.sendBeacon`/
  // `fetch(..., {keepalive: true})` — but neither is usable with the
  // Firestore SDK's own authenticated writes; closing this gap for real would
  // mean bypassing the SDK and hand-encoding Firestore's REST wire format for
  // a parallel write path used only at teardown. Deliberately not built: the
  // added complexity/maintenance cost wasn't judged worth it for how narrow
  // the window already is after the fixes in this file (a 200ms debounce
  // instead of 1.5s, and completions bypassing the debounce entirely). If
  // this becomes a recurring complaint, that REST+keepalive fallback is the
  // correct next step, not another tweak to the timing here.
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;
    // Goes through runPushNow's single-flight guard like every other caller:
    // if a push is already on the wire when the tab is going away, this
    // doesn't issue a second concurrent write — it sets the queued flag, and
    // the in-flight push runs one final follow-up when it settles. That
    // follow-up may well not finish before the tab is actually torn down,
    // which is an inherent limit of this path (see the note below: none of
    // these three events can guarantee an in-flight write completes) — it
    // narrows the race rather than closing it, and matters little now that
    // completions bypass the debounce entirely.
    const flush = () => {
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
        runPushNow();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [user, cloudSynced, runPushNow]);

  // ---- Apply remote data (from Firestore snapshot or an initial pull) ------
  // Mirrors applyBackupPayload below field-for-field, but routes tasks/blocks
  // through overwritePresent (NOT commit) since this data came from
  // elsewhere, not a local user action — it shouldn't be undoable, and
  // shouldn't consume a redo slot. A field missing from `remoteData` (an
  // older/partial doc) leaves that field untouched rather than wiping it.
  //
  // `skipAll` (set by the initial-pull/live-listener effects below, see
  // their own comments and planRemoteDataMerge's doc comment) means
  // remoteData is known to be stale relative to a local edit — nothing in it
  // is applied, since none of these fields carry a per-field "is this newer"
  // signal to fall back on the way tasks/blocks at least have an action id
  // for.
  const applyRemoteData = useCallback((remoteData, { skipAll = false, authoritative = false } = {}) => {
    const localTasksBefore = stateRef.current.tasks;
    const localEventsBefore = stateRef.current.events;
    // Captured for the same reason localTasksBefore/localEventsBefore are —
    // didEntityMergeChangeAnything needs "what was local a moment ago" to
    // tell a real content-changing per-entity merge apart from one that
    // resolved to exactly what was already there.
    const localSectionsBefore = stateRef.current.sections;
    const localProjectsBefore = stateRef.current.projects;
    const localLabelsBefore = stateRef.current.labels;
    const plan = planRemoteDataMerge(remoteData, stateRef.current, { skipAll, authoritative });
    if (plan.tasksBlocks) overwritePresent(plan.tasksBlocks);
    if ('sections' in plan) setSections(plan.sections);
    if ('projects' in plan) setProjects(plan.projects);
    if ('labels' in plan) setLabels(plan.labels);
    if ('routines' in plan) setRoutines(plan.routines);
    if ('rules' in plan) setRules(plan.rules);
    if ('soundEnabled' in plan) setSoundEnabled(plan.soundEnabled);
    if ('soundVolume' in plan) setSoundVolume(plan.soundVolume);
    if ('animationsEnabled' in plan) setAnimationsEnabled(plan.animationsEnabled);
    if ('notificationSettings' in plan) setNotificationSettings(plan.notificationSettings);
    if ('notes' in plan) setNotes(plan.notes);
    if ('shortcutBindings' in plan) {
      setShortcutBindings(plan.shortcutBindings);
      // Also write localStorage directly (not just React state) so the hot
      // keydown listener (see useKeyboardShortcuts.js) picks up an incoming
      // remote binding immediately, not just on this device's next local rebind.
      savePersisted('shortcutBindings', plan.shortcutBindings);
    }
    if ('savedViews' in plan) setSavedViews(plan.savedViews);
    if ('taskTemplates' in plan) setTaskTemplates(plan.taskTemplates);
    if ('trash' in plan) setTrash(plan.trash);
    if ('sharedProjectIds' in plan) setSharedProjectIds(plan.sharedProjectIds);
    if ('events' in plan) setEventsLive(plan.events);
    if ('fieldUpdatedAt' in plan) setFieldUpdatedAt(plan.fieldUpdatedAt);

    // Did the per-task merge actually produce a task set different from what
    // was local a moment ago? See didTaskMergeChangeAnything's own doc
    // comment — this one answer gates both the rebalance trigger and the
    // fingerprint-stamp skip below.
    const mergeChangedTasks = didTaskMergeChangeAnything(plan, localTasksBefore);
    // Same question for the per-event merge — see didEventMergeChangeAnything's
    // own doc comment. No rebalance trigger needed for events (nothing
    // downstream regenerates from them the way `blocks` regenerates from
    // tasks), so this only feeds the fingerprint-stamp-skip decision below.
    const mergeChangedEvents = didEventMergeChangeAnything(plan, localEventsBefore);
    // Same question for the sidecar-timestamped settings fields — see
    // didFieldStampsMergeChangeAnything's own doc comment.
    const mergeChangedFieldStamps = didFieldStampsMergeChangeAnything(plan);
    // Same question for each per-entity-merged collection — see
    // didEntityMergeChangeAnything's own doc comment.
    const mergeChangedSections = didEntityMergeChangeAnything(plan, 'sections', 'sectionsMerged', localSectionsBefore);
    const mergeChangedProjects = didEntityMergeChangeAnything(plan, 'projects', 'projectsMerged', localProjectsBefore);
    const mergeChangedLabels = didEntityMergeChangeAnything(plan, 'labels', 'labelsMerged', localLabelsBefore);

    // A real per-task merge that changed anything produced a combined result
    // that generally matches NEITHER side's raw array exactly — blocks are
    // never merged themselves (see planRemoteDataMerge's comment), so
    // `blocks` needs to regenerate fresh from the merged tasks rather than
    // staying whatever throwaway value planRemoteDataMerge picked for it.
    // This sits AFTER skipAll/plan computation, so it only ever runs when
    // applyRemoteData would have applied the merge anyway — it doesn't
    // bypass or duplicate the isStaleOwnEcho/hasLocalEditRaced/
    // isRemoteWriteStale race guards upstream of this call, it just
    // piggybacks on their decision.
    if (mergeChangedTasks) {
      runRebalanceTriggerRef.current();
    }

    // Stamp what we just applied as "already synced" so the debounced push
    // effect doesn't immediately echo this same data straight back to
    // Firestore — but only when tasks/blocks were actually applied as-is
    // (see planRemoteDataMerge's stampFingerprint comment) AND neither the
    // tasks nor the events branch just produced a genuinely NEW combined
    // result via their own per-item merge. Fingerprinting against raw
    // `remoteData` in that case would falsely mark the merged-but-not-yet-
    // pushed result as "Firestore already has this" — permanently
    // suppressing the push that's supposed to carry it up. Skipping the
    // stamp here is deliberately simpler than fingerprinting the as-applied
    // plan instead: the normal debounced push effect already watches
    // `state`/`stateRef` and will notice this local change like any other
    // edit and push it up on its own, no special-casing needed here.
    if (
      plan.stampFingerprint &&
      !mergeChangedTasks &&
      !mergeChangedEvents &&
      !mergeChangedFieldStamps &&
      !mergeChangedSections &&
      !mergeChangedProjects &&
      !mergeChangedLabels
    ) {
      const remoteFingerprint = computeFingerprint(remoteData);
      lastPushedFingerprintRef.current = remoteFingerprint;
      // This data just came FROM Firestore (a pull or a confirmed live
      // snapshot), so it's just as much a known-good "Firestore has this"
      // baseline as a successful push — persist it the same way, otherwise
      // a tab kill shortly after an incoming remote update would leave the
      // persisted value stale relative to what Firestore (and now this
      // device) actually has, and the next launch would wrongly think a
      // push is needed for data that's already in sync.
      savePersisted('lastPushedFingerprint', remoteFingerprint);
    }
  }, [
    overwritePresent,
    stateRef,
    setSections,
    setProjects,
    setLabels,
    setRoutines,
    setRules,
    setSoundEnabled,
    setSoundVolume,
    setAnimationsEnabled,
    setNotificationSettings,
    setNotes,
    setShortcutBindings,
    setSavedViews,
    setTaskTemplates,
    setTrash,
    setSharedProjectIds,
    setEventsLive,
  ]);

  // ---- Applies a full backup payload (local file or cloud backup) ----------
  // Same field set as applyRemoteData, but tasks/blocks go through commit()
  // (undoable, matching clearAllData's precedent) and this also restores
  // `theme`, which live sync deliberately leaves to ThemeContext.
  //
  // Two things make a restore different from applyRemoteData's "apply
  // whatever arrived" job, both fixing the same real bug (restoring a backup
  // felt instant, but a second device's older data would silently undo it
  // the next time that device synced):
  //
  //   1. Every restored task/event gets a FRESH timestamp (see
  //      restampBackupTasks/restampBackupEvents's own comment for the full
  //      "why") instead of keeping whatever old timestamp the backup was
  //      taken with. Only actually-incoming tasks/events are re-stamped —
  //      e.g. a payload with `blocks` but no `tasks` key falls back to
  //      whatever tasks are ALREADY local (see pickValid), which were never
  //      part of the restore and must keep their real, already-correct
  //      timestamps rather than being bumped as if they too had just changed.
  //   2. Every setter below is the TRACKED variant, not the raw one
  //      applyRemoteData uses — so the sync engine's race-guard machinery
  //      (see useLocalEditTrackedState's doc comment) sees this restore as a
  //      genuine local edit, the same as if the user had just typed
  //      something. Without that, a pull or live snapshot landing around the
  //      same moment as a restore would have no way to know a local change
  //      just happened, and could let stale remote data win the race before
  //      the restored content even gets pushed.
  //   `commit` (tasks/blocks) is already the tracked path — useHistoryState's
  //   commit() bumps `currentActionId` on every call — so only the timestamp
  //   re-stamp is needed there; every OTHER field needed the setter swap too.
  //
  // `payload.fieldUpdatedAt` (the sidecar timestamps for the nine settings-
  // shaped fields — see useFieldStampedState) is DELIBERATELY never read
  // here, even though it's a BACKUP_FIELDS entry. Every field below that's
  // sidecar-stamped is applied through its TRACKED setter (setRulesTracked,
  // etc.), and SchedulerContext wires those through useFieldStampedState —
  // so calling one already stamps "now" for that field automatically, the
  // same restamp-on-restore behavior restampBackupTasks/restampBackupEvents
  // give tasks/events explicitly. Applying the BACKUP's old fieldUpdatedAt
  // value instead would defeat that: a stale timestamp from when the backup
  // was taken could then lose to a genuinely older edit another device made
  // AFTER the backup but BEFORE the restore, silently un-doing the restore
  // for that field — exactly the bug this whole restamp-on-restore design
  // exists to prevent.
  const applyBackupPayload = useCallback((payload) => {
    const nowIso = new Date().toISOString();
    // NOTE: there is deliberately no `'fieldUpdatedAt' in payload` branch
    // here — see this function's own doc comment just above its declaration
    // for the full reasoning. Every sidecar-stamped field below already
    // restamps itself via its tracked setter.
    if ('tasks' in payload || 'blocks' in payload) {
      const nextTasks = 'tasks' in payload
        ? restampBackupTasks(pickValid('tasks', payload.tasks, stateRef.current.tasks), nowIso)
        : stateRef.current.tasks;
      commit(
        {
          tasks: nextTasks,
          blocks: pickValid('blocks', payload.blocks, stateRef.current.blocks),
        },
        'Restored from backup'
      );
    }
    if ('sections' in payload) setSectionsTracked(pickValid('sections', payload.sections, stateRef.current.sections));
    if ('projects' in payload) setProjectsTracked(pickValid('projects', payload.projects, stateRef.current.projects));
    if ('labels' in payload) setLabelsTracked(pickValid('labels', payload.labels, stateRef.current.labels));
    if ('routines' in payload) setRoutinesTracked(pickValid('routines', payload.routines, stateRef.current.routines));
    if ('rules' in payload) setRulesTracked(pickValid('rules', payload.rules, stateRef.current.rules));
    // Absent on a backup taken before `events` joined BACKUP_FIELDS — left
    // untouched in that case, same as any other field missing from an
    // older/partial payload (see isValidBackupPayload's doc comment).
    if ('events' in payload) {
      setEventsTracked(restampBackupEvents(pickValid('events', payload.events, events), nowIso));
    }
    if ('soundEnabled' in payload) {
      setSoundEnabledTracked(pickValid('soundEnabled', payload.soundEnabled, stateRef.current.soundEnabled));
    }
    if ('soundVolume' in payload) {
      setSoundVolumeTracked(pickValid('soundVolume', payload.soundVolume, stateRef.current.soundVolume));
    }
    if ('animationsEnabled' in payload) {
      setAnimationsEnabledTracked(pickValid('animationsEnabled', payload.animationsEnabled, stateRef.current.animationsEnabled));
    }
    if ('notificationSettings' in payload) {
      const notificationSettings = pickValid('notificationSettings', payload.notificationSettings, stateRef.current.notificationSettings);
      setNotificationSettingsTracked({ ...notificationSettings, timezone: getBrowserTimeZone() });
    }
    if ('theme' in payload) setTheme(pickValid('theme', payload.theme, theme));
    // Absent on a backup taken before `accentSeed` joined BACKUP_FIELDS —
    // left untouched in that case, same reasoning as `events` above.
    // `null` is a legitimate value (means "use the shipped default"), so
    // pickValid's own FIELD_TYPES check must accept it — see backupService.js.
    if ('accentSeed' in payload) setAccentSeed(pickValid('accentSeed', payload.accentSeed, accentSeed));
    if ('notes' in payload) setNotesTracked(pickValid('notes', payload.notes, stateRef.current.notes));
    else if ('pinnedLinks' in payload) {
      // legacy backup file, see notesModel.js migration note
      const migrated = migrateLinksToNotes(payload.pinnedLinks);
      if (migrated) setNotesTracked(migrated);
    }
    if ('shortcutBindings' in payload) {
      const shortcutBindings = pickValid('shortcutBindings', payload.shortcutBindings, stateRef.current.shortcutBindings);
      setShortcutBindingsTracked(shortcutBindings);
      savePersisted('shortcutBindings', shortcutBindings);
    }
    if ('savedViews' in payload) {
      setSavedViewsTracked(pickValid('savedViews', payload.savedViews, stateRef.current.savedViews));
    }
    if ('taskTemplates' in payload) {
      setTaskTemplatesTracked(pickValid('taskTemplates', payload.taskTemplates, stateRef.current.taskTemplates));
    }
    if ('trash' in payload) {
      setTrashTracked(pickValid('trash', payload.trash, stateRef.current.trash));
    }
    if ('sharedProjectIds' in payload) {
      setSharedProjectIdsTracked(pickValid('sharedProjectIds', payload.sharedProjectIds, stateRef.current.sharedProjectIds));
    }
  }, [
    commit,
    stateRef,
    setSectionsTracked,
    setProjectsTracked,
    setLabelsTracked,
    setRoutinesTracked,
    setRulesTracked,
    setSoundEnabledTracked,
    setSoundVolumeTracked,
    setAnimationsEnabledTracked,
    setNotificationSettingsTracked,
    setTheme,
    theme,
    setAccentSeed,
    accentSeed,
    setNotesTracked,
    setShortcutBindingsTracked,
    setSavedViewsTracked,
    setTaskTemplatesTracked,
    setTrashTracked,
    setSharedProjectIdsTracked,
    events,
    setEventsTracked,
  ]);

  // ---- Push this device's Google Calendar connection health -----------------
  // Whenever THIS device's own googleConnected/googleSyncStale changes,
  // merge-write a small `googleCalendarStatus` presence field (deviceId,
  // connected, stale) onto the shared per-user doc — see
  // firestoreSync.js's pushGoogleCalendarStatus for why this is safe to add
  // to that doc without touching the fields computeFingerprint/
  // planRemoteDataMerge/applyRemoteData reconcile (tasks/blocks/settings):
  // it's a new, isolated field those functions never look at.
  //
  // Best-effort: a failed write here just means another device won't see
  // this one's latest status until the next successful write (e.g. next
  // connect/disconnect, or the next time googleSyncStale flips) — nothing
  // else depends on it succeeding, so it's logged and otherwise ignored
  // rather than surfaced as a user-facing error.
  useEffect(() => {
    if (!user || !cloudSynced) return;
    if (typeof googleConnected !== 'boolean') return; // useGoogleCalendarSync not wired up (e.g. no Google client configured)
    pushGoogleCalendarStatus(user.uid, deviceIdRef.current, googleConnected, Boolean(googleSyncStale)).catch((err) => {
      console.warn('[useCloudSync] Failed to push Google Calendar status', err);
    });
  }, [user, cloudSynced, googleConnected, googleSyncStale]);

  // ---- Subscribe to Firestore on mount (when user is available) ------------
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;

    // Baseline local action as of the moment this listener (re)subscribes —
    // used below for the FIRST delivered snapshot only, mirroring the
    // initial-pull effect: that's the one snapshot that can race a local
    // edit made in the real-world gap between mount (localStorage-seeded UI
    // renders immediately) and the first delivery.
    const actionIdAtSubscribe = currentActionIdRef.current;
    const nonUndoEditIdAtSubscribe = localNonUndoEditIdRef.current;
    let receivedFirstSnapshot = false;
    const unsubscribe = subscribeUserData(user.uid, (remoteData) => {
      if (!remoteData) return;

      // Record the highest server-confirmed `lastWriteAt` this device has
      // seen, unconditionally and before any of the checks below — this is
      // "what does the server currently know" bookkeeping, independent of
      // whether THIS particular snapshot's data body ends up applied,
      // skipped as a race, or recognized as our own echo. Every path through
      // this callback has now observed a real, current server timestamp
      // (subscribeUserData already filtered out the pre-ack optimistic
      // event), so every path should widen the freshness baseline.
      recordObservedWriteAt(remoteData.lastWriteAt);

      // Restore lock (see firestoreSync.js's RestoreLock typedef) —
      // deliberately BEFORE the fingerprint-equality early return just
      // below, for the same reason the Google Calendar status check is:
      // `restoreLock` is excluded from computeFingerprint on purpose (a lock
      // acquire/release must never look like a data change to the merge
      // logic), so a snapshot where the lock is the ONLY thing that changed
      // would otherwise be skipped entirely, and this device would never
      // learn the restore started (or finished).
      restoreLockRef.current = remoteData.restoreLock || null;
      const lockActiveNow = isRestoreLockActive(restoreLockRef.current, deviceIdRef.current, Date.now());
      isBlockedByOtherRestoreRef.current = lockActiveNow;
      setIsBlockedByRestore(lockActiveNow);
      if (lockActiveNow) {
        // Another device just started (or is still) restoring — drop
        // anything of THIS device's own already sitting in the debounce
        // timer (an edit made moments before the lock arrived) rather than
        // letting it fire once the timer elapses. Per the intended design,
        // a device blocked by another's restore discards its own pending
        // edits for the duration rather than queuing them — see
        // runPushNow's own check for why simply blocking new pushes isn't
        // enough on its own.
        if (pushTimerRef.current) {
          clearTimeout(pushTimerRef.current);
          pushTimerRef.current = null;
        }
      } else {
        // Lock absent, released, or gone stale. If it's a RELEASE this
        // device hasn't converged on yet (a higher generation than the last
        // one it wholesale-applied), pull the finished restore and apply it
        // AUTHORITATIVELY — not merge it — so this device ends up byte-
        // identical to what the restoring device just finished, including
        // removing anything local the backup didn't contain. See
        // planRemoteDataMerge's own doc comment on why only a wholesale
        // apply can do that.
        const lock = restoreLockRef.current;
        const isUnconvergedRelease =
          lock &&
          lock.state === 'released' &&
          lock.deviceId !== deviceIdRef.current &&
          (lock.generation || 0) > lastAppliedRestoreLockGenerationRef.current;
        if (isUnconvergedRelease) {
          lastAppliedRestoreLockGenerationRef.current = lock.generation;
          pullUserData(user.uid)
            .then((freshRemoteData) => {
              if (!freshRemoteData) return;
              recordObservedWriteAt(freshRemoteData.lastWriteAt);
              applyRemoteData(freshRemoteData, { authoritative: true });
              runRebalanceTriggerRef.current();
              // Only when the restoring device's release says a Google
              // rewrite ran as PART of this restore (see firestoreSync.js's
              // RestoreLock typedef) — the googleEventIds in
              // freshRemoteData.events were just confirmed live against
              // Google by that rewrite's own batch insert, a real completed
              // round-trip, not merely a claim carried forward from whenever
              // the backup was taken. Seeding them here is what stops THIS
              // device's own next poll from treating their absence (it
              // hasn't pulled yet) as "Google deleted these" and re-pushing
              // duplicates — see seedConfirmedGoogleEventIds' own doc
              // comment (useGoogleCalendarSync.js) for why this is the ONE
              // situation where seeding from Firestore rather than a live
              // pull of this device's own is actually safe.
              if (lock.rewroteGoogleCalendar) {
                seedConfirmedGoogleEventIds?.(
                  (freshRemoteData.events || []).map((e) => e.googleEventId).filter(Boolean)
                );
              }
            })
            .catch((err) => console.warn('[useCloudSync] Failed to pull restore-lock release', err));
          return; // handled via the authoritative pull above, not the ordinary merge path below
        }
      }

      // Cross-device Google Calendar status check — deliberately BEFORE the
      // fingerprint-equality early return just below, since that fingerprint
      // covers only tasks/blocks/settings and would otherwise skip this
      // check entirely on a snapshot where `googleCalendarStatus` is the
      // ONLY thing that changed (exactly the case this exists to catch).
      // Isolated from the merge-decision logic beneath it — this only ever
      // reads `remoteData.googleCalendarStatus` and this device's own
      // googleConnected/googleSyncStale, never anything applyRemoteData
      // touches.
      const mismatch = detectGoogleCalendarStatusMismatch({
        remoteStatus: remoteData.googleCalendarStatus,
        localDeviceId: deviceIdRef.current,
        localConnected: googleConnectedRef.current,
        localSyncStale: googleSyncStaleRef.current,
      });
      if (mismatch !== lastWarnedGoogleStatusMismatchRef.current) {
        lastWarnedGoogleStatusMismatchRef.current = mismatch;
        if (mismatch === 'thisDeviceBehind') {
          setNotification({
            type: 'warning',
            message: "Google Calendar is out of sync between your devices — another device is connected, but this one isn't. Retrying now...",
          });
          // Self-heal: kick off this device's own pull rather than just
          // nagging. pullFromGoogleCalendar already no-ops safely if a
          // fetch is already in flight (googleFetchInFlightRef) or if
          // googleConnected is false (nothing to pull with yet — the
          // periodic/mount retry ladder is what recovers that case).
          pullFromGoogleCalendarRef.current?.();
        } else if (mismatch === 'otherDeviceBehind') {
          setNotification({
            type: 'warning',
            message: 'Google Calendar is out of sync between your devices — this one is fine, but another device last reported a problem.',
          });
        }
      }

      const fingerprint = computeFingerprint(stateRef.current);
      const remoteFingerprint = computeFingerprint(remoteData);
      if (fingerprint === remoteFingerprint) return; // echo of our own push, local state unchanged since
      const isFirstSnapshot = !receivedFirstSnapshot;
      receivedFirstSnapshot = true;
      // Two independent ways this snapshot can be stale, checked on EVERY
      // delivery (not just the first):
      //   - It's a delayed server ack of THIS device's own earlier push, and
      //     a local edit landed after that push was sent but before the ack
      //     arrived — see isStaleOwnEcho's doc comment for why the plain
      //     fingerprint-equality check above misses this case.
      //   - (First snapshot only, mirroring the initial-pull effect) a local
      //     commit landed in the gap between subscribing and the first
      //     snapshot actually arriving.
      const isStaleEcho = isStaleOwnEcho(remoteFingerprint, inFlightPushFingerprintsRef.current);
      if (isStaleEcho) {
        // This echo has now been accounted for — retire exactly one matching
        // entry so a LATER, genuinely different remote change that happens
        // to reuse the same fingerprint (e.g. the user edits A -> B -> A,
        // re-pushing "A") isn't mistaken for a leftover stale echo forever.
        inFlightPushFingerprintsRef.current = retireInFlightFingerprint(inFlightPushFingerprintsRef.current, remoteFingerprint);
      }
      const localEditLandedFirst =
        isFirstSnapshot &&
        hasAnyLocalEditRaced(
          { actionId: actionIdAtSubscribe, nonUndoEditId: nonUndoEditIdAtSubscribe },
          { actionId: currentActionIdRef.current, nonUndoEditId: localNonUndoEditIdRef.current }
        );
      // Cross-device staleness gate (see isRemoteWriteStale's doc comment) —
      // a DIFFERENT device's write that is provably older than one this
      // device already observed (e.g. a phone that just woke up, pushing a
      // debounced write queued hours ago). Independent of, and checked
      // alongside, the own-echo/own-race checks above: those two are about
      // THIS device's own in-flight pushes, this one is about another
      // device's write arriving out of order.
      const isCrossDeviceStale = isRemoteWriteStale(remoteData.lastWriteAt, lastKnownWriteAtMillisRef.current);
      applyRemoteData(remoteData, { skipAll: isStaleEcho || localEditLandedFirst || isCrossDeviceStale });
    });
    unsubscribeRef.current = unsubscribe;
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced]);

  // ---- Shared one-shot pull-and-apply, used by both the mount-time initial
  // pull and the visibility/focus refresh below (see that effect's comment
  // for why a second trigger for the same pull exists). Factored out so both
  // call sites run IDENTICAL logic rather than two copies drifting apart —
  // same "extract the shared step into one named function" pattern this file
  // already follows for recordObservedWriteAt/isRemoteWriteStale/etc.
  //
  // Baseline local action as of the moment this pull starts — if a genuinely
  // new local commit lands (e.g. the user edits a task, deletes or shares a
  // project) before this Firestore round-trip resolves, the fetched snapshot
  // is stale relative to that edit. Applying ANY of it via overwritePresent/
  // setState would silently discard the newer local edit, so the whole plan
  // is skipped in that case (see applyRemoteData's skipAll) — the debounced
  // push effect already fires on any state change, so the newer local edit
  // still reaches Firestore on its own; nothing is lost either way.
  //
  // Every caller passes its OWN `cancelled` getter/setter pair (a per-effect
  // closure variable) so each effect's cleanup can independently mark its own
  // in-flight call moot without the two effects' cancellation states
  // interfering with each other.
  const pullAndApplyRemoteData = useCallback(
    async (isCancelled) => {
      const actionIdAtStart = currentActionIdRef.current;
      const nonUndoEditIdAtStart = localNonUndoEditIdRef.current;
      setIsPullingCloud(true);
      try {
        const remoteData = await pullUserData(user.uid);
        if (!isCancelled() && remoteData) {
          // Record the server-confirmed `lastWriteAt` this pull observed —
          // same bookkeeping as the live listener, done BEFORE the staleness
          // check inside isRemoteWriteStale (called via applyRemoteData's
          // skipAll below) so this pull's own timestamp never gates itself.
          recordObservedWriteAt(remoteData.lastWriteAt);
          const localEditLandedDuringPull = hasAnyLocalEditRaced(
            { actionId: actionIdAtStart, nonUndoEditId: nonUndoEditIdAtStart },
            { actionId: currentActionIdRef.current, nonUndoEditId: localNonUndoEditIdRef.current }
          );
          applyRemoteData(remoteData, { skipAll: localEditLandedDuringPull });
        }
      } catch (err) {
        console.warn('[useCloudSync] Pull failed', err);
      } finally {
        if (!isCancelled()) setIsPullingCloud(false);
      }
    },
    [user, recordObservedWriteAt, currentActionIdRef, localNonUndoEditIdRef, applyRemoteData]
  );

  // ---- Initial pull on mount (when user is available) ----------------------
  useEffect(() => {
    if (!user || !cloudSynced) return;
    let cancelled = false;
    pullAndApplyRemoteData(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced]);

  // ---- Visibility/focus refresh (personal cross-device sync only) ----------
  // Fixes a real gap: the live onSnapshot listener above and the mount-time
  // pull are both keyed only on [user, cloudSynced], so neither re-runs when
  // this tab/app comes back to the foreground after being backgrounded for a
  // long time. A phone browser tab backgrounded for hours can have its
  // Firestore realtime connection go stale/suspended by the OS — e.g. edit on
  // a laptop, close it, then much later switch to an already-open phone tab:
  // without this, the phone never learns about the laptop's changes until it
  // reloads. Mirrors useGoogleCalendarSync.js's own visibility/focus refresh
  // effect (same pattern: visibilitychange + focus, throttled via a
  // last-fired ref) so the two "came back to the foreground" paths behave
  // consistently.
  //
  // Deliberately just an extra trigger for the SAME pullAndApplyRemoteData
  // used on mount — not a new sync path, and does not touch the live
  // onSnapshot listener's subscribe/unsubscribe lifecycle at all (that
  // listener's own race guards — isStaleOwnEcho/isFirstSnapshot bookkeeping —
  // are untouched by this effect).
  //
  // ALSO listens for `pageshow` (mirroring useGoogleCalendarSync.js's own
  // identical addition) — neither `visibilitychange` nor `focus` is
  // guaranteed to fire at all for an iOS "Add to Home Screen" standalone PWA
  // returning from the background (a WebKit limitation every iOS browser
  // inherits regardless of engine skin), which left THIS refresh — the one
  // that actually matters for personal task/schedule sync — silently
  // unreachable on that platform even after the Google Calendar hook got the
  // same fix. `pageshow` is the one event iOS reliably fires both on a fresh
  // launch and when restoring a suspended page from the back/forward cache.
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;

    let cancelled = false;
    const lastVisibilityPullAtRef = { current: 0 };
    const refreshIfDue = () => {
      const now = Date.now();
      if (!shouldTriggerVisibilityRefresh(lastVisibilityPullAtRef.current || null, now)) return;
      lastVisibilityPullAtRef.current = now;
      pullAndApplyRemoteData(() => cancelled);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      refreshIfDue();
    };
    const onFocus = () => refreshIfDue();
    const onPageshow = () => refreshIfDue();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageshow);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageshow);
    };
  }, [user, cloudSynced, pullAndApplyRemoteData]);

  // ---- Fallback: restore events from the latest backup if there's nothing
  // to show and no WORKING live Google Calendar source to repopulate them ---
  // `events` now DOES live-sync across devices (see computeFingerprint/
  // planRemoteDataMerge's `events` handling above), so in the ordinary case
  // this fallback never has anything left to do — the initial pull/live
  // listener already repopulates `events` on its own. It still earns its
  // keep for genuinely last-resort cases the live sync itself can't cover:
  // cloud sync toggled off, a first-ever pull that hasn't landed yet, or
  // (unchanged from before) a device with no working live Google Calendar
  // connection that also somehow has an empty local+remote `events`. Google
  // Calendar is still the normal day-to-day authoritative store when
  // connected, and `useGoogleCalendarSync`'s own silent reconnect repopulates
  // `events` from Google on every mount/refresh — this only covers the gap
  // that leaves. That's two situations, not one — Google not connected at
  // all (a new device, or wiped localStorage), AND Google nominally
  // connected but its fetches failing after exhausting their retries
  // (`googleSyncStale` — a cold start where auth wasn't ready yet, or a
  // network hiccup). Both leave `events` equally empty.
  //
  // Restoring ONLY the `events` field (not a full backup restore) keeps this
  // narrow — tasks/blocks/settings already come back via the live sync
  // above. Fires only when local `events` is genuinely empty, so it can
  // never clobber (or resurrect a deleted event out of) whatever the user
  // already has locally — same reasoning that keeps `events` out of the
  // continuously-reconciled live-sync path in the first place. Deliberately
  // no "non-empty but looks stale" heuristic: any timestamp/count comparison
  // there would be guesswork against a store this app isn't authoritative for.
  useEffect(() => {
    if (!user || !cloudSynced) return;
    if (!shouldRestoreEventsFromBackup({ events, googleConnected, googleSyncStale })) return;

    let cancelled = false;
    (async () => {
      try {
        const backups = await listBackups(user.uid);
        const latest = backups[0];
        if (!latest || cancelled) return;
        const payload = await getBackup(user.uid, latest.id);
        if (cancelled || !payload || !('events' in payload)) return;
        const restoredEvents = pickValid('events', payload.events, []);
        if (restoredEvents.length > 0) {
          setEvents(restoredEvents);
          setNotification({ type: 'info', message: 'Restored your calendar events from your latest backup.' });
        }
      } catch (err) {
        console.warn('[useCloudSync] Events fallback-from-backup failed', err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced, googleConnected, googleSyncStale]);

  // ---- Schedule push whenever state changes --------------------------------
  useEffect(() => {
    if (!user || !cloudSynced) return;
    schedulePush(state.tasks);
  }, [state, user, cloudSynced, schedulePush]);

  // ---- Toggle cloud sync ---------------------------------------------------
  const toggleCloudSync = useCallback(async () => {
    if (!user) {
      setNotification({ type: 'info', message: 'Sign in to enable cloud sync.' });
      return;
    }
    const next = !cloudSynced;
    setCloudSynced(next);
    if (next) {
      setIsPullingCloud(true);
      try {
        const remoteData = await pullUserData(user.uid);
        if (remoteData) {
          // Explicit, user-initiated "enable cloud sync" always applies
          // whatever's remote — deliberately no skipAll/staleness gate here,
          // same as pullFromCloud below (an explicit "pull now" action isn't
          // subject to the background race guards that protect an automatic
          // pull/listener from silently stomping a newer local edit). Still
          // records the observed timestamp so the background listener's
          // freshness baseline reflects it.
          recordObservedWriteAt(remoteData.lastWriteAt);
          applyRemoteData(remoteData);
        }
        setNotification({ type: 'success', message: 'Cloud sync enabled.' });
      } catch (err) {
        console.error(err);
        setNotification({ type: 'error', message: 'Failed to pull cloud data.' });
      } finally {
        setIsPullingCloud(false);
      }
    } else {
      setNotification({ type: 'info', message: 'Cloud sync disabled.' });
    }
  }, [user, cloudSynced, setCloudSynced, setNotification, applyRemoteData]);

  // ---- Manual pull from cloud ----------------------------------------------
  const pullFromCloud = useCallback(async () => {
    if (!user) return;
    setIsPullingCloud(true);
    try {
      const remoteData = await pullUserData(user.uid);
      if (remoteData) {
        // Same deliberate no-gate/record-only treatment as toggleCloudSync above.
        recordObservedWriteAt(remoteData.lastWriteAt);
        applyRemoteData(remoteData);
        setNotification({ type: 'success', message: 'Pulled latest data from cloud.' });
      } else {
        setNotification({ type: 'info', message: 'No cloud data found.' });
      }
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Pull from cloud failed.' });
    } finally {
      setIsPullingCloud(false);
    }
  }, [user, setNotification, applyRemoteData]);

  // ---- Manual push to cloud ------------------------------------------------
  // Shares runPushNow's single-flight guard, not just its echo bookkeeping.
  // The two used to differ: this function did the fingerprint/in-flight-echo
  // half but wrote via pushUserData directly, without ever consulting
  // pushInFlightRef — so clicking "Push to cloud" while the debounced
  // auto-push was already on the wire put two full-document setDocs on the
  // same doc concurrently, exactly the pattern computePushSingleFlightDecision
  // exists to prevent ("Write stream exhausted maximum allowed queued
  // writes"). That overlap is not hypothetical: any edit arms the debounce
  // timer, and the user can click the button before it fires or while its
  // write is still in flight.
  //
  // Unlike runPushNow, a skipped write can't just be coalesced away here —
  // this one is a user-visible action that owes an honest toast, and
  // reporting "Pushed data to cloud" for a write that never happened would be
  // a lie. So instead of dropping the call, it waits for the wire to clear and
  // then performs its own write against freshly-read state.
  const pushToCloud = useCallback(async () => {
    if (!user) return;
    setIsPushingCloud(true);
    try {
      await waitForPushWireToClear();
    } catch {
      // Wire never cleared within the cap — fall through and write anyway
      // rather than silently doing nothing for an explicit user action.
    }
    // Claim the wire for this write, so a debounced push starting mid-flight
    // coalesces behind it instead of racing it.
    pushInFlightRef.current = true;
    // Same in-flight bookkeeping as runPushNow (see isStaleOwnEcho's doc
    // comment) — this button can just as easily overlap a debounced push (or
    // another manual push) while the write is in flight, so its echo needs
    // to be recognizable too. Read AFTER the wait above, so it fingerprints
    // the state actually being written rather than a pre-wait snapshot.
    const fingerprint = computeFingerprint(stateRef.current);
    inFlightPushFingerprintsRef.current = addInFlightFingerprint(inFlightPushFingerprintsRef.current, fingerprint);
    try {
      await pushUserData(user.uid, stateRef.current);
      lastPushedFingerprintRef.current = fingerprint;
      // Confirmed by the server (after the await) — persist it, same as
      // runPushNow's debounced push, so this manual push also survives a
      // tab kill/reload as a known-good baseline.
      savePersisted('lastPushedFingerprint', fingerprint);
      setNotification({ type: 'success', message: 'Pushed data to cloud.' });
    } catch (err) {
      console.error(err);
      inFlightPushFingerprintsRef.current = retireInFlightFingerprint(inFlightPushFingerprintsRef.current, fingerprint);
      setNotification({ type: 'error', message: 'Push to cloud failed.' });
    } finally {
      setIsPushingCloud(false);
      // Release the wire and honour anything that queued behind this write,
      // exactly as runPushNow's own finally block does — otherwise a
      // debounced push that coalesced while this one held the wire would be
      // dropped instead of run.
      pushInFlightRef.current = false;
      if (pushQueuedRef.current) {
        pushQueuedRef.current = false;
        runPushNowRef.current?.();
      }
    }
  }, [user, stateRef, setNotification, computeFingerprint, waitForPushWireToClear]);

  // ---- Restore lock: the writer-side sequence ------------------------------
  // Wraps applyBackupPayload with the full "make this restore authoritative
  // on every device" sequence — see firestoreSync.js's RestoreLock typedef
  // for the full design. Every restore entry point (importBackup,
  // restoreCloudBackup, below) calls THIS instead of applyBackupPayload
  // directly.
  //
  // Sequence, in order:
  //   1. Acquire the lock (awaited BEFORE anything local changes) — so
  //      another device's listener has a real chance to see the lock and
  //      start blocking before this device's data starts moving. See
  //      firestoreSync.js's pushRestoreLock.
  //   2. Start a heartbeat interval so another device's staleness check
  //      doesn't time out while this restore is still genuinely in progress.
  //   3. Show this device's OWN "restoring" overlay (isRestoringBackup).
  //   4. Apply the backup locally (unchanged applyBackupPayload call).
  //   5. Force an IMMEDIATE push (reusing pushToCloud just above — see that
  //      function for why a manual write can't just rely on the ordinary
  //      200ms debounce: this write needs to be awaited and confirmed before
  //      the lock can safely release).
  //
  // Deliberately does NOT release the lock itself — it returns a `release`
  // function instead, and the CALLER decides when to invoke it. This is
  // because restoreCloudBackupAndRewriteCalendar (SchedulerContext.jsx)
  // needs to hold the lock across a SECOND step (rewriting Google Calendar)
  // that happens after this function returns — releasing here and having
  // that caller re-acquire for the rewrite would leave a gap where a blocked
  // device unblocks, polls/pushes, and races the in-progress rewrite. An
  // ordinary restore (no rewrite following) just calls `release()`
  // immediately, so there's no user-visible difference for that case.
  //
  // `release(rewroteGoogleCalendar)` stops the heartbeat, writes
  // state: 'released' (see firestoreSync.js's clearRestoreLock), and hides
  // this device's own overlay. Safe to call at most once per acquisition —
  // callers own that discipline, same as any other acquire/release pair.
  const acquireAndRunRestoreLock = useCallback(
    async (payload) => {
      if (!user) {
        // Signed out / cloud sync unavailable — nothing to coordinate with
        // other devices, so just apply locally exactly as before this lock
        // existed. Every restore entry point already only calls this once
        // the payload has already validated, so this is purely "no cloud,
        // no lock" rather than a validity check. `release` is a no-op here
        // — nothing was ever acquired.
        applyBackupPayload(payload);
        return { release: async () => {} };
      }
      // pushRestoreLock reads the server's own current generation itself
      // (see its own doc comment for why) — this device's local
      // lastAppliedRestoreLockGenerationRef is not consulted here at all,
      // only updated below once the new generation comes back.
      const generation = await pushRestoreLock(user.uid, deviceIdRef.current);
      // This device holds the lock now — it must never block on its own
      // restore (isRestoreLockActive already exempts the holder by
      // deviceId), but it DOES need to remember it has already converged on
      // this generation, so the release it writes at the end of this same
      // sequence doesn't make its OWN listener re-pull what it just applied.
      lastAppliedRestoreLockGenerationRef.current = generation;
      const heartbeatHandle = setInterval(() => {
        heartbeatRestoreLock(user.uid).catch((err) => console.warn('[useCloudSync] Restore-lock heartbeat failed', err));
      }, RESTORE_LOCK_HEARTBEAT_MS);
      setIsRestoringBackup(true);
      const release = async (rewroteGoogleCalendar = false) => {
        clearInterval(heartbeatHandle);
        try {
          await clearRestoreLock(user.uid, deviceIdRef.current, generation, rewroteGoogleCalendar);
        } catch (err) {
          console.warn('[useCloudSync] Failed to release restore lock — other devices may stay blocked until it goes stale', err);
        }
        setIsRestoringBackup(false);
      };
      try {
        applyBackupPayload(payload);
        await pushToCloud();
      } catch (err) {
        // Applying/pushing failed — release now rather than leaving the
        // lock (and every other device) stuck until it goes stale, then
        // re-throw so the caller's own error handling (importBackup/
        // restoreCloudBackup already wrap their own try/catch) still runs.
        await release(false);
        throw err;
      }
      return { release };
    },
    [user, applyBackupPayload, pushToCloud]
  );

  // ---- Export local backup file --------------------------------------------
  const exportBackup = useCallback(() => {
    const payload = buildBackupPayload({ ...stateRef.current, theme, accentSeed, events });
    downloadBackupFile(payload);
    setNotification({ type: 'success', message: 'Backup exported.' });
  }, [stateRef, theme, accentSeed, events, setNotification]);

  // ---- Import local backup file --------------------------------------------
  // Returns whether the restore actually applied, so callers (SettingsPanel)
  // can offer the separate, explicit "Rewrite Google Calendar to match
  // TaskFlow" follow-up action only after a real restore — never on a
  // rejected/invalid file. See restoreCloudBackup below for the cloud-backup
  // equivalent of this same signal.
  //
  // Goes through acquireAndRunRestoreLock (not applyBackupPayload directly)
  // so this restore becomes authoritative on every OTHER signed-in device
  // too — see that function's own doc comment. Releases the lock
  // IMMEDIATELY, since a plain restore (no Google rewrite following) has
  // nothing else to hold it open for; SchedulerContext's
  // importBackupFromFileAndRewriteCalendar is the variant that defers this
  // via `deferRelease` — see restoreCloudBackup's own doc comment for the
  // full reasoning, mirrored here identically.
  const importBackup = useCallback(
    async (file, { deferRelease = false } = {}) => {
      try {
        const payload = await readBackupFile(file);
        if (!isValidBackupPayload(payload)) {
          setNotification({ type: 'error', message: 'Invalid backup file.' });
          return false;
        }
        const { release } = await acquireAndRunRestoreLock(payload);
        setNotification({ type: 'success', message: 'Backup restored.' });
        if (deferRelease) return { ok: true, release };
        await release(false);
        return true;
      } catch (err) {
        setNotification({ type: 'error', message: err.message || 'Failed to read backup file.' });
        return deferRelease ? { ok: false, release: async () => {} } : false;
      }
    },
    [acquireAndRunRestoreLock, setNotification]
  );

  // Shared prune step for both backup pools (automatic and manual each have
  // their own independent retention count — see the constants above). Fetches
  // via `lister` (listAutomaticBackups/listManualBackups, NOT listBackups) so
  // enough backups of the other kind can't push old ones of this kind outside
  // listBackups's "most recent 40 overall" window and make them permanently
  // un-prunable — see those functions' doc comments. `isAutomatic` tells
  // planAutoBackupPrune which pool `lister`'s results belong to (both listers
  // already return single-pool lists, but this keeps the filter explicit
  // rather than assumed). Deletes anything planAutoBackupPrune flags as
  // beyond `retentionCount`, then trims them out of the locally-held
  // `cloudBackups` list so the UI doesn't need a full refetch to reflect it.
  // Errors are swallowed (warn + continue) since pruning is always a
  // best-effort follow-up to a backup that already succeeded, never
  // something the caller is waiting on.
  const pruneBackupPool = useCallback(
    async (lister, retentionCount, isAutomatic, label) => {
      const backups = await lister(user.uid);
      const idsToDelete = planAutoBackupPrune(backups, retentionCount, isAutomatic);
      if (idsToDelete.length === 0) return;
      try {
        await deleteBackups(user.uid, idsToDelete);
      } catch (err) {
        console.warn(`[useCloudSync] Failed to prune old ${label} backups`, err);
        return;
      }
      setCloudBackups((prev) => prev.filter((b) => !idsToDelete.includes(b.id)));
    },
    [user]
  );

  // ---- Cloud backup operations ---------------------------------------------
  const createCloudBackup = useCallback(async () => {
    if (!user) return;
    // ONLY the backup write itself decides success/failure. The prune and
    // list-refresh below are follow-ups: they run after the user's data is
    // already safely stored, so a failure in either must not be reported as
    // "Failed to create cloud backup" — that tells the user their data ISN'T
    // backed up when it demonstrably is, which is the most alarming way to be
    // wrong about a backup. (This is not hypothetical: the pool listers use a
    // `where('automatic', ...) + orderBy('createdAt')` composite query, so a
    // missing Firestore index made every successful backup report failure.)
    try {
      const payload = buildBackupPayload({ ...stateRef.current, theme, accentSeed, events });
      await createBackup(user.uid, payload);
    } catch (err) {
      console.error('[useCloudSync] Cloud backup failed', err);
      setNotification({ type: 'error', message: 'Failed to create cloud backup.' });
      return;
    }
    setNotification({ type: 'success', message: 'Cloud backup created.' });

    try {
      // Prune manual backups beyond their retention count right away, rather
      // than waiting for the next daily automatic-backup check — a user
      // backing up repeatedly in one session shouldn't have to wait a day to
      // get pruned back down to the retention limit.
      await pruneBackupPool(listManualBackups, BACKUP_RETENTION_COUNT_MANUAL, false, 'manual');
      setCloudBackups(await listBackups(user.uid));
    } catch (err) {
      // Retention drifting above its cap, or a stale "view backups" list, are
      // both cosmetic next to a backup that succeeded — warn and move on
      // rather than alarming the user about something that isn't lost.
      console.warn('[useCloudSync] Backup saved, but pruning/refreshing the list failed', err);
    }
  }, [user, stateRef, theme, accentSeed, events, setNotification, pruneBackupPool]);

  // ---- Automatic daily cloud backup + retention -----------------------------
  // Runs at most once per day. Unlike createCloudBackup above (a user-initiated
  // action they're actively waiting on, so it SHOULD surface errors), a failure
  // here just warns to the console and moves on — it's a background action the
  // user never explicitly triggered, so a disruptive error toast would be more
  // annoying than useful. It doesn't return anything or throw for the same
  // reason: nothing is waiting on it. Also takes this opportunity to prune
  // manual backups beyond their retention count — a daily catch-all on top of
  // the prune createCloudBackup already does right after each new manual backup.
  const runAutomaticBackupIfDue = useCallback(async () => {
    if (!user || !cloudSynced) return;
    if (autoBackupInFlightRef.current) return;
    const now = Date.now();
    if (lastAutoBackupAtRef.current && now - lastAutoBackupAtRef.current < BACKUP_CHECK_INTERVAL_MS) return;
    autoBackupInFlightRef.current = true;
    try {
      const payload = buildBackupPayload({ ...stateRef.current, theme, accentSeed, events });
      await createBackup(user.uid, payload, { automatic: true });
      // Stamp the ref immediately (not just the state setter, which only
      // takes effect on this hook's next render) so a same-session re-check
      // — the periodic setInterval below, or a fast remount — can't mistake
      // the backup that just succeeded for one still due.
      lastAutoBackupAtRef.current = now;
      setLastAutoBackupAt(now);

      // Prune both pools — independent retention counts. Manual backups are
      // never candidates in the automatic prune (and vice versa) since each is
      // fetched from its own filtered query.
      await pruneBackupPool(listAutomaticBackups, BACKUP_RETENTION_COUNT_AUTOMATIC, true, 'automatic');
      await pruneBackupPool(listManualBackups, BACKUP_RETENTION_COUNT_MANUAL, false, 'manual');
      // Refresh the displayed backup list (separate from pruning above) so
      // the just-created automatic backup shows up in the "view backups" UI.
      setCloudBackups(await listBackups(user.uid));
    } catch (err) {
      console.warn('[useCloudSync] Automatic backup failed', err);
    } finally {
      autoBackupInFlightRef.current = false;
    }
  }, [user, cloudSynced, stateRef, theme, accentSeed, events, setLastAutoBackupAt, pruneBackupPool]);

  // Checks once on mount (covers "app just opened, a day or more has passed")
  // and hourly after that (covers a long-lived tab crossing the day boundary
  // without a reload) — same setInterval + in-flight-guard shape as
  // useGoogleCalendarSync's periodic poll.
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;
    runAutomaticBackupIfDue();
    const handle = setInterval(runAutomaticBackupIfDue, BACKUP_CHECK_INTERVAL_MS);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced]);

  // ---- Restore-lock staleness re-check (crashed/closed restoring device) --
  // A device being BLOCKED (see isBlockedByOtherRestoreRef/isBlockedByRestore
  // above) only learns the lock exists via a Firestore snapshot — but a
  // device that crashes or has its tab closed mid-restore sends no FURTHER
  // snapshots at all, so a listener-only check would leave every other
  // device stuck behind that lock forever. This periodic re-evaluation
  // against the CURRENT clock (isRestoreLockActive's own `nowMs` freshness
  // check, not just whatever the last snapshot said) is what actually
  // recovers from that: once the lock's heartbeat is older than
  // RESTORE_LOCK_STALE_MS, this stops treating it as active and lets
  // ordinary syncing resume, with a toast explaining why.
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;
    const handle = setInterval(() => {
      if (!isBlockedByOtherRestoreRef.current) return; // nothing to re-check
      const stillActive = isRestoreLockActive(restoreLockRef.current, deviceIdRef.current, Date.now());
      if (stillActive) return;
      isBlockedByOtherRestoreRef.current = false;
      setIsBlockedByRestore(false);
      setNotification({
        type: 'warning',
        message: 'The other device stopped responding during its restore — resuming normal syncing.',
      });
    }, RESTORE_LOCK_HEARTBEAT_MS / 2);
    return () => clearInterval(handle);
  }, [user, cloudSynced, setNotification]);

  const loadCloudBackups = useCallback(async () => {
    if (!user) return;
    setIsLoadingBackups(true);
    try {
      const backups = await listBackups(user.uid);
      setCloudBackups(backups);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingBackups(false);
    }
  }, [user]);

  // Returns whether the restore actually applied — same reasoning as
  // importBackup above (BackupsModal/SettingsPanel use this to decide
  // whether to offer the "Rewrite Google Calendar to match TaskFlow" follow-up).
  //
  // Goes through acquireAndRunRestoreLock (not applyBackupPayload directly),
  // same reasoning as importBackup above. `deferRelease` (default false)
  // lets SchedulerContext's restoreCloudBackupAndRewriteCalendar keep the
  // lock held across the Google rewrite that follows a restore, instead of
  // this function releasing it the instant the restore itself finishes —
  // see acquireAndRunRestoreLock's own doc comment for why releasing too
  // early would let a blocked device race the in-progress rewrite. When
  // deferred, the resolved value carries a `release` function the caller
  // must invoke exactly once when it's actually done holding the lock open;
  // the plain (non-deferred) path releases immediately and returns the
  // ordinary boolean every existing caller already expects.
  const restoreCloudBackup = useCallback(
    async (backupId, { deferRelease = false } = {}) => {
      if (!user) return false;
      try {
        const payload = await getBackup(user.uid, backupId);
        if (!isValidBackupPayload(payload)) {
          setNotification({ type: 'error', message: 'Invalid cloud backup.' });
          return false;
        }
        const { release } = await acquireAndRunRestoreLock(payload);
        setNotification({ type: 'success', message: 'Cloud backup restored.' });
        if (deferRelease) return { ok: true, release };
        await release(false);
        return true;
      } catch (err) {
        console.error(err);
        setNotification({ type: 'error', message: 'Failed to restore cloud backup.' });
        return deferRelease ? { ok: false, release: async () => {} } : false;
      }
    },
    [user, acquireAndRunRestoreLock, setNotification]
  );

  const removeCloudBackup = useCallback(async (backupId) => {
    if (!user) return;
    try {
      await deleteBackup(user.uid, backupId);
      setCloudBackups((prev) => prev.filter((b) => b.id !== backupId));
      setNotification({ type: 'success', message: 'Cloud backup deleted.' });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Failed to delete cloud backup.' });
    }
  }, [user, setNotification]);

  return {
    cloudSynced,
    isPullingCloud,
    isPushingCloud,
    cloudBackups,
    isLoadingBackups,
    lastAutoBackupAt,
    toggleCloudSync,
    pullFromCloud,
    pushToCloud,
    exportBackup,
    importBackup,
    createCloudBackup,
    loadCloudBackups,
    restoreCloudBackup,
    removeCloudBackup,
    // Restore lock overlay state — see BlockingProgressOverlay.jsx. Exactly
    // one of these can be true at a time in practice (a device holding the
    // lock is exempt from its own block, see isRestoreLockActive), but both
    // are surfaced so the overlay's copy can tell "I am restoring" apart
    // from "another device is restoring and I'm waiting" without guessing.
    isRestoringBackup,
    isBlockedByRestore,
  };
}

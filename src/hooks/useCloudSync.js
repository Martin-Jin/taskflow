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
  pushGoogleCalendarStatus,
} from '../services/firestoreSync';
import { migrateLinksToNotes } from '../components/Dashboard/notesModel';
import { mergeTasksByUpdatedAt } from '../utils/taskMerge';
import { getBrowserTimeZone } from '../utils/dateUtils';
import { loadPersisted, savePersisted } from '../utils/persistence.js';
import { getDeviceId } from '../utils/deviceIdentity.js';
import {
  CLOUD_SYNC_DEBOUNCE_MS,
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_RETENTION_COUNT_AUTOMATIC,
  BACKUP_RETENTION_COUNT_MANUAL,
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

/**
 * Hashes/serializes the syncable subset of state so callers can detect "is
 * this remote update just an echo of what I just pushed" by string equality.
 * Pure and stateless — hoisted out of the hook (it never closed over
 * anything) so it can be exported and unit-tested directly.
 *
 * Deliberately excludes `events` — see backupService.js's BACKUP_FIELDS doc
 * comment for why CalendarEvents are device-local (Google Calendar-sourced)
 * now rather than round-tripped through Firestore.
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
    sharedProjectIds: source.sharedProjectIds,
  };
  return JSON.stringify(relevant);
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

// Safety cap on how many in-flight push fingerprints are tracked at once —
// pushes are debounced 1500ms apart and each ack normally arrives well
// within that, so this should never realistically fill up. It exists purely
// so a pathological case (acks never arriving, e.g. a permanently broken
// listener) can't grow this list forever; the oldest entry is dropped first,
// same "oldest first" policy as retireInFlightFingerprint's consumption order.
const MAX_IN_FLIGHT_FINGERPRINTS = 20;

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
 */
export function planRemoteDataMerge(remoteData, localState, { skipAll = false } = {}) {
  if (skipAll) return { stampFingerprint: false };

  const plan = {};

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
  if ('sections' in remoteData) plan.sections = pickValid('sections', remoteData.sections, localState.sections);
  if ('projects' in remoteData) plan.projects = pickValid('projects', remoteData.projects, localState.projects);
  if ('labels' in remoteData) plan.labels = pickValid('labels', remoteData.labels, localState.labels);
  if ('routines' in remoteData) plan.routines = pickValid('routines', remoteData.routines, localState.routines);
  if ('rules' in remoteData) plan.rules = pickValid('rules', remoteData.rules, localState.rules);
  if ('soundEnabled' in remoteData) plan.soundEnabled = pickValid('soundEnabled', remoteData.soundEnabled, localState.soundEnabled);
  if ('soundVolume' in remoteData) plan.soundVolume = pickValid('soundVolume', remoteData.soundVolume, localState.soundVolume);
  if ('animationsEnabled' in remoteData) {
    plan.animationsEnabled = pickValid('animationsEnabled', remoteData.animationsEnabled, localState.animationsEnabled);
  }
  // This device's own browser timezone always wins over whatever timezone
  // the remote doc carries (another device's, possibly stale).
  if ('notificationSettings' in remoteData) {
    const notificationSettings = pickValid('notificationSettings', remoteData.notificationSettings, localState.notificationSettings);
    plan.notificationSettings = { ...notificationSettings, timezone: getBrowserTimeZone() };
  }
  if ('notes' in remoteData) {
    plan.notes = pickValid('notes', remoteData.notes, localState.notes);
  } else if ('pinnedLinks' in remoteData) {
    // legacy remote doc, see notesModel.js migration note
    const migrated = migrateLinksToNotes(remoteData.pinnedLinks);
    if (migrated) plan.notes = migrated;
  }
  if ('shortcutBindings' in remoteData) {
    plan.shortcutBindings = pickValid('shortcutBindings', remoteData.shortcutBindings, localState.shortcutBindings);
  }
  if ('sharedProjectIds' in remoteData) {
    plan.sharedProjectIds = pickValid('sharedProjectIds', remoteData.sharedProjectIds, localState.sharedProjectIds);
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
  return JSON.stringify(plan.tasksBlocks.tasks) !== JSON.stringify(localTasksBefore);
}

/**
 * @param {Object} deps
 * @param {Object} deps.state - Current combined syncable state (tasks/blocks/
 *   sections/projects/labels/routines/rules/soundEnabled/soundVolume/
 *   animationsEnabled/notificationSettings/notes/shortcutBindings/
 *   sharedProjectIds) — a plain object recomputed whenever any of those
 *   fields changes, purely so the push-scheduling effect below has
 *   something to depend on. Deliberately excludes `events` — see
 *   backupService.js's BACKUP_FIELDS doc comment.
 * @param {React.MutableRefObject} deps.stateRef - Ref mirroring `state`, read
 *   from async callbacks (the debounced push, backup builders) that need the
 *   LATEST snapshot rather than whatever was closed over when they were created.
 * @param {React.MutableRefObject} deps.currentActionIdRef - Ref mirroring
 *   useHistoryState's currentActionId, read by the initial-pull/live-listener
 *   effects below to detect a local commit landing during their async gap
 *   (see their own comments) — same "ref so an async callback sees the
 *   latest value" reasoning as stateRef.
 * @param {Function} deps.setNotification - Toast notification setter
 * @param {Function} deps.commit - useHistoryState's commit (tasks/blocks, undoable)
 * @param {Function} deps.overwritePresent - useHistoryState's overwritePresent
 *   (tasks/blocks, NOT undoable) — used for data arriving from elsewhere
 *   (initial pull, live listener) rather than from a local user action.
 * @param {Function} deps.setSections - Setter for sections
 * @param {Function} deps.setProjects - Setter for projects
 * @param {Function} deps.setLabels - Setter for labels
 * @param {Function} deps.setRoutines - Setter for routines
 * @param {Function} deps.setRules - Setter for rules
 * @param {Function} deps.setSoundEnabled - Setter for soundEnabled
 * @param {Function} deps.setSoundVolume - Setter for soundVolume
 * @param {Function} deps.setAnimationsEnabled - Setter for animationsEnabled
 * @param {Function} deps.setNotificationSettings - Setter for notificationSettings
 * @param {Function} deps.setNotes - Setter for notes
 * @param {Function} deps.setShortcutBindings - Setter for shortcutBindings
 * @param {Function} deps.setSharedProjectIds - Setter for sharedProjectIds
 * @param {*} deps.theme - Current theme (owned live by ThemeContext) — only
 *   read here so a backup payload can capture it (see BACKUP_FIELDS).
 * @param {Function} deps.setTheme - Applies a restored backup's theme.
 * @param {Array} deps.events - Current CalendarEvents. Like `theme`, kept
 *   OUT of `state`/`stateRef` (so it never reaches the live-sync fingerprint
 *   or Firestore push/pull) but passed separately purely so backup payloads
 *   can capture it — see BACKUP_FIELDS' doc comment for why events are
 *   backed-up but not live-synced.
 * @param {Function} deps.setEvents - Applies a restored backup's events.
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
  setSharedProjectIds,
  theme,
  setTheme,
  events,
  setEvents,
  googleConnected,
  googleSyncStale,
  pullFromGoogleCalendar,
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

  // ---- Debounced push to Firestore -----------------------------------------
  // The fingerprint stamp/rollback decision itself lives in the pure,
  // exported computePushStampPlan — this just performs the actual write and
  // ref mutation around it.
  const runPushNow = useCallback(async () => {
    if (!user) return;
    const currentState = stateRef.current;
    const plan = computePushStampPlan(currentState, lastPushedFingerprintRef.current);
    if (!plan.shouldPush) return; // no change
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
    }
  }, [user, stateRef, setNotification]);

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
      pushTimerRef.current = setTimeout(runPushNow, CLOUD_SYNC_DEBOUNCE_MS);
    },
    [runPushNow]
  );

  // Flush a pending debounced push immediately when the tab is about to go
  // away (backgrounded or closed) instead of waiting out the full
  // CLOUD_SYNC_DEBOUNCE_MS. Without this, an edit made and then quickly followed by
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
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;
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
  const applyRemoteData = useCallback((remoteData, { skipAll = false } = {}) => {
    const localTasksBefore = stateRef.current.tasks;
    const plan = planRemoteDataMerge(remoteData, stateRef.current, { skipAll });
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
    if ('sharedProjectIds' in plan) setSharedProjectIds(plan.sharedProjectIds);

    // Did the per-task merge actually produce a task set different from what
    // was local a moment ago? See didTaskMergeChangeAnything's own doc
    // comment — this one answer gates both the rebalance trigger and the
    // fingerprint-stamp skip below.
    const mergeChangedTasks = didTaskMergeChangeAnything(plan, localTasksBefore);

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
    // (see planRemoteDataMerge's stampFingerprint comment) AND the tasks
    // branch didn't just produce a genuinely NEW combined result via the
    // per-task merge. Fingerprinting against raw `remoteData` in that case
    // would falsely mark the merged-but-not-yet-pushed result as "Firestore
    // already has this" — permanently suppressing the push that's supposed
    // to carry it up. Skipping the stamp here is deliberately simpler than
    // fingerprinting the as-applied plan instead: the normal debounced push
    // effect already watches `state`/`stateRef` and will notice this local
    // change like any other edit and push it up on its own, no special-
    // casing needed here.
    if (plan.stampFingerprint && !mergeChangedTasks) {
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
    setSharedProjectIds,
  ]);

  // ---- Applies a full backup payload (local file or cloud backup) ----------
  // Same field set as applyRemoteData, but tasks/blocks go through commit()
  // (undoable, matching clearAllData's precedent) and this also restores
  // `theme`, which live sync deliberately leaves to ThemeContext.
  const applyBackupPayload = useCallback((payload) => {
    if ('tasks' in payload || 'blocks' in payload) {
      commit(
        {
          tasks: pickValid('tasks', payload.tasks, stateRef.current.tasks),
          blocks: pickValid('blocks', payload.blocks, stateRef.current.blocks),
        },
        'Restored from backup'
      );
    }
    if ('sections' in payload) setSections(pickValid('sections', payload.sections, stateRef.current.sections));
    if ('projects' in payload) setProjects(pickValid('projects', payload.projects, stateRef.current.projects));
    if ('labels' in payload) setLabels(pickValid('labels', payload.labels, stateRef.current.labels));
    if ('routines' in payload) setRoutines(pickValid('routines', payload.routines, stateRef.current.routines));
    if ('rules' in payload) setRules(pickValid('rules', payload.rules, stateRef.current.rules));
    // Absent on a backup taken before `events` joined BACKUP_FIELDS — left
    // untouched in that case, same as any other field missing from an
    // older/partial payload (see isValidBackupPayload's doc comment).
    if ('events' in payload) setEvents(pickValid('events', payload.events, events));
    if ('soundEnabled' in payload) setSoundEnabled(pickValid('soundEnabled', payload.soundEnabled, stateRef.current.soundEnabled));
    if ('soundVolume' in payload) setSoundVolume(pickValid('soundVolume', payload.soundVolume, stateRef.current.soundVolume));
    if ('animationsEnabled' in payload) {
      setAnimationsEnabled(pickValid('animationsEnabled', payload.animationsEnabled, stateRef.current.animationsEnabled));
    }
    if ('notificationSettings' in payload) {
      const notificationSettings = pickValid('notificationSettings', payload.notificationSettings, stateRef.current.notificationSettings);
      setNotificationSettings({ ...notificationSettings, timezone: getBrowserTimeZone() });
    }
    if ('theme' in payload) setTheme(pickValid('theme', payload.theme, theme));
    if ('notes' in payload) setNotes(pickValid('notes', payload.notes, stateRef.current.notes));
    else if ('pinnedLinks' in payload) {
      // legacy backup file, see notesModel.js migration note
      const migrated = migrateLinksToNotes(payload.pinnedLinks);
      if (migrated) setNotes(migrated);
    }
    if ('shortcutBindings' in payload) {
      const shortcutBindings = pickValid('shortcutBindings', payload.shortcutBindings, stateRef.current.shortcutBindings);
      setShortcutBindings(shortcutBindings);
      savePersisted('shortcutBindings', shortcutBindings);
    }
    if ('sharedProjectIds' in payload) {
      setSharedProjectIds(pickValid('sharedProjectIds', payload.sharedProjectIds, stateRef.current.sharedProjectIds));
    }
  }, [
    commit,
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
    setTheme,
    theme,
    setNotes,
    setShortcutBindings,
    setSharedProjectIds,
    events,
    setEvents,
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
      const localEditLandedFirst = isFirstSnapshot && hasLocalEditRaced(actionIdAtSubscribe, currentActionIdRef.current);
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

  // ---- Initial pull on mount (when user is available) ----------------------
  useEffect(() => {
    if (!user || !cloudSynced) return;

    let cancelled = false;
    // Baseline local action as of the moment this pull starts — if a
    // genuinely new local commit lands (e.g. the user edits a task, deletes
    // or shares a project) before this Firestore round-trip resolves, the
    // fetched snapshot is stale relative to that edit. Applying ANY of it
    // via overwritePresent/setState would silently discard the newer local
    // edit, so the whole plan is skipped in that case (see applyRemoteData's
    // skipAll) — the debounced push effect already fires on any state
    // change, so the newer local edit still reaches Firestore on its own;
    // nothing is lost either way.
    const actionIdAtStart = currentActionIdRef.current;
    (async () => {
      setIsPullingCloud(true);
      try {
        const remoteData = await pullUserData(user.uid);
        if (!cancelled && remoteData) {
          // Record the server-confirmed `lastWriteAt` this pull observed —
          // same bookkeeping as the live listener, done BEFORE the
          // staleness check inside isRemoteWriteStale (called via
          // applyRemoteData's skipAll below) so this pull's own timestamp
          // never gates itself. At this point in a fresh session
          // lastKnownWriteAtMillisRef is still null, so isRemoteWriteStale
          // can never flag THIS pull as stale — there's nothing yet to
          // compare it against (see its doc comment) — but subsequent live
          // snapshots this session will compare against what's recorded here.
          recordObservedWriteAt(remoteData.lastWriteAt);
          const localEditLandedDuringPull = hasLocalEditRaced(actionIdAtStart, currentActionIdRef.current);
          applyRemoteData(remoteData, { skipAll: localEditLandedDuringPull });
        }
      } catch (err) {
        console.warn('[useCloudSync] Initial pull failed', err);
      } finally {
        if (!cancelled) setIsPullingCloud(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced]);

  // ---- Fallback: restore events from the latest backup if there's nothing
  // to show and no WORKING live Google Calendar source to repopulate them ---
  // `events` is deliberately excluded from the live cross-device sync above
  // (see BACKUP_FIELDS' doc comment) — Google Calendar is the normal
  // day-to-day authoritative store, and `useGoogleCalendarSync`'s own silent
  // reconnect repopulates `events` from Google on every mount/refresh. This
  // only covers the gap that leaves: a device with no working live Google
  // source has no other way to see events again, even though a recent
  // Firestore backup already has them. That's two situations, not one —
  // Google not connected at all (a new device, or wiped localStorage), AND
  // Google nominally connected but its fetches failing after exhausting
  // their retries (`googleSyncStale` — a cold start where auth wasn't ready
  // yet, or a network hiccup). Both leave `events` equally empty.
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
  const pushToCloud = useCallback(async () => {
    if (!user) return;
    setIsPushingCloud(true);
    // Same in-flight bookkeeping as runPushNow (see isStaleOwnEcho's doc
    // comment) — this button can just as easily overlap a debounced push (or
    // another manual push) while the write is in flight, so its echo needs
    // to be recognizable too.
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
    }
  }, [user, stateRef, setNotification, computeFingerprint]);

  // ---- Export local backup file --------------------------------------------
  const exportBackup = useCallback(() => {
    const payload = buildBackupPayload({ ...stateRef.current, theme, events });
    downloadBackupFile(payload);
    setNotification({ type: 'success', message: 'Backup exported.' });
  }, [stateRef, theme, events, setNotification]);

  // ---- Import local backup file --------------------------------------------
  const importBackup = useCallback(async (file) => {
    try {
      const payload = await readBackupFile(file);
      if (!isValidBackupPayload(payload)) {
        setNotification({ type: 'error', message: 'Invalid backup file.' });
        return;
      }
      applyBackupPayload(payload);
      setNotification({ type: 'success', message: 'Backup restored.' });
    } catch (err) {
      setNotification({ type: 'error', message: err.message || 'Failed to read backup file.' });
    }
  }, [applyBackupPayload, setNotification]);

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
      await Promise.all(
        idsToDelete.map((id) =>
          deleteBackup(user.uid, id).catch((err) => {
            console.warn(`[useCloudSync] Failed to prune old ${label} backup`, id, err);
          })
        )
      );
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
      const payload = buildBackupPayload({ ...stateRef.current, theme, events });
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
  }, [user, stateRef, theme, events, setNotification, pruneBackupPool]);

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
      const payload = buildBackupPayload({ ...stateRef.current, theme, events });
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
  }, [user, cloudSynced, stateRef, theme, events, setLastAutoBackupAt, pruneBackupPool]);

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

  const restoreCloudBackup = useCallback(async (backupId) => {
    if (!user) return;
    try {
      const payload = await getBackup(user.uid, backupId);
      if (!isValidBackupPayload(payload)) {
        setNotification({ type: 'error', message: 'Invalid cloud backup.' });
        return;
      }
      applyBackupPayload(payload);
      setNotification({ type: 'success', message: 'Cloud backup restored.' });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Failed to restore cloud backup.' });
    }
  }, [user, applyBackupPayload, setNotification]);

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
  };
}

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
  getBackup,
  deleteBackup,
} from '../services/firestoreSync';
import { migrateLinksToNotes } from '../components/Dashboard/notesModel';
import { getBrowserTimeZone } from '../utils/dateUtils';
import { savePersisted } from '../utils/persistence.js';

const PUSH_DEBOUNCE_MS = 1500;

// ---- Automatic cloud backups ------------------------------------------------
// Once per day while signed in with cloud sync active, a backup is taken
// automatically (tagged `automatic: true`, see firestoreSync.createBackup) and
// old automatic ones beyond AUTO_BACKUP_RETENTION_COUNT are pruned — manual
// "Back up now" backups are never touched by this, regardless of age (see
// planAutoBackupPrune below).
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_BACKUP_RETENTION_COUNT = 14;
// How often a long-lived open tab re-checks whether a day has elapsed since
// the last automatic backup, without needing a reload — mirrors
// useGoogleCalendarSync's periodic-poll pattern (a plain setInterval with an
// in-flight guard ref), just on a much coarser cadence since this only needs
// to catch a day boundary, not near-realtime freshness.
const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Pure retention decision for automatic cloud backups: given the full list of
 * backups (as returned by firestoreSync.listBackups — `{ id, automatic,
 * createdAt }`) and how many automatic ones to keep, returns the ids of
 * automatic backups beyond that count (oldest-first among the excess),
 * ready to delete. Manual backups (`automatic: false`) are never included in
 * the input filtering here, so they're never candidates for deletion no
 * matter how many exist or how old they are.
 */
export function planAutoBackupPrune(backups, retentionCount = AUTO_BACKUP_RETENTION_COUNT) {
  const automaticBackups = backups.filter((b) => b.automatic);
  const sorted = [...automaticBackups].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return sorted.slice(retentionCount).map((b) => b.id);
}

/** Firestore Timestamps expose `.toMillis()`; a plain number (e.g. in tests) is used as-is. Missing/unknown values sort last (treated as oldest). */
function toMillis(createdAt) {
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
  };
  return JSON.stringify(relevant);
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
 * race guard fired for tasks/blocks, returns a plan describing what to
 * apply. A key is present in the returned plan only when that field should
 * be set (mirrors the `'field' in remoteData` checks below) — the hook
 * still performs the actual setState calls/side effects, this just computes
 * what they should be.
 *
 * `skipTasksBlocks` (see the initial-pull/live-listener effects) means a
 * genuinely newer local commit landed while remoteData was in flight —
 * applying its tasks/blocks would silently discard that newer edit, so the
 * plan omits `tasksBlocks` and reports `stampFingerprint: false` so the next
 * schedulePush still sees a real change and pushes the newer local edit
 * instead of assuming it's already synced. Every OTHER field still applies
 * normally — they're plain setState with no undo-stack/history concept, so
 * there's no equivalent "this local value is newer" signal to check them against.
 */
export function planRemoteDataMerge(remoteData, localState, { skipTasksBlocks = false } = {}) {
  const plan = {};

  if (!skipTasksBlocks && ('tasks' in remoteData || 'blocks' in remoteData)) {
    plan.tasksBlocks = {
      tasks: pickValid('tasks', remoteData.tasks, localState.tasks),
      blocks: pickValid('blocks', remoteData.blocks, localState.blocks),
    };
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

  // Only stamp "already synced" when tasks/blocks were actually applied
  // as-is — when skipTasksBlocks is true, local tasks/blocks now differ from
  // remoteData's (the newer local edit was kept), so stamping remoteData's
  // fingerprint would claim a state we never actually applied.
  plan.stampFingerprint = !skipTasksBlocks;

  return plan;
}

/**
 * @param {Object} deps
 * @param {Object} deps.state - Current combined syncable state (tasks/blocks/
 *   sections/projects/labels/routines/rules/soundEnabled/soundVolume/
 *   animationsEnabled/notificationSettings/notes/shortcutBindings) — a plain
 *   object recomputed whenever any of those fields changes, purely so the
 *   push-scheduling effect below has something to depend on. Deliberately
 *   excludes `events` — see backupService.js's BACKUP_FIELDS doc comment.
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
 * @param {*} deps.theme - Current theme (owned live by ThemeContext) — only
 *   read here so a backup payload can capture it (see BACKUP_FIELDS).
 * @param {Function} deps.setTheme - Applies a restored backup's theme.
 * @param {Array} deps.events - Current CalendarEvents. Like `theme`, kept
 *   OUT of `state`/`stateRef` (so it never reaches the live-sync fingerprint
 *   or Firestore push/pull) but passed separately purely so backup payloads
 *   can capture it — see BACKUP_FIELDS' doc comment for why events are
 *   backed-up but not live-synced.
 * @param {Function} deps.setEvents - Applies a restored backup's events.
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
  theme,
  setTheme,
  events,
  setEvents,
}) {
  const { user } = useAuth();
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

  const pushTimerRef = useRef(null);
  const lastPushedFingerprintRef = useRef(null);
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
  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(async () => {
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
        await pushUserData(user.uid, currentState);
      } catch (err) {
        console.warn('[useCloudSync] Push failed', err);
        // Roll back the optimistic stamp — otherwise this fingerprint looks
        // "already pushed" even though the write never landed, so if the
        // user makes no further edit, every future schedulePush sees "no
        // change" and this edit is silently dropped from Firestore forever.
        // Restoring the previous value means the very next state change
        // (including one identical to this failed push) will retry it.
        lastPushedFingerprintRef.current = plan.rollbackFingerprint;
        setNotification({ type: 'error', message: 'Failed to sync to the cloud. Your changes are saved locally and will retry on your next edit.' });
      } finally {
        setIsPushingCloud(false);
      }
    }, PUSH_DEBOUNCE_MS);
  }, [user, stateRef, setNotification]);

  // ---- Apply remote data (from Firestore snapshot or an initial pull) ------
  // Mirrors applyBackupPayload below field-for-field, but routes tasks/blocks
  // through overwritePresent (NOT commit) since this data came from
  // elsewhere, not a local user action — it shouldn't be undoable, and
  // shouldn't consume a redo slot. A field missing from `remoteData` (an
  // older/partial doc) leaves that field untouched rather than wiping it.
  //
  // `skipTasksBlocks` (set by the initial-pull/live-listener effects below,
  // see their own comments) means a genuinely newer local commit landed
  // while this remoteData was in flight — applying its tasks/blocks here
  // would silently discard that newer edit with a stale one, so this skips
  // just that part. Every OTHER field still applies normally: they're
  // plain setState with no undo-stack/history concept, so there's no
  // equivalent "this local value is newer" signal to check them against.
  const applyRemoteData = useCallback((remoteData, { skipTasksBlocks = false } = {}) => {
    const plan = planRemoteDataMerge(remoteData, stateRef.current, { skipTasksBlocks });
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
    // Stamp what we just applied as "already synced" so the debounced push
    // effect doesn't immediately echo this same data straight back to
    // Firestore — but only when tasks/blocks were actually applied as-is
    // (see planRemoteDataMerge's stampFingerprint comment).
    if (plan.stampFingerprint) {
      lastPushedFingerprintRef.current = computeFingerprint(remoteData);
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
    events,
    setEvents,
  ]);

  // ---- Subscribe to Firestore on mount (when user is available) ------------
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;

    // Baseline local action as of the moment this listener (re)subscribes —
    // only its FIRST delivered snapshot can race a local edit made in the
    // real-world gap between mount (localStorage-seeded UI renders
    // immediately) and that first delivery, mirroring the initial-pull
    // effect below. Once a first snapshot has landed the app is past that
    // startup window, so every later snapshot is trusted normally — that's
    // the accepted steady-state model this file already uses elsewhere
    // (the fingerprint-based echo check just below).
    const actionIdAtSubscribe = currentActionIdRef.current;
    let receivedFirstSnapshot = false;
    const unsubscribe = subscribeUserData(user.uid, (remoteData) => {
      if (!remoteData) return;
      const fingerprint = computeFingerprint(stateRef.current);
      const remoteFingerprint = computeFingerprint(remoteData);
      if (fingerprint === remoteFingerprint) return; // echo of our own push
      const isFirstSnapshot = !receivedFirstSnapshot;
      receivedFirstSnapshot = true;
      const localEditLandedFirst = isFirstSnapshot && hasLocalEditRaced(actionIdAtSubscribe, currentActionIdRef.current);
      applyRemoteData(remoteData, { skipTasksBlocks: localEditLandedFirst });
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
    // genuinely new local commit lands (e.g. the user edits a task) before
    // this Firestore round-trip resolves, the fetched snapshot is stale
    // relative to that edit. Applying its tasks/blocks via overwritePresent
    // would silently discard the newer local edit, so that part is skipped
    // in that case (see applyRemoteData's skipTasksBlocks) — the debounced
    // push effect already fires on any state change, so the newer local
    // edit still reaches Firestore on its own; nothing is lost either way.
    const actionIdAtStart = currentActionIdRef.current;
    (async () => {
      setIsPullingCloud(true);
      try {
        const remoteData = await pullUserData(user.uid);
        if (!cancelled && remoteData) {
          const localEditLandedDuringPull = hasLocalEditRaced(actionIdAtStart, currentActionIdRef.current);
          applyRemoteData(remoteData, { skipTasksBlocks: localEditLandedDuringPull });
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

  // ---- Schedule push whenever state changes --------------------------------
  useEffect(() => {
    if (!user || !cloudSynced) return;
    schedulePush();
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
    try {
      await pushUserData(user.uid, stateRef.current);
      lastPushedFingerprintRef.current = computeFingerprint(stateRef.current);
      setNotification({ type: 'success', message: 'Pushed data to cloud.' });
    } catch (err) {
      console.error(err);
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

  // ---- Cloud backup operations ---------------------------------------------
  const createCloudBackup = useCallback(async () => {
    if (!user) return;
    try {
      const payload = buildBackupPayload({ ...stateRef.current, theme, events });
      await createBackup(user.uid, payload);
      setNotification({ type: 'success', message: 'Cloud backup created.' });
      // Refresh the backup list
      const backups = await listBackups(user.uid);
      setCloudBackups(backups);
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Failed to create cloud backup.' });
    }
  }, [user, stateRef, theme, events, setNotification]);

  // ---- Automatic daily cloud backup + retention -----------------------------
  // Runs at most once per AUTO_BACKUP_INTERVAL_MS. Unlike createCloudBackup
  // above (a user-initiated action they're actively waiting on, so it SHOULD
  // surface errors), a failure here just warns to the console and moves on —
  // it's a background action the user never explicitly triggered, so a
  // disruptive error toast would be more annoying than useful. It doesn't
  // return anything or throw for the same reason: nothing is waiting on it.
  const runAutomaticBackupIfDue = useCallback(async () => {
    if (!user || !cloudSynced) return;
    if (autoBackupInFlightRef.current) return;
    const now = Date.now();
    if (lastAutoBackupAtRef.current && now - lastAutoBackupAtRef.current < AUTO_BACKUP_INTERVAL_MS) return;
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

      // Prune old automatic backups beyond the retention count. Manual
      // backups are never candidates — see planAutoBackupPrune.
      const backups = await listBackups(user.uid);
      setCloudBackups(backups);
      const idsToDelete = planAutoBackupPrune(backups, AUTO_BACKUP_RETENTION_COUNT);
      if (idsToDelete.length > 0) {
        await Promise.all(
          idsToDelete.map((id) =>
            deleteBackup(user.uid, id).catch((err) => {
              console.warn('[useCloudSync] Failed to prune old automatic backup', id, err);
            })
          )
        );
        setCloudBackups((prev) => prev.filter((b) => !idsToDelete.includes(b.id)));
      }
    } catch (err) {
      console.warn('[useCloudSync] Automatic backup failed', err);
    } finally {
      autoBackupInFlightRef.current = false;
    }
  }, [user, cloudSynced, stateRef, theme, events, setLastAutoBackupAt]);

  // Checks once on mount (covers "app just opened, a day or more has passed")
  // and hourly after that (covers a long-lived tab crossing the day boundary
  // without a reload) — same setInterval + in-flight-guard shape as
  // useGoogleCalendarSync's periodic poll.
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;
    runAutomaticBackupIfDue();
    const handle = setInterval(runAutomaticBackupIfDue, AUTO_BACKUP_CHECK_INTERVAL_MS);
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

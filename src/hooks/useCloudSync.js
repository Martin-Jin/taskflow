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
import { buildBackupPayload, isValidBackupPayload, downloadBackupFile, readBackupFile } from '../services/backupService';
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
import { dedupeEventsByOccurrence } from '../utils/eventUtils';
import { getBrowserTimeZone } from '../utils/dateUtils';
import { savePersisted } from '../utils/persistence.js';

const PUSH_DEBOUNCE_MS = 1500;

/**
 * @param {Object} deps
 * @param {Object} deps.state - Current combined syncable state (tasks/blocks/
 *   sections/projects/labels/routines/rules/events/soundEnabled/soundVolume/
 *   animationsEnabled/notificationSettings/notes/shortcutBindings) — a plain
 *   object recomputed whenever any of those fields changes, purely so the
 *   push-scheduling effect below has something to depend on.
 * @param {React.MutableRefObject} deps.stateRef - Ref mirroring `state`, read
 *   from async callbacks (the debounced push, backup builders) that need the
 *   LATEST snapshot rather than whatever was closed over when they were created.
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
 * @param {Function} deps.setEvents - Setter for events
 * @param {Function} deps.setSoundEnabled - Setter for soundEnabled
 * @param {Function} deps.setSoundVolume - Setter for soundVolume
 * @param {Function} deps.setAnimationsEnabled - Setter for animationsEnabled
 * @param {Function} deps.setNotificationSettings - Setter for notificationSettings
 * @param {Function} deps.setNotes - Setter for notes
 * @param {Function} deps.setShortcutBindings - Setter for shortcutBindings
 * @param {*} deps.theme - Current theme (owned live by ThemeContext) — only
 *   read here so a backup payload can capture it (see BACKUP_FIELDS).
 * @param {Function} deps.setTheme - Applies a restored backup's theme.
 * @returns {Object} Cloud sync state and callbacks
 */
export function useCloudSync({
  state,
  stateRef,
  setNotification,
  commit,
  overwritePresent,
  setSections,
  setProjects,
  setLabels,
  setRoutines,
  setRules,
  setEvents,
  setSoundEnabled,
  setSoundVolume,
  setAnimationsEnabled,
  setNotificationSettings,
  setNotes,
  setShortcutBindings,
  theme,
  setTheme,
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

  const pushTimerRef = useRef(null);
  const lastPushedFingerprintRef = useRef(null);
  const unsubscribeRef = useRef(null);
  const isApplyingRemoteRef = useRef(false);

  // ---- Compute a fingerprint of the current state to detect echo -----------
  const computeFingerprint = useCallback((source) => {
    const relevant = {
      tasks: source.tasks,
      blocks: source.blocks,
      sections: source.sections,
      projects: source.projects,
      labels: source.labels,
      routines: source.routines,
      rules: source.rules,
      events: source.events,
      soundEnabled: source.soundEnabled,
      soundVolume: source.soundVolume,
      animationsEnabled: source.animationsEnabled,
      notificationSettings: source.notificationSettings,
      notes: source.notes,
      shortcutBindings: source.shortcutBindings,
    };
    return JSON.stringify(relevant);
  }, []);

  // ---- Debounced push to Firestore -----------------------------------------
  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(async () => {
      if (!user) return;
      const currentState = stateRef.current;
      const fingerprint = computeFingerprint(currentState);
      if (fingerprint === lastPushedFingerprintRef.current) return; // no change
      setIsPushingCloud(true);
      try {
        // Stamp the ref before the write resolves, not after — otherwise a
        // local change made while this push is in flight can race the live
        // listener below, which would mistake the server echo for a genuine
        // remote change and stomp whatever just changed locally.
        lastPushedFingerprintRef.current = fingerprint;
        await pushUserData(user.uid, currentState);
      } catch (err) {
        console.warn('[useCloudSync] Push failed', err);
      } finally {
        setIsPushingCloud(false);
      }
    }, PUSH_DEBOUNCE_MS);
  }, [user, stateRef, computeFingerprint]);

  // ---- Apply remote data (from Firestore snapshot or an initial pull) ------
  // Mirrors applyBackupPayload below field-for-field, but routes tasks/blocks
  // through overwritePresent (NOT commit) since this data came from
  // elsewhere, not a local user action — it shouldn't be undoable, and
  // shouldn't consume a redo slot. A field missing from `remoteData` (an
  // older/partial doc) leaves that field untouched rather than wiping it.
  const applyRemoteData = useCallback((remoteData) => {
    isApplyingRemoteRef.current = true;
    if ('tasks' in remoteData || 'blocks' in remoteData) {
      overwritePresent({ tasks: remoteData.tasks ?? stateRef.current.tasks, blocks: remoteData.blocks ?? stateRef.current.blocks });
    }
    if ('sections' in remoteData) setSections(remoteData.sections);
    if ('projects' in remoteData) setProjects(remoteData.projects);
    if ('labels' in remoteData) setLabels(remoteData.labels);
    if ('routines' in remoteData) setRoutines(remoteData.routines);
    if ('rules' in remoteData) setRules(remoteData.rules);
    if ('events' in remoteData) setEvents(dedupeEventsByOccurrence(remoteData.events));
    if ('soundEnabled' in remoteData) setSoundEnabled(remoteData.soundEnabled);
    if ('soundVolume' in remoteData) setSoundVolume(remoteData.soundVolume);
    if ('animationsEnabled' in remoteData) setAnimationsEnabled(remoteData.animationsEnabled);
    // This device's own browser timezone always wins over whatever timezone
    // the remote doc carries (another device's, possibly stale).
    if ('notificationSettings' in remoteData) {
      setNotificationSettings({ ...remoteData.notificationSettings, timezone: getBrowserTimeZone() });
    }
    if ('notes' in remoteData) setNotes(remoteData.notes);
    else if ('pinnedLinks' in remoteData) setNotes(migrateLinksToNotes(remoteData.pinnedLinks)); // legacy remote doc, see notesModel.js migration note
    if ('shortcutBindings' in remoteData) {
      setShortcutBindings(remoteData.shortcutBindings);
      // Also write localStorage directly (not just React state) so the hot
      // keydown listener (see useKeyboardShortcuts.js) picks up an incoming
      // remote binding immediately, not just on this device's next local rebind.
      savePersisted('shortcutBindings', remoteData.shortcutBindings);
    }
    // Stamp what we just applied as "already synced" so the debounced push
    // effect doesn't immediately echo this same data straight back to Firestore.
    lastPushedFingerprintRef.current = computeFingerprint(remoteData);
    isApplyingRemoteRef.current = false;
  }, [
    overwritePresent,
    stateRef,
    computeFingerprint,
    setSections,
    setProjects,
    setLabels,
    setRoutines,
    setRules,
    setEvents,
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
      commit({ tasks: payload.tasks ?? stateRef.current.tasks, blocks: payload.blocks ?? stateRef.current.blocks }, 'Restored from backup');
    }
    if ('sections' in payload) setSections(payload.sections);
    if ('projects' in payload) setProjects(payload.projects);
    if ('labels' in payload) setLabels(payload.labels);
    if ('routines' in payload) setRoutines(payload.routines);
    if ('rules' in payload) setRules(payload.rules);
    if ('events' in payload) setEvents(dedupeEventsByOccurrence(payload.events));
    if ('soundEnabled' in payload) setSoundEnabled(payload.soundEnabled);
    if ('soundVolume' in payload) setSoundVolume(payload.soundVolume);
    if ('animationsEnabled' in payload) setAnimationsEnabled(payload.animationsEnabled);
    if ('notificationSettings' in payload) {
      setNotificationSettings({ ...payload.notificationSettings, timezone: getBrowserTimeZone() });
    }
    if ('theme' in payload) setTheme(payload.theme);
    if ('notes' in payload) setNotes(payload.notes);
    else if ('pinnedLinks' in payload) setNotes(migrateLinksToNotes(payload.pinnedLinks)); // legacy backup file, see notesModel.js migration note
    if ('shortcutBindings' in payload) {
      setShortcutBindings(payload.shortcutBindings);
      savePersisted('shortcutBindings', payload.shortcutBindings);
    }
  }, [
    commit,
    stateRef,
    setSections,
    setProjects,
    setLabels,
    setRoutines,
    setRules,
    setEvents,
    setSoundEnabled,
    setSoundVolume,
    setAnimationsEnabled,
    setNotificationSettings,
    setTheme,
    setNotes,
    setShortcutBindings,
  ]);

  // ---- Subscribe to Firestore on mount (when user is available) ------------
  useEffect(() => {
    if (!user || !cloudSynced) return undefined;

    const unsubscribe = subscribeUserData(user.uid, (remoteData) => {
      if (!remoteData) return;
      const fingerprint = computeFingerprint(stateRef.current);
      const remoteFingerprint = computeFingerprint(remoteData);
      if (fingerprint === remoteFingerprint) return; // echo of our own push
      applyRemoteData(remoteData);
    });
    unsubscribeRef.current = unsubscribe;
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cloudSynced]);

  // ---- Initial pull on mount (when user is available) ----------------------
  useEffect(() => {
    if (!user || !cloudSynced) return;

    let cancelled = false;
    (async () => {
      setIsPullingCloud(true);
      try {
        const remoteData = await pullUserData(user.uid);
        if (!cancelled && remoteData) {
          applyRemoteData(remoteData);
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
    const payload = buildBackupPayload({ ...stateRef.current, theme });
    downloadBackupFile(payload);
    setNotification({ type: 'success', message: 'Backup exported.' });
  }, [stateRef, theme, setNotification]);

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
      const payload = buildBackupPayload({ ...stateRef.current, theme });
      await createBackup(user.uid, payload);
      setNotification({ type: 'success', message: 'Cloud backup created.' });
      // Refresh the backup list
      const backups = await listBackups(user.uid);
      setCloudBackups(backups);
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: 'Failed to create cloud backup.' });
    }
  }, [user, stateRef, theme, setNotification]);

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
    toggleCloudSync,
    pullFromCloud,
    pushToCloud,
    exportBackup,
    importBackup,
    createCloudBackup,
    loadCloudBackups,
    restoreCloudBackup,
    removeCloudBackup,
    isApplyingRemoteRef,
  };
}

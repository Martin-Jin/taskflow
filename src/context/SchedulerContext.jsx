/**
 * ============================================================================
 * SchedulerContext
 * ============================================================================
 * The single source of truth for the app's scheduling state. Wraps
 * useHistoryState (undo/redo) and exposes high-level actions that ALWAYS
 * commit a new history entry, so every mutation is automatically undoable.
 *
 * Anything that touches tasks/blocks should go through this context rather
 * than manipulating state directly in components — this keeps Undo/Redo
 * reliable and keeps the scheduling engine calls in one place.
 *
 * PERSISTENCE MODEL:
 *   - tasks / blocks / sections / projects / events are all seeded from
 *     localStorage on boot and re-saved on every change, so nothing is
 *     lost on refresh.
 *   - Todoist is a ONE-TIME IMPORT, not a live sync: nothing here ever
 *     fetches from Todoist automatically. `importFromTodoist()` below is
 *     the only thing that talks to Todoist's API, and it only runs when
 *     the user explicitly triggers it from Settings. Once imported, a task
 *     is exactly as locally-editable as any manually-created one — no
 *     field is ever pushed back to Todoist, and re-running the import
 *     later just upserts (updates existing imported items by id, adds new
 *     ones) rather than wiping out local edits by replacing everything.
 *
 * RECURRING TASKS: a Task can carry `isRecurring` + `recurrenceString`
 * (captured from Todoist's `due.is_recurring` / `due.string` on import, or
 * set directly when adding/editing a local task). Completing a recurring
 * task does NOT set `isCompleted` — mirroring Todoist's own behavior —
 * instead its due date advances to the next occurrence, computed locally
 * via `utils/recurrence.js`.
 *
 * Google Calendar sync and Firestore cloud sync have been extracted into
 * useGoogleCalendarSync and useCloudSync hooks respectively — see
 * src/hooks/ for those files.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHistoryState } from '../hooks/useHistoryState';
import { usePersistedState } from '../hooks/usePersistedState';
import { useNotificationChecker } from '../hooks/useNotificationChecker';
import { useGoogleCalendarSync } from '../hooks/useGoogleCalendarSync';
import { useCloudSync } from '../hooks/useCloudSync';
import { loadPersisted, savePersisted } from '../utils/persistence.js';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { DEFAULT_NOTES, migrateLinksToNotes } from '../components/Dashboard/notesModel';
import { playAddSound, playDeleteSound } from '../services/soundService';
import { uploadCommentAttachment, deleteCommentAttachment } from '../services/attachmentService';
import { rebalance, planToday } from '../algorithms/rebalanceEngine';
import { areDependenciesMet } from '../utils/dependencyUtils';
import { computeNextDueDate, deriveRecurrenceRule } from '../utils/recurrence';
import {
  fetchTasks as fetchTodoistTasks,
  fetchSections as fetchTodoistSections,
  fetchProjects as fetchTodoistProjects,
} from '../services/todoistService';
import {
  pushEventToCalendar,
  deleteCalendarEvent,
  pushEventInstanceUpdate,
  deleteCalendarEventInstance,
} from '../services/googleCalendarService';
import { getDefaultRoutines, getDefaultRules, getMockTasks, getMockSections, getMockProjects } from '../services/mockData';
import { toISODate, addDays, timeToMinutes, minutesToTime, getBrowserTimeZone } from '../utils/dateUtils';
import { resolveEventId, truncateRuleUntil, rebaseRuleForSplit } from '../utils/recurrenceExpansion';
import { dedupeEventsByOccurrence } from '../utils/eventUtils';
import { nextLabelColor } from '../utils/labelColor';
import { migrateBlockedTimeToEvents } from '../migrations/migrateBlockedTimeToEvents';
import { migrateSubtasksToTasks } from '../migrations/migrateSubtasksToTasks';

const SchedulerContext = createContext(null);

function getDefaultNotificationSettings() {
  return {
    inAppEnabled: true,
    emailEnabled: false,
    taskStartingSoon: true,
    taskOverdue: true,
    taskDueToday: true,
    startingSoonMinutes: 10,
    timezone: getBrowserTimeZone(),
  };
}

let localIdSequence = 0;
function generateLocalId(prefix) {
  localIdSequence += 1;
  return `${prefix}_${Date.now()}_${localIdSequence}`;
}

function buildNewTaskObject(taskInput, id) {
  const merged = {
    id,
    remainingHours: taskInput.estimatedHours,
    isLocked: false,
    isCompleted: false,
    isRecurring: false,
    recurrenceString: null,
    minChunkHours: 0.5,
    maxChunkHours: 4,
    dependsOn: [],
    isPassive: false,
    earliestDate: null,
    enforceDueDate: false,
    fixedTime: null,
    link: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'manual',
    ...taskInput,
  };
  return { ...merged, recurrenceRule: deriveRecurrenceRule(merged.recurrenceString) };
}

/**
 * Splits a true-RRULE master event's series in two at `occurrenceDate`,
 * implementing 'following' ("this and all future occurrences") scope for
 * both updateEvent and setEventIgnored below. A true-RRULE series (as
 * opposed to a "synthetic" one — see googleCalendarService.withSyntheticSeries)
 * is stored as exactly ONE row (the master, `seriesId === id`), so unlike a
 * synthetic series' scope fan-out (below) there's no second row to just
 * filter/map over — a new one has to be created.
 *   - The OLD master keeps its own id/googleEventId; its recurrenceRule is
 *     truncated to end the day before occurrenceDate (see
 *     truncateRuleUntil), so it now only produces occurrences strictly
 *     BEFORE the split.
 *   - A NEW master is created dated `occurrenceDate` with `fieldUpdates`
 *     applied on top of a clone of the old master, re-anchored via
 *     rebaseRuleForSplit (same FREQ/INTERVAL/BYDAY, carrying over the
 *     original series' own end bound if it had one). It has no
 *     googleEventId yet — from Google's point of view this is a brand new
 *     series (pushEventToCalendar will `insert`, not `update`).
 *   - Only override entries dated >= occurrenceDate are carried onto the
 *     new master (earlier ones belong to occurrences the old master still
 *     owns).
 * `newMasterId` is generated by the caller (not internally via e.g.
 * `Date.now()`) and threaded through explicitly — updateEvent below calls
 * this indirectly (via applyEventScopeUpdate) TWICE per edit for unrelated
 * reasons (once for the actual state write, once — against a possibly
 * different `prevEvents` snapshot — to compute what to push to Google), and
 * both calls need to agree on the new row's id or the post-push
 * googleEventId patch-back would target a row that doesn't match what was
 * actually committed to state.
 * @returns {{events: Array, newMaster: Object, updatedOldMaster: Object}}
 */
function splitSeriesAtOccurrence(prevEvents, master, occurrenceDate, fieldUpdates, newMasterId) {
  const dayBefore = addDays(occurrenceDate, -1);
  const updatedOldMaster = { ...master, recurrenceRule: truncateRuleUntil(master.recurrenceRule, dayBefore) };

  const carriedOverrides = {};
  for (const [date, ov] of Object.entries(master.overrides || {})) {
    if (date >= occurrenceDate) carriedOverrides[date] = ov;
  }

  const newMaster = {
    ...master,
    ...fieldUpdates,
    id: newMasterId,
    date: occurrenceDate,
    recurrenceRule: rebaseRuleForSplit(master.recurrenceRule, master.date, occurrenceDate),
    overrides: carriedOverrides,
    googleEventId: null, // a new series from Google's POV
  };
  newMaster.seriesId = newMaster.id; // matches googleCalendarService's "master's own id doubles as its seriesId" convention

  const events = prevEvents.map((e) => (e.id === master.id ? updatedOldMaster : e)).concat(newMaster);
  return { events, newMaster, updatedOldMaster };
}

/**
 * Shared by updateEvent (state update) and its Google-push side effect
 * below — applies `stamped` field updates onto `eventId`, optionally
 * spreading across its recurring series per the same 'this'/'following'/
 * 'all' scope semantics setEventIgnored uses. Pulled out as a standalone
 * function (rather than only living inside a setEvents updater) so
 * updateEvent can compute the resulting event data to push to Google
 * without waiting for React to actually commit the state update.
 *
 * `eventId` may be a VIRTUAL id (`${masterId}::${occurrenceDate}`, see
 * recurrenceExpansion.resolveEventId) when the target is a single
 * occurrence of a true-RRULE Google series stored as one master row (see
 * that module's doc comment) — resolved back to the real master row before
 * anything is touched. For a real id (manual event, or a "synthetic"
 * series' own real per-occurrence rows — see googleCalendarService), scope
 * fan-out behaves exactly as before this fix.
 *
 * @param {string} [splitId] - For scope 'following' on a true-RRULE
 *   occurrence, the id to give the newly-created master (see
 *   splitSeriesAtOccurrence) — threaded in by the caller rather than
 *   generated here so that updateEvent's two separate calls to this
 *   function for the same logical edit (one for the state write, one to
 *   compute Google push targets) agree on the new row's id. Unused for any
 *   other scope/event shape.
 * @returns {{events: Array, pushTargets: Array}} `pushTargets` lists every
 *   event object that changed and would need pushing to Google — for a
 *   plain edit or 'all' scope this is just the one edited/master row; for a
 *   'following' split on a true-RRULE series it's BOTH the truncated old
 *   master (an update — its Google-side RRULE must also gain the UNTIL, or
 *   the next pull would resurrect the un-truncated series over the split,
 *   per eventSyncService's "Google always wins on pull" policy) and the
 *   newly-created master (an insert). The caller (updateEvent) decides
 *   whether pushTargets is actually pushed — a 'this'-scope edit on a
 *   true-RRULE occurrence is local-only (see updateEvent's own comment).
 */
function applyEventScopeUpdate(prevEvents, eventId, stamped, scope, splitId) {
  const { masterId, occurrenceDate, isVirtual } = resolveEventId(eventId);

  if (!isVirtual) {
    const target = prevEvents.find((e) => e.id === eventId);
    if (!target || scope === 'this' || !target.seriesId) {
      const events = prevEvents.map((e) => (e.id === eventId ? { ...e, ...stamped } : e));
      return { events, pushTargets: [events.find((e) => e.id === eventId)].filter(Boolean) };
    }
    const events = prevEvents.map((e) => {
      if (e.seriesId !== target.seriesId) return e;
      if (scope === 'following' && e.date < target.date) return e;
      return { ...e, ...stamped };
    });
    return { events, pushTargets: [] }; // a synthetic (non-RRULE) series has no single "master" record to push
  }

  // True-RRULE occurrence: exactly one real row (the master) exists.
  const master = prevEvents.find((e) => e.id === masterId);
  if (!master) return { events: prevEvents, pushTargets: [] };

  if (scope === 'all') {
    const updatedMaster = { ...master, ...stamped };
    const events = prevEvents.map((e) => (e.id === masterId ? updatedMaster : e));
    return { events, pushTargets: [updatedMaster] };
  }

  if (scope === 'following') {
    const { events, newMaster, updatedOldMaster } = splitSeriesAtOccurrence(prevEvents, master, occurrenceDate, stamped, splitId);
    return { events, pushTargets: [updatedOldMaster, newMaster] };
  }

  // scope === 'this' — folds the edit into the master's per-occurrence
  // overrides map instead of touching its own top-level fields, so it only
  // ever affects this one date. Never pushed — see updateEvent's comment.
  const updatedMaster = {
    ...master,
    overrides: { ...(master.overrides || {}), [occurrenceDate]: { ...(master.overrides?.[occurrenceDate]), ...stamped } },
  };
  const events = prevEvents.map((e) => (e.id === masterId ? updatedMaster : e));
  return { events, pushTargets: [] };
}
/**
 * All ids of `taskId`'s descendants (children, grandchildren, ...) via the
 * `parentId` chain — shared by completeTask's cascade (reset a recurring
 * parent's whole subtree / complete a non-recurring parent's whole subtree)
 * and deleteTask's cascade-delete, so a parent's subtree always moves
 * together instead of leaving orphaned or inconsistent children behind.
 *
 * Nothing in the app's own UI can create a `parentId` cycle (it's only ever
 * set once, at creation, and never re-parented), but a `visited` guard costs
 * nothing and stops a hand-edited/corrupted backup restore from hanging the
 * tab in an infinite loop.
 */
function getDescendantIds(taskId, tasks) {
  const childrenByParentId = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const siblings = childrenByParentId.get(t.parentId) || [];
    siblings.push(t.id);
    childrenByParentId.set(t.parentId, siblings);
  }
  const descendants = [];
  const visited = new Set([taskId]);
  const queue = [...(childrenByParentId.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    descendants.push(id);
    queue.push(...(childrenByParentId.get(id) || []));
  }
  return descendants;
}

export function SchedulerProvider({ children }) {
  const { user } = useAuth();
  // Owned live by ThemeContext (which wraps this provider — see App.jsx) —
  // only read/written here so the backup payload (exportBackup/
  // createCloudBackup, both in useCloudSync) can capture it and a restore
  // (importBackup/restoreCloudBackup, also in useCloudSync) can apply it back.
  const { theme, setTheme } = useTheme();

  // tasks/blocks: seeded from whatever was last saved locally (falling back
  // to mock data on first-ever run). Whether the initial-load effect below
  // overwrites `tasks` depends on whether Todoist sync is actually active
  // (see the effect) — `blocks` (calendar placements) have no Todoist
  // equivalent and are NEVER overwritten by that effect; the persisted
  // copy is always the source of truth for them.
  const { state, commit, undo, redo, canUndo, canRedo, currentActionLabel, currentActionId, overwritePresent} = useHistoryState({
    tasks: loadPersisted('tasks', null) ?? getMockTasks(),
    blocks: loadPersisted('blocks', null) ?? [],
  });

  // Bottom-corner "Task added"/"Event saved"-style toast with an inline
  // Undo, replacing the old always-on topbar text label. `currentActionId`
  // only changes to a value we haven't seen before when commit() lands a
  // genuinely new action — undo/redo revisit an id already in this set (so
  // they clear any stale toast instead of popping a new one), and the
  // cloud-sync `overwritePresent` path never touches it at all.
  const [actionToast, setActionToast] = useState(null);
  const seenActionIdsRef = useRef(new Set([currentActionId]));
  useEffect(() => {
    // overwritePresent() (cloud sync / initial load) mints a fresh
    // `sync_...` id every time rather than reusing one we've already seen,
    // so it can't be caught by the "seen before" check below — skip it
    // explicitly instead, or every sync would pop a stale Undo toast.
    if (currentActionId.startsWith('sync_') || seenActionIdsRef.current.has(currentActionId)) {
      seenActionIdsRef.current.add(currentActionId);
      setActionToast(null);
      return;
    }
    seenActionIdsRef.current.add(currentActionId);
    setActionToast({ id: currentActionId, label: currentActionLabel });
  }, [currentActionId, currentActionLabel]);
  const dismissActionToast = useCallback(() => setActionToast(null), []);

  // Pure user preferences — persisted verbatim, no Todoist/Google
  // equivalent to fall back on, so these must survive a refresh or every
  // setting (work hours, buffer days, routines...) would silently reset
  // each time the app is opened.
  const [routines, setRoutines] = usePersistedState('routines', getDefaultRoutines);
  const [rules, setRules] = usePersistedState('rules', getDefaultRules);
  // Sound effect settings — synced/backed-up siblings of routines/rules (see
  // BACKUP_FIELDS) rather than SoundContext's own local-only state, so they
  // follow the user across devices and survive a backup restore like every
  // other setting. SoundContext (rendered inside this provider) just reads
  // these via useScheduler() instead of maintaining an independent copy.
  const [soundEnabled, setSoundEnabled] = usePersistedState('soundEnabled', true);
  const [soundVolume, setSoundVolume] = usePersistedState('soundVolume', 0.5);
  // Global animation toggle — same synced-setting treatment as sound above.
  // Applied to the DOM via the effect below (mirrors ThemeContext's
  // data-theme attribute) so global.css can key off it.
  const [animationsEnabled, setAnimationsEnabled] = usePersistedState('animationsEnabled', true);
  // Notification settings (TODO.md #10). In-app firing logic lives in
  // useNotificationChecker (Phase 2); emailEnabled is inert client-side and
  // waits on a Cloud Functions backend (Phase 3). Kept as one object (rather
  // than separate usePersistedState calls per toggle) since these are all
  // facets of a single feature that's always read/written together — same
  // synced-setting treatment as sound/animations above, following it through
  // the same list of places (useCloudSync's applyRemoteData/applyBackupPayload,
  // its cloud-push payload, and the context value below), plus BACKUP_FIELDS
  // in backupService.js.
  const [notificationSettings, setNotificationSettings] = usePersistedState('notificationSettings', getDefaultNotificationSettings);

  // Keep notificationSettings.timezone resynced to the browser's own IANA
  // timezone on every load — covers both an existing user who predates this
  // field (it's simply undefined until this runs once) and a returning user
  // who's switched devices or traveled since their last sync. Deliberately
  // unconditional (not gated on `user`) so it applies for signed-out/local-
  // only usage too. Runs before the cloud-sync effects further down, so a
  // remote pull that follows (see applyRemoteData) still gets the last word
  // for a signed-in user — it re-applies this same detected value there too,
  // ensuring the freshly-detected browser zone always wins over whatever's
  // stored locally or in the cloud, rather than a stale value from another
  // device sticking around.
  useEffect(() => {
    const detected = getBrowserTimeZone();
    setNotificationSettings((prev) => (prev.timezone === detected ? prev : { ...prev, timezone: detected }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-animations', animationsEnabled ? 'on' : 'off');
  }, [animationsEnabled]);

  // Folder-organized sticky notes (see Dashboard/NotesCard.jsx) — lifted up
  // here (rather than that component's own local usePersistedState) so this
  // user-created content follows them across devices and survives a backup
  // restore, same as routines/rules/sound settings.
  //
  // ONE-TIME MIGRATION — safe to delete this lazy initializer's fallback
  // (and just pass DEFAULT_NOTES directly) once no user's localStorage can
  // still have data under the old `pinnedLinks` key, i.e. once every active
  // user has loaded a version with this migration at least once. Reads the
  // old bookmark-style pinned-links shape directly (bypassing usePersistedState,
  // which only reads the *new* 'notes' key) and converts it once; from then
  // on 'notes' exists and this branch is never taken again.
  const [notes, setNotes] = usePersistedState('notes', () => {
    const legacy = loadPersisted('pinnedLinks', null);
    return legacy ? migrateLinksToNotes(legacy) : DEFAULT_NOTES;
  });
  // Custom keyboard-shortcut rebindings — the SOURCE OF TRUTH for these still
  // lives in localStorage under this exact same key, written directly by
  // useKeyboardShortcuts.js's setShortcutBinding/resetShortcutBinding (its
  // global keydown listener deliberately reads localStorage fresh on every
  // keydown, not through React state/context, for hot-path performance —
  // see that file's doc comment). This is a React-state MIRROR of that same
  // localStorage entry, kept in sync by ShortcutsModal.jsx after every write,
  // purely so it can be pushed/pulled/backed-up like every other setting.
  const [shortcutBindings, setShortcutBindings] = usePersistedState('shortcutBindings', {});
  // When the last one-time Todoist import ran, and how many tasks it
  // touched — shown as a status line in Settings so a re-import isn't a
  // total mystery each time ("last imported 3 tasks, 2 days ago").
  const [lastTodoistImport, setLastTodoistImport] = usePersistedState('lastTodoistImport', null);

  // Guards the one-time migrateBlockedTimeToEvents backfill below so it only
  // ever runs once per device instead of re-running (harmlessly, but
  // pointlessly) on every load. See src/migrations/migrateBlockedTimeToEvents.js.
  const [blockedTimeMigrationDone, setBlockedTimeMigrationDone] = usePersistedState('blockedTimeMigrationDone', false);

  // Guards the one-time migrateSubtasksToTasks backfill below — see
  // src/migrations/migrateSubtasksToTasks.js for why (the old nested
  // Task.subtasks array became standalone Tasks linked by parentId).
  const [subtasksMigrationDone, setSubtasksMigrationDone] = usePersistedState('subtasksMigrationDone', false);

  // events: seeded from local storage so a refresh doesn't blank the
  // calendar grid while the silent Google re-auth (below) is in flight, or
  // permanently if Google Calendar isn't configured at all (mock events
  // persist too, which is fine — they're deterministic from `mockData.js`
  // regardless).
  const [events, setEvents] = useState(() => dedupeEventsByOccurrence(loadPersisted('events', null) ?? []));

  // sections/projects: same idea as tasks — seeded from local storage, and
  // only ever touched by importFromTodoist's upsert-merge (see below), not
  // by anything that runs automatically on load.
  const [sections, setSections] = useState(() => loadPersisted('sections', null) ?? getMockSections());
  const [projects, setProjects] = useState(() => loadPersisted('projects', null) ?? getMockProjects());
  // labels: app-local tags (see types/index.js's Label typedef) — Todoist
  // does have its own label concept, and importFromTodoist maps a task's
  // Todoist labels onto these (creating any that don't exist yet by name),
  // but nothing here is ever pushed back to Todoist.
  const [labels, setLabels] = useState(() => loadPersisted('labels', null) ?? []);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  // Separate from isSyncing — Todoist import / Google push / cloud "Sync
  // now" are all conceptually "talk to a third party", while backups are
  // TaskFlow talking to its own storage. Keeping them distinct avoids a
  // Backups button reading "Syncing…" (or vice versa) if a user ever
  // triggers both around the same time.
  // Busy flag specifically for the cloud-backup create/restore actions below
  // (createCloudBackup/restoreCloudBackup, both from useCloudSync) — that
  // hook doesn't track its own busy state for these, so it's tracked here,
  // right around the two call sites that wrap them.
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [lastOverflow, setLastOverflow] = useState([]);
  // Separate from lastOverflow: planToday's "didn't fit today" list carries a
  // different meaning (see runPlanToday below) and must never be conflated
  // with rebalance's "at risk of missing its deadline" overflow.
  const [lastUnfitToday, setLastUnfitToday] = useState([]);
  const [notification, setNotification] = useState(null);
  // Ephemeral cross-component "jump to a Settings section" signal — not
  // persisted/synced/backed-up, just a bumped-counter request (mirrors the
  // addTaskSignal pattern in App.jsx) so components outside SettingsPanel can
  // switch to the Settings tab and scroll to a specific section.
  const [settingsSectionRequest, setSettingsSectionRequest] = useState(null);

  const requestSettingsSection = useCallback((section) => {
    setSettingsSectionRequest((prev) => ({ section, requestId: prev ? prev.requestId + 1 : 1 }));
  }, []);

  const { tasks, blocks } = state;

  // In-app notification checker (TODO.md #10, Phase 2) — scans tasks/blocks
  // on an interval and fires a native Notification (or Toast fallback) per
  // notificationSettings' toggles. Fully inert when in-app notifications are
  // off. Lives in its own hook rather than inline here since this file is
  // already large — see hooks/useNotificationChecker.js for the trigger/
  // dedupe logic.
  useNotificationChecker({ tasks, blocks, notificationSettings, setNotification });

  // Async Todoist-sync continuations (the `.then()` after a create call)
  // resolve after the fact, potentially after other commits have landed —
  // closing over `tasks`/`blocks` directly would replay a stale snapshot
  // and silently clobber whatever changed in the meantime. This ref always
  // holds the latest committed state for those continuations to read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);


  // The Todoist token: a per-visitor personal API token entered in Settings
  // (see setTodoistApiToken below), persisted to THIS BROWSER's localStorage
  // only — never bundled into the build, since this app is hosted as a
  // public static site and a build-time token would leak the deployer's own
  // Todoist account to every visitor. `VITE_TODOIST_API_TOKEN` is still read
  // as a fallback purely for local `npm run dev` convenience; it's gitignored
  // (see .env.example) and stays out of any production build a visitor uses.
  // A ref (not state) because importFromTodoist needs the current value
  // without re-creating its callback whenever unrelated state changes;
  // changing the token instead reloads the page (see setTodoistApiToken),
  // which naturally re-reads this on the fresh mount.
  const todoistTokenRef = useRef(loadPersisted('todoistToken', null) || import.meta.env.VITE_TODOIST_API_TOKEN || null);
  const todoistToken = todoistTokenRef.current;
  const todoistEnabled = !!todoistToken; // "is a Todoist token configured" — governs whether Import is available

  /**
   * Save (or clear, if passed a falsy value) the visitor's personal Todoist
   * API token and reload the app so every hook/effect that reads
   * `todoistToken` picks up the new value on a clean mount — simpler and
   * less error-prone than threading a live token change through the
   * initial-load effect and every memoized write callback above.
   */
  const setTodoistApiToken = useCallback((token) => {
    const trimmed = (token || '').trim();
    savePersisted('todoistToken', trimmed || null);
    window.location.reload();
  }, []);

  // ---- Persist tasks/blocks/sections/projects/events on every change -------
  // These live inside useHistoryState / plain useState rather than
  // usePersistedState (tasks+blocks are one atomic unit tied to undo/redo;
  // sections/projects/events are also written to imperatively via their
  // setters in several places), so they're persisted via a plain effect
  // instead of the usePersistedState wrapper.
  useEffect(() => {
    savePersisted('tasks', tasks);
  }, [tasks]);

  useEffect(() => {
    savePersisted('blocks', blocks);
  }, [blocks]);

  useEffect(() => {
    savePersisted('sections', sections);
  }, [sections]);

  useEffect(() => {
    savePersisted('projects', projects);
  }, [projects]);

  useEffect(() => {
    savePersisted('labels', labels);
  }, [labels]);

  useEffect(() => {
    savePersisted('events', events);
  }, [events]);

  // ONE-TIME MIGRATION — see src/migrations/migrateBlockedTimeToEvents.js. Safe to delete this effect once the flag above is true for all users.
  useEffect(() => {
    if (blockedTimeMigrationDone) return;
    setEvents((prev) => migrateBlockedTimeToEvents(prev));
    setBlockedTimeMigrationDone(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ONE-TIME MIGRATION — see src/migrations/migrateSubtasksToTasks.js. Only
  // actually commits a new history entry when this device's data has legacy
  // embedded subtasks to convert, so most users (who never had any) don't
  // get a needless "Migrated sub-tasks" entry in their Undo stack. Safe to
  // delete this effect once the flag above is true for all users.
  useEffect(() => {
    if (subtasksMigrationDone) return;
    if (stateRef.current.tasks.some((t) => t.subtasks && t.subtasks.length > 0)) {
      commit({ tasks: migrateSubtasksToTasks(stateRef.current.tasks), blocks: stateRef.current.blocks }, 'Migrated sub-tasks to standalone tasks');
    }
    setSubtasksMigrationDone(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Completed task retention sweep --------------------------------------
  // Runs once on mount. Completed (non-recurring — recurring tasks never set
  // isCompleted, see completeTask) tasks older than 30 days are dropped along
  // with their blocks, same task-id-based filtering as backupService.js's
  // excludeCompletedTasks. A once-per-load check is enough for this
  // personal-scale app — no need for a running interval on top of it.
  useEffect(() => {
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const isStaleCompleted = (t) => t.isCompleted && t.completedAt && new Date(t.completedAt).getTime() < cutoffMs;
    const staleIds = new Set(stateRef.current.tasks.filter(isStaleCompleted).map((t) => t.id));
    if (staleIds.size === 0) return;
    const newTasks = stateRef.current.tasks.filter((t) => !staleIds.has(t.id));
    const newBlocks = stateRef.current.blocks.filter((b) => !staleIds.has(b.taskId));
    commit({ tasks: newTasks, blocks: newBlocks }, `Removed ${staleIds.size} completed task(s) older than 30 days`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Initial data load ---------------------------------------------------
  // Google Calendar's own silent re-auth/pull now runs inside
  // useGoogleCalendarSync (below), so there's nothing left to block on here —
  // this just clears the loading flag once the one-time migration/sweep
  // effects above have run.
  useEffect(() => {
    setIsLoading(false);
  }, []);

  // ---- Google Calendar sync -------------------------------------------------
  // Connection state, silent re-auth, periodic polling, visibility-refresh,
  // and connect/pull/push actions all live in this hook now — see its own
  // doc comment (src/hooks/useGoogleCalendarSync.js).
  const {
    googleConnected,
    googleNeedsReconnect,
    isPullingGoogleEvents,
    connectGoogleCalendar,
    pullFromGoogleCalendar,
    pushToGoogleCalendar,
  } = useGoogleCalendarSync({ events, setEvents, setNotification, blocks, tasks, commit, stateRef, setActionToast });

  // ---- Cloud sync (Firestore) ------------------------------------------------
  // Pull/push/listener/fingerprint/backup/restore logic all lives in this
  // hook now — see its own doc comment (src/hooks/useCloudSync.js).
  // `cloudSyncState`/`cloudStateRef` bundle every field this sync (and local/
  // cloud backups) cover — everything BACKUP_FIELDS lists except `theme`,
  // which the hook takes as a separate param (see its own JSDoc), since live
  // sync deliberately leaves `theme` to ThemeContext's own independent sync.
  const cloudSyncState = useMemo(
    () => ({
      tasks,
      blocks,
      sections,
      projects,
      labels,
      routines,
      rules,
      events,
      soundEnabled,
      soundVolume,
      animationsEnabled,
      notificationSettings,
      notes,
      shortcutBindings,
    }),
    [tasks, blocks, sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, notificationSettings, notes, shortcutBindings]
  );
  const cloudStateRef = useRef(cloudSyncState);
  useEffect(() => {
    cloudStateRef.current = cloudSyncState;
  }, [cloudSyncState]);

  const {
    cloudBackups,
    pullFromCloud,
    exportBackup,
    importBackup,
    createCloudBackup,
    loadCloudBackups,
    restoreCloudBackup: restoreCloudBackupRaw,
    removeCloudBackup,
  } = useCloudSync({
    state: cloudSyncState,
    stateRef: cloudStateRef,
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
  });

  /**
   * Manual re-sync for Settings' "Sync now" button — covers the gap this
   * app's sync model deliberately leaves open (no live listener would ever
   * fire for a device that's just idly sitting open): if another device
   * pushed changes while this tab was already open and signed in, those
   * changes only arrive on next sign-in/reload/manual sync. Covers both
   * Firestore (useCloudSync's pullFromCloud) and Google Calendar
   * (useGoogleCalendarSync's pullFromGoogleCalendar) in one click; each pops
   * its own success/error toast, so this doesn't layer on a third.
   */
  const syncNow = useCallback(async () => {
    if (!user) return;
    setIsSyncing(true);
    try {
      await pullFromCloud();
      if (googleConnected) await pullFromGoogleCalendar();
    } finally {
      setIsSyncing(false);
    }
  }, [user, pullFromCloud, googleConnected, pullFromGoogleCalendar]);

  /** Settings' "Back up now" button — wraps useCloudSync's createCloudBackup with a busy flag that hook doesn't track itself. */
  const backupToCloud = useCallback(async () => {
    setIsBackingUp(true);
    try {
      await createCloudBackup();
    } finally {
      setIsBackingUp(false);
    }
  }, [createCloudBackup]);

  /** Settings' cloud-backups picker "Restore" action — same busy-flag wrapping as backupToCloud above. */
  const restoreCloudBackup = useCallback(
    async (backupId) => {
      setIsBackingUp(true);
      try {
        await restoreCloudBackupRaw(backupId);
      } finally {
        setIsBackingUp(false);
      }
    },
    [restoreCloudBackupRaw]
  );

  /** Settings' "Restore from file" action — matches old importBackupFromFile's name. */
  const importBackupFromFile = useCallback((file) => importBackup(file), [importBackup]);

  /** Settings' cloud-backups picker open action — matches old refreshCloudBackups' name. */
  const refreshCloudBackups = useCallback(() => loadCloudBackups(), [loadCloudBackups]);

  /** Settings' cloud-backups picker "Delete" action — matches old deleteCloudBackup's name. */
  const deleteCloudBackup = useCallback((backupId) => removeCloudBackup(backupId), [removeCloudBackup]);

  // ---- Core action: run the rebalance/reschedule engine -------------------
  const runRebalance = useCallback(() => {
    const result = rebalance({ tasks, existingBlocks: blocks, routines, events, rules });
    commit({ tasks, blocks: result.blocks }, `Re-balanced schedule (${result.stats.blocksCreated} blocks placed)`);
    setLastOverflow(result.overflow);
    const blockedNote =
      result.stats.blockedByDependencies > 0
        ? ` ${result.stats.blockedByDependencies} task(s) held back pending dependencies.`
        : '';
    if (result.overflow.length > 0) {
      setNotification({
        type: 'warning',
        message: `${result.overflow.length} task(s) couldn't be fully scheduled within their deadline window — consider extending due dates or freeing up capacity.${blockedNote}`,
      });
    } else {
      setNotification({ type: 'success', message: `Schedule rebalanced: ${result.stats.blocksCreated} blocks placed.${blockedNote}` });
    }
    return result;
  }, [tasks, blocks, routines, events, rules, commit]);

  /**
   * Lighter, day-scoped sibling of runRebalance: only clears and replans
   * TODAY's unlocked blocks (see algorithms/rebalanceEngine.planToday for
   * why this can't just be "run the normal rebalance and keep today's
   * slice" — the pacing math needs a dedicated greedy mode). Every other
   * day, past or future, is left exactly as it was.
   */
  const runPlanToday = useCallback(() => {
    const result = planToday({ tasks, existingBlocks: blocks, routines, events, rules });
    commit({ tasks, blocks: result.blocks }, `Planned today (${result.stats.blocksCreated} blocks placed)`);
    setLastUnfitToday(result.unfitToday);
    const blockedNote =
      result.stats.blockedByDependencies > 0
        ? ` ${result.stats.blockedByDependencies} task(s) held back pending dependencies.`
        : '';
    if (result.unfitToday.length > 0) {
      setNotification({
        type: 'warning',
        message: `${result.unfitToday.length} task(s) didn't fully fit in today's remaining capacity — they'll get picked up on a later plan/re-balance.${blockedNote}`,
      });
    } else {
      setNotification({ type: 'success', message: `Today planned: ${result.stats.blocksCreated} blocks placed.${blockedNote}` });
    }
    return result;
  }, [tasks, blocks, routines, events, rules, commit]);

  // ---- Task CRUD -----------------------------------------------------------

  /**
   * Add a task. Always local-only (source: 'manual') — Todoist tasks only
   * ever enter TaskFlow via the one-time importFromTodoist below, never
   * created directly from here.
   *
   * A due date is OPTIONAL — an undated task simply has no planning window
   * for the allocator, so it never gets auto-scheduled, but it still shows
   * up normally in the Tasks list and Board view (matching Todoist).
   */
  const addTask = useCallback(
    (taskInput) => {
      const newTask = buildNewTaskObject(taskInput, generateLocalId('task'));
      // Function form (see useHistoryState's commit doc comment) so several
      // addTask calls in the same synchronous tick — e.g. the AI Assistant
      // applying a multi-task plan — each build on the previous call's
      // result instead of each computing from the same stale `tasks` closure
      // and silently clobbering all but the last one.
      commit((current) => ({ tasks: [...current.tasks, newTask], blocks: current.blocks }), `Added task "${newTask.title}"`);
      if (soundEnabled) playAddSound(soundVolume);
      return newTask;
    },
    [commit, soundEnabled, soundVolume]
  );

  /**
   * Update a task's fields — purely local, regardless of `source`. A
   * Todoist-imported task is exactly as editable as a manual one once it's
   * in TaskFlow; nothing here is ever pushed back to Todoist.
   *
   * LIVE UI UPDATE: because this always calls `commit`, which updates the
   * shared `tasks` array in context, every consumer reading `tasks` (the
   * task list, board, and any open TaskDetailModal that derives its `task`
   * prop from `tasks` rather than holding a stale local copy) re-renders
   * with the new data immediately — no need to close/reopen anything.
   */
  const updateTask = useCallback(
    (taskId, updates) => {
      // Function form — see addTask's comment just above.
      commit(
        (current) => ({
          tasks: current.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const merged = { ...t, ...updates, updatedAt: new Date().toISOString() };
            // recurrenceRule is a derived cache of recurrenceString (see
            // utils/recurrence.js) — recompute it whenever a caller touches
            // recurrenceString so the two can never drift apart.
            return 'recurrenceString' in updates ? { ...merged, recurrenceRule: deriveRecurrenceRule(merged.recurrenceString) } : merged;
          }),
          blocks: current.blocks,
        }),
        `Updated task`
      );
    },
    [commit]
  );

  /**
   * Delete a task, cascading to its whole subtree — a task with children
   * (parentId pointing at it) would otherwise leave those children orphaned,
   * pointing at a parentId that no longer exists.
   */
  const deleteTask = useCallback(
    (taskId) => {
      const idsToDelete = new Set([taskId, ...getDescendantIds(taskId, tasks)]);
      // Scrub every deleted id (parent + descendants) out of every other
      // task's dependsOn — otherwise a dependent task references a task
      // that no longer exists and, since areDependenciesMet() treats a
      // missing dependency as unmet, it would stay permanently blocked with
      // no way to fix it in the UI.
      // Best-effort — deleted tasks' comment attachments would otherwise
      // stay orphaned in Storage forever. Fire-and-forget, not awaited: the
      // task deletion itself shouldn't wait on Storage round-trips. Skipped
      // entirely while signed out — Storage paths are uid-scoped, so the
      // delete would just fail auth (the attachment is orphaned either way;
      // no point spending a network round-trip on a call known to fail).
      if (user) {
        tasks
          .filter((t) => idsToDelete.has(t.id))
          .flatMap((t) => t.comments || [])
          .forEach((c) => {
            if (c.attachment) deleteCommentAttachment(c.attachment.path);
          });
      }
      // Function form — see addTask's comment above. The actual array
      // transform runs against `current`, not the closed-over `tasks`/
      // `blocks`, so this is safe even when several deletes/creates happen
      // in the same synchronous batch.
      commit(
        (current) => ({
          tasks: current.tasks
            .filter((t) => !idsToDelete.has(t.id))
            .map((t) =>
              t.dependsOn?.some((id) => idsToDelete.has(id))
                ? { ...t, dependsOn: t.dependsOn.filter((id) => !idsToDelete.has(id)) }
                : t
            ),
          blocks: current.blocks.filter((b) => !idsToDelete.has(b.taskId)),
        }),
        `Deleted task`
      );
      if (soundEnabled) playDeleteSound(soundVolume);
    },
    [tasks, commit, user, soundEnabled, soundVolume]
  );

  /**
   * Post a new comment on a task, optionally with one file attachment.
   * Uploads the file to Storage first (if present) so the Comment object
   * committed to `tasks` already has a resolved url/path — matches the
   * rest of the app's "Firestore only ever holds fully-formed data" model.
   * Requires a signed-in user for the attachment upload (Storage paths are
   * uid-scoped); text-only comments work whether signed in or not, same as
   * every other local-first field.
   *
   * Applies onto stateRef.current.tasks (the LATEST state), not the `tasks`
   * closed over at call time — an upload can take a while, and any
   * edit/delete that lands while it's in flight would otherwise be silently
   * clobbered when this commits a stale snapshot (same hazard
   * pushToGoogleCalendar works around below).
   */
  const addComment = useCallback(
    async (taskId, { text, file } = {}) => {
      let attachment = null;
      if (file) {
        if (!user) throw new Error('Sign in to attach files to a comment.');
        attachment = await uploadCommentAttachment(user.uid, taskId, file);
      }
      const newComment = {
        id: `comment_${Date.now()}`,
        text: text || '',
        attachment,
        createdAt: new Date().toISOString(),
      };
      const newTasks = stateRef.current.tasks.map((t) =>
        t.id === taskId ? { ...t, comments: [...(t.comments || []), newComment] } : t
      );
      commit({ tasks: newTasks, blocks: stateRef.current.blocks }, 'Added comment');
    },
    [commit, user]
  );

  /**
   * Remove a comment and, if it carried one, its attachment. The Storage
   * delete is best-effort (see deleteCommentAttachment) so a transient
   * failure there never blocks removing the comment itself.
   */
  const deleteComment = useCallback(
    (taskId, commentId) => {
      const task = tasks.find((t) => t.id === taskId);
      const comment = task?.comments?.find((c) => c.id === commentId);
      // See deleteTask's cleanup above for why this is skipped signed-out.
      if (comment?.attachment && user) deleteCommentAttachment(comment.attachment.path);
      const newTasks = tasks.map((t) =>
        t.id === taskId ? { ...t, comments: (t.comments || []).filter((c) => c.id !== commentId) } : t
      );
      commit({ tasks: newTasks, blocks }, 'Deleted comment');
    },
    [tasks, blocks, commit, user]
  );

  const toggleTaskLock = useCallback(
    (taskId) => {
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, isLocked: !t.isLocked } : t));
      commit({ tasks: newTasks, blocks }, `Toggled task lock`);
    },
    [tasks, blocks, commit]
  );

  /**
   * Complete a task.
   *
   * RECURRING TASKS (isRecurring: true): matches Todoist's own behavior —
   * checking off a recurring task does NOT complete it. Instead its due
   * date advances to the next occurrence, computed locally via
   * utils/recurrence.js (a permissive parser with a defensive "does the
   * string look like a recurrence rule" fallback, so "every month",
   * "monthly", "every 1 month", multi-weekday phrases, etc. all advance
   * correctly instead of silently falling back to +1 day) — this is now
   * the only source of truth for the next date, since there's no Todoist
   * round trip to defer to. `remainingHours` resets to `estimatedHours` so
   * it's schedulable again, and `isCompleted` stays false. Any scheduled
   * blocks tied to the task's *previous* occurrence are removed, since they
   * belonged to a cycle that's now closed out.
   *
   * NON-RECURRING TASKS: unchanged — `isCompleted: true`, `remainingHours: 0`.
   *
   * SUB-TASK CASCADE (both branches): completing a task with children
   * (parentId chain, to arbitrary depth) cascades to the whole subtree —
   * see getDescendantIds. For a recurring parent, every descendant is reset
   * (isCompleted: false, dueDate: null) rather than "completed", since the
   * parent itself isn't reaching a final completed state either; a
   * descendant's own recurrence (if any) is irrelevant here, this is an
   * unconditional reset. For a non-recurring parent, every descendant is
   * marked completed right alongside it. There's no upward cascade in
   * either direction — completing a sub-task never auto-completes its
   * parent, matching existing behavior (nothing reads sub-task completion
   * to trigger a parent action).
   *
   * ACTUAL TIME TRACKING: optional second arg `actualHours` — passed only by
   * CompleteTaskContext.requestComplete when the task being completed had a
   * Pomodoro timer, confirmed by the user via CompleteTaskConfirmModal. Only
   * applied to the task itself (not the sub-task cascade, which never ran a
   * timer of its own) and only on the non-recurring branch — a recurring
   * completion never sets `isCompleted: true` in the first place, so there's
   * nowhere meaningful to record it there (see requestComplete, which resets
   * that timer silently instead of prompting).
   *
   * DEPENDENCY GUARD: refuses to complete a task whose `dependsOn` isn't
   * fully satisfied yet (areDependenciesMet), popping the same toast
   * notification used for sync/backup errors instead of silently no-op'ing —
   * otherwise a task could be marked done while the thing it depends on still
   * isn't. Returns `false` in that case (and `true` on an actual completion)
   * so callers — namely CompleteTaskContext.requestComplete, whose own return
   * value callers like TaskDetailModal treat as "did this finish
   * synchronously" — don't act as if the task completed when it didn't.
   */
  const completeTask = useCallback(
    (taskId, actualHours) => {
      const existing = tasks.find((t) => t.id === taskId);
      if (!existing) return false;

      const taskById = new Map(tasks.map((t) => [t.id, t]));
      if (!areDependenciesMet(existing, taskById)) {
        const blockers = (existing.dependsOn || [])
          .map((id) => taskById.get(id))
          .filter((t) => t && !t.isCompleted)
          .map((t) => t.title);
        setNotification({
          type: 'warning',
          message:
            blockers.length > 0
              ? `Can't complete "${existing.title}" — finish "${blockers.join('", "')}" first.`
              : `Can't complete "${existing.title}" — its dependencies aren't done yet.`,
        });
        return false;
      }

      const descendantIds = new Set(getDescendantIds(taskId, tasks));

      if (existing.isRecurring && existing.dueDate) {
        // Base the next occurrence off today (not the stale due date) when the
        // task is completed late, so finishing an overdue daily task today
        // makes it due tomorrow instead of 1 day after the missed due date.
        const todayIso = toISODate(new Date());
        const baseDate = existing.dueDate < todayIso ? todayIso : existing.dueDate;
        const nextDueDate = computeNextDueDate(baseDate, existing.recurrenceString);
        const nowIso = new Date().toISOString();

        // Record this occurrence's completion, then trim anything older than
        // 7 days out of the raw `completedDates` list into the monthly
        // `completionHistory` aggregate instead of dropping it outright — see
        // types/index.js's Task typedef.
        const sevenDaysAgoIso = addDays(todayIso, -7);
        const keptDates = [];
        const nextHistory = { ...(existing.completionHistory || {}) };
        for (const d of [baseDate, ...(existing.completedDates || [])]) {
          if (d >= sevenDaysAgoIso) {
            keptDates.push(d);
          } else {
            const monthKey = d.slice(0, 7); // "YYYY-MM"
            nextHistory[monthKey] = (nextHistory[monthKey] || 0) + 1;
          }
        }

        const newTasks = tasks.map((t) => {
          if (t.id === taskId) {
            return {
              ...t,
              dueDate: nextDueDate,
              remainingHours: t.estimatedHours,
              isCompleted: false,
              completedDates: keptDates,
              completionHistory: nextHistory,
              updatedAt: nowIso,
            };
          }
          if (descendantIds.has(t.id)) {
            return { ...t, isCompleted: false, dueDate: null, updatedAt: nowIso };
          }
          return t;
        });
        // Drop only *unlocked* blocks for the occurrence actually being
        // closed out (date <= baseDate) — blocks for LATER dates belong to
        // future occurrences already placed by the last rebalance (each
        // occurrence gets its own block now, see rebalanceEngine's
        // generateTaskOccurrences expansion) and must survive. Locked blocks
        // are protected the same way a rebalance protects them, and blocks
        // for other tasks are untouched.
        const newBlocks = blocks.filter((b) => b.taskId !== taskId || b.isLocked || b.date > baseDate);
        commit({ tasks: newTasks, blocks: newBlocks }, `Completed recurring task — advanced to ${nextDueDate}`);
        return true;
      }

      const nowIso = new Date().toISOString();
      // Any other task that depended on this one (or one of its completed
      // descendants) is no longer blocked, so scrub those now-satisfied ids
      // out of dependsOn — same cleanup deleteTask does when a dependency
      // disappears, just triggered by it being *done* instead of gone.
      const completedIds = new Set([taskId, ...descendantIds]);
      const newTasks = tasks.map((t) => {
        if (t.id === taskId) {
          return {
            ...t,
            isCompleted: true,
            completedAt: nowIso,
            remainingHours: 0,
            ...(actualHours != null ? { actualHours } : {}),
          };
        }
        if (descendantIds.has(t.id)) {
          return { ...t, isCompleted: true, completedAt: nowIso, remainingHours: 0 };
        }
        if (t.dependsOn?.some((id) => completedIds.has(id))) {
          return { ...t, dependsOn: t.dependsOn.filter((id) => !completedIds.has(id)) };
        }
        return t;
      });
      commit({ tasks: newTasks, blocks }, `Completed task`);
      return true;
    },
    [tasks, blocks, commit, setNotification]
  );

  /**
   * Restore a task out of the completed state (undoes completeTask's
   * non-recurring branch). Only the single task is restored — a parent's
   * children aren't force-restored alongside it, since completing the parent
   * cascaded to them but that doesn't mean the reverse should be assumed.
   */
  const uncompleteTask = useCallback(
    (taskId) => {
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, isCompleted: false, completedAt: null } : t));
      commit({ tasks: newTasks, blocks }, `Restored completed task`);
    },
    [tasks, blocks, commit]
  );

  // ---- Label CRUD (app-local tags, see Label typedef) -----------------------

  /**
   * Resolve a list of tag names (as typed via the "@tag" smart-parse
   * shorthand) to Label ids, creating any that don't exist yet. Matching is
   * case-insensitive so "@Work" and "@work" resolve to the same label.
   * Synchronous by design — callers (TaskDetailModal/AddTaskModal's Save)
   * need the resulting ids immediately to attach to the task in the same
   * commit, with no round trip since labels have no backing API.
   */
  const getOrCreateLabelIds = useCallback(
    (names) => {
      const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
      if (uniqueNames.length === 0) return [];

      // A Map keyed by lowercased name gives O(1) lookups per requested
      // name instead of an O(labels) scan (with its own repeated
      // `.toLowerCase()` calls) — worth it since this runs against every
      // label the app has, once per name, every time a task is saved.
      const byLowerName = new Map(labels.map((l) => [l.name.toLowerCase(), l]));
      const newLabels = [];
      let nextCount = labels.length;

      const ids = uniqueNames.map((name) => {
        const key = name.toLowerCase();
        const existing = byLowerName.get(key);
        if (existing) return existing.id;
        const newLabel = { id: `label_${Date.now()}_${nextCount}`, name, color: nextLabelColor(nextCount) };
        byLowerName.set(key, newLabel);
        newLabels.push(newLabel);
        nextCount += 1;
        return newLabel.id;
      });

      if (newLabels.length > 0) setLabels([...labels, ...newLabels]);
      return ids;
    },
    [labels]
  );

  /** Rename a Label — purely local (labels have no Todoist equivalent). Every task referencing it by id picks up the new name automatically since nothing denormalizes a label's name onto the task itself. */
  const renameLabel = useCallback((labelId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setLabels((prev) => prev.map((l) => (l.id === labelId ? { ...l, name: trimmed } : l)));
  }, []);

  /** Delete a Label and strip it out of every task's labelIds — goes through commit() (not a bare setState) so removing a tag from every task it's attached to is itself one undoable action. */
  const deleteLabel = useCallback(
    (labelId) => {
      setLabels((prev) => prev.filter((l) => l.id !== labelId));
      const newTasks = tasks.map((t) =>
        t.labelIds?.includes(labelId) ? { ...t, labelIds: t.labelIds.filter((id) => id !== labelId) } : t
      );
      if (newTasks.some((t, i) => t !== tasks[i])) commit({ tasks: newTasks, blocks }, `Deleted tag`);
    },
    [tasks, blocks, commit]
  );

  // ---- Todoist: one-time import ---------------------------------------------

  /**
   * Pull every Project/Section/Task from Todoist ONCE and merge it into
   * local state — the only thing in this app that ever talks to the
   * Todoist API. Safe to re-run any time the user wants to pull in what's
   * changed on Todoist since the last import:
   *   - Projects/Sections/Tasks already imported (matched by id) get their
   *     fields refreshed from the fresh fetch.
   *   - New Projects/Sections/Tasks are added.
   *   - Anything local-only (a manually-created board/section, or a task
   *     with source: 'manual') is left completely untouched — this is an
   *     upsert-merge, never a wholesale replace.
   *   - A previously-imported item that's since been deleted in Todoist is
   *     NOT removed here; it just stops being touched by future imports,
   *     which is the expected "import once, then manage locally" contract.
   *
   * Also resolves each imported task's Todoist labels (raw label name
   * strings — Todoist's `labels` field, distinct from TaskFlow's own Label
   * records) onto local `labelIds`, creating any label that doesn't
   * already exist by name. This used to be silently dropped entirely (see
   * todoistService.js's module doc comment) from before the LabelPicker
   * feature existed, when labels genuinely had no Todoist equivalent to
   * worry about.
   */
  const importFromTodoist = useCallback(async () => {
    if (!todoistToken) {
      setNotification({ type: 'error', message: 'Add a Todoist API token in Settings first.' });
      return { ok: false };
    }

    setIsSyncing(true);
    try {
      const [fetchedProjects, fetchedSections] = await Promise.all([
        fetchTodoistProjects(todoistToken),
        fetchTodoistSections(todoistToken),
      ]);
      const sectionsById = new Map(fetchedSections.map((s) => [s.id, s.name]));
      const fetchedTasks = await fetchTodoistTasks(todoistToken, sectionsById);

      setProjects((prev) => {
        const byId = new Map(prev.map((p) => [p.id, p]));
        fetchedProjects.forEach((p) => byId.set(p.id, { ...byId.get(p.id), ...p }));
        return [...byId.values()];
      });
      setSections((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        fetchedSections.forEach((s) => byId.set(s.id, { ...byId.get(s.id), ...s }));
        return [...byId.values()];
      });

      // Resolve every fetched task's Todoist label NAMES to local label ids
      // in one batched pass across all tasks (not one getOrCreateLabelIds
      // call per task), so a label mentioned on several tasks is only
      // created once instead of racing itself across separate state updates.
      const allLabelNames = [...new Set(fetchedTasks.flatMap((t) => t.labelNames || []))];
      const labelIdByName = new Map();
      if (allLabelNames.length > 0) {
        const byLowerName = new Map(labels.map((l) => [l.name.toLowerCase(), l]));
        const newLabels = [];
        let nextCount = labels.length;
        allLabelNames.forEach((name) => {
          const key = name.toLowerCase();
          const existing = byLowerName.get(key);
          if (existing) {
            labelIdByName.set(name, existing.id);
            return;
          }
          const newLabel = { id: `label_${Date.now()}_${nextCount}`, name, color: nextLabelColor(nextCount) };
          byLowerName.set(key, newLabel);
          newLabels.push(newLabel);
          labelIdByName.set(name, newLabel.id);
          nextCount += 1;
        });
        if (newLabels.length > 0) setLabels((prev) => [...prev, ...newLabels]);
      }

      let addedCount = 0;
      let updatedCount = 0;
      const byId = new Map(tasks.map((t) => [t.id, t]));
      fetchedTasks.forEach((raw) => {
        const { labelNames, ...task } = raw;
        const resolvedLabelIds = (labelNames || []).map((n) => labelIdByName.get(n)).filter(Boolean);
        const existing = byId.get(task.id);
        if (existing) {
          updatedCount += 1;
          // Only refresh fields Todoist is actually the source of truth for.
          // Everything else (remainingHours, isLocked, isCompleted,
          // minChunkHours/maxChunkHours, dependsOn, isPassive, earliestDate,
          // enforceDueDate, fixedTime, link, createdAt) is app-local and must
          // survive a re-import untouched — see module doc comment above.
          byId.set(task.id, {
            ...existing,
            title: task.title,
            notes: task.notes,
            estimatedHours: task.estimatedHours,
            priority: task.priority,
            dueDate: task.dueDate,
            isRecurring: task.isRecurring,
            recurrenceString: task.recurrenceString,
            projectId: task.projectId,
            sectionId: task.sectionId,
            sectionName: task.sectionName,
            // Todoist's parent_id hierarchy is authoritative the same way
            // section/project membership is — a task moved under a
            // different parent (or promoted to top-level) in Todoist
            // should reflect that here on re-import too.
            parentId: task.parentId ?? null,
            labelIds: resolvedLabelIds,
            updatedAt: task.updatedAt,
          });
        } else {
          addedCount += 1;
          byId.set(task.id, { ...task, labelIds: resolvedLabelIds });
        }
      });
      const newTasks = [...byId.values()];
      commit({ tasks: newTasks, blocks }, `Imported from Todoist (${addedCount} new, ${updatedCount} updated)`);

      const summary = { at: new Date().toISOString(), addedCount, updatedCount, totalCount: fetchedTasks.length };
      setLastTodoistImport(summary);
      setNotification({
        type: 'success',
        message: `Imported ${addedCount} new and updated ${updatedCount} existing task${addedCount + updatedCount === 1 ? '' : 's'} from Todoist.`,
      });
      return { ok: true, ...summary };
    } catch (err) {
      console.error('[SchedulerContext] Todoist import failed', err);
      setNotification({ type: 'error', message: `Todoist import failed: ${err.message || err}` });
      return { ok: false };
    } finally {
      setIsSyncing(false);
    }
  }, [todoistToken, tasks, blocks, labels, commit, setLastTodoistImport]);

  // ---- Project CRUD (Board view "boards") -----------------------------------

  /** Create a new Project ("board") — always local; Todoist projects only ever enter via importFromTodoist. */
  const addProject = useCallback((name) => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false };
    const id = generateLocalId('proj');
    setProjects((prev) => [...prev, { id, name: trimmed, order: prev.length + 1 }]);
    return { ok: true, id };
  }, []);

  /**
   * Rename/delete/pin are all purely local — even for a Todoist-imported
   * project, none of these ever call the Todoist API.
   */
  const renameProject = useCallback(
    (projectId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)));
    },
    []
  );

  const deleteProject = useCallback(
    (projectId) => {
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setSections((prev) => prev.filter((s) => s.projectId !== projectId));
      // Function form — see addTask's comment above.
      commit(
        (current) => ({
          tasks: current.tasks.map((t) =>
            t.projectId === projectId ? { ...t, projectId: null, sectionId: null, sectionName: null } : t
          ),
          blocks: current.blocks,
        }),
        `Deleted project`
      );
    },
    [commit]
  );

  const togglePinProject = useCallback((projectId) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, isPinned: !p.isPinned } : p)));
  }, []);

  const touchProjectVisited = useCallback((projectId) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, lastVisitedAt: new Date().toISOString() } : p)));
  }, []);

  // ---- Section CRUD (Board view columns) ------------------------------------

  const addSection = useCallback(
    (projectId, name) => {
      const trimmed = name.trim();
      if (!trimmed || !projectId) return null;
      const newSection = { id: generateLocalId('sec'), name: trimmed, projectId, order: sections.length + 1 };
      setSections((prev) => [...prev, newSection]);
      return newSection;
    },
    [sections.length]
  );

  const renameSection = useCallback(
    (sectionId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s)));
      // Denormalized sectionName on any task currently in this section stays
      // in sync too. Function form — see addTask's comment above — always
      // commits rather than skipping when no task happens to reference this
      // section, since "did anything change" can't be checked ahead of time
      // against `current` (only known once the updater runs); a harmless
      // no-op-content undo entry in that rare case beats risking a lost
      // write in a same-tick batch.
      commit(
        (current) => ({
          tasks: current.tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionName: trimmed } : t)),
          blocks: current.blocks,
        }),
        `Renamed section`
      );
    },
    [commit]
  );

  const deleteSection = useCallback(
    (sectionId) => {
      setSections((prev) => prev.filter((s) => s.id !== sectionId));
      // Tasks in the deleted section fall back to "No Section", matching
      // what Todoist does. Function form — see addTask's comment above.
      commit(
        (current) => ({
          tasks: current.tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionId: null, sectionName: null } : t)),
          blocks: current.blocks,
        }),
        `Deleted section`
      );
    },
    [commit]
  );

  // ---- Block CRUD (manual drag/resize/lock) --------------------------------
  const updateBlock = useCallback(
    (blockId, updates) => {
      const newBlocks = blocks.map((b) => (b.id === blockId ? { ...b, ...updates } : b));
      commit({ tasks, blocks: newBlocks }, `Moved scheduled block`);
    },
    [tasks, blocks, commit]
  );

  const toggleBlockLock = useCallback(
    (blockId) => {
      const newBlocks = blocks.map((b) => (b.id === blockId ? { ...b, isLocked: !b.isLocked } : b));
      commit({ tasks, blocks: newBlocks }, `Toggled block lock`);
    },
    [tasks, blocks, commit]
  );

  const deleteBlock = useCallback(
    (blockId) => {
      const newBlocks = blocks.filter((b) => b.id !== blockId);
      commit({ tasks, blocks: newBlocks }, `Removed scheduled block`);
    },
    [tasks, blocks, commit]
  );

  /**
   * Manually place a task directly onto the calendar (drag from the task
   * list onto a day column — see WeekView's task-drop handling). Like any
   * other manual placement (dragging/resizing an existing block — see
   * WeekView/BlockDetailModal), this is `isAutoScheduled: false` so a later
   * rebalance/plan-today run leaves it exactly where the user put it unless
   * they explicitly lock it; `isLocked` stays at its default `false`,
   * matching every other freshly-created block/event in this file (locking
   * is always a separate, explicit user action via toggleBlockLock).
   */
  const scheduleTaskManually = useCallback(
    (taskId, date, startTime, durationHours) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const startMin = timeToMinutes(startTime);
      const endMin = startMin + Math.round(durationHours * 60);
      const newBlock = {
        id: generateLocalId('blk_manual'),
        taskId,
        date,
        startTime,
        endTime: minutesToTime(endMin),
        durationHours,
        isLocked: false,
        isAutoScheduled: false,
        status: 'scheduled',
        googleEventId: null,
        isPassive: !!task.isPassive,
      };
      commit({ tasks, blocks: [...blocks, newBlock] }, `Scheduled "${task.title}"`);
    },
    [tasks, blocks, commit]
  );

  // ---- Manual blocked-time CRUD --------------------------------------------
  // A "manual" CalendarEvent has no Google counterpart — it's the user
  // saying "block this time out" directly (e.g. plans changed, doing
  // something else for 3 hours). It's busy time from the scheduler's
  // perspective exactly like a Google event (see capacityEngine — it
  // doesn't distinguish by `source`), and re-running Re-balance schedule
  // will move any unlocked task work out from under it.
  const addManualEvent = useCallback(
    ({ title, date, startTime, endTime, description = '', location = '' }) => {
      const newEvent = {
        id: generateLocalId('evt_manual'),
        title: title?.trim() || 'Untitled event',
        date,
        startTime,
        endTime,
        description: description?.trim() || '',
        location: location?.trim() || '',
        isFreeTime: false,
        isRecurring: false,
        recurrenceRule: null,
        googleEventId: null,
        seriesId: null,
        source: 'manual',
      };
      setEvents((prev) => [...prev, newEvent]);

      // Fire-and-forget push to Google Calendar — don't block returning the
      // new event on a network round trip. On success, patch the returned
      // googleEventId/googleUpdatedAt back onto the LATEST events (via the
      // functional setEvents form) so a later edit/delete on this same
      // event knows which Google event to update/delete, regardless of
      // whatever else has changed in `events` while this was in flight.
      if (googleConnected) {
        pushEventToCalendar(newEvent)
          .then((result) => {
            if (!result) return;
            setEvents((prev) =>
              prev.map((e) => (e.id === newEvent.id ? { ...e, googleEventId: result.id, googleUpdatedAt: result.updated } : e))
            );
          })
          .catch((err) => console.error('[SchedulerContext] Failed to push new event to Google Calendar', err));
      }

      return newEvent;
    },
    [googleConnected]
  );

  /**
   * Update an event's fields, optionally applied across its recurring
   * series — mirrors setEventIgnored's own 'this'/'following'/'all' scope
   * branching just below (see its doc comment) so Save and Ignore use the
   * exact same scope semantics. Every touched event gets a fresh
   * `localUpdatedAt` stamp (kept for potential future use — see
   * eventSyncService.js's conflict policy doc comment for why it doesn't
   * currently gate anything). `eventId` may be a virtual per-occurrence id
   * (see recurrenceExpansion.resolveEventId / applyEventScopeUpdate) for a
   * single occurrence of a true-RRULE Google series.
   *
   * If connected, fire-and-forget pushes the edit to Google. A 'this'-scope
   * edit on a single occurrence of a true-RRULE series pushes via Google's
   * deterministic single-instance id (`{recurringEventId}_{originalStartTimeUTC}`
   * — see googleCalendarService.buildInstanceEventId/pushEventInstanceUpdate)
   * rather than through `applyEventScopeUpdate`'s `pushTargets` (which stays
   * empty for that case, since there's no top-level master-row change to
   * push — the edit only ever touches the master's `overrides` map). There's
   * no per-occurrence row to stamp a fresh googleEventId onto afterwards
   * (occurrences are virtual, never real rows — see recurrenceExpansion.js),
   * so success here is fire-and-forget with nothing to patch back onto state.
   * @param {string} eventId
   * @param {Partial<import('../types').CalendarEvent>} updates
   * @param {'this'|'following'|'all'} scope
   */
  const updateEvent = useCallback(
    (eventId, updates, scope = 'this') => {
      const stamped = { ...updates, localUpdatedAt: new Date().toISOString() };
      // Generated once up front (rather than inside applyEventScopeUpdate)
      // so BOTH calls below — the actual state write and the separate
      // push-targets computation — agree on the new master's id for a
      // 'following'-scope split; only used when scope is actually
      // 'following', but cheap enough to just always compute.
      const splitId = `evt_split_${Date.now()}`;
      // `events` as it stood BEFORE this edit (this callback closed over it
      // at call time) — kept around for the Undo toast below, which reverts
      // to this exact snapshot rather than trying to unwind whatever
      // scope-specific transform just ran (in-place edit, override-map entry,
      // or a 'following' series split into two rows).
      const prevEventsSnapshot = events;
      const { masterId, occurrenceDate, isVirtual } = resolveEventId(eventId);

      setEvents((prev) => applyEventScopeUpdate(prev, eventId, stamped, scope, splitId).events);

      // ---- Undo toast -----------------------------------------------------
      // Calendar events are a separate array from tasks/blocks (see this
      // file's doc comment) and deliberately NOT wired through
      // useHistoryState's commit()/undo stack — this pops the same
      // bottom-corner toast tasks/blocks actions use (see `actionToast`
      // above), but carries its own `undo` thunk instead of relying on the
      // shared tasks/blocks `undo()`. On Undo:
      //   - Local state always reverts to `prevEventsSnapshot` verbatim —
      //     trivially correct for every scope, including a 'following' split
      //     (just discards the new row) or an 'all' edit across every row of
      //     a synthetic series.
      //   - A single-occurrence edit on a true-RRULE series ('this' scope on
      //     a virtual id) never touches a top-level row — it's pushed to
      //     Google via the deterministic per-instance id instead of
      //     `pushTargets`, so its revert re-pushes the occurrence's pre-edit
      //     override the same way.
      //   - Everything else re-pushes the PRE-edit version of whatever
      //     `pushTargets` says changed, using its original googleEventId, so
      //     Google ends up back at its pre-edit content. A 'following'
      //     split's newly-created master has no pre-edit counterpart — that
      //     row is DELETED from Google instead (using whatever googleEventId
      //     it's picked up by the time Undo is clicked; if the fire-and-forget
      //     insert is still in flight, this is a no-op and leaves an orphan
      //     event on Google — rare enough, and cheap enough to remove by
      //     hand, not to justify blocking Undo on a network round trip).
      setActionToast({
        id: `evt_${Date.now()}`,
        label: 'Updated event',
        undo: () => {
          if (googleConnected) {
            if (isVirtual && scope === 'this') {
              const master = prevEventsSnapshot.find((e) => e.id === masterId);
              if (master?.googleEventId) {
                const originalOverride = master.overrides?.[occurrenceDate];
                const originalFields = { ...master, ...originalOverride, date: originalOverride?.date || occurrenceDate };
                pushEventInstanceUpdate(master, occurrenceDate, originalFields).catch((err) =>
                  console.error('[SchedulerContext] Failed to revert single-occurrence Google edit on undo', err)
                );
              }
            } else {
              const { pushTargets } = applyEventScopeUpdate(prevEventsSnapshot, eventId, stamped, scope, splitId);
              if (pushTargets.length > 0) {
                setEvents((latest) => {
                  for (const target of pushTargets) {
                    const before = prevEventsSnapshot.find((e) => e.id === target.id);
                    if (before) {
                      pushEventToCalendar(before).catch((err) =>
                        console.error('[SchedulerContext] Failed to revert Google event on undo', err)
                      );
                    } else {
                      // Only reachable for a 'following' split's newly-created
                      // master (see doc comment above) — delete it from
                      // Google instead of updating, since undo removes the
                      // row entirely.
                      const inserted = latest.find((e) => e.id === target.id);
                      if (inserted?.googleEventId) {
                        deleteCalendarEvent(inserted.googleEventId, inserted.calendarId).catch((err) =>
                          console.error('[SchedulerContext] Failed to delete split-series event from Google on undo', err)
                        );
                      }
                    }
                  }
                  return prevEventsSnapshot;
                });
                return; // already restored state via the functional setEvents above
              }
            }
          }
          setEvents(prevEventsSnapshot);
        },
      });

      if (!googleConnected) return;

      if (isVirtual && scope === 'this') {
        // Single-occurrence edit on a true-RRULE series: push via the
        // instance-id mechanism instead of the normal pushTargets path (see
        // doc comment above). `stamped` may only carry a PARTIAL edit (e.g.
        // WeekView's resize handler only sends `{ endTime }`), so re-merge it
        // onto any pre-existing override for this date the same way
        // applyEventScopeUpdate's 'this' branch just did for state, to get
        // this occurrence's full current field set (title/description/
        // location/date/startTime/endTime) before building the Google patch
        // body — a PATCH still needs complete start/end dateTimes.
        const master = events.find((e) => e.id === masterId);
        if (master?.googleEventId) {
          const mergedOverride = { ...master.overrides?.[occurrenceDate], ...stamped };
          const occurrenceFields = { ...master, ...mergedOverride, date: mergedOverride.date || occurrenceDate };
          pushEventInstanceUpdate(master, occurrenceDate, occurrenceFields).catch((err) =>
            console.error('[SchedulerContext] Failed to push single-occurrence edit to Google Calendar', err)
          );
        }
        return;
      }

      const { pushTargets } = applyEventScopeUpdate(events, eventId, stamped, scope, splitId);
      for (const eventToPush of pushTargets) {
        const pushId = eventToPush.id;
        pushEventToCalendar(eventToPush)
          .then((result) => {
            if (!result) return;
            setEvents((prev) =>
              prev.map((e) => (e.id === pushId ? { ...e, googleEventId: result.id, googleUpdatedAt: result.updated } : e))
            );
          })
          .catch((err) => console.error('[SchedulerContext] Failed to push updated event to Google Calendar', err));
      }
    },
    [events, googleConnected]
  );

  /**
   * Delete an event, honoring 'this'/'following'/'all' scope for a
   * true-RRULE Google series (one master row per series — see
   * recurrenceExpansion.js's doc comment). `eventId` may be a virtual
   * per-occurrence id (see resolveEventId).
   *   - 'all' (default — also the only meaningful scope for a real id, i.e.
   *     a manual event or a non-recurring/synthetic-series event): deletes
   *     the whole row, same as before this fix — and its Google copy, if
   *     one was ever pushed.
   *   - 'this' (true-RRULE occurrence only): keeps the master row; marks
   *     just this date's override `deleted`, so expandRecurringEvent stops
   *     generating it — and, if connected, also deletes that single instance
   *     on Google via the same deterministic instance-id mechanism
   *     `updateEvent` uses for 'this'-scope edits (see
   *     googleCalendarService.deleteCalendarEventInstance).
   *   - 'following' (true-RRULE occurrence only): truncates the master's
   *     recurrenceRule to end the day before this occurrence — no
   *     continuation series to create, unlike updateEvent's 'following'
   *     (there's nothing to re-create after a delete) — and pushes that
   *     truncation to Google so a later pull doesn't resurrect the deleted
   *     tail (mirrors updateEvent's old-master push).
   * @param {string} eventId
   * @param {'this'|'following'|'all'} scope
   */
  const deleteEvent = useCallback(
    (eventId, scope = 'all') => {
      const { masterId, occurrenceDate, isVirtual } = resolveEventId(eventId);

      if (!isVirtual || scope === 'all') {
        const target = events.find((e) => e.id === eventId);
        setEvents((prev) => prev.filter((e) => e.id !== eventId));
        if (googleConnected && target?.googleEventId) {
          deleteCalendarEvent(target.googleEventId, target.calendarId).catch((err) =>
            console.error('[SchedulerContext] Failed to delete event from Google Calendar', err)
          );
        }
        return;
      }

      const master = events.find((e) => e.id === masterId);
      if (!master) return;

      if (scope === 'this') {
        setEvents((prev) =>
          prev.map((e) =>
            e.id === masterId
              ? {
                  ...e,
                  overrides: { ...(e.overrides || {}), [occurrenceDate]: { ...(e.overrides?.[occurrenceDate]), deleted: true } },
                }
              : e
          )
        );
        if (googleConnected && master.googleEventId) {
          deleteCalendarEventInstance(master, occurrenceDate).catch((err) =>
            console.error('[SchedulerContext] Failed to delete single occurrence from Google Calendar', err)
          );
        }
        return;
      }

      // scope === 'following'
      const dayBefore = addDays(occurrenceDate, -1);
      const truncatedMaster = { ...master, recurrenceRule: truncateRuleUntil(master.recurrenceRule, dayBefore) };
      setEvents((prev) => prev.map((e) => (e.id === masterId ? truncatedMaster : e)));
      if (googleConnected) {
        pushEventToCalendar(truncatedMaster)
          .then((result) => {
            if (!result) return;
            setEvents((prev) =>
              prev.map((e) => (e.id === masterId ? { ...e, googleEventId: result.id, googleUpdatedAt: result.updated } : e))
            );
          })
          .catch((err) => console.error('[SchedulerContext] Failed to push truncated series to Google Calendar', err));
      }
    },
    [events, googleConnected]
  );

  /**
   * Set a (typically Google-sourced) event's `isFreeTime` "ignore" flag,
   * optionally applied across its recurring series — mirroring Google
   * Calendar's own "This event / This and following events / All events"
   * prompt when editing a recurring event. `event.id` may be a virtual
   * per-occurrence id (see resolveEventId) for a single occurrence of a
   * true-RRULE Google series (one master row per series). Always
   * local-only regardless of scope — Google Calendar has no concept of
   * "ignore" (it's a TaskFlow-only scheduling override), so this never
   * pushes.
   * @param {import('../types').CalendarEvent} event
   * @param {boolean} ignored
   * @param {'this'|'following'|'all'} scope
   */
  const setEventIgnored = useCallback((event, ignored, scope = 'this') => {
    const { masterId, occurrenceDate, isVirtual } = resolveEventId(event.id);

    if (!isVirtual) {
      if (scope === 'this' || !event.seriesId) {
        setEvents((prev) => prev.map((e) => (e.id === event.id ? { ...e, isFreeTime: ignored } : e)));
        return;
      }
      setEvents((prev) =>
        prev.map((e) => {
          if (e.seriesId !== event.seriesId) return e;
          if (scope === 'following' && e.date < event.date) return e;
          return { ...e, isFreeTime: ignored };
        })
      );
      return;
    }

    if (scope === 'all') {
      setEvents((prev) => prev.map((e) => (e.id === masterId ? { ...e, isFreeTime: ignored } : e)));
      return;
    }

    if (scope === 'following') {
      const splitId = `evt_split_${Date.now()}`;
      setEvents((prev) => {
        const master = prev.find((e) => e.id === masterId);
        if (!master) return prev;
        return splitSeriesAtOccurrence(prev, master, occurrenceDate, { isFreeTime: ignored }, splitId).events;
      });
      return;
    }

    // scope === 'this'
    setEvents((prev) =>
      prev.map((e) =>
        e.id === masterId
          ? {
              ...e,
              overrides: { ...(e.overrides || {}), [occurrenceDate]: { ...(e.overrides?.[occurrenceDate]), isFreeTime: ignored } },
            }
          : e
      )
    );
  }, []);

  /** Bulk-toggle every recurring (seriesId-bearing) event's `isFreeTime` flag at once. */
  const setAllRecurringIgnored = useCallback((ignored) => {
    setEvents((prev) => prev.map((e) => (e.seriesId ? { ...e, isFreeTime: ignored } : e)));
  }, []);

  const clearNotification = useCallback(() => setNotification(null), []);

  /**
   * Wipe every task, board (project), section, and label — used by
   * Settings' "Clear all data" action for a user who wants a blank slate
   * instead of the bundled sample data. Deliberately narrower than the
   * "Reset local data" danger-zone action: routines/rules/sync settings are
   * left untouched, and (unlike a full localStorage wipe) this doesn't fall
   * back to the sample data again afterward, since it persists the emptied
   * arrays rather than clearing the storage keys outright.
   */
  const clearAllData = useCallback(() => {
    commit({ tasks: [], blocks: [] }, 'Cleared all tasks and boards');
    setSections([]);
    setProjects([]);
    setLabels([]);
  }, [commit]);

  const value = useMemo(
    () => ({
      tasks,
      blocks,
      routines,
      events,
      rules,
      sections,
      projects,
      labels,
      searchQuery,
      isLoading,
      isSyncing,
      isBackingUp,
      isPullingGoogleEvents,
      cloudBackups,
      googleConnected,
      googleNeedsReconnect,
      todoistEnabled,
      todoistToken,
      setTodoistApiToken,
      importFromTodoist,
      lastTodoistImport,
      lastOverflow,
      lastUnfitToday,
      notification,
      setNotification,
      settingsSectionRequest,
      requestSettingsSection,
      canUndo,
      canRedo,
      currentActionLabel,
      actionToast,
      dismissActionToast,
      setRoutines,
      setEvents,
      setRules,
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      animationsEnabled,
      setAnimationsEnabled,
      notificationSettings,
      setNotificationSettings,
      notes,
      setNotes,
      shortcutBindings,
      setShortcutBindings,
      setSearchQuery,
      undo,
      redo,
      runRebalance,
      runPlanToday,
      addTask,
      updateTask,
      deleteTask,
      toggleTaskLock,
      completeTask,
      uncompleteTask,
      addComment,
      deleteComment,
      getOrCreateLabelIds,
      renameLabel,
      deleteLabel,
      addProject,
      renameProject,
      deleteProject,
      togglePinProject,
      touchProjectVisited,
      addSection,
      renameSection,
      deleteSection,
      updateBlock,
      toggleBlockLock,
      deleteBlock,
      scheduleTaskManually,
      addManualEvent,
      updateEvent,
      deleteEvent,
      setEventIgnored,
      setAllRecurringIgnored,
      connectGoogleCalendar,
      pullFromGoogleCalendar,
      pushToGoogleCalendar,
      syncNow,
      exportBackup,
      importBackupFromFile,
      refreshCloudBackups,
      backupToCloud,
      restoreCloudBackup,
      deleteCloudBackup,
      clearNotification,
      clearAllData,
    }),
    [
      tasks,
      blocks,
      routines,
      events,
      rules,
      sections,
      projects,
      labels,
      searchQuery,
      isLoading,
      isSyncing,
      isBackingUp,
      isPullingGoogleEvents,
      cloudBackups,
      googleConnected,
      googleNeedsReconnect,
      todoistEnabled,
      todoistToken,
      setTodoistApiToken,
      importFromTodoist,
      lastTodoistImport,
      lastOverflow,
      lastUnfitToday,
      notification,
      setNotification,
      settingsSectionRequest,
      requestSettingsSection,
      canUndo,
      canRedo,
      currentActionLabel,
      actionToast,
      dismissActionToast,
      soundEnabled,
      soundVolume,
      animationsEnabled,
      notificationSettings,
      notes,
      shortcutBindings,
      undo,
      redo,
      runRebalance,
      runPlanToday,
      addTask,
      updateTask,
      deleteTask,
      toggleTaskLock,
      completeTask,
      uncompleteTask,
      addComment,
      deleteComment,
      getOrCreateLabelIds,
      renameLabel,
      deleteLabel,
      addProject,
      renameProject,
      deleteProject,
      togglePinProject,
      touchProjectVisited,
      addSection,
      renameSection,
      deleteSection,
      updateBlock,
      toggleBlockLock,
      deleteBlock,
      scheduleTaskManually,
      addManualEvent,
      updateEvent,
      deleteEvent,
      setEventIgnored,
      setAllRecurringIgnored,
      connectGoogleCalendar,
      pullFromGoogleCalendar,
      pushToGoogleCalendar,
      syncNow,
      exportBackup,
      importBackupFromFile,
      refreshCloudBackups,
      backupToCloud,
      restoreCloudBackup,
      deleteCloudBackup,
      clearNotification,
      clearAllData,
    ]
  );

  return <SchedulerContext.Provider value={value}>{children}</SchedulerContext.Provider>;
}

export function useScheduler() {
  const ctx = useContext(SchedulerContext);
  if (!ctx) throw new Error('useScheduler must be used within a SchedulerProvider');
  return ctx;
}

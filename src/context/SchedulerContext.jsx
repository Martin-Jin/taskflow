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
 *   - If Google Calendar was connected in a previous session,
 *     `googleConnected` persists and the load effect attempts a SILENT
 *     token refresh (no popup) so the user isn't asked to sign in again
 *     every time they open the app. If the silent refresh fails (token
 *     revoked, grant expired), we fall back to `googleConnected: false`
 *     and the user just clicks "Connect" again — no error state, no
 *     forced popup on load.
 *
 * RECURRING TASKS: a Task can carry `isRecurring` + `recurrenceString`
 * (captured from Todoist's `due.is_recurring` / `due.string` on import, or
 * set directly when adding/editing a local task). Completing a recurring
 * task does NOT set `isCompleted` — mirroring Todoist's own behavior —
 * instead its due date advances to the next occurrence, computed locally
 * via `utils/recurrence.js` (handles "every month", "monthly", "every 1
 * month", Todoist's non-shifting "every!" marker, multi-weekday phrases
 * like "every sat and sun", "every weekday", "every other week", etc.) —
 * there's no Todoist round trip to defer to anymore, so this local
 * computation is now the only source of truth for the next date, not just
 * a same-session convenience ahead of the next sync.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHistoryState } from '../hooks/useHistoryState';
import { usePersistedState } from '../hooks/usePersistedState';
import { loadPersisted, savePersisted } from '../utils/persistence.js';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { DEFAULT_PINNED_LINKS } from '../components/Dashboard/pinnedLinksModel';
import { playAddSound, playDeleteSound } from '../services/soundService';
import { pullUserData, pushUserData, subscribeUserData, createBackup, listBackups, getBackup, deleteBackup } from '../services/firestoreSync';
import { buildBackupPayload, isValidBackupPayload, downloadBackupFile, readBackupFile, BACKUP_FIELDS } from '../services/backupService';
import { uploadCommentAttachment, deleteCommentAttachment } from '../services/attachmentService';
import { rebalance } from '../algorithms/rebalanceEngine';
import { computeNextDueDate } from '../utils/recurrence';
import {
  fetchTasks as fetchTodoistTasks,
  fetchSections as fetchTodoistSections,
  fetchProjects as fetchTodoistProjects,
} from '../services/todoistService';
import {
  fetchEvents as fetchGoogleEvents,
  pushBlockToCalendar,
  pushEventToCalendar,
  deleteCalendarEvent,
  pushEventInstanceUpdate,
  deleteCalendarEventInstance,
  initGoogleCalendar,
  requestAccessToken,
} from '../services/googleCalendarService';
import { mergePulledGoogleEvents } from '../services/eventSyncService';
import { getDefaultRoutines, getDefaultRules, getMockTasks, getMockSections, getMockProjects } from '../services/mockData';
import { toISODate, addDays } from '../utils/dateUtils';
import { resolveEventId, truncateRuleUntil, rebaseRuleForSplit } from '../utils/recurrenceExpansion';
import { nextLabelColor } from '../utils/labelColor';
import { migrateBlockedTimeToEvents } from '../migrations/migrateBlockedTimeToEvents';
import { migrateSubtasksToTasks } from '../migrations/migrateSubtasksToTasks';

const SchedulerContext = createContext(null);

const EVENTS_HORIZON_DAYS = 28;

/**
 * Collapses events that represent the same real-world occurrence (same
 * title/date/time) down to one. Needed on top of googleCalendarService's
 * own fetch-time dedup because `events` isn't only ever set from a fresh
 * fetch — it's also seeded from localStorage on boot and pulled verbatim
 * from the Firestore cloud doc on every sign-in (see pullFromCloud below),
 * either of which can reintroduce duplicate copies that were already
 * cached/synced before the fetch-time fix existed. Prefers googleEventId
 * when present (the reliable identity for a synced event) and only falls
 * back to the date/time/title composite key for manual events that have
 * no googleEventId at all.
 */
function dedupeEventsByOccurrence(events) {
  if (!Array.isArray(events)) return events;
  const seen = new Set();
  return events.filter((e) => {
    const key = e.googleEventId ? `g:${e.googleEventId}` : `m:${e.date}|${e.startTime}|${e.endTime}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `theme` is in BACKUP_FIELDS (so point-in-time backups capture it) but is
 * deliberately NOT part of SchedulerContext's own live push/pull/listener
 * payloads — it's synced independently by ThemeContext on the same
 * users/{uid} doc (see that file). If the fingerprint below included it,
 * every comparison against a freshly-pulled/live-listener `remote` (which
 * always carries ThemeContext's real value) vs. this context's own payload
 * (which never sets a `theme` key at all) would mismatch on that field
 * alone — permanently defeating the "is this just our own write echoing
 * back" check further down and ping-ponging pushes/re-applies forever.
 * Excluded here for that reason; kept in BACKUP_FIELDS for backups.
 */
const SYNC_FINGERPRINT_FIELDS = BACKUP_FIELDS.filter((field) => field !== 'theme');

/**
 * Deterministic, field-order-independent fingerprint of the syncable
 * state — used to tell "the cloud doc actually changed" apart from "the
 * live listener is just echoing back a write we made ourselves." Keys off
 * SYNC_FINGERPRINT_FIELDS (BACKUP_FIELDS minus fields synced elsewhere —
 * see its comment) so any field added to BACKUP_FIELDS that SchedulerContext
 * itself also pushes/pulls is automatically covered here too.
 */
function computeSyncFingerprint(source) {
  return JSON.stringify(SYNC_FINGERPRINT_FIELDS.map((field) => source[field]));
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

// How long a signed-in session waits since the last cloud backup before
// silently taking a new one on sign-in — frequent enough that a bad week
// never costs more than a day of data, infrequent enough that the
// `backups` subcollection doesn't fill up with near-duplicate snapshots
// from every reload/tab reopen.
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function SchedulerProvider({ children }) {
  const { user } = useAuth();
  // Owned live by ThemeContext (which wraps this provider — see App.jsx) —
  // only read/written here for the backup-payload/restoreFromBackup paths
  // (see SYNC_FINGERPRINT_FIELDS' comment for why it's excluded from live sync).
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

  useEffect(() => {
    document.documentElement.setAttribute('data-animations', animationsEnabled ? 'on' : 'off');
  }, [animationsEnabled]);

  // Bookmark-bar-style pinned links (see Dashboard/PinnedLinks.jsx) — lifted
  // up here (rather than that component's own local usePersistedState) so
  // this user-created content follows them across devices and survives a
  // backup restore, same as routines/rules/sound settings.
  const [pinnedLinks, setPinnedLinks] = usePersistedState('pinnedLinks', DEFAULT_PINNED_LINKS);
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

  // Whether the user has connected Google Calendar in *some* previous
  // session. The actual OAuth access token is short-lived and lives only
  // in googleCalendarService's module state (tokens shouldn't be persisted
  // to localStorage), but THIS flag persisting is what lets the load
  // effect know it should attempt a silent re-auth instead of requiring a
  // manual "Connect" click every time.
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);

  // Set whenever an AUTOMATIC (silent re-auth on load, or periodic poll)
  // Google Calendar reconnect attempt fails and falls back to disconnected —
  // as opposed to the user never having connected at all. Google's
  // Identity Services implicit-token flow has no refresh token to persist;
  // the cached access token (see googleCalendarService's TOKEN_STORAGE_KEY)
  // only covers repeat opens within its own ~1hr lifetime, so this WILL
  // legitimately happen periodically (token expired while the tab was
  // closed, third-party-cookie/FedCM restrictions blocking a truly silent
  // GIS request, grant revoked, etc.) — there's no way to make the silent
  // path succeed 100% of the time within this OAuth model. Rather than
  // pretend otherwise (the previous behavior: quietly flip back to
  // `googleConnected: false` with only a console.warn, which looks
  // identical in the UI to "never connected"), this flag lets Settings show
  // a distinct "disconnected, reconnect?" state and pops one dismissible
  // notification — deliberately NOT session-persisted, since the very next
  // successful connectGoogleCalendar() call (or the next mount's silent
  // retry, if it happens to succeed) clears it back to a normal state.
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);

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
  const [isBackingUp, setIsBackingUp] = useState(false);
  // True only while a manual "Pull from Google Calendar" is in flight
  // (distinct from isSyncing, which covers the periodic/automatic pulls).
  const [isPullingGoogleEvents, setIsPullingGoogleEvents] = useState(false);
  // Metadata-only list (see firestoreSync.listBackups) for the Settings
  // "cloud backups" picker — never holds full task/block/etc payloads for
  // more than the one backup actively being restored.
  const [cloudBackups, setCloudBackups] = useState([]);
  const [lastOverflow, setLastOverflow] = useState([]);
  const [notification, setNotification] = useState(null);

  const { tasks, blocks } = state;

  // Async Todoist-sync continuations (the `.then()` after a create call)
  // resolve after the fact, potentially after other commits have landed —
  // closing over `tasks`/`blocks` directly would replay a stale snapshot
  // and silently clobber whatever changed in the meantime. This ref always
  // holds the latest committed state for those continuations to read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);


  // Content fingerprint of whatever's already reconciled with the cloud
  // doc — either the last payload we successfully pushed, or the last
  // remote payload we applied. The debounced push effect and the live
  // listener effect below both check against this before doing anything,
  // which is what stops the two from ping-ponging the same data back and
  // forth between devices forever (device A pushes -> device B's listener
  // applies it -> B's local state change re-triggers B's own push effect
  // -> ...).
  const lastSyncedSnapshotRef = useRef(null);

  // Guards the push effect below against racing the initial pull-on-sign-in.
  // Without this, a device that's been offline/closed a while (still holding
  // stale local data) schedules its debounced push at mount time — same tick
  // as the pull kicking off — purely because `lastSyncedSnapshotRef` starts
  // at null on every sign-in, which looks like "unsynced local changes" even
  // when there aren't any. Normally the pull (fast) resolves and rewrites
  // local state before the debounce timer fires, cancelling it — but on a
  // slow/flaky connection (exactly when this matters most: a device just
  // coming back online) the stale push can fire FIRST and clobber genuinely
  // newer data another device already wrote to the cloud doc. False until
  // the current sign-in's pull settles (success or failure), so the push
  // effect simply can't fire before this device has seen the latest remote
  // state at least once.
  const initialPullDoneRef = useRef(false);

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
  // Runs once on mount. Todoist is NOT part of this — it's a one-time
  // import the user explicitly triggers from Settings (see
  // importFromTodoist below), never fetched automatically. The only thing
  // this effect does is Google Calendar events, attempted SILENTLY (no
  // consent popup) if the user previously connected (persisted
  // `googleConnected`), so re-opening the app doesn't require signing in
  // again. If the silent attempt fails, we fall back to "not connected" —
  // this is expected to happen periodically (see `googleNeedsReconnect`'s
  // doc comment above), so it's surfaced as one dismissible notification
  // plus a lingering Settings-panel indicator, not a blocking error.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);

      if (googleConnected) {
        try {
          const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
          const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
          const { enabled } = await initGoogleCalendar(clientId, apiKey);
          if (enabled) {
            await requestAccessToken(true); // silent — no consent popup
            const rangeStartIso = toISODate(new Date());
            const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
            const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
            if (!cancelled) {
              // MERGE, not replace — a plain setEvents(fetchedEvents) here used
              // to wholesale replace the entire events array with only the
              // freshly-fetched Google events, silently deleting every
              // manual (source:'manual') event on every load. See
              // eventSyncService.js for the full merge/reconcile policy.
              setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
              if (failedCalendars.length > 0) {
                // Silent, like the catch block below — this is the automatic
                // load-on-mount fetch, not a user-initiated action, so a
                // partial failure here shouldn't pop a toast before the user
                // has done anything.
                console.warn(`[SchedulerContext] Couldn't load events from: ${failedCalendars.join(', ')}`);
              }
            }
          } else if (!cancelled) {
            setGoogleConnected(false);
          }
        } catch (err) {
          // Silent refresh failed — the grant likely expired (GIS's implicit
          // flow has no refresh token, so this is expected roughly hourly
          // for a reopened tab, not just on revocation) — fall back to
          // "disconnected" and tell the user plainly instead of leaving
          // sync quietly dead with no clue why (see `googleNeedsReconnect`).
          console.warn('[SchedulerContext] Silent Google Calendar re-auth failed, falling back to disconnected.', err);
          if (!cancelled) {
            setGoogleConnected(false);
            setGoogleNeedsReconnect(true);
            setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
          }
        }
      }

      if (!cancelled) setIsLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Periodic Google Calendar polling ------------------------------------
  // While connected, re-fetch and merge Google events every few minutes so
  // edits/deletes/new events made directly in Google Calendar (from another
  // device, or the web UI) converge into TaskFlow without requiring a full
  // page reload or a manual "Sync now" click — this is IN ADDITION to the
  // load-on-mount effect above and the manual syncNow path below, not a
  // replacement for either.
  const googlePollInFlightRef = useRef(false);
  // Timestamp (ms) of the last poll attempt (interval tick OR visibility-
  // triggered refresh below) — lets the visibilitychange listener throttle
  // itself against both without needing a second in-flight flag.
  const lastGooglePollAtRef = useRef(0);
  const pollGoogleEventsRef = useRef(null);
  useEffect(() => {
    if (!googleConnected) return undefined;

    const poll = async () => {
      // A slow previous poll (or the initial load effect) still in flight —
      // skip this tick rather than let two fetches race and merge out of order.
      if (googlePollInFlightRef.current) return;
      googlePollInFlightRef.current = true;
      lastGooglePollAtRef.current = Date.now();
      try {
        const rangeStartIso = toISODate(new Date());
        const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
        const { events: fetchedEvents } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
        setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
      } catch (err) {
        if (err?.isGoogleAuthError) {
          // The token was already invalidated by fetchEvents — disconnecting
          // here too stops this interval (see the `googleConnected` guard/dep
          // above) instead of letting it keep firing with no access token,
          // which would otherwise silently fall back to mock sample events
          // being merged into the user's real calendar every 5 minutes.
          // Surfaced to the user (see `googleNeedsReconnect`'s doc comment)
          // instead of a bare console.warn — this is a real, actionable
          // state change (sync was working, now it's stopped), not a
          // mount-time hiccup.
          console.warn('[SchedulerContext] Google Calendar auth expired during poll, disconnecting.', err);
          setGoogleConnected(false);
          setGoogleNeedsReconnect(true);
          setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
          return;
        }
        // A missed poll just means the next one (5 minutes later) tries
        // again — not worth surfacing to the user as an error.
        console.warn('[SchedulerContext] Periodic Google Calendar poll failed', err);
      } finally {
        googlePollInFlightRef.current = false;
      }
    };
    // Exposed via ref so the visibilitychange effect below (and anything
    // else that wants "the same poll, on demand") can reuse this exact
    // function/in-flight-guard instead of duplicating the fetch+merge logic.
    pollGoogleEventsRef.current = poll;

    const handle = setInterval(poll, 5 * 60 * 1000);
    return () => clearInterval(handle);
  }, [googleConnected]);

  // Refresh Google events when the tab/app regains visibility (e.g. the user
  // alt-tabs back after being away) — otherwise a stale calendar can sit
  // around for up to the full 5-minute poll interval after switching back.
  // Throttled against the periodic poll above (shared timestamp ref) so
  // rapid tab-switching doesn't trigger a fetch every time; only fires if
  // it's been at least VISIBILITY_REFRESH_THROTTLE_MS since the last poll
  // (interval-driven or visibility-driven) of either kind.
  useEffect(() => {
    if (!googleConnected) return undefined;

    const VISIBILITY_REFRESH_THROTTLE_MS = 60 * 1000;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastGooglePollAtRef.current < VISIBILITY_REFRESH_THROTTLE_MS) return;
      pollGoogleEventsRef.current?.();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [googleConnected]);

  // ---- Cloud sync (Firestore) ----------------------------------------------
  /**
   * Apply a full remote payload — from either the one-time sign-in pull or
   * the live listener below — onto local state, and stamp
   * `lastSyncedSnapshotRef` with what was just applied so the debounced
   * push effect doesn't immediately re-push the very data it just received.
   */
  const applyRemoteData = useCallback(
    (remote) => {
      lastSyncedSnapshotRef.current = computeSyncFingerprint(remote);
      if ('tasks' in remote || 'blocks' in remote) {
        overwritePresent({ tasks: remote.tasks ?? stateRef.current.tasks, blocks: remote.blocks ?? stateRef.current.blocks });
      }
      if ('sections' in remote) setSections(remote.sections);
      if ('projects' in remote) setProjects(remote.projects);
      if ('labels' in remote) setLabels(remote.labels);
      if ('routines' in remote) setRoutines(remote.routines);
      if ('rules' in remote) setRules(remote.rules);
      if ('events' in remote) setEvents(dedupeEventsByOccurrence(remote.events));
      if ('soundEnabled' in remote) setSoundEnabled(remote.soundEnabled);
      if ('soundVolume' in remote) setSoundVolume(remote.soundVolume);
      if ('animationsEnabled' in remote) setAnimationsEnabled(remote.animationsEnabled);
      if ('pinnedLinks' in remote) setPinnedLinks(remote.pinnedLinks);
      if ('shortcutBindings' in remote) {
        setShortcutBindings(remote.shortcutBindings);
        // Also write localStorage directly (not just React state) so the
        // hot keydown listener (see useKeyboardShortcuts.js) picks up an
        // incoming remote binding immediately, not just on this device's
        // next local rebind.
        savePersisted('shortcutBindings', remote.shortcutBindings);
      }
    },
    [
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
      setPinnedLinks,
      setShortcutBindings,
    ]
  );

  /**
   * One-time pull for a fresh sign-in: applies whatever's already synced,
   * or — if this is the very first device to ever sign in for this
   * account — seeds the cloud doc from this device's current local data.
   * Ongoing convergence after this point is handled by the live listener
   * effect further down, not by this function.
   */
  const pullFromCloud = useCallback(
    async (uid) => {
      const remote = await pullUserData(uid);
      if (remote) {
        applyRemoteData(remote);
      } else {
        const seedPayload = {
          tasks: stateRef.current.tasks,
          blocks: stateRef.current.blocks,
          sections,
          projects,
          labels,
          routines,
          rules,
          events,
          soundEnabled,
          soundVolume,
          animationsEnabled,
          pinnedLinks,
          shortcutBindings,
        };
        await pushUserData(uid, seedPayload);
        lastSyncedSnapshotRef.current = computeSyncFingerprint(seedPayload);
      }
    },
    [applyRemoteData, sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, pinnedLinks, shortcutBindings]
  );

  /**
   * Checks whether this signed-in user's most recent cloud backup is older
   * than AUTO_BACKUP_INTERVAL_MS and, if so, silently takes a new one —
   * this is the "regularly auto-backed-up" half of the feature; the manual
   * "Back up now" button (see backupToCloud below) is the other half.
   * Deliberately quiet on success (no toast) matching how the debounced
   * push effect below never notifies on every write either — only load
   * failures are worth surfacing, not routine background activity.
   */
  const maybeAutoBackup = useCallback(
    async (uid) => {
      try {
        const list = await listBackups(uid);
        setCloudBackups(list);
        const mostRecent = list[0];
        const mostRecentMs = mostRecent?.createdAt?.toMillis
          ? mostRecent.createdAt.toMillis()
          : mostRecent?.exportedAt
          ? new Date(mostRecent.exportedAt).getTime()
          : 0;
        if (mostRecent && Date.now() - mostRecentMs < AUTO_BACKUP_INTERVAL_MS) return;

        const payload = buildBackupPayload({
          tasks: stateRef.current.tasks,
          blocks: stateRef.current.blocks,
          sections,
          projects,
          labels,
          routines,
          rules,
          events,
          soundEnabled,
          soundVolume,
          animationsEnabled,
          theme,
          pinnedLinks,
          shortcutBindings,
        });
        await createBackup(uid, payload);
        setCloudBackups(await listBackups(uid));
      } catch (err) {
        // Never surface this to the user — an auto-backup miss just means
        // it'll be retried on the next sign-in, not a lost write.
        console.warn('[SchedulerContext] Auto-backup check failed', err);
      }
    },
    [sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, theme, pinnedLinks, shortcutBindings]
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    lastSyncedSnapshotRef.current = null;
    initialPullDoneRef.current = false;
    pullFromCloud(user.uid)
      .catch((err) => {
        if (cancelled) return;
        // Silent — this is the automatic pull that runs on sign-in/initial
        // load, not a user-initiated sync, so a failure here shouldn't pop
        // a toast before the user has done anything.
        console.error('[SchedulerContext] Cloud sync failed to load', err);
      })
      .then(() => {
        // Chained onto pullFromCloud rather than a separate effect on the
        // same [user] dep: two effects with the same deps fire in the same
        // tick with no ordering guarantee between their async work, so a
        // sibling effect could snapshot THIS device's pre-sync local state
        // for the backup instead of whatever pullFromCloud just converged
        // onto. Chaining guarantees the backup (if any) always reflects
        // post-sync state.
        if (cancelled) return;
        return maybeAutoBackup(user.uid);
      })
      .finally(() => {
        // Set even if the pull failed (offline etc.) — otherwise a
        // persistent failure would permanently block this device from ever
        // pushing local edits again for the rest of the session. See
        // initialPullDoneRef's own comment for what this guards against.
        if (!cancelled) initialPullDoneRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // Deliberately only re-runs when the signed-in user changes — this pulls
    // once per sign-in, not on every local state change (that's the push
    // effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  
  // Live convergence — same idea as ThemeContext's own listener on this same
  // users/{uid} doc. Without this, a change pushed from another signed-in
  // device only ever arrives here on next sign-in/reload/manual "Sync now".
  useEffect(() => {
    if (!user) return undefined;
    const unsubscribe = subscribeUserData(
      user.uid,
      (remote) => {
        const fingerprint = computeSyncFingerprint(remote);
        if (fingerprint === lastSyncedSnapshotRef.current) return; // our own write echoing back
        applyRemoteData(remote);
      },
      (err) => console.error('[SchedulerContext] Live sync listener failed', err)
    );
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Pushes local data up to the cloud doc whenever it changes, so the NEXT
  // device to sign in (or this device's next reload) picks up the latest
  // state. Debounced so a burst of edits (typing, dragging) doesn't fire a
  // write per keystroke.
  useEffect(() => {
    if (!user) return;
    if (!initialPullDoneRef.current) return; // wait for this sign-in's pull to settle first — see initialPullDoneRef's comment
    const payload = { tasks, blocks, sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, pinnedLinks, shortcutBindings };
    const fingerprint = computeSyncFingerprint(payload);
    if (fingerprint === lastSyncedSnapshotRef.current) return; // already matches what's synced
    const handle = setTimeout(() => {
      // Stamp the ref before sending, not after resolution — otherwise a local
      // change (e.g. undo) made while this write is in flight can race the
      // listener above, which would mistake the server echo for a genuine
      // remote change and stomp the undo.
      lastSyncedSnapshotRef.current = fingerprint;
      pushUserData(user.uid, payload).catch((err) => {
        console.error('[SchedulerContext] Cloud sync failed to save', err);
      });
    }, 1500);
    return () => clearTimeout(handle);
  }, [user, tasks, blocks, sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, pinnedLinks, shortcutBindings]);

  /**
   * Manual re-pull for Settings' "Sync now" button — covers the gap this
   * app's sync model deliberately leaves open (no live listener; see
   * firestoreSync.js): if another device pushed changes while this tab was
   * already open and signed in, those changes only arrive on next sign-in
   * or reload unless the user asks for them explicitly here.
   */
  const syncNow = useCallback(async () => {
    if (!user) return;
    setIsSyncing(true);
    try {
      await pullFromCloud(user.uid);
      // Also refetch+merge Google Calendar events, so one "Sync now" click
      // covers both Firestore AND Google Calendar instead of just the former.
      if (googleConnected) {
        const rangeStartIso = toISODate(new Date());
        const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
        const { events: fetchedEvents } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
        setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
      }
      setNotification({ type: 'success', message: 'Synced with your account.' });
    } catch (err) {
      console.error('[SchedulerContext] Manual cloud sync failed', err);
      setNotification({ type: 'error', message: `Sync failed: ${err.message || err}` });
    } finally {
      setIsSyncing(false);
    }
  }, [user, pullFromCloud, googleConnected]);

  // ---- Backup / restore -----------------------------------------------------

  /**
   * Applies a full backup payload (from a local file import or a cloud
   * backup — same shape either way, see backupService.js) onto current
   * state. Mirrors applyRemoteData's field-by-field apply above, but routes
   * tasks/blocks through commit() so a restore is itself one undoable
   * action, matching clearAllData's precedent. A payload missing a field
   * (an older/partial backup) leaves that field untouched rather than
   * wiping it.
   */
  const restoreFromBackup = useCallback(
    (payload) => {
      if (!payload) return;
      if ('tasks' in payload || 'blocks' in payload) {
        commit(
          { tasks: payload.tasks ?? stateRef.current.tasks, blocks: payload.blocks ?? stateRef.current.blocks },
          'Restored from backup'
        );
      }
      if ('sections' in payload) setSections(payload.sections);
      if ('projects' in payload) setProjects(payload.projects);
      if ('labels' in payload) setLabels(payload.labels);
      if ('routines' in payload) setRoutines(payload.routines);
      if ('rules' in payload) setRules(payload.rules);
      // Deduped the same way applyRemoteData/the boot-time load already are —
      // a backup can carry duplicate copies of the same event occurrence for
      // the same reasons localStorage/Firestore can (see dedupeEventsByOccurrence's
      // own comment), so restoring one shouldn't reintroduce them.
      if ('events' in payload) setEvents(dedupeEventsByOccurrence(payload.events));
      if ('soundEnabled' in payload) setSoundEnabled(payload.soundEnabled);
      if ('soundVolume' in payload) setSoundVolume(payload.soundVolume);
      if ('animationsEnabled' in payload) setAnimationsEnabled(payload.animationsEnabled);
      if ('theme' in payload) setTheme(payload.theme);
      if ('pinnedLinks' in payload) setPinnedLinks(payload.pinnedLinks);
      if ('shortcutBindings' in payload) {
        setShortcutBindings(payload.shortcutBindings);
        // Same reasoning as applyRemoteData above — keep the hot keydown
        // listener's localStorage source in sync immediately, not just this
        // context's own React-state mirror.
        savePersisted('shortcutBindings', payload.shortcutBindings);
      }
    },
    [
      commit,
      setSections,
      setProjects,
      setLabels,
      setRoutines,
      setRules,
      setEvents,
      setSoundEnabled,
      setSoundVolume,
      setAnimationsEnabled,
      setTheme,
      setPinnedLinks,
      setShortcutBindings,
    ]
  );

  /** Downloads a full backup of current state as a local .json file — works signed-out, since it never touches Firestore. */
  const exportBackup = useCallback(() => {
    const payload = buildBackupPayload({
      tasks: stateRef.current.tasks,
      blocks: stateRef.current.blocks,
      sections,
      projects,
      labels,
      routines,
      rules,
      events,
      soundEnabled,
      soundVolume,
      animationsEnabled,
      theme,
      pinnedLinks,
      shortcutBindings,
    });
    downloadBackupFile(payload);
  }, [sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, theme, pinnedLinks, shortcutBindings]);

  /** Reads a backup .json file the user picked and restores it — works signed-out, matching exportBackup. */
  const importBackupFromFile = useCallback(
    async (file) => {
      try {
        const payload = await readBackupFile(file);
        if (!isValidBackupPayload(payload)) {
          setNotification({ type: 'error', message: "That file doesn't look like a TaskFlow backup." });
          return { ok: false };
        }
        restoreFromBackup(payload);
        setNotification({ type: 'success', message: 'Restored from backup file.' });
        return { ok: true };
      } catch (err) {
        console.error('[SchedulerContext] Restore from file failed', err);
        setNotification({ type: 'error', message: `Restore failed: ${err.message || err}` });
        return { ok: false };
      }
    },
    [restoreFromBackup]
  );

  /** Re-fetches the signed-in user's cloud backup list (metadata only) for Settings' backups picker. */
  const refreshCloudBackups = useCallback(async () => {
    if (!user) return;
    try {
      setCloudBackups(await listBackups(user.uid));
    } catch (err) {
      console.error('[SchedulerContext] Failed to list cloud backups', err);
      setNotification({ type: 'error', message: `Couldn't load cloud backups: ${err.message || err}` });
    }
  }, [user]);

  /** Settings' "Back up now" button — an explicit, immediate cloud backup on top of the silent sign-in cadence in maybeAutoBackup. */
  const backupToCloud = useCallback(async () => {
    if (!user) return;
    setIsBackingUp(true);
    try {
      const payload = buildBackupPayload({
        tasks: stateRef.current.tasks,
        blocks: stateRef.current.blocks,
        sections,
        projects,
        labels,
        routines,
        rules,
        events,
        soundEnabled,
        soundVolume,
        animationsEnabled,
        theme,
        pinnedLinks,
        shortcutBindings,
      });
      await createBackup(user.uid, payload);
      await refreshCloudBackups();
      setNotification({ type: 'success', message: 'Backed up to your account.' });
    } catch (err) {
      console.error('[SchedulerContext] Cloud backup failed', err);
      setNotification({ type: 'error', message: `Backup failed: ${err.message || err}` });
    } finally {
      setIsBackingUp(false);
    }
  }, [user, sections, projects, labels, routines, rules, events, soundEnabled, soundVolume, animationsEnabled, theme, pinnedLinks, shortcutBindings, refreshCloudBackups]);

  /** Fetches one cloud backup's full payload by id and restores it. */
  const restoreCloudBackup = useCallback(
    async (backupId) => {
      if (!user) return;
      setIsBackingUp(true);
      try {
        const payload = await getBackup(user.uid, backupId);
        if (!payload) {
          setNotification({ type: 'error', message: 'That backup no longer exists.' });
          return;
        }
        restoreFromBackup(payload);
        setNotification({ type: 'success', message: 'Restored from cloud backup.' });
      } catch (err) {
        console.error('[SchedulerContext] Cloud restore failed', err);
        setNotification({ type: 'error', message: `Restore failed: ${err.message || err}` });
      } finally {
        setIsBackingUp(false);
      }
    },
    [user, restoreFromBackup]
  );

  /** Deletes one cloud backup by id. */
  const deleteCloudBackup = useCallback(
    async (backupId) => {
      if (!user) return;
      try {
        await deleteBackup(user.uid, backupId);
        setCloudBackups((prev) => prev.filter((b) => b.id !== backupId));
      } catch (err) {
        console.error('[SchedulerContext] Delete cloud backup failed', err);
        setNotification({ type: 'error', message: `Couldn't delete backup: ${err.message || err}` });
      }
    },
    [user]
  );

  // ---- Google Calendar connection ----------------------------------------
  const connectGoogleCalendar = useCallback(async () => {
    try {
      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
      const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
      const { enabled } = await initGoogleCalendar(clientId, apiKey);
      if (!enabled) {
        setNotification({ type: 'info', message: 'Google Calendar not configured — see README for setup. Using mock events.' });
        return;
      }
      await requestAccessToken(false); // explicit user action — show consent screen if needed
      setGoogleConnected(true);
      setGoogleNeedsReconnect(false); // a fresh connect/reconnect clears any prior "disconnected" indicator
      const rangeStartIso = toISODate(new Date());
      const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
      // MERGE, not replace — see the load effect above / eventSyncService.js
      // for why a plain setEvents(fetchedEvents) here would silently delete
      // every manual event on every manual (re)connect.
      setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Connected, but couldn't load events from: ${failedCalendars.join(', ')}.`,
        });
      } else {
        setNotification({ type: 'success', message: 'Connected to Google Calendar.' });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Google Calendar connection failed: ${reason}` });
    }
  }, [setGoogleConnected]);

  /**
   * Manual, on-demand re-pull of Google Calendar events — for when a user
   * suspects drift or wants to discard local edits to synced events. Uses
   * the same fetch window and the same mergePulledGoogleEvents policy as
   * connectGoogleCalendar/the periodic sync (Google always wins for
   * anything it returns), just triggered explicitly instead of on
   * mount/connect/interval.
   */
  const pullFromGoogleCalendar = useCallback(async () => {
    if (!googleConnected) return;
    setIsPullingGoogleEvents(true);
    try {
      const rangeStartIso = toISODate(new Date());
      const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
      setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Pulled, but couldn't load events from: ${failedCalendars.join(', ')}.`,
        });
      } else {
        setNotification({ type: 'success', message: 'Pulled latest events from Google Calendar.' });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Pull from Google Calendar failed: ${reason}` });
    } finally {
      setIsPullingGoogleEvents(false);
    }
  }, [googleConnected]);

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
      const localId = `task_${Date.now()}`;
      const newTask = {
        id: localId,
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
      commit({ tasks: [...tasks, newTask], blocks }, `Added task "${newTask.title}"`);
      if (soundEnabled) playAddSound(soundVolume);
    },
    [tasks, blocks, commit, soundEnabled, soundVolume]
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
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t));
      commit({ tasks: newTasks, blocks }, `Updated task`);
    },
    [tasks, blocks, commit]
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
      const newTasks = tasks
        .filter((t) => !idsToDelete.has(t.id))
        .map((t) =>
          t.dependsOn?.some((id) => idsToDelete.has(id))
            ? { ...t, dependsOn: t.dependsOn.filter((id) => !idsToDelete.has(id)) }
            : t
        );
      const newBlocks = blocks.filter((b) => !idsToDelete.has(b.taskId));
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
      commit({ tasks: newTasks, blocks: newBlocks }, `Deleted task`);
      if (soundEnabled) playDeleteSound(soundVolume);
    },
    [tasks, blocks, commit, user, soundEnabled, soundVolume]
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
   */
  const completeTask = useCallback(
    (taskId, actualHours) => {
      const existing = tasks.find((t) => t.id === taskId);
      if (!existing) return;
      const descendantIds = new Set(getDescendantIds(taskId, tasks));

      if (existing.isRecurring && existing.dueDate) {
        // Base the next occurrence off today (not the stale due date) when the
        // task is completed late, so finishing an overdue daily task today
        // makes it due tomorrow instead of 1 day after the missed due date.
        const todayIso = toISODate(new Date());
        const baseDate = existing.dueDate < todayIso ? todayIso : existing.dueDate;
        const nextDueDate = computeNextDueDate(baseDate, existing.recurrenceString);
        const nowIso = new Date().toISOString();
        const newTasks = tasks.map((t) => {
          if (t.id === taskId) {
            return { ...t, dueDate: nextDueDate, remainingHours: t.estimatedHours, isCompleted: false, updatedAt: nowIso };
          }
          if (descendantIds.has(t.id)) {
            return { ...t, isCompleted: false, dueDate: null, updatedAt: nowIso };
          }
          return t;
        });
        // Drop any *unlocked* blocks scheduled for the just-finished
        // occurrence — a fresh planning window starts from the new due date
        // on the next rebalance. Locked blocks are protected the same way a
        // rebalance protects them (see rebalanceEngine), and blocks for
        // other tasks are untouched.
        const newBlocks = blocks.filter((b) => b.taskId !== taskId || b.isLocked);
        commit({ tasks: newTasks, blocks: newBlocks }, `Completed recurring task — advanced to ${nextDueDate}`);
        return;
      }

      const nowIso = new Date().toISOString();
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
        return t;
      });
      commit({ tasks: newTasks, blocks }, `Completed task`);
    },
    [tasks, blocks, commit]
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
    const localId = `proj_${Date.now()}`;
    setProjects((prev) => [...prev, { id: localId, name: trimmed, order: prev.length + 1 }]);
    return { ok: true };
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
      const newTasks = tasks.map((t) =>
        t.projectId === projectId ? { ...t, projectId: null, sectionId: null, sectionName: null } : t
      );
      commit({ tasks: newTasks, blocks }, `Deleted project`);
    },
    [tasks, blocks, commit]
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
      if (!trimmed || !projectId) return;
      const localId = `sec_${Date.now()}`;
      const newSection = { id: localId, name: trimmed, projectId, order: sections.length + 1 };
      setSections((prev) => [...prev, newSection]);
    },
    [sections.length]
  );

  const renameSection = useCallback(
    (sectionId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s)));
      // Denormalized sectionName on any task currently in this section stays in sync too.
      const newTasks = tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionName: trimmed } : t));
      if (newTasks.some((t, i) => t !== tasks[i])) commit({ tasks: newTasks, blocks }, `Renamed section`);
    },
    [tasks, blocks, commit]
  );

  const deleteSection = useCallback(
    (sectionId) => {
      setSections((prev) => prev.filter((s) => s.id !== sectionId));
      // Tasks in the deleted section fall back to "No Section", matching what Todoist does.
      const newTasks = tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionId: null, sectionName: null } : t));
      commit({ tasks: newTasks, blocks }, `Deleted section`);
    },
    [tasks, blocks, commit]
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

  // ---- Push all auto-scheduled, unpushed blocks to Google Calendar --------
  const pushToGoogleCalendar = useCallback(async () => {
    setIsSyncing(true);
    try {
      const toPush = blocks.filter((b) => !b.googleEventId);
      const pushedEventIdsByBlockId = new Map();
      for (const block of toPush) {
        const task = tasks.find((t) => t.id === block.taskId);
        if (!task) continue;
        const eventId = await pushBlockToCalendar(block, task);
        if (eventId) pushedEventIdsByBlockId.set(block.id, eventId);
      }
      // Apply the pushed googleEventIds onto the LATEST blocks (via
      // stateRef), not the `blocks` closed over at call time — the network
      // round-trip above can take a while per block, and any edit/delete
      // that lands while it's in flight would otherwise be clobbered by
      // committing the stale array wholesale.
      const latestBlocks = stateRef.current.blocks;
      const updated = latestBlocks.map((b) =>
        pushedEventIdsByBlockId.has(b.id) ? { ...b, googleEventId: pushedEventIdsByBlockId.get(b.id) } : b
      );
      commit({ tasks: stateRef.current.tasks, blocks: updated }, `Pushed ${pushedEventIdsByBlockId.size} block(s) to Google Calendar`);
      setNotification({ type: 'success', message: `Pushed ${pushedEventIdsByBlockId.size} block(s) to Google Calendar.` });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: `Push to Google Calendar failed: ${err.message || err}` });
    } finally {
      setIsSyncing(false);
    }
  }, [blocks, tasks, commit]);

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
        id: `evt_manual_${Date.now()}`,
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
      notification,
      setNotification,
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
      pinnedLinks,
      setPinnedLinks,
      shortcutBindings,
      setShortcutBindings,
      setSearchQuery,
      undo,
      redo,
      runRebalance,
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
      restoreFromBackup,
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
      notification,
      setNotification,
      canUndo,
      canRedo,
      currentActionLabel,
      actionToast,
      dismissActionToast,
      soundEnabled,
      soundVolume,
      animationsEnabled,
      pinnedLinks,
      shortcutBindings,
      undo,
      redo,
      runRebalance,
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
      restoreFromBackup,
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

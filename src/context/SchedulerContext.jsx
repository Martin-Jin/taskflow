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
 *   - If Todoist sync is OFF (no token configured, or the user has
 *     switched off "Keep syncing task changes to Todoist" in Settings),
 *     the initial-load effect below does NOT re-fetch from Todoist —
 *     the locally persisted `tasks` are the source of truth, full stop.
 *     This is what makes local-only mode actually local-only: without
 *     this guard, every page load would silently re-import from Todoist
 *     and clobber local edits regardless of the toggle.
 *   - If Google Calendar was connected in a previous session,
 *     `googleConnected` persists and the load effect attempts a SILENT
 *     token refresh (no popup) so the user isn't asked to sign in again
 *     every time they open the app. If the silent refresh fails (token
 *     revoked, grant expired), we fall back to `googleConnected: false`
 *     and the user just clicks "Connect" again — no error state, no
 *     forced popup on load.
 *
 * TWO-WAY TODOIST SYNC: every task/subtask/section mutation below applies
 * the change to local state immediately (so the UI and Undo/Redo never
 * wait on a network round trip), then — if the item is Todoist-sourced and
 * a token is configured — fires the matching todoistService write call in
 * the background. Failures surface as a toast rather than rolling back the
 * local edit, since silently reverting a change the user just made would
 * be more confusing than a "sync failed, retry from Todoist" notice.
 * Local-only ("manual") tasks and their subtasks are never pushed, since
 * there's no corresponding Todoist item to update.
 *
 * RECURRING TASKS: a Task can carry `isRecurring` + `recurrenceString`
 * (captured from Todoist's `due.is_recurring` / `due.string` on import, or
 * set directly when adding/editing a local task). Completing a recurring
 * task does NOT set `isCompleted` — mirroring Todoist, where checking off a
 * recurring task just advances its due date to the next occurrence and
 * keeps it active. See `completeTask` below and `utils/recurrence.js` for
 * the local next-due-date computation, which now uses a much more
 * permissive parser (handles "every month", "monthly", "every 1 month",
 * Todoist's non-shifting "every!" marker, etc.) plus a defensive fallback
 * detector (`isRecurringDue`) so recurrence is picked up even if Todoist's
 * `is_recurring` flag is ever missing on a task that clearly repeats.
 *
 * `recurrenceString` is now also a Todoist-synced field (see
 * TODOIST_SYNCED_FIELDS below) — editing the "Repeats every N ___" control
 * in TaskDetailModal/AddTaskModal pushes the change to Todoist via its
 * natural-language `due_string` field, same as any other synced field.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHistoryState } from '../hooks/useHistoryState';
import { usePersistedState } from '../hooks/usePersistedState';
import { loadPersisted, savePersisted } from '../utils/persistence.js';
import { rebalance } from '../algorithms/rebalanceEngine';
import { computeNextDueDate } from '../utils/recurrence';
import {
  fetchTasks as fetchTodoistTasks,
  fetchSections as fetchTodoistSections,
  fetchProjects as fetchTodoistProjects,
  createProject as createTodoistProject,
  createTask as createTodoistTask,
  updateTask as updateTodoistTask,
  moveTask as moveTodoistTask,
  deleteTask as deleteTodoistTask,
  setTaskCompleted as setTodoistTaskCompleted,
  createSubtask as createTodoistSubtask,
  setSubtaskCompleted as setTodoistSubtaskCompleted,
  deleteSubtask as deleteTodoistSubtask,
  renameSubtask as renameTodoistSubtask,
  createSection as createTodoistSection,
  renameSection as renameTodoistSection,
  deleteSection as deleteTodoistSection,
} from '../services/todoistService';
import { fetchEvents as fetchGoogleEvents, pushBlockToCalendar, initGoogleCalendar, requestAccessToken } from '../services/googleCalendarService';
import { getDefaultRoutines, getDefaultRules, getMockTasks, getMockSections, getMockProjects } from '../services/mockData';
import { toISODate } from '../utils/dateUtils';
import { nextLabelColor } from '../utils/labelColor';

const SchedulerContext = createContext(null);

/** Fields on a Task that have a Todoist equivalent and should be pushed on updateTask(). */
const TODOIST_SYNCED_FIELDS = ['title', 'notes', 'priority', 'dueDate', 'estimatedHours', 'recurrenceString'];

const EVENTS_HORIZON_DAYS = 28;

export function SchedulerProvider({ children }) {
  // tasks/blocks: seeded from whatever was last saved locally (falling back
  // to mock data on first-ever run). Whether the initial-load effect below
  // overwrites `tasks` depends on whether Todoist sync is actually active
  // (see the effect) — `blocks` (calendar placements) have no Todoist
  // equivalent and are NEVER overwritten by that effect; the persisted
  // copy is always the source of truth for them.
  const { state, commit, undo, redo, canUndo, canRedo, currentActionLabel } = useHistoryState({
    tasks: loadPersisted('tasks', null) ?? getMockTasks(),
    blocks: loadPersisted('blocks', null) ?? [],
  });

  // Pure user preferences — persisted verbatim, no Todoist/Google
  // equivalent to fall back on, so these must survive a refresh or every
  // setting (work hours, buffer days, routines, sync toggle...) would
  // silently reset each time the app is opened.
  const [routines, setRoutines] = usePersistedState('routines', getDefaultRoutines);
  const [rules, setRules] = usePersistedState('rules', getDefaultRules);
  const [taskSyncEnabled, setTaskSyncEnabled] = usePersistedState('taskSyncEnabled', true);

  // Whether the user has connected Google Calendar in *some* previous
  // session. The actual OAuth access token is short-lived and lives only
  // in googleCalendarService's module state (tokens shouldn't be persisted
  // to localStorage), but THIS flag persisting is what lets the load
  // effect know it should attempt a silent re-auth instead of requiring a
  // manual "Connect" click every time.
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);

  // events: seeded from local storage so a refresh doesn't blank the
  // calendar grid while the silent Google re-auth (below) is in flight, or
  // permanently if Google Calendar isn't configured at all (mock events
  // persist too, which is fine — they're deterministic from `mockData.js`
  // regardless).
  const [events, setEvents] = useState(() => loadPersisted('events', null) ?? []);

  // sections/projects: same idea as tasks — seeded from local storage so a
  // refresh doesn't wipe locally-created boards/sections when Todoist isn't
  // configured (or sync is paused), but overwritten by the Todoist fetch
  // below whenever that sync is actually active.
  const [sections, setSections] = useState(() => loadPersisted('sections', null) ?? getMockSections());
  const [projects, setProjects] = useState(() => loadPersisted('projects', null) ?? getMockProjects());
  // labels: app-local tags (see types/index.js's Label typedef) — no Todoist
  // equivalent, so unlike sections/projects this is never overwritten by the
  // Todoist load effect below.
  const [labels, setLabels] = useState(() => loadPersisted('labels', null) ?? []);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
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

  // The Todoist token: a per-visitor personal API token entered in Settings
  // (see setTodoistApiToken below), persisted to THIS BROWSER's localStorage
  // only — never bundled into the build, since this app is hosted as a
  // public static site and a build-time token would leak the deployer's own
  // Todoist account to every visitor. `VITE_TODOIST_API_TOKEN` is still read
  // as a fallback purely for local `npm run dev` convenience; it's gitignored
  // (see .env.example) and stays out of any production build a visitor uses.
  // A ref (not state) because every write helper below needs the current
  // value without re-creating its callback whenever unrelated state changes;
  // changing the token instead reloads the page (see setTodoistApiToken),
  // which naturally re-reads this on the fresh mount.
  const todoistTokenRef = useRef(loadPersisted('todoistToken', null) || import.meta.env.VITE_TODOIST_API_TOKEN || null);
  const todoistToken = todoistTokenRef.current;
  const todoistEnabled = !!todoistToken; // "is a Todoist token configured" — governs import + UI visibility
  const syncActive = todoistEnabled && taskSyncEnabled; // "should we actually push writes to Todoist right now"

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

  /** Surface a background sync failure without disturbing the local edit that already applied. */
  const notifySyncFailure = useCallback((action, err) => {
    console.error(`[SchedulerContext] Todoist sync failed: ${action}`, err);
    setNotification({ type: 'warning', message: `Saved locally, but syncing to Todoist failed (${action}): ${err.message || err}` });
  }, []);

  // ---- Initial data load ---------------------------------------------------
  // Runs once on mount. Two independent concerns, gated separately:
  //   1. Todoist projects/sections/tasks — only re-fetched if sync is
  //      actually active (token configured AND the user hasn't paused it
  //      in Settings). If sync is off, whatever was loaded from
  //      localStorage above stands untouched — that's the whole point of
  //      "local-only" mode.
  //   2. Google Calendar events — only attempted if the user previously
  //      connected (persisted `googleConnected`), and done SILENTLY (no
  //      consent popup) so re-opening the app doesn't require signing in
  //      again. If the silent attempt fails, we quietly fall back to
  //      "not connected" rather than throwing an error at the user.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      const shouldSyncTodoist = todoistEnabled && taskSyncEnabled;

      try {
        if (shouldSyncTodoist) {
          const [fetchedProjects, fetchedSections] = await Promise.all([
            fetchTodoistProjects(todoistToken),
            fetchTodoistSections(todoistToken),
          ]);
          const sectionsById = new Map(fetchedSections.map((s) => [s.id, s.name]));
          const fetchedTasks = await fetchTodoistTasks(todoistToken, sectionsById);
          if (!cancelled) {
            // NOTE: blocks is intentionally preserved here (not reset to
            // []) — calendar placements have no Todoist equivalent and
            // this effect runs on every mount, so resetting it would wipe
            // the user's schedule every time the app reloads. Read via
            // stateRef (not the `blocks` closed over at mount) in case the
            // user edited a block while this fetch was in flight.
            commit({ tasks: fetchedTasks, blocks: stateRef.current.blocks }, 'Loaded tasks from Todoist');
            setSections(fetchedSections);
            setProjects(fetchedProjects);
          }
        }
        // else: sync is off — leave the locally persisted tasks/sections/
        // projects exactly as loaded from storage above.
      } catch (err) {
        console.error('Failed to load Todoist data', err);
        if (!cancelled) setNotification({ type: 'error', message: `Failed to load Todoist data: ${err.message}` });
      }

      if (googleConnected) {
        try {
          const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
          const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
          const { enabled } = await initGoogleCalendar(clientId, apiKey);
          if (enabled) {
            await requestAccessToken(true); // silent — no consent popup
            const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(
              toISODate(new Date()),
              toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000))
            );
            if (!cancelled) {
              setEvents(fetchedEvents);
              if (failedCalendars.length > 0) {
                setNotification({
                  type: 'warning',
                  message: `Couldn't load events from: ${failedCalendars.join(', ')}. Check that you still have access to these calendars.`,
                });
              }
            }
          } else if (!cancelled) {
            setGoogleConnected(false);
          }
        } catch (err) {
          // Silent refresh failed — the grant likely expired or was
          // revoked. Don't show an error; just fall back to "disconnected"
          // so the Settings panel invites a normal manual reconnect.
          console.warn('[SchedulerContext] Silent Google Calendar re-auth failed, falling back to disconnected.', err);
          if (!cancelled) setGoogleConnected(false);
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
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(
        toISODate(new Date()),
        toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000))
      );
      setEvents(fetchedEvents);
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
   * Add a task. Local-only by default (source: 'manual'); pass
   * `syncToTodoist: true` (e.g. from an "Add to Todoist too" checkbox) to
   * also create it in Todoist immediately and adopt the returned todoistId.
   *
   * A due date is OPTIONAL — an undated task simply has no planning window
   * for the allocator, so it never gets auto-scheduled, but it still shows
   * up normally in the Tasks list and Board view (matching Todoist).
   */
  const addTask = useCallback(
    (taskInput) => {
      const { syncToTodoist, ...rest } = taskInput;
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'manual',
        subtasks: [],
        ...rest,
      };
      commit({ tasks: [...tasks, newTask], blocks }, `Added task "${newTask.title}"`);

      if (syncToTodoist && syncActive) {
        createTodoistTask(todoistToken, {
          title: newTask.title,
          notes: newTask.notes,
          priority: newTask.priority,
          dueDate: newTask.dueDate,
          estimatedHours: newTask.estimatedHours,
          recurrenceString: newTask.recurrenceString,
          projectId: newTask.projectId,
          sectionId: newTask.sectionId,
        })
          .then((created) => {
            if (!created?.id) return;
            // Read the latest tasks/blocks (via stateRef), not the `tasks`
            // closed over at call time — an intervening commit elsewhere
            // must not be clobbered by this delayed follow-up commit.
            commit(
              {
                tasks: stateRef.current.tasks.map((t) =>
                  t.id === localId ? { ...t, source: 'todoist', todoistId: String(created.id) } : t
                ),
                blocks: stateRef.current.blocks,
              },
              `Synced task "${newTask.title}" to Todoist`
            );
          })
          .catch((err) => notifySyncFailure('create task', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  /**
   * Update a task's fields. Applies locally first, then pushes any
   * Todoist-synced fields (title/notes/priority/dueDate/estimatedHours/
   * recurrenceString) and, separately, any section/project move — Todoist
   * requires the move to go through its own `/move` endpoint rather than
   * the general update call.
   *
   * LIVE UI UPDATE: because this always calls `commit`, which updates the
   * shared `tasks` array in context, every consumer reading `tasks` (the
   * task list, board, and any open TaskDetailModal that derives its `task`
   * prop from `tasks` rather than holding a stale local copy) re-renders
   * with the new data immediately — no need to close/reopen anything.
   */
  const updateTask = useCallback(
    (taskId, updates) => {
      const existing = tasks.find((t) => t.id === taskId);
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t));
      commit({ tasks: newTasks, blocks }, `Updated task`);

      if (!existing || existing.source !== 'todoist' || !syncActive || !existing.todoistId) return;

      const fieldUpdates = {};
      for (const field of TODOIST_SYNCED_FIELDS) {
        if (field in updates) fieldUpdates[field] = updates[field];
      }
      if (Object.keys(fieldUpdates).length > 0) {
        updateTodoistTask(todoistToken, existing.todoistId, fieldUpdates).catch((err) => notifySyncFailure('update task', err));
      }

      if ('sectionId' in updates || 'projectId' in updates) {
        moveTodoistTask(todoistToken, existing.todoistId, {
          sectionId: 'sectionId' in updates ? updates.sectionId : undefined,
          projectId: 'projectId' in updates ? updates.projectId : undefined,
        }).catch((err) => notifySyncFailure('move task', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  const deleteTask = useCallback(
    (taskId) => {
      const existing = tasks.find((t) => t.id === taskId);
      const newTasks = tasks.filter((t) => t.id !== taskId);
      const newBlocks = blocks.filter((b) => b.taskId !== taskId);
      commit({ tasks: newTasks, blocks: newBlocks }, `Deleted task`);

      if (existing?.source === 'todoist' && syncActive && existing.todoistId) {
        deleteTodoistTask(todoistToken, existing.todoistId).catch((err) => notifySyncFailure('delete task', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  // Lock/unlock is a scheduling-engine-only concept with no Todoist
  // equivalent, so it's never synced.
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
   * date advances to the next occurrence (computed locally via
   * utils/recurrence.js — now with a much more permissive parser and a
   * defensive "does the string look like a recurrence rule" fallback, so
   * "every month", "monthly", "every 1 month" etc. all advance correctly
   * instead of silently falling back to +1 day), `remainingHours` resets
   * to `estimatedHours` so it's schedulable again, and `isCompleted` stays
   * false. Any scheduled blocks tied to the task's *previous* occurrence
   * are removed, since they belonged to a cycle that's now closed out. We
   * still call Todoist's `close` endpoint (not `reopen`) for recurring
   * tasks — that's the exact action Todoist itself uses to advance a
   * recurring task's date server-side, and it remains the ultimate
   * authority on the precise next date on the next sync.
   *
   * NON-RECURRING TASKS: unchanged — `isCompleted: true`, `remainingHours: 0`.
   */
  const completeTask = useCallback(
    (taskId) => {
      const existing = tasks.find((t) => t.id === taskId);
      if (!existing) return;

      if (existing.isRecurring && existing.dueDate) {
        const nextDueDate = computeNextDueDate(existing.dueDate, existing.recurrenceString);
        const newTasks = tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                dueDate: nextDueDate,
                remainingHours: t.estimatedHours,
                isCompleted: false,
                updatedAt: new Date().toISOString(),
              }
            : t
        );
        // Drop any blocks scheduled for the just-finished occurrence — a
        // fresh planning window starts from the new due date on the next
        // rebalance. Blocks for other tasks are untouched.
        const newBlocks = blocks.filter((b) => b.taskId !== taskId);
        commit({ tasks: newTasks, blocks: newBlocks }, `Completed recurring task — advanced to ${nextDueDate}`);

        if (existing.source === 'todoist' && syncActive && existing.todoistId) {
          setTodoistTaskCompleted(todoistToken, existing.todoistId, true).catch((err) => notifySyncFailure('complete recurring task', err));
        }
        return;
      }

      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, isCompleted: true, remainingHours: 0 } : t));
      commit({ tasks: newTasks, blocks }, `Completed task`);

      if (existing.source === 'todoist' && syncActive && existing.todoistId) {
        setTodoistTaskCompleted(todoistToken, existing.todoistId, true).catch((err) => notifySyncFailure('complete task', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  // ---- Subtask CRUD (nested under a parent Task) ---------------------------

  const addSubtask = useCallback(
    (taskId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const parent = tasks.find((t) => t.id === taskId);
      if (!parent) return;
      const localId = `sub_${Date.now()}`;
      const newSubtasks = [...(parent.subtasks || []), { id: localId, title: trimmed, isCompleted: false }];
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, subtasks: newSubtasks, updatedAt: new Date().toISOString() } : t));
      commit({ tasks: newTasks, blocks }, `Added subtask`);

      if (parent.source === 'todoist' && syncActive && parent.todoistId) {
        createTodoistSubtask(todoistToken, parent.todoistId, trimmed)
          .then((created) => {
            if (!created?.id) return;
            // Read the latest tasks/blocks (via stateRef) rather than the
            // `tasks` closed over at call time — see stateRef's doc comment.
            const latestTasks = stateRef.current.tasks;
            const latestParent = latestTasks.find((t) => t.id === taskId);
            if (!latestParent) return;
            const updatedSubtasks = (latestParent.subtasks || newSubtasks).map((s) =>
              s.id === localId ? { ...s, todoistId: String(created.id) } : s
            );
            const finalTasks = latestTasks.map((t) => (t.id === taskId ? { ...t, subtasks: updatedSubtasks } : t));
            commit({ tasks: finalTasks, blocks: stateRef.current.blocks }, `Synced subtask to Todoist`);
          })
          .catch((err) => notifySyncFailure('add subtask', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  const renameSubtask = useCallback(
    (taskId, subtaskId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const parent = tasks.find((t) => t.id === taskId);
      if (!parent) return;
      const sub = parent.subtasks?.find((s) => s.id === subtaskId);
      const newTasks = tasks.map((t) =>
        t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, title: trimmed } : s)) } : t
      );
      commit({ tasks: newTasks, blocks }, `Renamed subtask`);

      if (sub?.todoistId && syncActive) {
        renameTodoistSubtask(todoistToken, sub.todoistId, trimmed).catch((err) => notifySyncFailure('rename subtask', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  const toggleSubtask = useCallback(
    (taskId, subtaskId) => {
      const parent = tasks.find((t) => t.id === taskId);
      if (!parent) return;
      const sub = parent.subtasks?.find((s) => s.id === subtaskId);
      const nextCompleted = !sub?.isCompleted;
      const newTasks = tasks.map((t) =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, isCompleted: nextCompleted } : s)) }
          : t
      );
      commit({ tasks: newTasks, blocks }, `Toggled subtask`);

      if (sub?.todoistId && syncActive) {
        setTodoistSubtaskCompleted(todoistToken, sub.todoistId, nextCompleted).catch((err) => notifySyncFailure('toggle subtask', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  const removeSubtask = useCallback(
    (taskId, subtaskId) => {
      const parent = tasks.find((t) => t.id === taskId);
      if (!parent) return;
      const sub = parent.subtasks?.find((s) => s.id === subtaskId);
      const newTasks = tasks.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subtaskId) } : t));
      commit({ tasks: newTasks, blocks }, `Removed subtask`);

      if (sub?.todoistId && syncActive) {
        deleteTodoistSubtask(todoistToken, sub.todoistId).catch((err) => notifySyncFailure('delete subtask', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  /**
   * Update a subtask's title/notes/completion from its own compact detail
   * view (SubtaskDetailModal) in one commit, rather than composing the
   * individual renameSubtask/toggleSubtask calls above — those still exist
   * for the quick inline checkbox/rename affordances in the checklist row.
   * Only `title` and `isCompleted` have a Todoist equivalent; `notes` stays
   * app-local (see Subtask typedef).
   */
  const updateSubtask = useCallback(
    (taskId, subtaskId, updates) => {
      const parent = tasks.find((t) => t.id === taskId);
      if (!parent) return;
      const sub = parent.subtasks?.find((s) => s.id === subtaskId);
      if (!sub) return;
      const nextTitle = updates.title !== undefined ? updates.title.trim() || sub.title : sub.title;
      const newTasks = tasks.map((t) =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, ...updates, title: nextTitle } : s)) }
          : t
      );
      commit({ tasks: newTasks, blocks }, `Updated subtask`);

      if (sub.todoistId && syncActive) {
        if (updates.title !== undefined && nextTitle !== sub.title) {
          renameTodoistSubtask(todoistToken, sub.todoistId, nextTitle).catch((err) => notifySyncFailure('rename subtask', err));
        }
        if (updates.isCompleted !== undefined && updates.isCompleted !== sub.isCompleted) {
          setTodoistSubtaskCompleted(todoistToken, sub.todoistId, updates.isCompleted).catch((err) =>
            notifySyncFailure('toggle subtask', err)
          );
        }
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
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

  // ---- Project CRUD (Board view "boards") -----------------------------------

  /**
   * Create a new Project ("board"). If Todoist is configured, tries to
   * create it there first (so it two-way-syncs like everything else). If
   * Todoist rejects it because the account has hit its project limit (free
   * tier: 5 active projects), we fall back to a LOCAL-ONLY project instead
   * of failing outright — the board still works in TaskFlow, it just won't
   * exist in Todoist, and we tell the user that explicitly via toast so
   * they're not confused later about why it's missing from the Todoist app.
   *
   * @returns {Promise<{ ok: boolean, localOnly: boolean }>}
   */
  const addProject = useCallback(
    async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return { ok: false, localOnly: false };

      if (!syncActive) {
        const localId = `proj_${Date.now()}`;
        setProjects((prev) => [...prev, { id: localId, name: trimmed, order: prev.length + 1 }]);
        setNotification({
          type: 'success',
          message: todoistEnabled
            ? `Board "${trimmed}" created (TaskFlow only — task sync is turned off in Settings).`
            : `Board "${trimmed}" created (TaskFlow only — Todoist not configured).`,
        });
        return { ok: true, localOnly: true };
      }

      try {
        const created = await createTodoistProject(todoistToken, trimmed);
        if (!created?.id) throw new Error('Todoist did not return a created project.');
        setProjects((prev) => [...prev, { id: String(created.id), name: trimmed, color: created.color, order: prev.length + 1 }]);
        setNotification({ type: 'success', message: `Board "${trimmed}" created and synced to Todoist.` });
        return { ok: true, localOnly: false };
      } catch (err) {
        if (err.isLimitReached) {
          // Fall back to a local-only board rather than blocking the user.
          const localId = `proj_${Date.now()}`;
          setProjects((prev) => [...prev, { id: localId, name: trimmed, order: prev.length + 1 }]);
          setNotification({
            type: 'warning',
            message: `Todoist's project limit is reached, so "${trimmed}" was created in TaskFlow only — it won't sync to Todoist.`,
          });
          return { ok: true, localOnly: true };
        }
        console.error('[SchedulerContext] Failed to create project', err);
        setNotification({ type: 'error', message: `Couldn't create board: ${err.message || err}` });
        return { ok: false, localOnly: false };
      }
    },
    [syncActive, todoistEnabled, todoistToken]
  );

  // ---- Section CRUD (Board view columns) ------------------------------------

  const addSection = useCallback(
    (projectId, name) => {
      const trimmed = name.trim();
      if (!trimmed || !projectId) return;
      const localId = `sec_${Date.now()}`;
      const newSection = { id: localId, name: trimmed, projectId, order: sections.length + 1 };
      setSections((prev) => [...prev, newSection]);

      if (syncActive) {
        createTodoistSection(todoistToken, projectId, trimmed)
          .then((created) => {
            if (!created?.id) return;
            setSections((prev) => prev.map((s) => (s.id === localId ? { ...s, id: String(created.id) } : s)));
          })
          .catch((err) => notifySyncFailure('create section', err));
      }
    },
    [sections.length, syncActive, todoistToken, notifySyncFailure]
  );

  const renameSection = useCallback(
    (sectionId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s)));
      // Denormalized sectionName on any task currently in this section stays in sync too.
      const newTasks = tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionName: trimmed } : t));
      if (newTasks.some((t, i) => t !== tasks[i])) commit({ tasks: newTasks, blocks }, `Renamed section`);

      if (syncActive) {
        renameTodoistSection(todoistToken, sectionId, trimmed).catch((err) => notifySyncFailure('rename section', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
  );

  const deleteSection = useCallback(
    (sectionId) => {
      setSections((prev) => prev.filter((s) => s.id !== sectionId));
      // Tasks in the deleted section fall back to "No Section", matching what Todoist does.
      const newTasks = tasks.map((t) => (t.sectionId === sectionId ? { ...t, sectionId: null, sectionName: null } : t));
      commit({ tasks: newTasks, blocks }, `Deleted section`);

      if (syncActive) {
        deleteTodoistSection(todoistToken, sectionId).catch((err) => notifySyncFailure('delete section', err));
      }
    },
    [tasks, blocks, commit, syncActive, todoistToken, notifySyncFailure]
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
  const addManualEvent = useCallback(({ title, date, startTime, endTime }) => {
    const newEvent = {
      id: `evt_manual_${Date.now()}`,
      title: title?.trim() || 'Blocked time',
      date,
      startTime,
      endTime,
      isFreeTime: false,
      isRecurring: false,
      googleEventId: null,
      seriesId: null,
      source: 'manual',
    };
    setEvents((prev) => [...prev, newEvent]);
    return newEvent;
  }, []);

  const updateEvent = useCallback((eventId, updates) => {
    setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, ...updates } : e)));
  }, []);

  /** Only meaningful for manual events — Google-sourced events aren't owned by TaskFlow to delete. */
  const deleteEvent = useCallback((eventId) => {
    setEvents((prev) => prev.filter((e) => e.id !== eventId));
  }, []);

  /**
   * Set a (typically Google-sourced) event's `isFreeTime` "ignore" flag,
   * optionally applied across its recurring series — mirroring Google
   * Calendar's own "This event / This and following events / All events"
   * prompt when editing a recurring event.
   * @param {import('../types').CalendarEvent} event
   * @param {boolean} ignored
   * @param {'this'|'following'|'all'} scope
   */
  const setEventIgnored = useCallback((event, ignored, scope = 'this') => {
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
  }, []);

  /** Bulk-toggle every recurring (seriesId-bearing) event's `isFreeTime` flag at once. */
  const setAllRecurringIgnored = useCallback((ignored) => {
    setEvents((prev) => prev.map((e) => (e.seriesId ? { ...e, isFreeTime: ignored } : e)));
  }, []);

  const clearNotification = useCallback(() => setNotification(null), []);

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
      googleConnected,
      todoistEnabled,
      todoistToken,
      setTodoistApiToken,
      taskSyncEnabled,
      setTaskSyncEnabled,
      syncActive,
      lastOverflow,
      notification,
      canUndo,
      canRedo,
      currentActionLabel,
      setRoutines,
      setEvents,
      setRules,
      setSearchQuery,
      undo,
      redo,
      runRebalance,
      addTask,
      updateTask,
      deleteTask,
      toggleTaskLock,
      completeTask,
      addSubtask,
      renameSubtask,
      toggleSubtask,
      removeSubtask,
      updateSubtask,
      getOrCreateLabelIds,
      addProject,
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
      pushToGoogleCalendar,
      clearNotification,
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
      googleConnected,
      todoistEnabled,
      todoistToken,
      setTodoistApiToken,
      taskSyncEnabled,
      setTaskSyncEnabled,
      syncActive,
      lastOverflow,
      notification,
      canUndo,
      canRedo,
      currentActionLabel,
      undo,
      redo,
      runRebalance,
      addTask,
      updateTask,
      deleteTask,
      toggleTaskLock,
      completeTask,
      addSubtask,
      renameSubtask,
      toggleSubtask,
      removeSubtask,
      updateSubtask,
      getOrCreateLabelIds,
      addProject,
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
      pushToGoogleCalendar,
      clearNotification,
    ]
  );

  return <SchedulerContext.Provider value={value}>{children}</SchedulerContext.Provider>;
}

export function useScheduler() {
  const ctx = useContext(SchedulerContext);
  if (!ctx) throw new Error('useScheduler must be used within a SchedulerProvider');
  return ctx;
}

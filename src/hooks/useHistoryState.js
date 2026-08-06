/**
 * ============================================================================
 * useHistoryState
 * ============================================================================
 * A generic Undo/Redo transactional state hook. Rather than bolting undo
 * logic onto each piece of state individually, we snapshot the ENTIRE
 * scheduling state (tasks + blocks) as one atomic unit per action. This
 * matches how users think about undo ("undo that reschedule") rather than
 * field-by-field diffing, and sidesteps a whole class of partial-undo bugs.
 *
 * Design:
 *   - `past`: stack of previous HistoryEntry snapshots (oldest first)
 *   - `present`: the current HistoryEntry
 *   - `future`: stack of undone snapshots, replayable via redo
 *
 * `commit(newState, actionLabel)` pushes `present` onto `past`, sets the new
 * state as `present`, and clears `future` (standard undo-tree pruning: any
 * new action invalidates the old redo branch).
 * ============================================================================
 */

import { useCallback, useMemo, useState } from 'react';

const MAX_HISTORY = 50; // Cap memory usage; oldest entries are dropped beyond this.

/**
 * Pure reducer behind `commit()` — extracted (same rationale as
 * useCloudSync.js's computeFingerprint/race-guard functions) so the
 * same-tick-batching resolution behavior (function-form state/label
 * resolving against the freshest queued `h`, not a stale outer closure) can
 * be unit tested without mounting a component. Behavior-preserving refactor
 * only: this is exactly what used to live inline inside `setHistory((h) =>
 * {...})` below.
 */
export function commitReducer(h, newTasksAndBlocksOrUpdater, actionLabelOrFn) {
  const newTasksAndBlocks =
    typeof newTasksAndBlocksOrUpdater === 'function'
      ? newTasksAndBlocksOrUpdater({ tasks: h.present.tasksSnapshot, blocks: h.present.blocksSnapshot })
      : newTasksAndBlocksOrUpdater;
  // actionLabel may also be a function of the resolved {tasks, blocks} —
  // needed by callers (e.g. SchedulerContext's runRebalance) whose label
  // text depends on a value only known once the function-form state
  // updater above has actually run (e.g. a block count computed fresh
  // against `current`, not a stale outer closure).
  const actionLabel = typeof actionLabelOrFn === 'function' ? actionLabelOrFn(newTasksAndBlocks) : actionLabelOrFn;
  const entry = {
    id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    actionLabel,
    tasksSnapshot: newTasksAndBlocks.tasks,
    blocksSnapshot: newTasksAndBlocks.blocks,
  };
  const newPast = [...h.past, h.present].slice(-MAX_HISTORY);
  return { past: newPast, present: entry, future: [] };
}

/**
 * Pure reducer behind `overwritePresent()` — extracted for the same reason as
 * `commitReducer` above, and tested alongside it.
 *
 * Replaces `present`'s snapshots WITHOUT touching past/future, so the result
 * can't be undone and doesn't consume a redo slot: this is for state that
 * arrived from elsewhere (a cloud-sync listener, a migration) rather than from
 * a user action in this tab.
 *
 * Accepts an updater `(current) => ({tasks, blocks})` for exactly the reason
 * commitReducer does: a caller running in the SAME TICK as a preceding
 * undo/redo/commit can't read that call's result from a ref, because refs are
 * refreshed by an effect only after React commits. SchedulerContext's
 * restoreLiveSharedTasks is that caller — it runs synchronously right after
 * undoHistory(), and reading a stale pre-undo snapshot there wrote the pre-undo
 * tasks straight back into `present`, silently cancelling the undo it was meant
 * to run after (the history pointer moved but the visible state didn't).
 */
export function overwritePresentReducer(h, newTasksAndBlocksOrUpdater) {
  const current = { tasks: h.present.tasksSnapshot, blocks: h.present.blocksSnapshot };
  const next =
    typeof newTasksAndBlocksOrUpdater === 'function'
      ? newTasksAndBlocksOrUpdater(current)
      : newTasksAndBlocksOrUpdater;
  return {
    ...h,
    present: {
      ...h.present,
      id: `sync_${Date.now()}`,
      timestamp: Date.now(),
      tasksSnapshot: next.tasks,
      blocksSnapshot: next.blocks,
    },
  };
}

/**
 * @param {{tasks: import('../types').Task[], blocks: import('../types').ScheduledBlock[]}} initialState
 */
export function useHistoryState(initialState) {
  const [history, setHistory] = useState(() => ({
    past: [],
    present: {
      id: 'initial',
      timestamp: Date.now(),
      actionLabel: 'Initial state',
      tasksSnapshot: initialState.tasks,
      blocksSnapshot: initialState.blocks,
    },
    future: [],
  }));

  /**
   * `newTasksAndBlocksOrUpdater` is normally a precomputed `{tasks, blocks}`
   * object — fine for the common case of one commit() per user action. But
   * when several commit() calls happen synchronously in the same tick with
   * no re-render in between (e.g. the AI Assistant applying a multi-op plan
   * — see aiPlanService.js/SchedulerContext.applyAIPlan), every caller that
   * precomputed its object from a closed-over `tasks`/`blocks` variable was
   * working off the SAME stale snapshot, so each commit's payload silently
   * overwrote the previous one's addition instead of building on it — only
   * the last call in the batch would actually survive. Passing a function
   * `(current) => ({tasks, blocks})` instead lets the caller compute off
   * `current`, which this always derives from the latest queued `h.present`
   * (React processes queued setState updaters in order), fixing that for
   * any same-tick sequence of commits, not just this one call site.
   */
  const commit = useCallback((newTasksAndBlocksOrUpdater, actionLabelOrFn) => {
    setHistory((h) => commitReducer(h, newTasksAndBlocksOrUpdater, actionLabelOrFn));
  }, []);


  // See overwritePresentReducer above for what this does and why it takes an
  // updater form as well as a plain object.
  const overwritePresent = useCallback((newTasksAndBlocksOrUpdater) => {
    setHistory((h) => overwritePresentReducer(h, newTasksAndBlocksOrUpdater));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      const newPast = h.past.slice(0, -1);
      return { past: newPast, present: previous, future: [h.present, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      const newFuture = h.future.slice(1);
      return { past: [...h.past, h.present], present: next, future: newFuture };
    });
  }, []);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const state = useMemo(
    () => ({ tasks: history.present.tasksSnapshot, blocks: history.present.blocksSnapshot }),
    [history.present]
  );

  return {
    state,
    commit,
    overwritePresent,
    undo,
    redo,
    canUndo,
    canRedo,
    currentActionLabel: history.present.actionLabel,
    // Lets consumers tell "a genuinely new commit() just landed" apart from
    // "undo/redo just replayed an entry we've already seen" — commit() always
    // mints a fresh random id, while undo/redo revisit an existing entry's id.
    currentActionId: history.present.id,
  };
}

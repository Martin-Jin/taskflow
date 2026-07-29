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

  const commit = useCallback((newTasksAndBlocks, actionLabel) => {
    setHistory((h) => {
      const entry = {
        id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        actionLabel,
        tasksSnapshot: newTasksAndBlocks.tasks,
        blocksSnapshot: newTasksAndBlocks.blocks,
      };
      const newPast = [...h.past, h.present].slice(-MAX_HISTORY);
      return { past: newPast, present: entry, future: [] };
    });
  }, []);


  // Applies an incoming snapshot (e.g. from a live cloud-sync listener)
  // WITHOUT pushing a history entry — unlike commit(), this doesn't touch
  // past/future at all, so it can't be undone and doesn't consume a redo
  // slot. Used for state that arrived from elsewhere rather than from a
  // user action taken in this tab.
  const overwritePresent = useCallback((newTasksAndBlocks) => {
    setHistory((h) => ({
      ...h,
      present: {
        ...h.present,
        id: `sync_${Date.now()}`,
        timestamp: Date.now(),
        tasksSnapshot: newTasksAndBlocks.tasks,
        blocksSnapshot: newTasksAndBlocks.blocks,
      },
    }));
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

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

import { useCallback, useMemo, useRef, useState } from 'react';

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
 * Pure reducer behind `commitAndGet()` — extracted for the same reason as
 * `commitReducer`/`overwritePresentReducer` above (the hook can't be rendered
 * in this repo's node-environment unit suite), and tested alongside them.
 *
 * Runs `compute(current)` against the passed-in history, expecting it to
 * return `{ next, value }`, and returns BOTH the new history and the caller's
 * `value` — so a caller can read a value computed inside the updater without
 * depending on when React chooses to run that updater. See `commitAndGet`
 * below for the full rationale and the crash this fixed.
 */
export function commitAndGetReducer(h, compute, actionLabelOrFn) {
  let value;
  const history = commitReducer(
    h,
    (current) => {
      const computed = compute(current);
      value = computed.value;
      return computed.next;
    },
    actionLabelOrFn
  );
  return { history, value };
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
   * Mirrors the LATEST QUEUED history — not the latest RENDERED one (that's
   * `history` above, and `state` below). Every mutator here reduces against
   * this ref eagerly and then hands the already-reduced result to
   * `setHistory`, rather than reducing lazily inside a `setHistory(h => ...)`
   * updater.
   *
   * This is what makes `commitAndGet` (and `commit`'s return value) able to
   * report what a commit resolved to on the very next line, while keeping the
   * same-tick batching guarantee the updater form was introduced for: several
   * commits in one tick still each build on the previous one's result, since
   * they all chain through this ref in call order — exactly what React does
   * with queued updaters. Refs are written synchronously during the call, so
   * unlike `stateRef` (refreshed in an effect, one render behind) this is
   * never stale, and unlike a `setState` updater it isn't deferred.
   *
   * MUST be kept in lockstep by every mutator below (commit, commitAndGet,
   * overwritePresent, undo, redo) — a mutator that updates `setHistory`
   * without updating this ref would let the two diverge, and the next commit
   * would silently reduce against a snapshot that no longer matches state.
   */
  const queuedHistoryRef = useRef(history);

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
   * `current`, which this always derives from the latest queued history (see
   * `queuedHistoryRef`), fixing that for any same-tick sequence of commits,
   * not just this one call site.
   *
   * Returns the resolved `{tasks, blocks}` — see `commitAndGet` below for
   * callers that also need a value computed *inside* the updater.
   */
  const commit = useCallback((newTasksAndBlocksOrUpdater, actionLabelOrFn) => {
    queuedHistoryRef.current = commitReducer(queuedHistoryRef.current, newTasksAndBlocksOrUpdater, actionLabelOrFn);
    const resolved = queuedHistoryRef.current;
    setHistory(() => resolved);
    return { tasks: resolved.present.tasksSnapshot, blocks: resolved.present.blocksSnapshot };
  }, []);

  /**
   * `commit()` variant for callers that must READ something computed inside
   * the updater, synchronously, on the very next line — e.g.
   * SchedulerContext's runRebalance, which needs the engine's
   * `overflow`/`timeShifted`/`stats` to raise its toast and populate the
   * conflicts modal.
   *
   * Why this exists: React does NOT promise a `setState` updater runs before
   * `setState` returns. Under automatic batching — which is exactly what
   * happens when the caller is a debounced `setTimeout` (queueDueDateRebalance)
   * or an awaited promise continuation rather than a direct DOM event handler
   * — the updater can be deferred to the next render pass. Callers that used
   * to assign an engine result to an outer `let` inside the updater and read
   * it straight after `commit()` therefore hit `undefined` intermittently
   * (the real crash: "can't access property 'overflow', e is undefined").
   *
   * `compute` receives the same freshest-queued `{tasks, blocks}` a
   * `commit()` updater would, and returns `{ next, value }`: `next` is the
   * `{tasks, blocks}` to commit, `value` is whatever the caller needs back.
   * The commit is still queued through `setHistory` exactly as before, so
   * same-tick batching semantics are unchanged — the only difference is that
   * the reducer runs eagerly against `queuedHistoryRef` instead of lazily
   * inside the updater, so `value` is guaranteed populated on return.
   */
  const commitAndGet = useCallback((compute, actionLabelOrFn) => {
    const { history: resolved, value } = commitAndGetReducer(queuedHistoryRef.current, compute, actionLabelOrFn);
    queuedHistoryRef.current = resolved;
    setHistory(() => resolved);
    return value;
  }, []);


  // See overwritePresentReducer above for what this does and why it takes an
  // updater form as well as a plain object.
  const overwritePresent = useCallback((newTasksAndBlocksOrUpdater) => {
    queuedHistoryRef.current = overwritePresentReducer(queuedHistoryRef.current, newTasksAndBlocksOrUpdater);
    const resolved = queuedHistoryRef.current;
    setHistory(() => resolved);
  }, []);

  const undo = useCallback(() => {
    const h = queuedHistoryRef.current;
    if (h.past.length === 0) return;
    const previous = h.past[h.past.length - 1];
    const resolved = { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
    queuedHistoryRef.current = resolved;
    setHistory(() => resolved);
  }, []);

  const redo = useCallback(() => {
    const h = queuedHistoryRef.current;
    if (h.future.length === 0) return;
    const next = h.future[0];
    const resolved = { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    queuedHistoryRef.current = resolved;
    setHistory(() => resolved);
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
    commitAndGet,
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

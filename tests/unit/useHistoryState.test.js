/**
 * ============================================================================
 * useHistoryState reducers — same-tick batching + deferred-updater regressions
 * ============================================================================
 * The hook itself can't be rendered here (no @testing-library/react, node
 * environment) — see useCloudSync.test.js for the same rationale. Its pure
 * reducer (`commitReducer`, the function that used to live inline inside
 * `setHistory((h) => {...})`) was extracted specifically so this scenario
 * could be unit tested directly: several `commit()` calls landing in the
 * same React batch/tick must each resolve against the PREVIOUS commit's
 * result, not a stale outer closure — this is what a debounced rebalance
 * timer racing another commit (SchedulerContext's runRebalance, fixed
 * alongside this test) depends on.
 */
import { describe, it, expect } from 'vitest';
import { commitReducer, overwritePresentReducer, commitAndGetReducer } from '../../src/hooks/useHistoryState.js';

function makeHistory(tasks, blocks) {
  return {
    past: [],
    present: { id: 'initial', timestamp: 0, actionLabel: 'Initial state', tasksSnapshot: tasks, blocksSnapshot: blocks },
    future: ['stale-redo-entry'], // sentinel — every commit must clear this
  };
}

describe('commitReducer', () => {
  it('applies a plain-object payload directly (the common single-commit case)', () => {
    const h = makeHistory([{ id: 't1' }], []);
    const next = commitReducer(h, { tasks: [{ id: 't1' }, { id: 't2' }], blocks: [] }, 'Added task');
    expect(next.present.tasksSnapshot).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(next.present.actionLabel).toBe('Added task');
    expect(next.past).toEqual([h.present]);
    expect(next.future).toEqual([]);
  });

  it('resolves a function-form payload against the passed-in h.present, not a stale snapshot', () => {
    const h = makeHistory([{ id: 't1' }], []);
    const next = commitReducer(
      h,
      (current) => ({ tasks: [...current.tasks, { id: 't2' }], blocks: current.blocks }),
      'Added task'
    );
    expect(next.present.tasksSnapshot).toEqual([{ id: 't1' }, { id: 't2' }]);
  });

  it('chains correctly across several same-tick commits, matching React batching (each updater sees the previous result)', () => {
    // Simulates: addTask commits {t1}, then a debounced rebalance fires in
    // the same tick and commits against `current` — the rebalance's commit
    // must see t1, not the pre-addTask snapshot. This is exactly the bug
    // fixed in runRebalance: a plain-object commit computed from a stale
    // closure would have silently dropped t1 here.
    let h = makeHistory([], []);
    h = commitReducer(h, (current) => ({ tasks: [...current.tasks, { id: 't1' }], blocks: current.blocks }), 'Added task "t1"');
    h = commitReducer(
      h,
      (current) => ({ tasks: current.tasks, blocks: [...current.blocks, { id: 'b1', taskId: 't1' }] }),
      'Re-balanced schedule'
    );
    expect(h.present.tasksSnapshot).toEqual([{ id: 't1' }]);
    expect(h.present.blocksSnapshot).toEqual([{ id: 'b1', taskId: 't1' }]);
  });

  it('resolves a function-form actionLabel against the resolved {tasks, blocks}, after the state updater has run', () => {
    const h = makeHistory([], []);
    const next = commitReducer(
      h,
      (current) => ({ tasks: current.tasks, blocks: [...current.blocks, { id: 'b1' }, { id: 'b2' }] }),
      (resolved) => `Re-balanced schedule (${resolved.blocks.length} blocks placed)`
    );
    expect(next.present.actionLabel).toBe('Re-balanced schedule (2 blocks placed)');
  });

  it('always clears future (redo stack), whether the payload/label is a plain value or a function', () => {
    const h = makeHistory([], []);
    const next = commitReducer(h, { tasks: [], blocks: [] }, () => 'label');
    expect(next.future).toEqual([]);
  });
});

/**
 * ============================================================================
 * commitAndGetReducer — the "can't access property 'overflow', e is undefined"
 * crash when re-balancing
 * ============================================================================
 * SchedulerContext's runRebalance used to run the scheduling engine INSIDE a
 * `commit()` updater and assign the engine result to an outer `let`, then read
 * `result.overflow`/`result.stats` on the very next line. React makes no
 * promise that a setState updater runs before setState returns — under
 * automatic batching (runRebalance is reachable from a debounced setTimeout,
 * `queueDueDateRebalance`, and silentRebalanceForRewrite from an awaited
 * restore) the updater was deferred, leaving `result` undefined and throwing
 * before the toast/lastOverflow/conflicts-modal work could run. That's why
 * "press reschedule multiple times" was a symptom.
 *
 * commitAndGet fixes it by resolving the payload EAGERLY (still against the
 * freshest queued history, so same-tick batching is preserved) and handing the
 * caller its value back as a return value rather than via a closure that races
 * React's scheduler.
 */
describe('commitAndGetReducer', () => {
  it('returns the value computed inside the updater, synchronously', () => {
    const h = makeHistory([{ id: 't1' }], []);
    const { history, value } = commitAndGetReducer(
      h,
      (current) => ({
        next: { tasks: current.tasks, blocks: [{ id: 'b1' }] },
        value: { overflow: [], stats: { blocksCreated: 1 } },
      }),
      'Re-balanced schedule'
    );
    // The crash was that this was `undefined` at the equivalent moment.
    expect(value).toEqual({ overflow: [], stats: { blocksCreated: 1 } });
    expect(history.present.blocksSnapshot).toEqual([{ id: 'b1' }]);
  });

  it('still resolves against the freshest queued history, so same-tick batching is not regressed', () => {
    // The exact scenario the updater form was introduced for: addTask commits
    // t1, then a debounced rebalance fires in the same tick. The rebalance
    // must see t1 — computing it outside the commit (off a one-render-behind
    // `stateRef`) would have silently dropped it.
    let h = makeHistory([], []);
    h = commitReducer(h, (current) => ({ tasks: [...current.tasks, { id: 't1' }], blocks: current.blocks }), 'Added task "t1"');
    const { history, value } = commitAndGetReducer(
      h,
      (current) => {
        const placed = current.tasks.map((t) => ({ id: `b_${t.id}`, taskId: t.id }));
        return { next: { tasks: current.tasks, blocks: placed }, value: { stats: { blocksCreated: placed.length } } };
      },
      'Re-balanced schedule'
    );
    expect(value.stats.blocksCreated).toBe(1);
    expect(history.present.blocksSnapshot).toEqual([{ id: 'b_t1', taskId: 't1' }]);
  });

  it('chains: a second commit in the same tick builds on the commitAndGet result', () => {
    let h = makeHistory([{ id: 't1' }], []);
    const first = commitAndGetReducer(
      h,
      (current) => ({ next: { tasks: current.tasks, blocks: [{ id: 'b1' }] }, value: 'ok' }),
      'Re-balanced schedule'
    );
    h = commitReducer(first.history, (current) => ({ tasks: [...current.tasks, { id: 't2' }], blocks: current.blocks }), 'Added task "t2"');
    // The rebalance's blocks survived the later commit, and vice versa.
    expect(h.present.blocksSnapshot).toEqual([{ id: 'b1' }]);
    expect(h.present.tasksSnapshot).toEqual([{ id: 't1' }, { id: 't2' }]);
  });

  it('supports a function-form actionLabel reading the value the updater computed', () => {
    const h = makeHistory([], []);
    const { history } = commitAndGetReducer(
      h,
      (current) => ({ next: { tasks: current.tasks, blocks: [{ id: 'b1' }, { id: 'b2' }] }, value: { stats: { blocksCreated: 2 } } }),
      (resolved) => `Re-balanced schedule (${resolved.blocks.length} blocks placed)`
    );
    expect(history.present.actionLabel).toBe('Re-balanced schedule (2 blocks placed)');
  });

  it('pushes exactly one undoable entry and clears the redo stack, like any other commit', () => {
    const h = makeHistory([{ id: 't1' }], []);
    const { history } = commitAndGetReducer(
      h,
      (current) => ({ next: { tasks: current.tasks, blocks: [] }, value: null }),
      'Re-balanced schedule'
    );
    expect(history.past).toEqual([h.present]);
    expect(history.future).toEqual([]);
  });
});

/**
 * ============================================================================
 * overwritePresentReducer — the same-tick staleness bug behind "undo does
 * nothing when you're in a shared project"
 * ============================================================================
 * SchedulerContext wraps undo/redo so a history snapshot can never restore a
 * SHARED task (collaborators' concurrent edits aren't this user's to undo):
 * `undo()` calls undoHistory() and then, synchronously, restoreLiveSharedTasks()
 * → overwritePresent(). That second call cannot read the first one's result from
 * `stateRef` (refs are refreshed in an effect, after React commits), so it must
 * use the updater form — otherwise it writes the PRE-undo tasks back into
 * `present` and cancels the undo entirely.
 */
describe('overwritePresentReducer', () => {
  it('applies a plain-object payload and leaves past/future untouched (the cloud-sync case)', () => {
    const h = makeHistory([{ id: 't1' }], []);
    const next = overwritePresentReducer(h, { tasks: [{ id: 'remote' }], blocks: [{ id: 'b1' }] });
    expect(next.present.tasksSnapshot).toEqual([{ id: 'remote' }]);
    expect(next.present.blocksSnapshot).toEqual([{ id: 'b1' }]);
    // Not a user action: it must not become undoable, nor consume a redo slot.
    expect(next.past).toEqual(h.past);
    expect(next.future).toEqual(h.future);
  });

  it('resolves a function-form payload against the passed-in h.present, not a stale snapshot', () => {
    const h = makeHistory([{ id: 't1' }], [{ id: 'b1' }]);
    const next = overwritePresentReducer(h, (current) => ({
      tasks: [...current.tasks, { id: 't2' }],
      blocks: current.blocks,
    }));
    expect(next.present.tasksSnapshot).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(next.present.blocksSnapshot).toEqual([{ id: 'b1' }]);
  });

  it('preserves an undo when a shared-task restore runs in the SAME tick (the regression)', () => {
    // Personal task edited from "before" to "after", plus a shared task that
    // must survive the undo untouched at its LIVE value.
    const shared = { id: 's1', title: 'live shared', sharedProjectId: 'proj-1' };
    const staleShared = { id: 's1', title: 'stale shared', sharedProjectId: 'proj-1' };
    let h = makeHistory([{ id: 't1', title: 'before' }, staleShared], []);
    h = commitReducer(h, { tasks: [{ id: 't1', title: 'after' }, staleShared], blocks: [] }, 'Edited t1');

    // undoHistory(): present moves back to the "before" snapshot.
    const previous = h.past[h.past.length - 1];
    h = { past: h.past.slice(0, -1), present: previous, future: [h.present] };

    // restoreLiveSharedTasks(), same tick — swaps the snapshot's copy of the
    // shared task for the live one, while keeping the undone personal task.
    h = overwritePresentReducer(h, (current) => ({
      tasks: [...current.tasks.filter((t) => !t.sharedProjectId), shared],
      blocks: current.blocks,
    }));

    // The undo survived: t1 is back to "before" (previously it snapped back to
    // "after"), and the shared task is at its live value, not the snapshot's.
    expect(h.present.tasksSnapshot).toEqual([{ id: 't1', title: 'before' }, shared]);
  });
});

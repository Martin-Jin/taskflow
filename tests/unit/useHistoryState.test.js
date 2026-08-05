/**
 * ============================================================================
 * useHistoryState.commitReducer — same-tick batching regression coverage
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
import { commitReducer } from '../../src/hooks/useHistoryState.js';

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

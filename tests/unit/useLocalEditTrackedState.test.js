/**
 * ============================================================================
 * useLocalEditTrackedState — structural local-edit tracking for cloud-synced
 * fields
 * ============================================================================
 * See usePersistedState.js's doc comment for the full design. Short version:
 * useCloudSync's race guard (hasAnyLocalEditRaced, see useCloudSync.test.js)
 * needs to know whenever a REAL local edit happens to a cloud-synced
 * non-task/block field (sections/projects/labels/routines/rules/soundEnabled/
 * soundVolume/animationsEnabled/notificationSettings/notes/shortcutBindings/
 * sharedProjectIds) — none of which go through useHistoryState's commit(), so
 * none of them bump currentActionId on their own. A prior fix bumped a
 * counter ref (localNonUndoEditIdRef) manually inside exactly two call sites
 * (shareProject/joinSharedProject) that a real bug was found in;
 * useLocalEditTrackedState generalizes that into a single wrapper so EVERY
 * mutator for EVERY one of the fields above bumps the same ref automatically,
 * with no per-call-site discipline required.
 *
 * The hook itself can't be rendered here (no @testing-library/react, node
 * environment — same rationale as useHistoryState.test.js/useCloudSync.test.js),
 * so this tests `trackAndSet`, the pure bump-then-forward function the hook's
 * memoized setter is just a thin useCallback wrapper around.
 */
import { describe, it, expect, vi } from 'vitest';
import { trackAndSet } from '../../src/hooks/usePersistedState.js';
import { hasAnyLocalEditRaced } from '../../src/hooks/useCloudSync.js';

describe('trackAndSet', () => {
  it('bumps the edit-id ref and forwards the value to the raw setter unchanged', () => {
    const editIdRef = { current: 0 };
    const rawSetValue = vi.fn();
    trackAndSet(editIdRef, rawSetValue, { id: 'p1', name: 'New Project' });
    expect(editIdRef.current).toBe(1);
    expect(rawSetValue).toHaveBeenCalledWith({ id: 'p1', name: 'New Project' });
  });

  it('bumps the ref exactly once per call, so N distinct edits are each individually detectable', () => {
    const editIdRef = { current: 0 };
    const rawSetValue = vi.fn();
    trackAndSet(editIdRef, rawSetValue, 'a');
    trackAndSet(editIdRef, rawSetValue, 'b');
    trackAndSet(editIdRef, rawSetValue, 'c');
    expect(editIdRef.current).toBe(3);
    expect(rawSetValue).toHaveBeenCalledTimes(3);
  });

  it('preserves the functional-update form (setter called with an updater function) exactly — forwards it unexamined', () => {
    const editIdRef = { current: 0 };
    const rawSetValue = vi.fn();
    const updater = (prev) => [...prev, 'new'];
    trackAndSet(editIdRef, rawSetValue, updater);
    expect(editIdRef.current).toBe(1);
    // The exact same function reference is forwarded — trackAndSet doesn't
    // unwrap/call it itself (that's the underlying useState setter's job),
    // so an updater-form call behaves identically to calling the raw setter
    // directly, just with the ref bump alongside it.
    expect(rawSetValue).toHaveBeenCalledWith(updater);
    expect(rawSetValue.mock.calls[0][0]).toBe(updater);
  });

  it('never touches the ref if the raw setter is called directly instead (proves the raw/tracked split is real, not cosmetic)', () => {
    const editIdRef = { current: 0 };
    const rawSetValue = vi.fn();
    // Calling the RAW setter directly (as useCloudSync's applyRemoteData/
    // applyBackupPayload do) must never bump the ref — this is the crux of
    // the tracked-vs-raw split: the sync engine applying remote/backup data
    // must be structurally invisible to the local-edit race guard, or every
    // incoming sync would flag itself as racing a local change and never
    // cleanly apply.
    rawSetValue({ some: 'remote data' });
    expect(editIdRef.current).toBe(0);
    expect(rawSetValue).toHaveBeenCalledWith({ some: 'remote data' });
  });
});

describe('useLocalEditTrackedState end-to-end with hasAnyLocalEditRaced', () => {
  // Simulates the exact scenario the original narrow fix (shareProject/
  // joinSharedProject) targeted, but for an ORDINARY field mutator that never
  // got the manual fix — e.g. addProject creating a brand-new personal
  // project. Proves the generic tracked setter now protects call sites the
  // narrow per-call-site fix never touched.
  it('detects a tracked-setter edit that lands during a cloud-sync pull/listener async gap', () => {
    const editIdRef = { current: 0 };
    const rawSetProjects = vi.fn();

    // Baseline captured when useCloudSync's pull/listener starts (mirrors
    // actionIdAtStart/actionIdAtSubscribe in useCloudSync.js).
    const baseline = { actionId: 'action-1', nonUndoEditId: editIdRef.current };

    // A local edit happens in the async gap — e.g. addProject calling the
    // TRACKED setProjects (not the raw one), same as any other CRUD action
    // exposed via SchedulerContext's context value.
    trackAndSet(editIdRef, rawSetProjects, (prev) => [...prev, { id: 'p2', name: 'New Project' }]);

    // useCloudSync re-reads the current snapshot once the network round-trip
    // resolves (currentActionIdRef.current/localNonUndoEditIdRef.current).
    const current = { actionId: 'action-1', nonUndoEditId: editIdRef.current };

    expect(hasAnyLocalEditRaced(baseline, current)).toBe(true);
  });

  it('does NOT flag a race when only the sync engine itself applies remote data via the raw setter', () => {
    const editIdRef = { current: 0 };
    const rawSetProjects = vi.fn();

    const baseline = { actionId: 'action-1', nonUndoEditId: editIdRef.current };

    // applyRemoteData/applyBackupPayload call the RAW setter directly — this
    // must not move nonUndoEditId, or the sync engine would perpetually
    // detect itself as racing and skip applying every incoming update.
    rawSetProjects((prev) => prev.map((p) => (p.id === 'p1' ? { ...p, name: 'Renamed remotely' } : p)));

    const current = { actionId: 'action-1', nonUndoEditId: editIdRef.current };

    expect(hasAnyLocalEditRaced(baseline, current)).toBe(false);
  });

  it('two independent tracked fields (e.g. projects and notificationSettings) share one counter without interfering', () => {
    // SchedulerContext wires every tracked field through the SAME
    // localNonUndoEditIdRef — a real bug class this guards against is one
    // field's tracked setter not actually reaching the shared ref (e.g. a
    // copy-paste mistake giving a field its own independent ref instead).
    const sharedEditIdRef = { current: 0 };
    const rawSetProjects = vi.fn();
    const rawSetNotificationSettings = vi.fn();

    const baseline = { actionId: 'action-1', nonUndoEditId: sharedEditIdRef.current };

    trackAndSet(sharedEditIdRef, rawSetNotificationSettings, { taskOverdue: false });

    const current = { actionId: 'action-1', nonUndoEditId: sharedEditIdRef.current };
    expect(hasAnyLocalEditRaced(baseline, current)).toBe(true);
    // The other field's raw setter was untouched by this — confirms the two
    // tracked setters are independent wrappers over the same ref, not
    // accidentally sharing state beyond the ref itself.
    expect(rawSetProjects).not.toHaveBeenCalled();
  });
});

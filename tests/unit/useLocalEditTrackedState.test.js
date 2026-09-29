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
import { trackAndSet, stampAndSet, stampChangedEntitiesAndSet } from '../../src/hooks/usePersistedState.js';
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

describe('stampAndSet', () => {
  // useFieldStampedState's setter is a thin useCallback wrapper around this,
  // same "test the plain function, not the hook" approach as trackAndSet
  // above (see usePersistedState.js's useFieldStampedState doc comment for
  // the full "why" — the per-field sidecar timestamp this stamps is what
  // planRemoteDataMerge's pickScalarField later compares, see
  // useCloudSync.test.js's 'fieldUpdatedAt sidecar merge wiring' coverage).

  it('stamps the given field with an ISO timestamp and forwards the value to the tracked setter unchanged', () => {
    const setFieldStamps = vi.fn();
    const trackedSetRules = vi.fn();
    stampAndSet(setFieldStamps, 'rules', trackedSetRules, { bufferDays: 2 });
    expect(trackedSetRules).toHaveBeenCalledWith({ bufferDays: 2 });
    expect(setFieldStamps).toHaveBeenCalledTimes(1);
    // Called with an updater function (not a plain object) — see this
    // function's own doc comment for why: it must never depend on or race
    // the sidecar map's value from an earlier render.
    const updater = setFieldStamps.mock.calls[0][0];
    expect(typeof updater).toBe('function');
    const result = updater({ soundVolume: '2026-08-01T00:00:00.000Z' });
    expect(result.soundVolume).toBe('2026-08-01T00:00:00.000Z'); // other fields preserved
    expect(typeof result.rules).toBe('string');
    expect(Number.isNaN(new Date(result.rules).getTime())).toBe(false); // a real, parseable timestamp
  });

  it('stamps the field the setter was called for, not some other field, when two fields are stamped in sequence', () => {
    const stamps = {};
    const setFieldStamps = (updater) => {
      Object.assign(stamps, updater(stamps));
    };
    const trackedSetRules = vi.fn();
    const trackedSetSoundVolume = vi.fn();
    stampAndSet(setFieldStamps, 'rules', trackedSetRules, {});
    stampAndSet(setFieldStamps, 'soundVolume', trackedSetSoundVolume, 0.7);
    expect(Object.keys(stamps).sort()).toEqual(['rules', 'soundVolume']);
    expect(trackedSetRules).toHaveBeenCalledTimes(1);
    expect(trackedSetSoundVolume).toHaveBeenCalledTimes(1);
  });

  it('preserves the functional-update form for the wrapped value exactly, same as trackAndSet', () => {
    const setFieldStamps = vi.fn();
    const trackedSetNotes = vi.fn();
    const updater = (prev) => ({ ...prev, notes: [...prev.notes, 'new'] });
    stampAndSet(setFieldStamps, 'notes', trackedSetNotes, updater);
    expect(trackedSetNotes).toHaveBeenCalledWith(updater);
    expect(trackedSetNotes.mock.calls[0][0]).toBe(updater);
  });
});

describe('stampChangedEntitiesAndSet', () => {
  // useEntityStampedState's setter is a thin useCallback wrapper around this
  // — same "test the plain function, not the hook" approach as
  // trackAndSet/stampAndSet above. This is the highest-risk piece of the
  // per-entity stamping design (see useEntityStampedState's own doc comment
  // for the full "why diffing, not stamp-everything" reasoning): getting the
  // diff wrong in the over-stamping direction is the same class of bug
  // CLAUDE.md's TaskDetailModal write-loop warning describes — a set that
  // re-stamps every row on every call, not just the row that actually
  // changed.

  it('stamps updatedAt ONLY on the row whose content actually changed, leaving unrelated rows untouched (same reference)', () => {
    const prev = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ];
    const currentValueRef = { current: prev };
    const trackedSetProjects = vi.fn();
    // A rename of p1 that re-creates the WHOLE array via .map() — same
    // pattern renameProject/etc. actually use — so p2 is a NEW object
    // reference even though its content is unchanged.
    const next = [
      { id: 'p1', name: 'Alpha renamed' },
      { id: 'p2', name: 'Beta' },
    ];
    stampChangedEntitiesAndSet(currentValueRef, trackedSetProjects, next);
    expect(trackedSetProjects).toHaveBeenCalledTimes(1);
    const result = trackedSetProjects.mock.calls[0][0];
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get('p1').name).toBe('Alpha renamed');
    expect(typeof byId.get('p1').updatedAt).toBe('string');
    // p2's content is identical to before -> untouched, no stamp, same
    // object reference as what was passed in.
    expect(byId.get('p2').updatedAt).toBeUndefined();
    expect(byId.get('p2')).toBe(next[1]);
  });

  it('stamps a brand-new row (no previous version at all)', () => {
    const prev = [{ id: 'p1', name: 'Alpha' }];
    const currentValueRef = { current: prev };
    const trackedSetProjects = vi.fn();
    const next = [...prev, { id: 'p2', name: 'New project' }];
    stampChangedEntitiesAndSet(currentValueRef, trackedSetProjects, next);
    const result = trackedSetProjects.mock.calls[0][0];
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(typeof byId.get('p2').updatedAt).toBe('string');
  });

  it('does NOT stamp when nothing in the collection actually changed content-wise, even if the array itself is a new reference', () => {
    const prev = [{ id: 'p1', name: 'Alpha', order: 1 }];
    const currentValueRef = { current: prev };
    const trackedSetProjects = vi.fn();
    // Same content, keys in a different order — canonicalStringify (not
    // JSON.stringify) must treat this as unchanged, same reasoning as
    // didTaskMergeChangeAnything's own key-order regression test.
    const next = [{ order: 1, name: 'Alpha', id: 'p1' }];
    stampChangedEntitiesAndSet(currentValueRef, trackedSetProjects, next);
    const result = trackedSetProjects.mock.calls[0][0];
    expect(result[0].updatedAt).toBeUndefined();
  });

  it('resolves a functional update against the CURRENT ref value, not a stale closed-over array', () => {
    const currentValueRef = { current: [{ id: 'p1', name: 'Alpha' }] };
    const trackedSetProjects = vi.fn();
    const updater = (prevRows) => prevRows.map((r) => (r.id === 'p1' ? { ...r, name: 'Alpha renamed' } : r));
    stampChangedEntitiesAndSet(currentValueRef, trackedSetProjects, updater);
    const result = trackedSetProjects.mock.calls[0][0];
    expect(result[0].name).toBe('Alpha renamed');
    expect(typeof result[0].updatedAt).toBe('string');
  });

  it('a row present before but absent after (a hard delete) is simply gone from the result, nothing thrown', () => {
    const prev = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ];
    const currentValueRef = { current: prev };
    const trackedSetProjects = vi.fn();
    const next = prev.filter((p) => p.id !== 'p2');
    stampChangedEntitiesAndSet(currentValueRef, trackedSetProjects, next);
    const result = trackedSetProjects.mock.calls[0][0];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
  });

  it('stamping many unrelated edits in sequence never cross-contaminates rows (regression guard for the write-loop failure mode)', () => {
    // Simulates N distinct single-row edits in a row, the way a user renaming
    // several projects one after another would drive this setter repeatedly
    // — asserts each call stamps exactly the row that changed and nothing
    // else, however many times it's called.
    let current = [
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
      { id: 'p3', name: 'C' },
    ];
    const currentValueRef = { current };
    const setValue = (rows) => {
      current = rows;
      currentValueRef.current = rows;
    };
    stampChangedEntitiesAndSet(currentValueRef, setValue, current.map((r) => (r.id === 'p1' ? { ...r, name: 'A renamed' } : r)));
    const afterFirst = new Map(current.map((r) => [r.id, r]));
    expect(afterFirst.get('p1').updatedAt).toBeDefined();
    expect(afterFirst.get('p2').updatedAt).toBeUndefined();
    expect(afterFirst.get('p3').updatedAt).toBeUndefined();

    stampChangedEntitiesAndSet(currentValueRef, setValue, current.map((r) => (r.id === 'p2' ? { ...r, name: 'B renamed' } : r)));
    const afterSecond = new Map(current.map((r) => [r.id, r]));
    // p1's stamp from the first edit must survive untouched by the second,
    // unrelated edit.
    expect(afterSecond.get('p1').updatedAt).toBe(afterFirst.get('p1').updatedAt);
    expect(afterSecond.get('p2').updatedAt).toBeDefined();
    expect(afterSecond.get('p3').updatedAt).toBeUndefined();
  });
});

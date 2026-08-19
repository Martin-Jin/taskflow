/**
 * usePersistedState — a drop-in `useState` replacement that reads its
 * initial value from localStorage (falling back to `initialValue` if
 * nothing's saved yet) and writes back to localStorage on every change.
 *
 * Deliberately simple: no debouncing, no cross-tab sync. Settings-style
 * state (routines, rules, a boolean toggle) changes rarely enough that
 * writing on every change is cheap, and correctness/simplicity matters
 * more here than shaving a few localStorage.setItem calls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPersisted, savePersisted } from '../utils/persistence';

export function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(() => loadPersisted(key, typeof initialValue === 'function' ? initialValue() : initialValue));

  useEffect(() => {
    savePersisted(key, value);
  }, [key, value]);

  return [value, setValue];
}

/**
 * Wraps an existing `[value, setValue]` pair (from `useState` or
 * `usePersistedState` above) so every call to the returned TRACKED setter
 * bumps a shared "a local edit just happened" counter ref, in addition to
 * updating state exactly as before. Also returns the original, untouched
 * setter as a third element — see below for why both are needed.
 *
 * WHY THIS EXISTS: useCloudSync's race guard (hasAnyLocalEditRaced, see
 * that file) needs to know whenever a REAL user-initiated edit to a
 * cloud-synced field happens, so it can tell a genuine local change apart
 * from "nothing happened locally" when deciding whether an async pull/
 * listener snapshot is safe to apply. Tasks/blocks get this for free via
 * useHistoryState's currentActionId (bumped by every commit()), but every
 * OTHER synced field (sections/projects/labels/routines/rules/soundEnabled/
 * soundVolume/animationsEnabled/notificationSettings/notes/shortcutBindings/
 * sharedProjectIds) is plain setState with no such signal — invisible to
 * the race guard by default. A prior narrow fix bumped a counter ref
 * manually inside shareProject/joinSharedProject alone (the two call sites
 * a real bug was found in), but that doesn't scale: every OTHER mutator for
 * every one of these fields (e.g. addProject/renameProject/deleteProject/
 * togglePinProject, every routine/rule/setting editor) still had the exact
 * same gap, undetected until the next report. This hook makes tracking
 * automatic for ANY setter built on it, so a future field added the same
 * way is covered without anyone needing to remember to bump anything.
 *
 * THE TRACKED-VS-RAW SPLIT IS THE CRUX OF THIS: useCloudSync's own
 * applyRemoteData/applyBackupPayload calls these same setters to APPLY
 * incoming remote/backup data — that is emphatically NOT a local edit, and
 * must never bump this ref, or every incoming sync would flag itself as
 * racing a local change and refuse to apply (a remote update would never
 * stick). SchedulerContext.jsx exposes the TRACKED setter to ordinary app
 * code (UI components, CRUD actions like addProject/renameProject) via
 * useScheduler()'s context value, while continuing to pass the RAW setter
 * (this function's third return value) into useCloudSync — so the sync
 * engine's own writes are structurally invisible to the counter, exactly
 * like before, without needing a skip-tracking flag threaded through.
 *
 * Referential stability: the tracked setter is memoized with an empty
 * dependency array (it closes over `editIdRef`, a ref, and `rawSetValue`,
 * which is itself stable — React guarantees a useState setter's identity
 * never changes, and usePersistedState just forwards that same setter). So
 * this never breaks memoization for anything that depends on the setter's
 * identity (e.g. a useCallback listing setProjects in its deps).
 *
 * Functional-update form (`setValue(prev => ...)`) is preserved exactly:
 * the tracked setter just forwards whatever it's called with — object or
 * updater function — straight to the raw setter unchanged, and only adds
 * the ref bump alongside it.
 */
export function useLocalEditTrackedState([value, rawSetValue], editIdRef) {
  const trackedSetValue = useCallback(
    (next) => trackAndSet(editIdRef, rawSetValue, next),
    // rawSetValue/editIdRef are both stable (a useState setter, and a ref
    // object itself never changes identity) — empty deps is correct, not
    // just permissible, and keeps trackedSetValue's own identity fixed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return [value, trackedSetValue, rawSetValue];
}

/**
 * The actual bump-then-forward behavior behind the tracked setter above —
 * pulled out as a plain, side-effecting-but-pure-shaped function (same
 * "extract so it's unit-testable without rendering a hook" precedent as
 * useCloudSync.js's/useHistoryState.js's own pure decisions) so tests can
 * verify the ref bump and the pass-through both happen, and in the right
 * order, without needing @testing-library/react in this node-environment
 * suite. `next` is forwarded completely unexamined (object or updater
 * function) — this function doesn't need to know or care which, matching
 * the doc comment above on why the functional-update form isn't affected.
 */
export function trackAndSet(editIdRef, rawSetValue, next) {
  editIdRef.current += 1;
  rawSetValue(next);
}
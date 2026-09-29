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
import { canonicalStringify } from '../utils/canonicalStringify';

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

/**
 * Wraps a TRACKED setter (the second element useLocalEditTrackedState
 * returns) so every genuine local edit to that field also stamps a
 * per-field "when was this last written" timestamp into a shared sidecar
 * state object, in addition to everything trackAndSet already does.
 *
 * WHY THIS EXISTS: tasks and events each carry their own per-item
 * `updatedAt`/`localUpdatedAt`, so two devices editing different tasks (or
 * the same task at different times) merge correctly — the newer edit wins,
 * see taskMerge.js/eventMerge.js. Every OTHER cloud-synced field this app
 * has (routines/rules/soundEnabled/soundVolume/animationsEnabled/
 * notificationSettings/notes/shortcutBindings/sharedProjectIds) has no
 * timestamp of its own at all: useCloudSync's planRemoteDataMerge just takes
 * whichever side's whole value showed up in a Firestore doc that happened to
 * get written last (pickValid), regardless of which device's edit is
 * actually more recent. Concretely: change the sound volume on your phone,
 * then a moment later a different device's ALREADY-QUEUED push (e.g. from an
 * edit made seconds earlier, still in its 200ms debounce) lands after your
 * phone's write and silently reverts the volume change — not because that
 * device's edit was newer, but because its write simply arrived at
 * Firestore last. A per-field sidecar timestamp (stamped here, compared via
 * entityMerge.js's pickNewerScalar) fixes this the same way per-task
 * timestamps already fixed the identical bug for tasks.
 *
 * DELIBERATELY A SIDECAR MAP, NOT A TIMESTAMP ON EACH VALUE: unlike a task or
 * event, none of these nine fields has a stable per-row identity to hang a
 * timestamp on (a settings object has no "id", and stamping every entry of
 * e.g. `notificationSettings` individually would mean redesigning its shape
 * for no benefit — the whole object is always read/written together). One
 * ISO timestamp per FIELD, stored in one `fieldUpdatedAt` state object keyed
 * by field name (itself an ordinary usePersistedState value, so it persists/
 * syncs/backs up exactly like any other field — see useCloudSync.js's
 * `fieldUpdatedAt` in computeFingerprint/planRemoteDataMerge/BACKUP_FIELDS),
 * is the cheapest fix for exactly the value/granularity these fields already
 * have — see CLAUDE.md's Backups section for why finer-grained per-entity
 * timestamps are used instead for sections/projects/labels/savedViews/
 * taskTemplates/trash, which DO have stable per-row ids.
 *
 * Only wraps the TRACKED setter, never the raw one — exactly mirroring
 * useLocalEditTrackedState's own tracked/raw split. useCloudSync's own
 * application of remote/backup data must never re-stamp "now": doing so
 * would make every incoming sync look like a brand-new local edit and
 * permanently win every future comparison, which defeats the entire point
 * of comparing timestamps in the first place. Remote data brings its OWN
 * fieldUpdatedAt entry over the wire; applyRemoteData is responsible for
 * writing that value (not `now`) via the RAW fieldUpdatedAt setter — see
 * useCloudSync.js's applyRemoteData and planRemoteDataMerge.
 *
 * @param {[*, Function, Function]} trackedTriple - the exact
 *   [value, trackedSetter, rawSetter] returned by useLocalEditTrackedState.
 * @param {Function} setFieldStamps - the TRACKED setter for the shared
 *   `fieldUpdatedAt` state object (SchedulerContext keeps one such object
 *   for all nine sidecar-stamped fields — every field's stamp lives in the
 *   same object, same "one shared piece of state, many fields" shape
 *   `notificationSettings` itself already uses). Using the tracked setter
 *   here (not fieldUpdatedAt's raw one) is deliberate: a genuine local edit
 *   to, say, `soundVolume` is exactly the kind of local change
 *   useLocalEditTrackedState's own race-guard bump exists to signal, and
 *   fieldUpdatedAt changing alongside it should be indistinguishable from
 *   any other local edit to the sync engine.
 * @param {string} fieldName - this field's key in the fieldUpdatedAt object,
 *   matching its key in useCloudSync's `fieldUpdatedAt`/BACKUP_FIELDS.
 * @returns {[*, Function, Function]} the same shape as the input triple,
 *   with the tracked setter replaced by a stamping version — the value and
 *   raw setter pass through untouched, so this can wrap
 *   useLocalEditTrackedState's output transparently.
 */
export function useFieldStampedState([value, trackedSetValue, rawSetValue], setFieldStamps, fieldName) {
  const stampedSetValue = useCallback(
    (next) => stampAndSet(setFieldStamps, fieldName, trackedSetValue, next),
    // setFieldStamps/fieldName/trackedSetValue are all stable across renders
    // for a given field (setFieldStamps is itself a memoized tracked setter
    // with a fixed identity; fieldName is a literal at each call site;
    // trackedSetValue is itself already memoized with an empty dep array by
    // useLocalEditTrackedState) — empty deps is correct, not just
    // permissible, keeping this setter's own identity fixed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return [value, stampedSetValue, rawSetValue];
}

/**
 * The actual stamp-then-forward behavior behind useFieldStampedState's
 * setter — pulled out as a plain function for the same "unit-testable
 * without rendering a hook" reason trackAndSet is its own function above.
 * `next` is forwarded completely unexamined (object or updater function),
 * matching trackAndSet's own contract. `setFieldStamps` is called with an
 * updater function (not a plain object) so this never depends on — or races
 * — the sidecar map's own value from an earlier render.
 */
export function stampAndSet(setFieldStamps, fieldName, trackedSetValue, next) {
  setFieldStamps((prev) => ({ ...prev, [fieldName]: new Date().toISOString() }));
  trackedSetValue(next);
}

/**
 * The per-ENTITY counterpart to useFieldStampedState above, for a collection
 * of rows with a stable `id` — sections, projects, and labels (see
 * utils/entityMerge.js's mergeEntitiesByTimestamp, which is what actually
 * compares the `updatedAt` this stamps against another device's copy).
 * Wraps a TRACKED array setter so every genuine local edit stamps `updatedAt`
 * ONLY on the row(s) that actually changed content — not the whole array,
 * and not every row unconditionally — because two devices concurrently
 * editing DIFFERENT rows in the same collection (e.g. renaming project A on
 * one device while adding project B on another) must each keep their own
 * edit's real timestamp, not have it overwritten by whatever the OTHER
 * device's unrelated edit happened to stamp everything with.
 *
 * WHY DIFFING, NOT "STAMP EVERYTHING ON EVERY SET": this collection's setter
 * is called on every local mutation, including ones that only touch ONE row
 * (rename a single project) while re-creating the rest of the array via a
 * plain `.map()`/spread — a correct, existing pattern (see e.g.
 * SchedulerContext's renameProject) that produces a NEW array reference for
 * unrelated rows too, even though their CONTENT didn't change. Comparing by
 * reference would over-stamp (every unrelated row looks "just edited");
 * comparing by content — via canonicalStringify, not `JSON.stringify`, for
 * the same key-order-instability reason that function's own doc comment
 * explains — correctly stamps only the row(s) whose actual content changed.
 * Getting this wrong in either direction is a real risk: under-stamping
 * (e.g. by reference only) can make a genuine edit invisible to the merge;
 * over-stamping every row on every set — the same class of bug documented in
 * TaskDetailModal's own "write loop" warning in CLAUDE.md — would peg every
 * row's timestamp to "now" on every unrelated edit, defeating per-row
 * comparison entirely and (if this ever fed a debounced push loop the way
 * TaskDetailModal's autosave does) risking a runaway write cycle.
 *
 * Only wraps the TRACKED setter, exactly like useFieldStampedState — see
 * that hook's own doc comment for why applying remote/backup data must never
 * flow through this stamping path.
 *
 * @param {[Array<{id: string}>, Function, Function]} trackedTriple - the
 *   exact [value, trackedSetter, rawSetter] returned by
 *   useLocalEditTrackedState, where `value` is the collection's current
 *   array.
 * @returns {[Array<object>, Function, Function]} the same shape as the input
 *   triple, with the tracked setter replaced by a stamping version.
 */
export function useEntityStampedState([value, trackedSetValue, rawSetValue]) {
  // Mirrors the current array so the stamping setter can diff against
  // "what was there a moment ago" even when called with a functional update
  // (`setSections(prev => ...)`) — the diff needs the PRE-update array,
  // which a functional-update caller never hands over directly.
  const currentValueRef = useRef(value);
  useEffect(() => {
    currentValueRef.current = value;
  }, [value]);

  const stampedSetValue = useCallback(
    (next) => stampChangedEntitiesAndSet(currentValueRef, trackedSetValue, next),
    // currentValueRef/trackedSetValue are both stable (a ref's identity never
    // changes; trackedSetValue is itself already memoized with an empty dep
    // array by useLocalEditTrackedState) — empty deps is correct, keeping
    // this setter's own identity fixed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return [value, stampedSetValue, rawSetValue];
}

/**
 * The actual diff-then-stamp-then-forward behavior behind
 * useEntityStampedState's setter. Resolves `next` (a plain array, OR a
 * functional update) against `currentValueRef.current` to get the
 * about-to-be-applied array, stamps `updatedAt` on every row whose content
 * (by canonicalStringify) differs from its previous version OR that's new
 * (no previous version at all — a freshly-added row), and forwards a
 * plain array (never a function) to the tracked setter.
 *
 * A row present before but ABSENT after (an ordinary hard delete, before
 * this collection's own delete function is converted to tombstone-instead-
 * of-remove) is simply gone from the result — nothing to stamp, since
 * there's no row left to stamp it on.
 *
 * @param {{current: Array<{id: string}>}} currentValueRef
 * @param {Function} trackedSetValue
 * @param {Array<object>|((prev: Array<object>) => Array<object>)} next
 */
export function stampChangedEntitiesAndSet(currentValueRef, trackedSetValue, next) {
  const prevRows = currentValueRef.current || [];
  const nextRows = typeof next === 'function' ? next(prevRows) : next;
  if (!Array.isArray(nextRows)) {
    // Defensive: an unexpected shape (shouldn't happen for these
    // collections) is forwarded as-is rather than thrown on — matches
    // pickValid's own "fall back rather than crash" philosophy elsewhere in
    // the sync layer.
    trackedSetValue(next);
    return;
  }
  const prevById = new Map(prevRows.map((row) => [row.id, row]));
  const nowIso = new Date().toISOString();
  const stamped = nextRows.map((row) => {
    const prevRow = prevById.get(row.id);
    // Content-identical to what was there before (by value, not reference —
    // see this function's own doc comment on why reference equality would
    // over-stamp): nothing actually changed for this row, leave it exactly
    // as constructed.
    if (prevRow && canonicalStringify(prevRow) === canonicalStringify(row)) return row;
    return { ...row, updatedAt: nowIso };
  });
  trackedSetValue(stamped);
}
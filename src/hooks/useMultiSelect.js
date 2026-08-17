/**
 * ============================================================================
 * useMultiSelect
 * ============================================================================
 * Transient (NOT persisted — matches `collapsedIds` in TaskListPanel, not
 * `usePersistedState`-backed filter/view state) selection-mode state, shared
 * shape for every bulk-select surface in the app: List view, Board view,
 * Calendar (Week/Month share one instance, lifted into CalendarPage), and
 * TaskDetailModal's own embedded sub-task list. Each surface gets its OWN
 * independent instance — selecting rows in List has no effect on Board, and
 * TaskDetailModal's sub-task selection is fully scoped to that modal.
 *
 * Keys are opaque strings chosen by the caller — List/Board use a plain task
 * id (every selectable item there is a Task), while Calendar needs to
 * disambiguate two different entity types sharing the same visual space
 * (ScheduledBlock vs. CalendarEvent) via a composite `block:<id>`/`event:<id>`
 * key scheme (see WeekView/MonthView/CalendarPage) — see makeSelectionKey/
 * parseSelectionKey below, the single place that scheme is encoded/decoded so
 * every caller agrees on it.
 * ============================================================================
 */

import { useCallback, useMemo, useState } from 'react';

/** Composite key for an entity that isn't just a bare task id (e.g. Calendar's block/event mix). */
export function makeSelectionKey(kind, id) {
  return `${kind}:${id}`;
}

/** Inverse of makeSelectionKey — splits on the FIRST colon only, since a Google-event virtual id
 * (`${masterId}::${date}`, see recurrenceExpansion.resolveEventId) contains colons of its own. */
export function parseSelectionKey(key) {
  const sep = key.indexOf(':');
  if (sep === -1) return { kind: null, id: key };
  return { kind: key.slice(0, sep), id: key.slice(sep + 1) };
}

/**
 * @returns {{
 *   selectionMode: boolean,
 *   setSelectionMode: (v: boolean) => void,
 *   selectedKeys: Set<string>,
 *   isSelected: (key: string) => boolean,
 *   toggle: (key: string) => void,
 *   selectMany: (keys: string[]) => void,
 *   selectAll: (keys: string[]) => void,
 *   clearSelection: () => void,
 *   exitSelectionMode: () => void,
 *   count: number,
 * }}
 */
export function useMultiSelect() {
  const [selectionMode, setSelectionModeRaw] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());

  // Toggling selection mode off always drops whatever was selected — re-
  // entering later should start from a clean slate, not resurrect a stale
  // selection from a previous session in this view.
  const setSelectionMode = useCallback((next) => {
    setSelectionModeRaw(next);
    if (!next) setSelectedKeys(new Set());
  }, []);

  const toggle = useCallback((key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Adds every key in `keys` to the selection (used by MonthView's cluster/overflow chips,
   * which represent several underlying blocks/events at once — clicking one selects them all). */
  const selectMany = useCallback((keys) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  }, []);

  /** Replaces the selection with exactly `keys` — the toolbar's "Select all" affordance. */
  const selectAll = useCallback((keys) => {
    setSelectedKeys(new Set(keys));
  }, []);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  // "Cancel"/"Deselect all" in the bottom bar exits selection mode entirely
  // (not just clearing the set) — matching the toolbar's own Select toggle.
  const exitSelectionMode = useCallback(() => setSelectionMode(false), [setSelectionMode]);

  const isSelected = useCallback((key) => selectedKeys.has(key), [selectedKeys]);

  return useMemo(
    () => ({
      selectionMode,
      setSelectionMode,
      selectedKeys,
      isSelected,
      toggle,
      selectMany,
      selectAll,
      clearSelection,
      exitSelectionMode,
      count: selectedKeys.size,
    }),
    [selectionMode, setSelectionMode, selectedKeys, isSelected, toggle, selectMany, selectAll, clearSelection, exitSelectionMode]
  );
}

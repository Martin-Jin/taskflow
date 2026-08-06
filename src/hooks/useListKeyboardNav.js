/**
 * useListKeyboardNav — shared keyboard navigation for "type into an input,
 * arrow through a ranked results list below it, Enter to activate" comboboxes
 * (CommandPalette, Sidebar/ManageProjectsModal project search,
 * CalendarFilterMenu's project search). Owns just the active-row index and
 * the key handling/scroll-into-view around it; the caller still owns the
 * query string and the ranked/filtered item list itself, since that's where
 * the matching logic (and its cost) legitimately differs per site.
 *
 * Deliberately a *different* hook from useComboboxMultiSelect rather than
 * folding into it: that hook's own doc comment explains its keyboard nav was
 * left out because a multi-select combobox's Enter toggles a row without
 * closing the list (LabelPicker/DependencyPicker, and CalendarFilterMenu's
 * FilterGroup) — a different selection contract than "Enter picks exactly one
 * item and the interaction ends" (CommandPalette/Sidebar/ManageProjectsModal).
 * This hook makes that contract explicit via `wrap`/onSelect instead of
 * guessing at it, and callers that need multi-select's query/open-state
 * plumbing (like FilterGroup) simply use both hooks side by side.
 *
 * `itemCount` is passed in fresh each render (not tracked internally) so the
 * caller's own filtering/ranking is the single source of truth for the list;
 * the hook only clamps/resets its index when that count changes out from
 * under it (e.g. a query narrows the list to fewer rows than the current
 * active index).
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Pure index-wrap helper, exported for unit testing — computes the next
 * active index for an Up/Down key press over a list of `count` items.
 * `wrap` mirrors CommandPalette's original wrap-around behavior; passing
 * `false` (CalendarFilterMenu's original behavior) clamps at the ends instead.
 */
export function nextIndex(current, direction, count, wrap = true) {
  if (count <= 0) return 0;
  if (wrap) return (current + direction + count) % count;
  return Math.min(Math.max(current + direction, 0), count - 1);
}

export function useListKeyboardNav({ itemCount, onSelect, wrap = true, resetKey } = {}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef(null);

  // Reset to the top whenever the caller's identity for "this is a fresh
  // list" changes (e.g. the query string) — same as CommandPalette resetting
  // activeIndex on every query change.
  useEffect(() => {
    setActiveIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // The list may have shrunk since the last render (e.g. typing narrowed the
  // results) — clamp back onto a valid row rather than leaving the index
  // pointing past the end until the next arrow press.
  useEffect(() => {
    if (activeIndex >= itemCount) setActiveIndex(0);
  }, [itemCount, activeIndex]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => nextIndex(i, 1, itemCount, wrap));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => nextIndex(i, -1, itemCount, wrap));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect?.(activeIndex);
    }
  }

  return { activeIndex, setActiveIndex, listRef, handleKeyDown };
}

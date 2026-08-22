/**
 * useComboboxMultiSelect — the state and open/close timing shared by
 * DependencyPicker and LabelPicker (both a text input + dropdown list +
 * removable-chip multi-select): the search query, the dropdown's open
 * state (with a short close delay on blur so a click on a dropdown option
 * registers before the list unmounts), the highlighted row index, and the
 * input ref. Keyboard navigation (Arrow/Enter/Backspace) stays with each
 * caller — it needs each picker's own row count and selection behavior
 * (LabelPicker's Enter can also create a new tag), so parameterizing it
 * through this hook would need the caller's filtered-row count before the
 * hook itself could exist, which is circular. Sharing just the state here
 * still removes the bulk of the duplication between the two pickers.
 *
 * Not to be confused with useListKeyboardNav.js, a separate hook covering a
 * different shape of the same problem: single-select "pick exactly one and
 * the interaction ends" comboboxes (CommandPalette, Sidebar/
 * ManageProjectsModal project search) rather than this hook's multi-select
 * "Enter toggles a row without closing the list" one. CalendarFilterMenu's
 * FilterGroup is the one caller that needs both — this hook's query/open
 * state plus useListKeyboardNav's Arrow/Enter handling on top of it.
 */

import { useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from './useEscapeLayer';

export function useComboboxMultiSelect() {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef(null);
  const blurTimeoutRef = useRef(null);

  // Cancel a pending close if the component unmounts mid-delay (e.g. the
  // modal it lives in closes right after the input blurs).
  useEffect(() => () => clearTimeout(blurTimeoutRef.current), []);

  // Escape dismisses the open list, and only the open list. Both pickers live
  // inside modals, so this has to go through the shared layer stack — as a
  // plain onKeyDown on the input it never fired at all, and one Escape while
  // typing a tag discarded the whole draft task instead (see useEscapeLayer).
  // Closes now, not in 120ms: going through blur alone would leave the list
  // (and this escape layer) nominally open for the close delay below, so a
  // quick second Escape meant to reach the surrounding modal hit a list that
  // was already visually gone. Blur as well as close, so re-focusing the input
  // reopens it — closing with focus still inside would leave a dead input.
  useEscapeLayer(isOpen, () => {
    clearTimeout(blurTimeoutRef.current);
    setIsOpen(false);
    inputRef.current?.blur();
  });

  function handleBlur() {
    // Delay closing so a click on a dropdown option (which blurs the
    // input first) still registers before the list unmounts.
    blurTimeoutRef.current = setTimeout(() => setIsOpen(false), 120);
  }

  function handleFocus() {
    clearTimeout(blurTimeoutRef.current);
    setIsOpen(true);
    // The option list may have shrunk since it was last open (e.g. an item
    // got selected/removed); reset the highlight rather than leaving it on
    // a stale/out-of-range row until the user presses an arrow key.
    setHighlightedIndex(0);
  }

  /** Call after a selection/creation lands — clears the query and refocuses for the next one. */
  function resetQuery() {
    setQuery('');
    setHighlightedIndex(0);
    inputRef.current?.focus();
  }

  return {
    query,
    setQuery,
    isOpen,
    highlightedIndex,
    setHighlightedIndex,
    inputRef,
    handleBlur,
    handleFocus,
    resetQuery,
  };
}

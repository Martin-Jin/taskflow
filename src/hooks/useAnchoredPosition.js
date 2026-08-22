/**
 * useAnchoredPosition — shared position math for SmartTitleInput's two
 * caret-anchored popups (MentionDropdown, KeywordSuggestPopup). Both are
 * portaled to document.body and positioned from an `anchorRect` (the pixel
 * position of the trigger character, plus an `aboveTop` for the flip-above
 * case), but their content-dependent size means the popup has to actually
 * mount and be measured before its position can be clamped to the viewport
 * — hence the ref + useLayoutEffect (no dependency array, so it re-measures
 * on every render) rather than computing position from anchorRect alone.
 *
 * The functional setState bail-out (returning `prev` when left/top are
 * unchanged) keeps this from looping forever: without it, every render
 * would produce a new position object, which would trigger a re-render,
 * which would run the effect again.
 */

import { useLayoutEffect, useRef, useState } from 'react';

const EDGE_MARGIN = 8;

export function useAnchoredPosition(anchorRect) {
  const elementRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!anchorRect || !elementRef.current) return;
    const rect = elementRef.current.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN, Math.min(anchorRect.left, window.innerWidth - rect.width - EDGE_MARGIN));
    const spaceBelow = window.innerHeight - anchorRect.top;
    const openAbove = spaceBelow < rect.height + EDGE_MARGIN && anchorRect.aboveTop > rect.height + EDGE_MARGIN;
    const top = openAbove
      ? Math.max(EDGE_MARGIN, anchorRect.aboveTop - rect.height)
      : Math.min(anchorRect.top, window.innerHeight - rect.height - EDGE_MARGIN);
    setPosition((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  });

  const pos = anchorRect ? position || anchorRect : null;
  return { elementRef, position: pos };
}

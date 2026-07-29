/**
 * KeywordSuggestPopup — the "did you mean?" popup shown by
 * useSmartKeywordSuggest while typing a near-miss for a smart-parse keyword
 * (e.g. "tommorow"). Same portaled-to-body/anchor-measured approach as
 * MentionDropdown (see its own doc comment for why), just rendered as a
 * compact single row of candidate pills rather than a tall list — there's
 * usually exactly one candidate, and this is a lighter-weight assist than a
 * full autocomplete menu.
 *
 * Every pill is its own tappable button (mobile has no physical Tab key, so
 * tapping is the only way to reach a non-active candidate there); the
 * Tab-cycled candidate is visually distinguished so keyboard users can see
 * what Enter will apply.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE_MARGIN = 8;

export default function KeywordSuggestPopup({ anchorRect, matches, activeIndex, onSelect }) {
  const popupRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!anchorRect || !popupRef.current) return;
    const rect = popupRef.current.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN, Math.min(anchorRect.left, window.innerWidth - rect.width - EDGE_MARGIN));
    const spaceBelow = window.innerHeight - anchorRect.top;
    const openAbove = spaceBelow < rect.height + EDGE_MARGIN && anchorRect.aboveTop > rect.height + EDGE_MARGIN;
    const top = openAbove
      ? Math.max(EDGE_MARGIN, anchorRect.aboveTop - rect.height)
      : Math.min(anchorRect.top, window.innerHeight - rect.height - EDGE_MARGIN);
    setPosition((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  });

  if (!anchorRect) return null;
  const pos = position || anchorRect;

  return createPortal(
    <div ref={popupRef} className="keyword-suggest-popup" style={{ position: 'fixed', left: pos.left, top: pos.top }}>
      <span className="keyword-suggest-label">Did you mean</span>
      {matches.map((candidate, i) => (
        <button
          key={candidate}
          type="button"
          className={`keyword-suggest-option ${i === activeIndex ? 'active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
        >
          {candidate}
        </button>
      ))}
      <span className="keyword-suggest-hint">Tab · Enter</span>
    </div>,
    document.body
  );
}

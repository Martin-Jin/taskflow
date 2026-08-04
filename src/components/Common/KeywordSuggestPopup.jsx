/**
 * KeywordSuggestPopup — the "did you mean?" popup shown by
 * useSmartKeywordSuggest while typing a near-miss for a smart-parse keyword
 * (e.g. "tommorow"). Same portaled-to-body/anchor-measured approach as
 * MentionDropdown (see useAnchoredPosition for the shared positioning math),
 * just rendered as a compact single row of candidate pills rather than a
 * tall list — there's usually exactly one candidate, and this is a
 * lighter-weight assist than a full autocomplete menu.
 *
 * Every pill is its own tappable button (mobile has no physical Tab key, so
 * tapping is the only way to reach a non-active candidate there); the
 * Tab-cycled candidate is visually distinguished so keyboard users can see
 * what Enter will apply.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition } from '../../hooks/useAnchoredPosition';

export default function KeywordSuggestPopup({ anchorRect, matches, activeIndex, onSelect }) {
  const { elementRef: popupRef, position: pos } = useAnchoredPosition(anchorRect);

  if (!anchorRect) return null;

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
      <span className="keyword-suggest-hint">{matches.length > 1 ? 'Tab · Enter' : 'Enter'}</span>
    </div>,
    document.body
  );
}

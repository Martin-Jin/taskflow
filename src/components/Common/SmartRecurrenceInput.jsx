/**
 * SmartRecurrenceInput — free-text editor for the day-specific Repeat field
 * in TaskDetailModal (e.g. "every sat and sun"). Same backdrop/<mark>
 * highlight technique as SmartDurationInput, scoped to one detector
 * (findRecurrencePhrase) instead of the full multi-detector title textarea,
 * so a recognized recurrence phrase gets the same inline highlight the
 * Title field's smart-parse gives — this field previously had none at all.
 *
 * Unlike SmartDurationInput, editing/committing/canceling is owned by the
 * parent (TaskDetailModal's repeatEditText + commitRepeatEditText) since
 * this field's blur/Enter/Escape behavior is already wired up there; this
 * component only adds the highlight overlay on top of that controlled input.
 */

import React, { useRef, useState } from 'react';
import { findRecurrencePhrase } from '../../utils/recurrence';

export default function SmartRecurrenceInput({ value, onChange, onBlur, onKeyDown, autoFocus, disabled }) {
  const inputRef = useRef(null);
  const [scrollLeft, setScrollLeft] = useState(0);

  const match = findRecurrencePhrase(value || '');

  function syncScroll() {
    if (inputRef.current) setScrollLeft(inputRef.current.scrollLeft);
  }

  let before = value || '';
  let highlighted = '';
  let after = '';
  if (match) {
    before = value.slice(0, match.index);
    highlighted = match.matchedText;
    after = value.slice(match.index + match.matchedText.length);
  }

  return (
    <div className="smart-duration-wrap">
      <div className="smart-duration-backdrop" style={{ transform: `translateX(-${scrollLeft}px)` }} aria-hidden="true">
        <span>{before}</span>
        {highlighted && <mark className="smart-duration-mark">{highlighted}</mark>}
        <span>{after}</span>
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e);
          syncScroll();
        }}
        onScroll={syncScroll}
        onFocus={(e) => e.target.select()}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
    </div>
  );
}

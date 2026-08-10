/**
 * SmartDurationInput — single-purpose smart-parsing text field for the
 * "Estimated time" field in AddTaskModal/TaskDetailModal. A lighter-weight
 * cousin of SmartTitleInput's highlight-overlay technique, scoped to one
 * detector (findDurationPhrase) and one line of text instead of the full
 * multi-detector textarea machinery.
 *
 * Behavior: while focused, the field is a free-text input the user can type
 * things like "1h 30m" or "20 min" into; findDurationPhrase runs on every
 * keystroke and, when it matches, both highlights the recognized substring
 * (same backdrop/<mark> overlay trick as SmartTitleInput, mirrored scroll)
 * and reports the parsed hours up via onChange. On blur, the field collapses
 * to the spelled-out long form (formatHoursLong, e.g. "1 hour 30 minutes")
 * rather than leaving the user's raw typed text sitting there or showing a
 * separate hint line underneath — so "1h 30m" settles to "1 hour 30 minutes"
 * once they move on, and clicking back in swaps it for the short editable
 * form ("1.5h") to type over. If nothing parses, the last confirmed `hours`
 * value is kept (onChange simply isn't called), so a stray keystroke never
 * wipes out the committed estimate — except clearing the field entirely,
 * which commits an estimate of 0 on blur rather than snapping back to the
 * old value.
 */

import React, { useRef, useState } from 'react';
import { findDurationPhrase } from '../../utils/durationParser';
import { formatHours, formatHoursLong } from '../../utils/formatHours';

// Wrapped in memo — `hours`/`onChange` are a stable primitive/setState pair
// at TaskDetailModal's call site, so this skips re-rendering on unrelated
// keystrokes (title/notes) elsewhere in the modal.
function SmartDurationInput({ hours, onChange, placeholder, disabled = false }) {
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [rawText, setRawText] = useState('');
  const [scrollLeft, setScrollLeft] = useState(0);

  const match = editing ? findDurationPhrase(rawText) : null;

  function syncScroll() {
    if (inputRef.current) setScrollLeft(inputRef.current.scrollLeft);
  }

  function handleFocus(e) {
    setRawText(formatHours(hours));
    setEditing(true);
    e.target.select();
  }

  function handleChange(e) {
    const text = e.target.value;
    setRawText(text);
    const found = findDurationPhrase(text);
    if (found) onChange(found.hours);
    syncScroll();
  }

  function handleBlur() {
    if (!rawText.trim()) onChange(0);
    setEditing(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  }

  let before = rawText;
  let highlighted = '';
  let after = '';
  if (match) {
    before = rawText.slice(0, match.index);
    highlighted = match.matchedText;
    after = rawText.slice(match.index + match.matchedText.length);
  }

  return (
    <div className="smart-duration-wrap">
      {editing && (
        <div
          className="smart-duration-backdrop"
          style={{ transform: `translateX(-${scrollLeft}px)` }}
          aria-hidden="true"
        >
          <span>{before}</span>
          {highlighted && <mark className="smart-duration-mark">{highlighted}</mark>}
          <span>{after}</span>
        </div>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        className="smart-duration-input"
        value={editing ? rawText : formatHoursLong(hours)}
        onFocus={handleFocus}
        onChange={handleChange}
        onScroll={syncScroll}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}

export default React.memo(SmartDurationInput);

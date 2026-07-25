/**
 * SmartTitleInput — the Title field used by AddTaskModal/TaskDetailModal.
 * Wraps a plain text input with a highlight overlay: whatever smartParse.js
 * currently has detected in the typed text (a due date, "every month", a
 * priority shorthand, an "after <task>" mention) gets an inline highlight
 * directly over the matched words, clickable to cancel that one detection
 * without touching the rest of the title. Cancelling reverts the field it
 * wrote (see useSmartTaskTitle) — retyping the same trigger word later
 * re-arms it, since the dismissal only holds while that exact phrase is
 * still present in the text.
 *
 * Implementation: an absolutely-positioned backdrop sits in the same box as
 * the real input, rendering the same text with transparent characters and a
 * highlighted <mark> behind the detected substrings. The backdrop is
 * pointer-events: none everywhere except the <mark> spans themselves, so
 * clicks/typing pass through to the real input except when clicking directly
 * on a highlight. Horizontal scroll is mirrored from the input so the
 * highlight tracks the text as it scrolls past the field's edge.
 */

import React, { useRef, useState } from 'react';

const TYPE_LABELS = {
  dueDate: 'due date',
  recurrence: 'recurrence',
  priority: 'priority',
  dependency: 'dependency',
  project: 'project',
  labels: 'tag',
};

const SCALAR_TYPES = ['dueDate', 'recurrence', 'priority', 'dependency', 'project'];

/** Find where each still-active detection's matched text sits in the current title, in reading order. */
function buildRanges(title, smartDetected) {
  const claimed = [];
  const ranges = [];
  const lowerTitle = title.toLowerCase();

  function claimRange(type, matchedText, match) {
    const lowerMatch = matchedText.toLowerCase();
    let searchFrom = 0;
    let start = -1;
    // Skip past any range already claimed by an earlier detection so two
    // matches never highlight the same characters.
    while (searchFrom <= lowerTitle.length) {
      const idx = lowerTitle.indexOf(lowerMatch, searchFrom);
      if (idx === -1) break;
      const end = idx + lowerMatch.length;
      const overlaps = claimed.some(([cs, ce]) => idx < ce && end > cs);
      if (!overlaps) {
        start = idx;
        break;
      }
      searchFrom = idx + 1;
    }
    if (start === -1) return;

    const end = start + matchedText.length;
    claimed.push([start, end]);
    ranges.push({ type, start, end, match });
  }

  SCALAR_TYPES.forEach((type) => {
    const entry = smartDetected[type];
    if (entry?.matchedText) claimRange(type, entry.matchedText, entry);
  });

  (smartDetected.labels || []).forEach((entry) => {
    if (entry.matchedText) claimRange('labels', entry.matchedText, entry);
  });

  return ranges.sort((a, b) => a.start - b.start);
}

export default function SmartTitleInput({ value, onChange, smartDetected, onDismiss, placeholder, autoFocus }) {
  const inputRef = useRef(null);
  const [scrollLeft, setScrollLeft] = useState(0);

  function syncScroll() {
    if (inputRef.current) setScrollLeft(inputRef.current.scrollLeft);
  }

  const ranges = buildRanges(value, smartDetected);
  const segments = [];
  let cursor = 0;
  ranges.forEach((r) => {
    if (r.start > cursor) segments.push({ text: value.slice(cursor, r.start), type: null });
    segments.push({ text: value.slice(r.start, r.end), type: r.type, match: r.match });
    cursor = r.end;
  });
  if (cursor < value.length) segments.push({ text: value.slice(cursor), type: null });

  return (
    <div className="smart-title-wrap">
      <div className="smart-title-backdrop" style={{ transform: `translateX(-${scrollLeft}px)` }} aria-hidden="true">
        {segments.map((seg, i) =>
          seg.type ? (
            <mark
              key={i}
              className="smart-title-mark"
              title={`Not this — cancel the detected ${TYPE_LABELS[seg.type]}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onDismiss(seg.type, seg.type === 'labels' ? seg.match : undefined);
              }}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </div>
      <input
        ref={inputRef}
        className="smart-title-input"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyUp={syncScroll}
        onClick={syncScroll}
        placeholder={placeholder}
      />
    </div>
  );
}

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
 *
 * LIVE "@"/"#" AUTOCOMPLETE: on top of the after-the-fact chip detection
 * above, useMentionAutocomplete watches the caret to find an in-progress,
 * unterminated "@label" or "#project[/section]" span and offers a
 * MentionDropdown to complete it. Its pixel anchor is measured by splicing
 * a zero-width marker <span> into the (already invisible, color:
 * transparent) backdrop text at the span's start offset and reading its
 * getBoundingClientRect() — reusing the backdrop's already-perfect overlay
 * instead of a second hidden measuring element.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useMentionAutocomplete } from '../../hooks/useMentionAutocomplete';
import MentionDropdown from './MentionDropdown';

const TYPE_LABELS = {
  link: 'link',
  dueDate: 'due date',
  recurrence: 'recurrence',
  priority: 'priority',
  dependency: 'dependency',
  project: 'project',
  labels: 'tag',
};

const SCALAR_TYPES = ['link', 'dueDate', 'recurrence', 'priority', 'dependency', 'project'];

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

/** Splice a zero-width `{ marker: true }` entry into `segments` at character offset `at`, splitting a text segment if `at` falls inside one. */
function insertMarker(segments, at) {
  const out = [];
  let pos = 0;
  let inserted = false;
  segments.forEach((seg) => {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    if (!inserted && at === segStart) {
      out.push({ marker: true });
      inserted = true;
    }
    if (!inserted && at > segStart && at < segEnd) {
      const cut = at - segStart;
      out.push({ ...seg, text: seg.text.slice(0, cut) });
      out.push({ marker: true });
      out.push({ ...seg, text: seg.text.slice(cut) });
      inserted = true;
      pos = segEnd;
      return;
    }
    out.push(seg);
    pos = segEnd;
  });
  if (!inserted) out.push({ marker: true });
  return out;
}

export default function SmartTitleInput({
  value,
  onChange,
  smartDetected,
  onDismiss,
  placeholder,
  autoFocus,
  projects = [],
  sections = [],
  labels = [],
  onEnter,
}) {
  const inputRef = useRef(null);
  const markerRef = useRef(null);
  const [scrollState, setScrollState] = useState({ left: 0, top: 0 });
  const [anchorRect, setAnchorRect] = useState(null);

  const mention = useMentionAutocomplete({ inputRef, value, onChange, projects, sections, labels });
  useAutosizeTextarea(inputRef, value, { maxLines: 3 });

  function syncScroll() {
    if (inputRef.current) {
      setScrollState({ left: inputRef.current.scrollLeft, top: inputRef.current.scrollTop });
    }
  }

  const ranges = buildRanges(value, smartDetected);
  let segments = [];
  let cursor = 0;
  ranges.forEach((r) => {
    if (r.start > cursor) segments.push({ text: value.slice(cursor, r.start), type: null });
    segments.push({ text: value.slice(r.start, r.end), type: r.type, match: r.match });
    cursor = r.end;
  });
  if (cursor < value.length) segments.push({ text: value.slice(cursor), type: null });

  if (mention.isOpen && mention.spanStart != null) {
    segments = insertMarker(segments, mention.spanStart);
  }

  // Deliberately no dependency array — this needs to re-measure on every
  // render (text changed, scroll changed, dropdown just opened, ...), not
  // just a fixed set of tracked values. What keeps this from looping
  // forever is the functional setState below: it bails out to the *same*
  // object reference when the computed position hasn't actually changed,
  // so React skips the re-render that would otherwise re-run this effect
  // and set the same thing again forever.
  useLayoutEffect(() => {
    if (!mention.isOpen || !markerRef.current || !inputRef.current) {
      setAnchorRect((prev) => (prev === null ? prev : null));
      return;
    }
    const markerRect = markerRef.current.getBoundingClientRect();
    const inputRect = inputRef.current.getBoundingClientRect();
    // `top` is where the dropdown opens by default (just below the field);
    // `aboveTop` is the alternative anchor MentionDropdown falls back to
    // when there isn't room below (see its own clamping) — the bottom edge
    // it would open upward from.
    const next = { left: markerRect.left, top: inputRect.bottom + 4, aboveTop: inputRect.top - 4 };
    setAnchorRect((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.aboveTop === next.aboveTop ? prev : next
    );
  });

  function handleCaretMove() {
    syncScroll();
    mention.refresh();
  }

  function handleKeyDown(e) {
    // If the mention dropdown (see useMentionAutocomplete) consumed this
    // keypress (e.g. Enter to pick a suggestion), it already returns true
    // and we shouldn't also treat it as "submit the form". Only an Enter
    // that the dropdown ignored counts as a real submit request.
    const handledByMention = mention.handleKeyDown(e);
    if (!handledByMention && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onEnter?.(e);
    }
  }

  return (
    <div className="smart-title-wrap">
      <div className="smart-title-backdrop" style={{ transform: `translate(-${scrollState.left}px, -${scrollState.top}px)` }} aria-hidden="true">
        {segments.map((seg, i) =>
          seg.marker ? (
            <span key={i} ref={markerRef} />
          ) : seg.type ? (
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
      <textarea
        ref={inputRef}
        className="smart-title-input"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyUp={handleCaretMove}
        onClick={handleCaretMove}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
      />
      {mention.isOpen && (
        <MentionDropdown
          anchorRect={anchorRect}
          mode={mention.mode}
          query={mention.query}
          matches={mention.matches}
          showCreateOption={mention.showCreateOption}
          highlightedIndex={mention.highlightedIndex}
          onHighlight={mention.setHighlightedIndex}
          onSelect={mention.selectByIndex}
        />
      )}
    </div>
  );
}

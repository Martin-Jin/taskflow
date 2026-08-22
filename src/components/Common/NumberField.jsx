/**
 * NumberField — a number input that actually enforces its own min/max.
 *
 * `<input type="number" min max>` only constrains the spinner arrows: typing
 * a value past the max, or clearing the field entirely, still fires onChange,
 * and the settings screens' `Number(e.target.value)` handlers were happily
 * writing 99 into a max-16 field and 0 into a min-1 one. This keeps the
 * user's raw keystrokes in a local draft, commits only values that are in
 * range, and on blur (or Enter) explains the rejection via useFieldRejection
 * and snaps the draft back to the last good value — so an invalid entry is
 * never silently accepted OR silently discarded.
 *
 * `inputProps` is spread BEFORE this component's own handlers, so a caller
 * passing onChange/onBlur/onFocus/onKeyDown would have it silently dropped
 * rather than composed. That's deliberate — those four are the mechanism —
 * but it means a caller wanting extra behavior on blur has to wrap this
 * component instead of passing a handler through it.
 */

import React, { useEffect, useRef, useState } from 'react';
import FieldRejectionHint from './FieldRejectionHint';
import { useFieldRejection } from '../../hooks/useFieldRejection';

export default function NumberField({ value, onCommit, min, max, unitLabel, ...inputProps }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const isFocusedRef = useRef(false);
  const rejection = useFieldRejection();

  // Track external changes (a backup restore, a cross-device sync) but never
  // while the field is focused — that would yank the caret mid-edit.
  useEffect(() => {
    if (!isFocusedRef.current) setDraft(String(value ?? ''));
  }, [value]);

  function rangeMessage() {
    if (min != null && max != null) return `Enter a number between ${min} and ${max}${unitLabel ? ` ${unitLabel}` : ''}.`;
    if (min != null) return `Enter a number of ${min} or more.`;
    if (max != null) return `Enter a number of ${max} or less.`;
    return 'Enter a number.';
  }

  function parseDraft(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    if (min != null && parsed < min) return null;
    if (max != null && parsed > max) return null;
    return parsed;
  }

  function handleChange(e) {
    const raw = e.target.value;
    setDraft(raw);
    const parsed = parseDraft(raw);
    // Commit as they type while the value is valid, matching how these
    // settings behaved before; hold off on complaining until they're done
    // (blur/Enter), so a half-typed "1" of "16" isn't flagged.
    if (parsed !== null) {
      rejection.clear();
      onCommit(parsed);
    }
  }

  function settle() {
    const parsed = parseDraft(draft);
    if (parsed === null) {
      rejection.reject(rangeMessage());
      setDraft(String(value ?? ''));
    }
  }

  return (
    <>
      <FieldRejectionHint message={rejection.message} />
      <input
        {...inputProps}
        type="number"
        min={min}
        max={max}
        value={draft}
        className={`${inputProps.className || ''} ${rejection.shakeProps.className}`.trim() || undefined}
        onAnimationEnd={rejection.shakeProps.onAnimationEnd}
        onChange={handleChange}
        onFocus={() => {
          isFocusedRef.current = true;
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          settle();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') settle();
        }}
      />
    </>
  );
}

/**
 * Shared boilerplate behind useMentionAutocomplete and useSmartKeywordSuggest:
 * both watch the input's caret position to derive an "active span/word" at
 * that offset, re-deriving whenever the typed text changes (click/arrow-key
 * moves with no text change are handled by callers wiring the returned
 * `refresh` into onClick/onKeyUp instead, since those don't retrigger this).
 *
 * `deriveSpan(value, caret)` is the one thing that differs between the two
 * hooks (mention/project/section matching vs. fuzzy-keyword matching) and is
 * left entirely up to the caller; this hook only owns the "watch the caret,
 * re-run on value change" plumbing.
 */

import { useEffect, useRef, useState } from 'react';

export function useCaretActiveSpan(inputRef, value, deriveSpan, onRefresh) {
  const [span, setSpan] = useState(null);
  // Set right before a selection-driven splice: the caret hasn't physically
  // moved yet (that happens async via requestAnimationFrame in
  // spliceTextAndMoveCaret), so the `value`-change effect below would
  // otherwise re-derive a span from the stale caret position and reopen the
  // popup it was just told to close, until a later keystroke corrects it.
  const suppressNextRefresh = useRef(false);

  function refresh() {
    const el = inputRef.current;
    const caret = el ? el.selectionStart : null;
    setSpan(caret == null ? null : deriveSpan(value, caret));
    onRefresh?.();
  }

  /** Close the popup and skip the next value-triggered re-derivation (see suppressNextRefresh above). */
  function dismiss() {
    suppressNextRefresh.current = true;
    setSpan(null);
  }

  useEffect(() => {
    if (suppressNextRefresh.current) {
      suppressNextRefresh.current = false;
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return [span, setSpan, refresh, dismiss];
}

/**
 * Replace `value[start:end]` with `replacement`, call `onChange` with the
 * result, then refocus the input and move its caret to just after the
 * inserted text (+ `extraCaretOffset`, for callers that add trailing
 * characters of their own, e.g. a padding space, that aren't part of
 * `replacement` itself).
 */
export function spliceTextAndMoveCaret({ inputRef, value, onChange, start, end, replacement, extraCaretOffset = 0 }) {
  const el = inputRef.current;
  const before = value.slice(0, start);
  const after = value.slice(end);
  onChange(`${before}${replacement}${after}`);
  const nextCaret = before.length + replacement.length + extraCaretOffset;
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
  });
}

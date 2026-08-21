/**
 * useSelectAllOnFocus — app-wide "focusing a text field selects its whole
 * value" behavior, so clicking (or Tab-ing) into any field is enough to
 * replace it outright, matching a browser address bar rather than requiring
 * a manual select-all first. A handful of fields already did this one at a
 * time (`onFocus={(e) => e.target.select()}` — rename inputs, note editing,
 * smart-parse boxes); this generalizes it to every eligible field in one
 * place instead of needing the same one-liner copied into every new field.
 *
 * Listens on the `focusin` event (bubbles, unlike plain `focus`) at the
 * document root rather than per-field, so newly-mounted fields are covered
 * automatically with no wiring at the call site. Opt out of a specific field
 * with `data-no-select-all` — e.g. a field where the cursor position itself
 * carries meaning across a refocus (none identified in this app yet, but the
 * hook is a no-op to skip via the attribute rather than a special case here).
 *
 * Deliberately excludes: checkbox/radio/range/color/file/button-like inputs
 * (not "typable" text to begin with), and date/time/month/week (native
 * segmented widgets where whole-value selection isn't a meaningful concept
 * and can render oddly).
 */

import { useEffect } from 'react';

const EXCLUDED_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'button',
  'submit',
  'reset',
  'hidden',
  'image',
  'date',
  'time',
  'month',
  'week',
  'datetime-local',
]);

function isEligible(el) {
  if (!el || el.disabled || el.readOnly || el.hasAttribute('data-no-select-all')) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !EXCLUDED_INPUT_TYPES.has((el.type || 'text').toLowerCase());
  return false;
}

export function useSelectAllOnFocus() {
  useEffect(() => {
    function handleFocusIn(e) {
      const el = e.target;
      if (!isEligible(el)) return;
      // Deferred: a real mouse click fires this same click's native
      // "place the cursor where you clicked" behavior on mouseup, AFTER
      // this focus event — selecting synchronously here would just get
      // immediately collapsed back to a caret. Deferring past that (any
      // task-queue callback works; setTimeout(0) is the simplest) lets the
      // whole-value selection win regardless of where exactly the click
      // landed.
      //
      // A field that autofocuses on mount (many "click to edit"/"add"
      // inputs in this app do) fires this same focusin before the user has
      // typed anything — but real fast typing (or an automated test's
      // keyboard.type right after the click that revealed the field) can
      // insert characters before this deferred callback gets to run.
      // Selecting unconditionally at that point would grab whatever's been
      // typed so far, and the very next keystroke would then replace that
      // selection instead of continuing to append — silently corrupting
      // input typed within this same tick. Capturing the value at focus
      // time and only selecting if it's unchanged means this only ever
      // fires when nothing has been typed yet (on an empty value, `.select()`
      // is a no-op anyway) — never after.
      const valueAtFocus = el.value;
      setTimeout(() => {
        if (document.activeElement === el && el.value === valueAtFocus) el.select();
      }, 0);
    }
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);
}

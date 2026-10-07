/**
 * dismissedSpans — remembers WHICH typed occurrence of a smart-parse phrase
 * the user cancelled, so only that one stays cancelled.
 *
 * **Why it exists.** Cancelling used to be remembered as "this phrase text
 * (e.g. 'friday') is dismissed". That blocked every later "friday" in the
 * title too, and — because the parser only ever picks one date — a second
 * date typed after the cancelled one (e.g. "Change time for friday monday")
 * was never reached.
 *
 * **What it does.**
 * - A "span" is `{ start, end, text }`: the exact character range of one
 *   cancelled phrase in the title.
 * - `shiftSpans` moves each span along as the user edits the title, and drops
 *   a span once the user edits the cancelled text itself (or glues more word
 *   characters onto it), so retyping the phrase re-arms the parse.
 * - `maskSpans` blanks the cancelled ranges out before parsing, so the parser
 *   only ever sees the occurrences that are still live.
 *
 * **Limitations.** Spans are plain character offsets, so a title replaced
 * wholesale from outside the input (not typed) simply drops every span.
 */

const WORD_CHAR = /\w/;

/** Where the text changed: the untouched prefix/suffix, and the inserted text. */
function diffEdit(oldText, newText) {
  const maxCommon = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxCommon && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < maxCommon - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  return {
    removedStart: prefix,
    removedEnd: oldText.length - suffix,
    inserted: newText.slice(prefix, newText.length - suffix),
  };
}

/** Carry `spans` (positions in `oldText`) over to `newText`, dropping any the edit touched. */
export function shiftSpans(spans, oldText, newText) {
  if (spans.length === 0) return spans;
  const { removedStart, removedEnd, inserted } = diffEdit(oldText, newText);
  const delta = inserted.length - (removedEnd - removedStart);
  const kept = [];

  spans.forEach((span) => {
    let next = null;
    if (span.end <= removedStart) {
      // Edit is after the span. Typing a word character straight onto its end
      // ("fri" + "day") makes it a longer word, which is a new phrase.
      const extendsWord = span.end === removedStart && removedStart === removedEnd && WORD_CHAR.test(inserted[0] || '');
      if (!extendsWord) next = span;
    } else if (span.start >= removedEnd) {
      // Edit is before the span; same word-extension check on its front.
      const extendsWord = span.start === removedEnd && removedStart === removedEnd && WORD_CHAR.test(inserted[inserted.length - 1] || '');
      if (!extendsWord) next = { ...span, start: span.start + delta, end: span.end + delta };
    }
    // Anything else overlaps the edit: the cancelled text itself changed.
    if (next && newText.slice(next.start, next.end).toLowerCase() === span.text.toLowerCase()) kept.push(next);
  });
  return kept;
}

/** Replace each span in `text` with same-length filler so the parser can't match it, but offsets stay put. */
export function maskSpans(text, spans) {
  let out = text;
  spans.forEach((s) => {
    out = out.slice(0, s.start) + '_'.repeat(s.end - s.start) + out.slice(s.end);
  });
  return out;
}

/** Index of the first occurrence of `phrase` in `text` that isn't inside a cancelled span, or -1. */
export function findLiveIndex(text, phrase, spans) {
  if (!phrase) return -1;
  const masked = maskSpans(text, spans).toLowerCase();
  return masked.indexOf(phrase.toLowerCase());
}

/** Remove the text at each `{ start, end }` range (any order) from `text`, then tidy doubled spaces. */
export function removeRanges(text, ranges) {
  let out = text;
  [...ranges]
    .sort((a, b) => b.start - a.start)
    .forEach((r) => {
      out = out.slice(0, r.start) + out.slice(r.end);
    });
  return out.replace(/\s{2,}/g, ' ').trim();
}

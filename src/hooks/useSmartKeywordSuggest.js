/**
 * useSmartKeywordSuggest — live "did you mean?" typo assist for
 * SmartTitleInput, sitting alongside (and independent from) the after-the-
 * fact chip detection in smartParse.js. Watches the word the caret currently
 * sits at the end of and, if it's a near-miss (small edit distance, see
 * fuzzyKeyword.js) for a real smart-parse trigger keyword — a weekday/month
 * name, a recurrence lead word, a duration unit, etc. — surfaces it as a
 * suggestion the user can accept, which corrects the raw text *before* the
 * real parser (parseTaskText) ever sees it. This is deliberately not a new
 * detected-field type: it never touches smartDetected/the chip system.
 *
 * Shape mirrors useMentionAutocomplete — both share the caret-watching and
 * splice-and-reposition-caret boilerplate via useCaretActiveSpan.js.
 * `refresh()` re-derives the active word from the caret position (called
 * from onKeyUp/onClick, plus a useEffect on `value`), and `handleKeyDown`
 * returns true when it consumed the keypress so callers know not to fall
 * through to their own handling.
 *
 * Interaction differs from the mention popup on purpose (per design): Tab
 * cycles between candidates (rare to have more than one) instead of
 * accepting, and Enter applies whichever candidate is currently shown —
 * there's no physical Tab on mobile, so the popup UI also exposes every
 * candidate as a tappable button (see KeywordSuggestPopup).
 */

import { useState } from 'react';
import { useEscapeLayer } from './useEscapeLayer';
import { useCaretActiveSpan, spliceTextAndMoveCaret } from './useCaretActiveSpan';
import { findActiveWord, findFuzzyKeywordMatches } from '../utils/fuzzyKeyword';
import { WEEKDAY_ALIASES, MONTH_ALIASES, WORD_NUMBERS, UNIT_ALIASES as DATE_UNIT_ALIASES, PHRASE_WORDS } from '../utils/dateParse';
import { UNIT_ALIASES as RECURRENCE_UNIT_ALIASES, LEAD_WORDS, ORDINAL_ALIASES, WEEKDAY_SHORTCUT_WORDS } from '../utils/recurrence';
import { DURATION_UNIT_WORDS } from '../utils/durationParser';

// The full smart-parse trigger vocabulary this hook fuzzy-matches typed
// words against, flattened from every parser's own alias tables (see each
// file's exports) so a new alias added there is automatically covered here
// too, with nothing to keep in sync by hand beyond the imports above.
const VOCABULARY = [
  ...Object.keys(WEEKDAY_ALIASES),
  ...Object.keys(MONTH_ALIASES),
  ...Object.keys(WORD_NUMBERS),
  ...Object.keys(DATE_UNIT_ALIASES),
  ...PHRASE_WORDS,
  ...Object.values(RECURRENCE_UNIT_ALIASES).flat(),
  ...LEAD_WORDS,
  ...WEEKDAY_SHORTCUT_WORDS,
  ...Object.keys(ORDINAL_ALIASES),
  ...DURATION_UNIT_WORDS,
];

export function useSmartKeywordSuggest({ inputRef, value, onChange, suppress = false }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [word, setWord, refresh, dismiss] = useCaretActiveSpan(inputRef, value, findActiveWord, () => setActiveIndex(0));

  const matches = !suppress && word ? findFuzzyKeywordMatches(word.word, VOCABULARY) : [];
  const isOpen = matches.length > 0;

  // Escape dismisses this popup, and only this popup. It goes through the
  // shared layer stack because the title field usually sits inside a modal,
  // and a plain keydown branch here never fired — one Escape with the
  // suggestion list open discarded the whole draft instead (see
  // src/hooks/useEscapeLayer.js).
  useEscapeLayer(isOpen, dismiss);
  const current = isOpen ? matches[activeIndex % matches.length] : null;

  /** Replace the active word with `candidate` and move the caret right after it. */
  function applyCandidate(candidate) {
    if (!word || !candidate) return;
    dismiss();
    spliceTextAndMoveCaret({ inputRef, value, onChange, start: word.start, end: word.end, replacement: candidate });
  }

  function selectIndex(index) {
    applyCandidate(matches[index]);
  }

  /** Returns true if it handled the key (caller should not also treat it as e.g. form submit). */
  function handleKeyDown(e) {
    if (!isOpen) return false;
    if (e.key === 'Tab') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCandidate(current);
      return true;
    }
    // Escape is claimed by the escape layer registered above, so a keydown
    // on the input never sees it (see useEscapeLayer).
    return false;
  }

  return {
    isOpen,
    matches,
    current,
    activeIndex,
    anchorIndex: word?.end ?? null, // marker offset for popup positioning — right after the mistyped word
    selectIndex,
    handleKeyDown,
    refresh,
  };
}

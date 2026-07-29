/**
 * Small word-numbers people type instead of digits ("a week", "a couple of
 * days", "a few hours"). Shared base vocabulary for dateParse.js (calendar
 * quantities, up to "ten") and durationParser.js (task-duration phrases,
 * which additionally layers "half"/"half an" on top — a duration-specific
 * concept that doesn't apply to counting weeks/months).
 *
 * Deliberately its own dependency-free file rather than living in
 * dateUtils.js: dateUtils.js re-exports `parseDurationHours` from
 * durationParser.js, so if this vocabulary lived there too, durationParser.js
 * importing it back from dateUtils.js would form an import cycle —
 * durationParser.js's own top-level code (which builds its WORD_NUMBERS map
 * immediately at module-eval time) could then run before dateUtils.js's
 * body had gotten far enough to define this constant, throwing a "before
 * initialization" error. Keeping this in its own leaf module (no imports of
 * its own) means whichever of dateUtils.js/durationParser.js/dateParse.js
 * loads first, this is already fully initialized.
 */
export const BASE_WORD_NUMBERS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  few: 3,
  // Multi-word forms — "a couple"/"a few" read as one count, not "a" (=1) stopping short before "couple".
  'a couple': 2,
  'a few': 3,
};

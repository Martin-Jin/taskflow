/**
 * fuzzyKeyword — generic edit-distance typo detector used to suggest a fix
 * for a mistyped smart-parse trigger word (e.g. "tommorow" -> "tomorrow").
 * Deliberately NOT a hardcoded typo->correction dictionary: callers pass in
 * the *real* keyword vocabulary a parser already matches against (see
 * dateParse.js/recurrence.js/durationParser.js's exported alias tables), and
 * this just finds which of those keywords the currently-typed word is close
 * enough to be a typo of. New typos are caught for free as long as they're
 * edit-distance-close to an existing keyword — no per-typo entry needed.
 */

// Shorter than this and *any* two short real English words tend to sit one
// edit apart from each other (e.g. "the" vs. "tue"/"thu") — too noisy to
// safely fuzzy-correct, so words below this length are never suggested for.
const MIN_TOKEN_LENGTH = 4;
// Same reasoning as MIN_TOKEN_LENGTH — a candidate keyword shorter than this
// (e.g. "ten", "end", "ev") is itself a common short real word, so almost
// anything typo-adjacent to it is just as likely to be an unrelated real
// word ("then" -> "ten", "send" -> "end") as an actual typo of it.
const MIN_CANDIDATE_LENGTH = 4;

/**
 * Restricted Damerau-Levenshtein distance (a.k.a. "optimal string
 * alignment"): Levenshtein plus adjacent-transposition as a single-cost
 * edit, since swapped-adjacent-letters ("nxet" for "next") is one of the
 * most common typo shapes and plain Levenshtein would otherwise price it at
 * 2, pushing it past this module's small distance thresholds.
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const rows = [Array.from({ length: n + 1 }, (_, j) => j)];
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const prev = rows[i - 1];
      let cost = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, rows[i - 2][j - 2] + 1);
      }
      curr[j] = cost;
    }
    rows.push(curr);
  }
  return rows[m][n];
}

/** Max tolerated edit distance for a word of this length — short words get less slack to avoid false positives on real, unrelated words. */
function thresholdFor(length) {
  return length <= 5 ? 1 : 2;
}

/**
 * Find the plain word (letters only) the caret currently sits at the end
 * of, e.g. typing "Piano tommorow|" (caret at the end) -> "tommorow".
 * Mirrors findActiveSpan in useMentionAutocomplete.js but for an ordinary
 * word rather than an "@"/"#" span — scans backward from the caret for a
 * contiguous run of letters.
 * @returns {{word: string, start: number, end: number}|null}
 */
export function findActiveWord(text, caret) {
  if (caret == null) return null;
  const upToCaret = text.slice(0, caret);
  const match = upToCaret.match(/[a-zA-Z]+$/);
  if (!match) return null;
  return { word: match[0], start: caret - match[0].length, end: caret };
}

/**
 * Near-miss keyword candidates for `word` out of `vocabulary` (a flat list
 * of keyword strings — callers just concatenate whichever alias tables are
 * relevant; duplicates/casing are handled here). Excludes exact matches
 * (an already-correct word isn't a "suggestion") and words too short to
 * fuzzy-correct with any confidence.
 * @param {string} word
 * @param {string[]} vocabulary
 * @returns {string[]} deduplicated near-match keywords, closest first
 */
export function findFuzzyKeywordMatches(word, vocabulary) {
  if (!word) return [];
  const w = word.toLowerCase();
  if (w.length < MIN_TOKEN_LENGTH) return [];
  // Already a real keyword as typed — nothing to correct, even if it also
  // happens to sit one edit from a *different* keyword (e.g. "hours" is one
  // edit from "hour", but it's already spelled correctly).
  if (vocabulary.some((v) => v.toLowerCase() === w)) return [];
  const threshold = thresholdFor(w.length);

  const seen = new Set();
  const scored = [];
  for (const raw of vocabulary) {
    const candidate = raw.toLowerCase();
    if (candidate.length < MIN_CANDIDATE_LENGTH || candidate === w || seen.has(candidate)) continue;
    // Cheap pre-filters before paying for a full edit-distance computation.
    // Requiring the same first letter is a standard typo heuristic (people
    // rarely fumble a word's very first letter) that also happens to rule
    // out most unrelated-real-word collisions at distance 1 ("your" is one
    // edit from both "four" and "hour", but shares neither's first letter).
    if (candidate[0] !== w[0]) continue;
    if (Math.abs(candidate.length - w.length) > threshold) continue;
    const dist = editDistance(w, candidate);
    if (dist > 0 && dist <= threshold) {
      seen.add(candidate);
      scored.push({ candidate, dist });
    }
  }
  return scored.sort((a, b) => a.dist - b.dist).map((s) => s.candidate);
}

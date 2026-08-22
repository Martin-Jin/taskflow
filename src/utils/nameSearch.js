/**
 * ============================================================================
 * NAME SEARCH
 * ============================================================================
 * Single shared "rank named things by a typed query" matcher — originally
 * written for CalendarFilterMenu's Projects search box (hence the earlier
 * `scoreProjectMatch`/`rankProjectsBySearch` names living in calendarFilter.js),
 * then adopted everywhere else in the app that searches projects by name
 * (Sidebar, ManageProjectsModal, SearchBar, useMentionAutocomplete,
 * CommandPalette) so there's exactly one typo-tolerant matcher instead of
 * several ad-hoc `.includes()`/subsequence checks with slightly different
 * behavior. The logic itself has nothing project-specific about it — it's
 * "rank a list of `{ id, label }`-shaped items against a query string" — so
 * it lives in its own module rather than calendarFilter.js, which is now just
 * a re-exporting shim for backwards compatibility (see that file).
 *
 * Strips everything but letters/digits/spaces before matching, so emoji
 * commonly used in project names ("Lists 📄", "Tasks 📋") don't break
 * prefix/substring/fuzzy matching — typing "lists" still finds "Lists 📄".
 * ============================================================================
 */

import { editDistance } from './fuzzyKeyword';

function normalizeForSearch(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

/** Same length-scaled tolerance reasoning as fuzzyKeyword's thresholdFor, tuned slightly looser here since search queries are often shorter than a full word. */
function fuzzyThresholdFor(length) {
  if (length <= 2) return 0; // a 1-2 char query only matches by prefix/substring — fuzzy would match nearly anything
  if (length <= 5) return 1;
  return 2;
}

/** True if every character of `query` appears in `text`, in order (not necessarily contiguous) — e.g. "ab" in "assignments backlog". */
function isSubsequence(query, text) {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j++) {
    if (text[j] === query[i]) i++;
  }
  return i === query.length;
}

/**
 * Ranks `name` against `query` for incremental search, returning a numeric
 * score (lower is better) or `null` if it doesn't match at all. Tiers, best
 * to worst: prefix match, substring match, subsequence/initials match, then
 * fuzzy (typo-tolerant) match — built on fuzzyKeyword's editDistance rather
 * than a second edit-distance implementation, but with its own thresholds
 * since findFuzzyKeywordMatches is tuned for whole-word typo correction, not
 * short, incremental search queries.
 */
export function scoreNameMatch(query, name) {
  const q = normalizeForSearch(query);
  const n = normalizeForSearch(name);
  if (!q) return 0;
  if (!n) return null;

  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (isSubsequence(q, n)) return 2;

  const threshold = fuzzyThresholdFor(q.length);
  if (threshold > 0) {
    // Fuzzy-match against a sliding window the length of the query across
    // each word of the name (rather than the whole name at once) so a short
    // query can still typo-match one word of a multi-word name.
    for (const word of n.split(/\s+/)) {
      if (!word) continue;
      const dist = editDistance(q, word.length > q.length + threshold ? word.slice(0, q.length + threshold) : word);
      if (dist <= threshold) return 3 + dist / 10;
    }
  }
  return null;
}

/**
 * Filters + ranks `items` (each `{ id, label, ... }`) by `query`. Empty query
 * returns items unchanged (original order preserved) so search never
 * reorders the list before the user types. Ties (equal score) keep their
 * relative order from `items`, so a caller that pre-sorts its list (e.g. the
 * Sidebar's pinned/recency order) keeps that ordering among equally-good
 * matches instead of an arbitrary one.
 */
export function rankByNameSearch(query, items) {
  if (!query.trim()) return items;
  return items
    .map((item, index) => ({ item, index, score: scoreNameMatch(query, item.label) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** Strict tiers only (prefix/substring/subsequence — no fuzzy typo tolerance). Used where a silent fuzzy resolution would be surprising (e.g. resolving an in-progress "#project" mention). */
export function scoreNameMatchStrict(query, name) {
  const q = normalizeForSearch(query);
  const n = normalizeForSearch(name);
  if (!q) return 0;
  if (!n) return null;
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (isSubsequence(q, n)) return 2;
  return null;
}

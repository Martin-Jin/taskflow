/**
 * ============================================================================
 * DURATION PARSER
 * ============================================================================
 * Extracts an estimated-hours number from free-text (a task's `description`
 * / `notes` field, or its title). This is a fallback source of truth for
 * task duration, used when Todoist's structured `duration` field isn't set —
 * many people write estimates directly in the task notes instead (e.g.
 * "~2 hours", "1.5hr", "30 min", "Est: 3 Hours").
 *
 * Deliberately robust to real-world phrasing rather than a single rigid
 * "<number><space>hours" pattern:
 *   - Case-insensitive: "Hours", "HOUR", "hr" all match.
 *   - Singular/plural/abbreviated units: hour, hours, hr, hrs, h.
 *   - Optional/variable whitespace, or none at all: "2h", "2 h", "2  hours".
 *   - Decimal and fractional hours: "1.5 hours", "1,5 hours" (EU decimal
 *     comma), "1/2 hour".
 *   - Written-out small numbers: "half an hour", "an hour", "a couple hours".
 *   - Optional leading markers like "~", "approx", "about", "est"/"estimate".
 *   - Minutes, converted to hours: "45 min", "45 minutes", "45m".
 *   - Combined hour+minute: "1h 30m", "1 hour 30 minutes".
 *   - Ignores unrelated numbers in the text (dates, counts, etc.) by
 *     requiring a duration-unit word/abbreviation directly adjacent to the
 *     number — it does not just grab "the first number in the string".
 * ============================================================================
 */

const WORD_NUMBERS = {
  half: 0.5,
  'half an': 0.5,
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
  couple: 2,
  'couple of': 2,
  few: 3,
  'a few': 3,
};

/** Normalize a numeric token: handles ".", "," decimals and simple "a/b" fractions. */
function parseNumberToken(token) {
  if (!token) return null;
  const t = token.trim();

  // Simple fraction like "1/2" or "3/4".
  const fractionMatch = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fractionMatch) {
    const num = Number(fractionMatch[1]);
    const den = Number(fractionMatch[2]);
    if (den !== 0) return num / den;
  }

  // EU-style decimal comma ("1,5") vs. thousands-separator ambiguity is a
  // non-issue at task-duration scale, so treat "," as "." when it appears
  // between digits.
  const normalized = t.replace(/(\d),(\d)/, '$1.$2');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// Unit group patterns. Longer/more-specific alternatives first so e.g.
// "hrs" isn't mis-split by a greedier "h" match. A trailing boundary is
// required so "h" doesn't match inside "hats" or "happy" — but the
// boundary must accept being followed directly by a digit too (e.g.
// "1hr30min", where "hr" is immediately followed by "30"), so it's
// expressed as "non-letter or end-of-string" rather than plain \b.
const HOUR_UNIT = /(?:hours?|hrs?|h)(?=[^a-z]|$)/i;
const MINUTE_UNIT = /(?:minutes?|mins?|m)(?=[^a-z]|$)/i;

// A leading approximation marker some people prefix estimates with.
const APPROX_PREFIX = /(?:~|approx(?:imately)?\.?|about|est(?:imate[d]?)?:?\s*)?\s*/i;

/**
 * Try to find an explicit "<number> <unit>" duration mention in free text.
 * Returns {hours, matchedText, index} or null if nothing confident was found.
 */
function matchNumericDuration(text) {
  // Combined "1h 30m" / "1 hour 30 minutes" / "1hr30min" form first, since
  // it's more specific and should win over a lone hour or minute match.
  const combinedRe = new RegExp(
    `${APPROX_PREFIX.source}(\\d+(?:[.,]\\d+)?)\\s*${HOUR_UNIT.source}\\s*(?:and\\s*)?(\\d+(?:[.,]\\d+)?)\\s*${MINUTE_UNIT.source}`,
    'i'
  );
  const combinedMatch = text.match(combinedRe);
  if (combinedMatch) {
    const h = parseNumberToken(combinedMatch[1]) || 0;
    const m = parseNumberToken(combinedMatch[2]) || 0;
    const total = h + m / 60;
    if (total > 0) return { hours: total, matchedText: combinedMatch[0], index: combinedMatch.index };
  }

  // Plain "<number> hour(s)/hr(s)/h" — also accepts a fraction like "1/2 hour".
  const hourRe = new RegExp(
    `${APPROX_PREFIX.source}(\\d+(?:[.,]\\d+)?(?:\\s*\\/\\s*\\d+)?)\\s*${HOUR_UNIT.source}`,
    'i'
  );
  const hourMatch = text.match(hourRe);
  if (hourMatch) {
    const hours = parseNumberToken(hourMatch[1]);
    if (hours !== null && hours > 0) return { hours, matchedText: hourMatch[0], index: hourMatch.index };
  }

  // Plain "<number> min(s)/minute(s)/m" -> convert to hours.
  const minRe = new RegExp(`${APPROX_PREFIX.source}(\\d+(?:[.,]\\d+)?)\\s*${MINUTE_UNIT.source}`, 'i');
  const minMatch = text.match(minRe);
  if (minMatch) {
    const minutes = parseNumberToken(minMatch[1]);
    if (minutes !== null && minutes > 0) return { hours: minutes / 60, matchedText: minMatch[0], index: minMatch.index };
  }

  return null;
}

/**
 * Try to find a written-out duration ("half an hour", "a couple hours",
 * "an hour"). Returns {hours, matchedText, index} or null.
 */
function matchWordDuration(text) {
  // Longest phrases first so "a couple of hours" isn't shadowed by "a".
  const phrases = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    const re = new RegExp(`\\b${phrase}\\b\\s*(?:an?\\s+)?${HOUR_UNIT.source}`, 'i');
    const m = text.match(re);
    if (m) {
      return { hours: WORD_NUMBERS[phrase], matchedText: m[0], index: m.index };
    }
  }
  return null;
}

/**
 * Locate a duration mention anywhere inside a longer piece of text (e.g. a
 * task title being typed) and report the exact substring matched, so a
 * caller (smartParse.js) can strip it back out of the saved title — mirrors
 * findRecurrencePhrase in recurrence.js. Returns null if nothing confident
 * was found.
 * @param {string} text
 * @returns {{hours: number, matchedText: string, index: number}|null}
 */
export function findDurationPhrase(text) {
  if (!text || typeof text !== 'string') return null;
  const numeric = matchNumericDuration(text);
  if (numeric) return { hours: roundToQuarterHour(numeric.hours), matchedText: numeric.matchedText, index: numeric.index };
  const worded = matchWordDuration(text);
  if (worded) return { hours: roundToQuarterHour(worded.hours), matchedText: worded.matchedText, index: worded.index };
  return null;
}

/**
 * Extract an estimated duration, in hours, from free text such as a task's
 * description/notes or title. Returns null if no confident duration
 * mention is found (callers should fall back to some other default rather
 * than guessing).
 *
 * @param {string} text
 * @returns {number|null}
 */
export function extractDurationHours(text) {
  if (!text || typeof text !== 'string') return null;
  const match = findDurationPhrase(text);
  return match ? match.hours : null;
}

/**
 * Round to the nearest 15 minutes — matches the granularity the scheduler
 * already works in. Floors at one quarter-hour rather than 0: callers only
 * ever pass a confidently-matched positive duration (e.g. "5 min"), and a
 * result of 0 would be indistinguishable from "no duration found" at the
 * call site, silently discarding a real (if very short) estimate.
 */
function roundToQuarterHour(hours) {
  return Math.max(0.25, Math.round(hours * 4) / 4);
}

/**
 * ============================================================================
 * RECURRENCE
 * ============================================================================
 * Small helper for Todoist-style recurring tasks ("every day", "every
 * Monday", "every 3 weeks", "every month", ...). Todoist itself is the
 * source of truth for advancing a recurring task's due date when it's
 * completed there — the server computes the next occurrence and the task
 * simply never becomes "done". This module exists so TaskFlow can mirror
 * that behavior LOCALLY and instantly (no round trip required) whenever a
 * recurring task is completed in-app, so the UI never shows a recurring
 * task flipping to "completed".
 *
 * This is a best-effort parser covering the common phrasings Todoist's
 * natural-language recurrence produces in `due.string`. Real-world Todoist
 * strings vary more than a single tight regex can handle, e.g.:
 *   "every day", "every!  day" (non-shifting variant — the "!" means "don't
 *   push to next day if I complete it late", it doesn't change the interval),
 *   "every month", "every 1 month" (Todoist sometimes writes count-1 rules
 *   explicitly instead of omitting the number), "monthly", "every mon",
 *   "every mon, wed, fri", "ev day" (Todoist's own quick-add abbreviates
 *   "every" to "ev" in some locales/versions).
 * If a string can't be confidently parsed, we fall back to a flat +1 day
 * rather than guessing wildly, and the next real Todoist sync will correct
 * it — but the matcher below is intentionally generous so that fallback is
 * rarely hit in practice.
 * ============================================================================
 */

import { addDays } from './dateUtils';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Canonical unit -> aliases Todoist (or a user typing a custom recurrence)
// might use. Longest/most-specific first isn't required here since we
// build a single alternation and rely on \b word boundaries.
const UNIT_ALIASES = {
  day: ['day', 'days', 'daily', 'everyday'],
  week: ['week', 'weeks', 'weekly', 'fortnight', 'fortnightly'],
  month: ['month', 'months', 'monthly'],
  year: ['year', 'years', 'yearly', 'annually', 'annual'],
};

// "each" is as common a leading word as "every"/"ev" ("each week", "each month").
const LEAD_WORD = 'every|ev|each';

function unitAliasPattern() {
  const all = Object.values(UNIT_ALIASES).flat();
  return all.join('|');
}

function resolveCanonicalUnit(word) {
  const w = word.toLowerCase();
  if (w === 'fortnight' || w === 'fortnightly') return 'week'; // special-cased count below
  for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
    if (aliases.includes(w)) return canonical;
  }
  return null;
}

/**
 * Determine whether a Todoist `due` object represents a recurring task.
 *
 * Primarily trusts `due.is_recurring`, which is the authoritative flag from
 * Todoist's API. As a defensive fallback (in case the API ever omits/misses
 * this flag for a task that clearly does repeat, e.g. some quick-add-parsed
 * tasks), we also treat it as recurring if `due.string` itself parses as a
 * recurrence pattern — better to correctly detect a repeating task than to
 * silently drop it into one-off "complete = done forever" behavior.
 *
 * @param {Object|null|undefined} due - raw Todoist `due` object
 * @returns {boolean}
 */
export function isRecurringDue(due) {
  if (!due) return false;
  if (due.is_recurring) return true;
  // Defensive fallback: some tasks come back with is_recurring falsy/missing
  // even though due.string is plainly a recurrence phrase (e.g. certain
  // quick-add-parsed or legacy tasks). Trust the string in that case.
  return !!parseRecurrenceRule(due.string);
}

/**
 * Parse the interval unit + count out of a Todoist recurrence string.
 * Returns null if the string doesn't match a supported pattern.
 *
 * Deliberately permissive:
 *   - Accepts "every", "ev", or no leading word at all before the unit
 *     (e.g. bare "monthly").
 *   - Ignores Todoist's non-shifting "!" marker ("every! month").
 *   - Accepts singular/plural/adverbial unit forms (month/months/monthly).
 *   - Falls back to a weekly cadence for "every <weekday>" / "every mon,
 *     wed, fri" style strings.
 *
 * @param {string} str - e.g. "every day", "every 2 weeks", "every month", "monthly"
 * @returns {{unit: 'day'|'week'|'month'|'year', count: number}|null}
 */
export function parseRecurrenceRule(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();

  const unitAlt = unitAliasPattern();

  // "every N <unit>(s)" — the general numeric form. Allows "every!" (Todoist's
  // non-shifting marker) and "ev" as an abbreviation for "every".
  const numericMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(\\d+)\\s*(${unitAlt})\\b`));
  if (numericMatch) {
    const unit = resolveCanonicalUnit(numericMatch[2]);
    if (unit) return { unit, count: Math.max(1, Number(numericMatch[1])) };
  }

  // "every <unit>" / "ev <unit>" (implicit count of 1), tolerating the "!" marker.
  const simpleMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(${unitAlt})\\b`));
  if (simpleMatch) {
    const unit = resolveCanonicalUnit(simpleMatch[1]);
    if (unit) return { unit, count: unit === 'week' && /fortnight/.test(simpleMatch[1]) ? 2 : 1 };
  }

  // Bare adverbial form with no "every" at all: "monthly", "daily", "weekly",
  // "yearly", "fortnightly" — some Todoist strings (and custom text) omit
  // "every" entirely.
  const bareMatch = s.match(new RegExp(`^(${unitAlt})$`));
  if (bareMatch) {
    const unit = resolveCanonicalUnit(bareMatch[1]);
    if (unit) return { unit, count: /fortnight/.test(bareMatch[1]) ? 2 : 1 };
  }

  // "every <weekday>" or "every mon, wed, fri" — treat as a weekly cadence
  // for local advancement purposes (Todoist will compute the precise next
  // matching weekday server-side on the next sync).
  const hasWeekday = DAY_NAMES.some((d) => s.includes(d));
  if ((s.startsWith('every') || s.startsWith('ev') || s.startsWith('each')) && hasWeekday) {
    return { unit: 'week', count: 1 };
  }

  return null;
}

/**
 * Locate a recurrence phrase anywhere inside a longer piece of text (e.g. a
 * task title being typed), rather than requiring the whole string to BE the
 * recurrence phrase like parseRecurrenceRule does. Used by smartParse.js to
 * detect "every month" etc. inline and know exactly what substring to strip
 * out of the saved title. Reuses the same alias tables/patterns as
 * parseRecurrenceRule so the two stay in sync.
 *
 * @param {string} text
 * @returns {{rule: {unit: string, count: number}, matchedText: string, index: number}|null}
 */
export function findRecurrencePhrase(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();
  const unitAlt = unitAliasPattern();

  const numericMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(\\d+)\\s*(${unitAlt})\\b`));
  if (numericMatch) {
    const unit = resolveCanonicalUnit(numericMatch[2]);
    if (unit) {
      return { rule: { unit, count: Math.max(1, Number(numericMatch[1])) }, matchedText: numericMatch[0], index: numericMatch.index };
    }
  }

  const simpleMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(${unitAlt})\\b`));
  if (simpleMatch) {
    const unit = resolveCanonicalUnit(simpleMatch[1]);
    if (unit) {
      const count = unit === 'week' && /fortnight/.test(simpleMatch[1]) ? 2 : 1;
      return { rule: { unit, count }, matchedText: simpleMatch[0], index: simpleMatch.index };
    }
  }

  const weekdayMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(${DAY_NAMES.join('|')})[a-z]*(?:,\\s*(?:${DAY_NAMES.join('|')})[a-z]*)*`));
  if (weekdayMatch) {
    return { rule: { unit: 'week', count: 1 }, matchedText: weekdayMatch[0], index: weekdayMatch.index };
  }

  const bareMatch = s.match(new RegExp(`\\b(${unitAlt})\\b`));
  if (bareMatch) {
    const unit = resolveCanonicalUnit(bareMatch[1]);
    if (unit) {
      const count = /fortnight/.test(bareMatch[1]) ? 2 : 1;
      return { rule: { unit, count }, matchedText: bareMatch[0], index: bareMatch.index };
    }
  }

  return null;
}

/**
 * Compute the next due date after completing a recurring task, given its
 * current due date and recurrence string. Falls back to +1 day if the
 * recurrence string isn't confidently parseable.
 * @param {string} currentDueDate - ISO date (YYYY-MM-DD)
 * @param {string|null|undefined} recurrenceString - Todoist's `due.string`
 * @returns {string} ISO date
 */
export function computeNextDueDate(currentDueDate, recurrenceString) {
  const rule = parseRecurrenceRule(recurrenceString);
  if (!rule) return addDays(currentDueDate, 1);

  switch (rule.unit) {
    case 'day':
      return addDays(currentDueDate, rule.count);
    case 'week':
      return addDays(currentDueDate, rule.count * 7);
    case 'month':
      return addMonths(currentDueDate, rule.count);
    case 'year':
      return addMonths(currentDueDate, rule.count * 12);
    default:
      return addDays(currentDueDate, 1);
  }
}

/** Add N months to an ISO date, clamping the day-of-month if it overflows the target month. */
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1 + n, 1);
  const lastDayOfTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDayOfTargetMonth));
  const pad = (v) => String(v).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

/** Options for the "Repeats every N ___" unit <select> in AddTaskModal/TaskDetailModal. */
export const RECURRENCE_UNITS = [
  { value: 'day', label: 'Day(s)' },
  { value: 'week', label: 'Week(s)' },
  { value: 'month', label: 'Month(s)' },
  { value: 'year', label: 'Year(s)' },
];

/** Build a normalized "every N <unit>(s)" string from a count+unit pair — the inverse of parseRecurrenceRule. */
export function buildRecurrenceString(count, unit) {
  const n = Math.max(1, Number(count) || 1);
  return `every ${n} ${unit}${n === 1 ? '' : 's'}`;
}

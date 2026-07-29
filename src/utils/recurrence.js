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

/** Short display labels for DAY_NAMES indices (0=Sun..6=Sat), used to build a readable recurrenceString. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// Ordinal words for "every second sunday" (= every other Sunday), "every third monday", etc.
// Numeric ordinals ("every 2nd sunday") are handled separately via a digit+suffix pattern.
// "other" is folded in here too so "every other monday" (Todoist's own phrasing for
// biweekly-on-a-weekday) falls out of the same ordinal machinery for free.
const ORDINAL_ALIASES = {
  other: 2,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
};

function unitAliasPattern() {
  const all = Object.values(UNIT_ALIASES).flat();
  return all.join('|');
}

// Bare "day"/"days" (no leading "every"/"ev"/"each") is too ambiguous to treat
// as a recurrence signal on its own — it collides with unrelated phrases like
// "on the day" (enforceDueDate) or "in 3 days". The unambiguous adverbial
// forms ("daily", "everyday") still work bare; only the plain noun requires a
// lead word. Other units' bare forms ("monthly", "weekly", ...) are already
// adverbial-only so they don't need this filtering.
function bareUnitAliasPattern() {
  const bareAliases = { ...UNIT_ALIASES, day: UNIT_ALIASES.day.filter((a) => a !== 'day' && a !== 'days') };
  return Object.values(bareAliases).flat().join('|');
}

function ordinalAliasPattern() {
  return Object.keys(ORDINAL_ALIASES).join('|');
}

/** "sun"/"sunday" -> 0, ..., "sat"/"saturday" -> 6; matches DAY_NAMES stems with any trailing letters. */
function dayTokenPattern() {
  return `(?:${DAY_NAMES.join('|')})[a-z]*`;
}

function ordinalTokenPattern() {
  return `(?:\\d+(?:st|nd|rd|th)|${ordinalAliasPattern()})`;
}

/** Every distinct weekday index (0=Sun..6=Sat) mentioned in `span`, in weekday order. */
function extractDaysFromSpan(span) {
  const days = [];
  const dayRe = new RegExp(`\\b(${DAY_NAMES.join('|')})[a-z]*\\b`, 'g');
  for (const m of span.matchAll(dayRe)) {
    const idx = DAY_NAMES.indexOf(m[1]);
    if (idx !== -1 && !days.includes(idx)) days.push(idx);
  }
  return days.sort((a, b) => a - b);
}

/**
 * First ordinal ("second", "2nd", ...) mentioned in `span`, or 1 if none.
 * Known limitation: the `{unit, count, days}` shape has one count for every
 * day in the match, so a mixed phrase like "every sunday and every second
 * saturday" comes out as every-2-weeks on BOTH days rather than weekly
 * Sunday + biweekly Saturday. Representing that correctly would need a
 * per-day count, which isn't worth the complexity for how rare mixed-cadence
 * phrasing is in practice — Todoist's own sync remains the source of truth
 * for the precise next date regardless.
 */
function extractOrdinalCountFromSpan(span) {
  const m = span.match(new RegExp(`\\b(?:(\\d+)(?:st|nd|rd|th)|(${ordinalAliasPattern()}))\\b`));
  if (!m) return 1;
  return m[1] ? Number(m[1]) : ORDINAL_ALIASES[m[2]];
}

/**
 * "every N week(s) on <weekday list>" — the exact shape buildRecurrenceString
 * produces for a weekday-specific rule, tolerant of full weekday names too
 * (not just the 3-letter labels it emits) so a manually typed/edited
 * recurrence still parses. Shared by parseRecurrenceRule (whole-string
 * contract) and findRecurrencePhrase (search-anywhere contract) so both stay
 * in sync — findRecurrencePhrase previously lacked this branch entirely and
 * fell through to the plain "every week" matcher, silently dropping the day
 * list from the match.
 */
function findOnDaysSpan(s) {
  const dayToken = dayTokenPattern();
  const re = new RegExp(
    `(?:${LEAD_WORD})!?\\s+(?:(\\d+)\\s*)?weeks?\\s+on\\s+${dayToken}(?:\\s*(?:,|&|and)\\s*${dayToken})*`
  );
  const m = s.match(re);
  if (!m) return null;
  const days = extractDaysFromSpan(m[0]);
  if (!days.length) return null;
  return { rule: { unit: 'week', count: Math.max(1, Number(m[1]) || 1), days }, matchedText: m[0], index: m.index };
}

/**
 * Match one or more weekday mentions after a leading "every"/"ev"/"each",
 * covering the phrasings this feature targets:
 *   "every sunday", "every sat and sun", "every mon, wed, fri",
 *   "every sunday and every saturday" (repeated lead word per day),
 *   "every second sun" / "every 2nd sunday" (ordinal -> biweekly-style count).
 * Returns a rule with a `days` array (weekday indices, 0=Sun..6=Sat) alongside
 * the existing `{unit, count}` shape so simple callers (computeNextDueDate)
 * keep working unchanged while richer callers (smartParse's chip label) can
 * use `days` to show which weekdays were detected.
 */
function findWeekdayRecurrenceSpan(s) {
  const dayToken = dayTokenPattern();
  const ordinalToken = ordinalTokenPattern();
  const re = new RegExp(
    `(?:${LEAD_WORD})!?\\s+(?:${ordinalToken}\\s+)?${dayToken}` +
      `(?:\\s*(?:,|&|and)\\s*(?:(?:${LEAD_WORD})!?\\s+)?(?:${ordinalToken}\\s+)?${dayToken})*`
  );
  const m = s.match(re);
  if (!m) return null;
  const span = m[0];
  const days = extractDaysFromSpan(span);
  if (!days.length) return null;
  const count = extractOrdinalCountFromSpan(span);
  return { rule: { unit: 'week', count, days }, matchedText: span, index: m.index };
}

/**
 * "every weekday" / "every weekdays" — Todoist's own shortcut for Mon-Fri.
 * Modeled with the same `{unit: 'week', count: 1, days}` shape the
 * multi-weekday matcher already produces, just with all five business days
 * pre-filled, so every caller that already knows how to render/advance a
 * `days` array (smartParse's chip label, computeNextDueDate) handles this
 * for free with no special-casing.
 */
function findWeekdayShortcutMatch(s) {
  const m = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+weekdays?\\b`));
  if (!m) return null;
  return { rule: { unit: 'week', count: 1, days: [1, 2, 3, 4, 5] }, matchedText: m[0], index: m.index };
}

/**
 * "every other <unit>" — Todoist's own phrasing for a plain every-2 cadence
 * ("every other week" = "every 2 weeks"). Kept separate from the numeric
 * ("every N <unit>") and simple ("every <unit>") matchers above since
 * neither pattern has a slot for the word "other" between the lead word
 * and the unit.
 */
function findOtherUnitMatch(s, unitAlt) {
  const m = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+other\\s+(${unitAlt})\\b`));
  if (!m) return null;
  const unit = resolveCanonicalUnit(m[1]);
  if (!unit) return null;
  return { rule: { unit, count: 2 }, matchedText: m[0], index: m.index };
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
 * @param {string} str - e.g. "every day", "every 2 weeks", "every month", "monthly", "every sat and sun"
 * @returns {{unit: 'day'|'week'|'month'|'year', count: number, days?: number[]}|null}
 */
export function parseRecurrenceRule(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();

  const unitAlt = unitAliasPattern();

  // "every N week(s) on Mon, Wed" — the exact shape buildRecurrenceString
  // produces above for a weekday-specific rule. Checked first so a saved/
  // re-opened task (or one edited again after smart-parse) can round-trip
  // its own `days` back out instead of losing them to the generic
  // "every N week(s)" branch further down.
  const onDaysSpan = findOnDaysSpan(s);
  if (onDaysSpan) return onDaysSpan.rule;

  // "every N <unit>(s)" — the general numeric form. Allows "every!" (Todoist's
  // non-shifting marker) and "ev" as an abbreviation for "every".
  const numericMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(\\d+)\\s*(${unitAlt})\\b`));
  if (numericMatch) {
    const unit = resolveCanonicalUnit(numericMatch[2]);
    if (unit) return { unit, count: Math.max(1, Number(numericMatch[1])) };
  }

  // "every weekday" (Mon-Fri shortcut) and "every other <unit>" (= every 2
  // <unit>) — checked before the plain simple/numeric forms since neither
  // of those has a slot for "weekday" or "other".
  const weekdayShortcutMatch = findWeekdayShortcutMatch(s);
  if (weekdayShortcutMatch && weekdayShortcutMatch.index === 0) return weekdayShortcutMatch.rule;
  const otherUnitMatch = findOtherUnitMatch(s, unitAlt);
  if (otherUnitMatch && otherUnitMatch.index === 0) return otherUnitMatch.rule;

  // "every <unit>" / "ev <unit>" (implicit count of 1), tolerating the "!" marker.
  const simpleMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(${unitAlt})\\b`));
  if (simpleMatch) {
    const unit = resolveCanonicalUnit(simpleMatch[1]);
    if (unit) return { unit, count: unit === 'week' && /fortnight/.test(simpleMatch[1]) ? 2 : 1 };
  }

  // Bare adverbial form with no "every" at all: "monthly", "daily", "weekly",
  // "yearly", "fortnightly" — some Todoist strings (and custom text) omit
  // "every" entirely. Plain "day"/"days" excluded (see bareUnitAliasPattern).
  const bareMatch = s.match(new RegExp(`^(${bareUnitAliasPattern()})$`));
  if (bareMatch) {
    const unit = resolveCanonicalUnit(bareMatch[1]);
    if (unit) return { unit, count: /fortnight/.test(bareMatch[1]) ? 2 : 1 };
  }

  // "every <weekday>", "every sat and sun", "every mon, wed, fri", "every
  // second sunday" — treat as a weekly (or every-N-weeks, for the ordinal
  // form) cadence for local advancement purposes; Todoist computes the
  // precise next matching weekday(s) server-side on the next sync.
  // Require the match at the very start of the string (unlike
  // findRecurrencePhrase, which intentionally searches anywhere inside a
  // longer typed title) — parseRecurrenceRule's contract is "does this
  // whole due.string represent a recurrence", so a stray weekday mention
  // later in an unrelated string shouldn't be treated as one.
  const weekdayMatch = findWeekdayRecurrenceSpan(s);
  if (weekdayMatch && weekdayMatch.index === 0) return weekdayMatch.rule;

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
 * @returns {{rule: {unit: string, count: number, days?: number[]}, matchedText: string, index: number}|null}
 */
export function findRecurrencePhrase(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();
  const unitAlt = unitAliasPattern();

  const onDaysSpan = findOnDaysSpan(s);
  if (onDaysSpan) return onDaysSpan;

  const numericMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(\\d+)\\s*(${unitAlt})\\b`));
  if (numericMatch) {
    const unit = resolveCanonicalUnit(numericMatch[2]);
    if (unit) {
      return { rule: { unit, count: Math.max(1, Number(numericMatch[1])) }, matchedText: numericMatch[0], index: numericMatch.index };
    }
  }

  const weekdayShortcutMatch = findWeekdayShortcutMatch(s);
  if (weekdayShortcutMatch) return weekdayShortcutMatch;
  const otherUnitMatch = findOtherUnitMatch(s, unitAlt);
  if (otherUnitMatch) return otherUnitMatch;

  const simpleMatch = s.match(new RegExp(`(?:${LEAD_WORD})!?\\s+(${unitAlt})\\b`));
  if (simpleMatch) {
    const unit = resolveCanonicalUnit(simpleMatch[1]);
    if (unit) {
      const count = unit === 'week' && /fortnight/.test(simpleMatch[1]) ? 2 : 1;
      return { rule: { unit, count }, matchedText: simpleMatch[0], index: simpleMatch.index };
    }
  }

  const weekdayMatch = findWeekdayRecurrenceSpan(s);
  if (weekdayMatch) return weekdayMatch;

  const bareMatch = s.match(new RegExp(`\\b(${bareUnitAliasPattern()})\\b`));
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

/**
 * Build a normalized recurrence string from a count+unit pair — the inverse
 * of parseRecurrenceRule. When `days` (weekday indices, 0=Sun..6=Sat) is
 * given for a weekly rule, produces the same "every N week(s) on Mon, Wed"
 * shape smartParse.js's chip label already uses, so a weekday-specific
 * recurrence detected via smart-parse doesn't collapse into a generic
 * "every N week(s)" once saved — see parseRecurrenceRule's matching branch
 * below for the round-trip back into { unit, count, days }.
 */
export function buildRecurrenceString(count, unit, days) {
  const n = Math.max(1, Number(count) || 1);
  if (unit === 'week' && Array.isArray(days) && days.length > 0) {
    const dayLabels = days.map((d) => WEEKDAY_LABELS[d]).join(', ');
    return `every ${n === 1 ? '' : `${n} `}week${n === 1 ? '' : 's'} on ${dayLabels}`;
  }
  return `every ${n} ${unit}${n === 1 ? '' : 's'}`;
}

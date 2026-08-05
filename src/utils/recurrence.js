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

import { addDays, addMonthsClamped, fromISODate } from './dateUtils';
import { generateRuleOccurrences } from './recurrenceExpansion';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Short display labels for DAY_NAMES indices (0=Sun..6=Sat), used to build a readable recurrenceString. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Ceiling on a recurrence's `count` (as in "every N days/weeks/months/years").
// Without this, a huge count (typed directly, or arriving via a Todoist
// due.string with no UI involved at all) overflows Date arithmetic
// (addDays/addMonthsClamped) into Invalid Date, which then serializes to
// "NaN-NaN-NaN" and syncs to Firestore. 999 is comfortably above any
// legitimate recurrence a user would set.
export const MAX_RECURRENCE_COUNT = 999;

/** Clamp a recurrence count to [1, MAX_RECURRENCE_COUNT], defaulting to 1 for non-numeric input. */
function clampRecurrenceCount(value) {
  return Math.min(MAX_RECURRENCE_COUNT, Math.max(1, Number(value) || 1));
}

// Canonical unit -> aliases Todoist (or a user typing a custom recurrence)
// might use. Longest/most-specific first isn't required here since we
// build a single alternation and rely on \b word boundaries. Exported so
// fuzzy typo suggestion (useSmartKeywordSuggest) can reuse this same
// vocabulary instead of duplicating it.
export const UNIT_ALIASES = {
  day: ['day', 'days', 'daily', 'everyday'],
  week: ['week', 'weeks', 'weekly', 'fortnight', 'fortnightly'],
  month: ['month', 'months', 'monthly'],
  year: ['year', 'years', 'yearly', 'annually', 'annual'],
};

// "each" is as common a leading word as "every"/"ev" ("each week", "each month").
const LEAD_WORD = 'every|ev|each';
// Same words as LEAD_WORD, as a plain list for fuzzy typo suggestion.
export const LEAD_WORDS = ['every', 'ev', 'each'];

// Ordinal words for "every second sunday" (= every other Sunday), "every third monday", etc.
// Numeric ordinals ("every 2nd sunday") are handled separately via a digit+suffix pattern.
// "other" is folded in here too so "every other monday" (Todoist's own phrasing for
// biweekly-on-a-weekday) falls out of the same ordinal machinery for free.
export const ORDINAL_ALIASES = {
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
  return m[1] ? clampRecurrenceCount(m[1]) : ORDINAL_ALIASES[m[2]];
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
  return { rule: { unit: 'week', count: clampRecurrenceCount(m[1]), days }, matchedText: m[0], index: m.index };
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
// "weekday"/"weekdays" themselves, for fuzzy typo suggestion — not part of
// UNIT_ALIASES since they're matched as a fixed literal below, not a unit.
export const WEEKDAY_SHORTCUT_WORDS = ['weekday', 'weekdays'];

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
    if (unit) return { unit, count: clampRecurrenceCount(numericMatch[1]) };
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
 * Thin, named wrapper over parseRecurrenceRule for call sites that are
 * (re)computing Task.recurrenceRule — the cached/derived copy of the parsed
 * rule stored alongside `recurrenceString` (see types/index.js). Named
 * distinctly from parseRecurrenceRule so those call sites read as "recompute
 * the hidden rule field" rather than a generic parse — every place that sets
 * `recurrenceString` on a Task must call this alongside it so the two never
 * drift out of sync.
 * @param {string|null|undefined} recurrenceString
 * @returns {{unit: 'day'|'week'|'month'|'year', count: number, days?: number[]}|null}
 */
export function deriveRecurrenceRule(recurrenceString) {
  return parseRecurrenceRule(recurrenceString);
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
      return { rule: { unit, count: clampRecurrenceCount(numericMatch[1]) }, matchedText: numericMatch[0], index: numericMatch.index };
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
      // A weekday-specific rule ("every Mon, Wed") must advance to the next
      // matching weekday, not blindly jump count*7 days — otherwise "every
      // Mon, Wed" completed on a Monday jumps straight to next Monday
      // instead of the same week's Wednesday.
      if (rule.days && rule.days.length) return nextWeekdayOccurrence(currentDueDate, rule.days, rule.count);
      return addDays(currentDueDate, rule.count * 7);
    case 'month':
      return addMonthsClamped(currentDueDate, rule.count);
    case 'year':
      return addMonthsClamped(currentDueDate, rule.count * 12);
    default:
      return addDays(currentDueDate, 1);
  }
}

/**
 * Next date after `currentDueDate` whose weekday is in `days` (0=Sun..6=Sat).
 * If the next matching weekday falls within the same week (i.e. before
 * wrapping back around to a day <= today's weekday), it's used directly
 * regardless of `weekInterval` — an every-N-weeks-on-certain-days rule still
 * cycles through all its listed days every single week, `weekInterval` only
 * stretches the gap between one full week-cycle and the next. So the interval
 * only applies once we wrap past the end of the current week.
 */
function nextWeekdayOccurrence(currentDueDate, days, weekInterval) {
  const sorted = [...days].sort((a, b) => a - b);
  const currentWeekday = fromISODate(currentDueDate).getDay();
  const nextInWeek = sorted.find((d) => d > currentWeekday);
  if (nextInWeek !== undefined) return addDays(currentDueDate, nextInWeek - currentWeekday);
  const daysUntilWrap = 7 - currentWeekday + sorted[0] + 7 * (Math.max(1, weekInterval) - 1);
  return addDays(currentDueDate, daysUntilWrap);
}

/**
 * Every occurrence date of a recurring task within [rangeStartIso,
 * rangeEndIso] (inclusive), anchored at the task's own `dueDate` (the first/
 * defining occurrence — see Task.recurrenceRule). Used by rebalanceEngine.js
 * to actually place a recurring task on every day (or specific weekday) it
 * repeats, instead of only ever seeing its single current `dueDate` window.
 *
 * We only ever need FUTURE occurrences here (scheduling), never historical
 * reconstruction of past ones — so this always walks forward from
 * `task.dueDate`, same as computeNextDueDate's own contract.
 *
 * Reuses recurrenceExpansion.js's `generateRuleOccurrences` (the same
 * BYDAY-walking date generator CalendarEvent expansion already relies on)
 * rather than reimplementing that math here — see this module's header
 * comment for why these are two distinct recurrence systems (natural-
 * language Task due dates vs. RRULE CalendarEvents) that still share this one
 * piece of date-walking logic. `month`/`year` map to a MONTHLY step (interval
 * = count, or count*12 for year) since neither supports a `days` filter
 * today, matching computeNextDueDate's own year-as-12-months convention.
 *
 * @param {import('../types').Task} task - must have `dueDate` and `recurrenceRule` set; returns [] otherwise.
 * @param {string} rangeStartIso - "YYYY-MM-DD"
 * @param {string} rangeEndIso - "YYYY-MM-DD"
 * @returns {string[]} ISO occurrence dates, ascending, including `task.dueDate` itself if it falls in range.
 */
export function generateTaskOccurrences(task, rangeStartIso, rangeEndIso) {
  const rule = task?.recurrenceRule;
  if (!rule || !task.dueDate) return [];
  if (rangeEndIso < task.dueDate) return []; // task's first occurrence hasn't happened yet within this range

  let freq;
  let interval;
  let byDay = null;
  switch (rule.unit) {
    case 'day':
      freq = 'DAILY';
      interval = rule.count;
      break;
    case 'week':
      freq = 'WEEKLY';
      interval = rule.count;
      byDay = rule.days && rule.days.length ? rule.days : null;
      break;
    case 'month':
      freq = 'MONTHLY';
      interval = rule.count;
      break;
    case 'year':
      freq = 'MONTHLY';
      interval = rule.count * 12;
      break;
    default:
      return [];
  }

  const expansionRule = { freq, interval: Math.max(1, interval), byDay, count: null };
  return generateRuleOccurrences(task.dueDate, expansionRule, rangeStartIso, rangeEndIso);
}

/**
 * Roll a recurring task/descendant's raw `completedDates` forward: prepend
 * the just-closed `occurrenceDate`, then trim anything older than 7 days out
 * into the monthly `completionHistory` aggregate instead of dropping it
 * outright — see types/index.js's Task typedef. Shared by
 * SchedulerContext.completeTask's recurring-parent branch and
 * computeRecurringDescendantUpdate below so the two don't diverge on this
 * bookkeeping.
 *
 * @param {string} occurrenceDate - ISO date of the occurrence being closed out
 * @param {string[]} existingCompletedDates - task's current `completedDates`
 * @param {object} existingCompletionHistory - task's current `completionHistory`
 * @param {string} todayIso - ISO date (YYYY-MM-DD), pre-computed by the caller
 * @returns {{completedDates: string[], completionHistory: object}}
 */
export function computeCompletionHistoryUpdate(
  occurrenceDate,
  existingCompletedDates,
  existingCompletionHistory,
  todayIso
) {
  const sevenDaysAgoIso = addDays(todayIso, -7);
  const keptDates = [];
  const nextHistory = { ...(existingCompletionHistory || {}) };
  for (const d of [occurrenceDate, ...(existingCompletedDates || [])]) {
    if (d >= sevenDaysAgoIso) {
      keptDates.push(d);
    } else {
      const monthKey = d.slice(0, 7); // "YYYY-MM"
      nextHistory[monthKey] = (nextHistory[monthKey] || 0) + 1;
    }
  }
  return { completedDates: keptDates, completionHistory: nextHistory };
}

/**
 * Decide how a single descendant (sub-task) should be updated when its
 * RECURRING ancestor is completed and rolls forward — see
 * SchedulerContext.completeTask's recurring-parent branch, which calls this
 * once per entry in getDescendantIds.
 *
 * A descendant can independently carry its own `isRecurring`/`recurrenceString`
 * /`dueDate` (e.g. via TaskDetailModal's "Apply to all sub-tasks", which copies
 * those fields straight from the parent down onto every sub-task — they're
 * generic Task fields, not parent-only ones, see types/index.js). Two cases:
 *
 *   - Descendant is itself recurring with its own dueDate: advance ITS due
 *     date to its next occurrence the exact same way the parent's is advanced
 *     (including the "base off today, not a stale overdue date" rule), reset
 *     isCompleted to false (it isn't "done", it just rolled forward), reset
 *     remainingHours to its own estimatedHours (schedulable again for the new
 *     occurrence, same as the parent), and record THIS occurrence into its
 *     OWN completedDates/completionHistory the same way the parent branch
 *     records its own — see computeCompletionHistoryUpdate. This mirroring
 *     was added because isBlockTaskCompleted (missedTasks.js) reads a
 *     recurring task's own completedDates to decide whether ITS calendar
 *     block/agenda entry should show as done, independent of whichever task
 *     the user actually clicked complete on — without it, a sub-task
 *     completed via its recurring parent never shows as done anywhere (the
 *     bug this comment used to describe as "intentional").
 *   - Descendant is NOT independently recurring (no isRecurring, or recurring
 *     but with no dueDate of its own): leave it alone entirely. Per
 *     types/index.js's `dueDate` doc comment, an undated sub-task already
 *     borrows its nearest ancestor's dueDate for scheduling urgency, and a
 *     dated-but-non-recurring sub-task's date is just a plain deadline with no
 *     recurrence reason to clear it — nulling it out (the old, buggy
 *     behavior) destroyed real user data for no benefit. isCompleted is left
 *     untouched too: this cascade path only exists to keep a recurring
 *     parent's re-opening from stranding a sub-task in a stale completed
 *     state, which doesn't apply to one that a never completed in the first
 *     place.
 *
 * @param {object} descendant - the sub-task Task object
 * @param {string} todayIso - ISO date (YYYY-MM-DD), pre-computed by the caller
 * @returns {{dueDate: string|null|undefined, isCompleted: boolean, remainingHours: number|undefined,
 *   completedDates: string[]|undefined, completionHistory: object|undefined}} fields to spread onto
 *   the descendant; `dueDate: undefined` means "don't touch it" (mirrored by the other undefined fields).
 */
export function computeRecurringDescendantUpdate(descendant, todayIso) {
  if (descendant.isRecurring && descendant.dueDate) {
    const baseDate = descendant.dueDate < todayIso ? todayIso : descendant.dueDate;
    const { completedDates, completionHistory } = computeCompletionHistoryUpdate(
      descendant.dueDate,
      descendant.completedDates,
      descendant.completionHistory,
      todayIso
    );
    return {
      dueDate: computeNextDueDate(baseDate, descendant.recurrenceString),
      isCompleted: false,
      remainingHours: descendant.estimatedHours,
      completedDates,
      completionHistory,
    };
  }
  return {
    dueDate: undefined,
    isCompleted: descendant.isCompleted,
    remainingHours: undefined,
    completedDates: undefined,
    completionHistory: undefined,
  };
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
  const n = clampRecurrenceCount(count);
  if (unit === 'week' && Array.isArray(days) && days.length > 0) {
    const dayLabels = days.map((d) => WEEKDAY_LABELS[d]).join(', ');
    return `every ${n === 1 ? '' : `${n} `}week${n === 1 ? '' : 's'} on ${dayLabels}`;
  }
  return `every ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A parent's sub-tasks are the steps toward its recurring goal, and a
 * sub-task being made recurring means the goal it belongs to is ongoing too
 * — so parent/sub-task recurrence must always agree. This computes the set
 * of tasks that need updating to restore that invariant across the WHOLE
 * list, given nesting can be up to 2 levels deep (task -> sub-task ->
 * grand-sub-task): if any task in a parent/descendant chain is recurring,
 * every task in that chain should be too.
 *
 * Shared by SchedulerContext's addTask/updateTask (enforced going forward,
 * one small chain at a time) and migrateRecurrenceConsistency.js (the
 * one-time backfill over every existing task at once) — both just need "here
 * are the tasks, tell me what to change", so the walk itself lives here
 * rather than being duplicated in both call sites.
 *
 * Which `recurrenceString` wins when propagating: the nearest recurring
 * relative going UP the chain first (parent's cadence describes the overall
 * goal), falling back to the nearest recurring DESCENDANT if only a
 * descendant is recurring. Not a full "merge all cadences" — there's no
 * single sensible merge of e.g. "every day" (a sub-task) and "every month"
 * (a sibling sub-task) into a parent's own cadence, so the first recurring
 * relative found wins and the rest fall in line with it. Already-consistent
 * tasks (including fully non-recurring chains) are left untouched.
 *
 * `isRecurring: true` is set even on a task with no `dueDate` of its own —
 * consistent with how `isRecurring` is already treated everywhere else in
 * the app (e.g. completeTask, TaskDetailModal's commitChanges), it simply
 * has no effect until a due date exists.
 *
 * @param {import('../types').Task[]} tasks
 * @returns {Map<string, {isRecurring: boolean, recurrenceString: string, recurrenceRule: object|null}>}
 *   keyed by task id — only entries that actually need to change are included.
 */
export function computeRecurrenceSyncUpdates(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenByParentId = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const siblings = childrenByParentId.get(t.parentId) || [];
    siblings.push(t);
    childrenByParentId.set(t.parentId, siblings);
  }

  /** Walk a task's ancestor chain (parent, grandparent, ...) as an array, nearest first. Guards against a corrupted-backup parentId cycle. */
  function getAncestors(task) {
    const ancestors = [];
    const visited = new Set([task.id]);
    let current = task;
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || visited.has(parent.id)) break;
      ancestors.push(parent);
      visited.add(parent.id);
      current = parent;
    }
    return ancestors;
  }

  /** Walk a task's descendants (children, grandchildren, ...), nearest first, breadth-first. */
  function getDescendants(task) {
    const descendants = [];
    const visited = new Set([task.id]);
    const queue = [...(childrenByParentId.get(task.id) || [])];
    while (queue.length > 0) {
      const t = queue.shift();
      if (visited.has(t.id)) continue;
      visited.add(t.id);
      descendants.push(t);
      queue.push(...(childrenByParentId.get(t.id) || []));
    }
    return descendants;
  }

  const updates = new Map();
  for (const task of tasks) {
    if (task.isRecurring) continue; // already recurring — nothing to propagate onto it

    // Nearest recurring ancestor wins over a recurring descendant (see doc comment above).
    const recurringAncestor = getAncestors(task).find((t) => t.isRecurring);
    const recurringSource = recurringAncestor || getDescendants(task).find((t) => t.isRecurring);
    if (!recurringSource) continue;

    updates.set(task.id, {
      isRecurring: true,
      recurrenceString: recurringSource.recurrenceString,
      recurrenceRule: deriveRecurrenceRule(recurringSource.recurrenceString),
    });
  }
  return updates;
}

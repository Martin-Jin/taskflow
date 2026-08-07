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
 * The first date on/after `anchorDate` that actually satisfies
 * `recurrenceString` — for a weekday-specific rule ("every Wed, Sun") that
 * means the nearest matching weekday, same-week included; every other rule
 * shape (plain day/week/month/year interval, no `days` filter) has no
 * per-date constraint beyond "is a valid date", so the anchor itself always
 * matches. Falls back to `anchorDate` unchanged if the string isn't
 * confidently parseable, mirroring computeNextDueDate's own fallback.
 *
 * Used to give a newly-recurrence-synced task (see
 * computeRecurrenceSyncUpdates) a `dueDate` that's actually valid for the
 * rule it just inherited, rather than blindly copying the recurring
 * relative's own `dueDate` — a sub-task and its parent can each have been
 * created on different dates, so "same calendar date" isn't guaranteed to
 * land on one of the rule's matching weekdays.
 *
 * @param {string} anchorDate - ISO date (YYYY-MM-DD) to search forward from
 * @param {string|null|undefined} recurrenceString
 * @returns {string} ISO date
 */
export function computeFirstMatchingDueDate(anchorDate, recurrenceString) {
  const rule = parseRecurrenceRule(recurrenceString);
  if (!rule || rule.unit !== 'week' || !rule.days || !rule.days.length) return anchorDate;
  const currentWeekday = fromISODate(anchorDate).getDay();
  if (rule.days.includes(currentWeekday)) return anchorDate;
  return nextWeekdayOccurrence(anchorDate, rule.days, rule.count);
}

/**
 * The date a recurring task's CURRENT occurrence should actually be shown as
 * due on, honoring a single-occurrence `overrides` move (see
 * computeRecurringRescheduleUpdate's off-pattern branch and Task.overrides in
 * types/index.js).
 *
 * `task.dueDate` deliberately stays pinned to the series' own pattern anchor
 * when an occurrence is moved off-pattern (e.g. "every Mon/Wed/Fri" moved
 * this week onto a Thursday) — re-anchoring the whole series onto an
 * off-pattern date would change which weekdays every FUTURE occurrence lands
 * on, which is not what a one-off move means. But that split leaves every
 * plain `task.dueDate` reader (TaskDetailModal's due-date field, its
 * "Scheduled" block list) displaying the stale pre-move date, even though the
 * scheduler itself (expandTaskOccurrences/rebalanceEngine) already places the
 * occurrence's block on the moved-to date. This is the one place both need to
 * agree: the override's `date`, when present and not `deleted`, IS the
 * occurrence's real due date for display purposes; `task.dueDate` remains
 * unchanged as the series anchor underneath it.
 *
 * A no-op (returns `task.dueDate` unchanged) for a non-recurring task, one
 * with no override recorded against its current due date, or one whose
 * override is a `deleted` entry (shouldn't happen for the task's OWN current
 * occurrence — deleting the very occurrence a task is currently sitting on
 * would leave it with no due date at all — but falls back safely rather than
 * surfacing a dropped date if it ever does).
 *
 * @param {import('../types').Task} task
 * @returns {string|null} ISO date, or null if the task has no due date at all.
 */
export function resolveCurrentOccurrenceDueDate(task) {
  if (!task?.isRecurring || !task.dueDate || !task.overrides) return task?.dueDate ?? null;
  const override = task.overrides[task.dueDate];
  if (!override || override.deleted) return task.dueDate;
  return override.date || task.dueDate;
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
 * Like generateTaskOccurrences, but consults `task.overrides` the same way
 * recurrenceExpansion.js's expandRecurringEvent consults a CalendarEvent's —
 * see Task.overrides in types/index.js. Each returned entry's `date` is
 * where the occurrence should actually be scheduled/displayed (the
 * override's moved-to date if one exists, otherwise the plain pattern
 * date), while `originalDate` stays the untouched pattern date the override
 * is keyed by — callers (rebalanceEngine.js's expandRecurringTasks) key
 * virtual occurrence ids off `originalDate` so `spentHoursByTaskDate`/
 * completedDates lookups keyed by the pattern date keep working after a
 * move, exactly like CalendarEvent's `${masterId}::${originalDate}` virtual
 * ids do.
 *
 * A `deleted: true` override drops that occurrence entirely. A moved
 * occurrence whose ORIGINAL date wouldn't naturally fall in
 * [rangeStartIso, rangeEndIso], but whose overridden date does (or vice
 * versa), is still included/excluded correctly — checked in both
 * directions, same as expandRecurringEvent.
 *
 * Backward compatible: a task with no `overrides` (the pre-existing case)
 * behaves identically to generateTaskOccurrences.
 *
 * @param {import('../types').Task} task
 * @param {string} rangeStartIso - "YYYY-MM-DD"
 * @param {string} rangeEndIso - "YYYY-MM-DD"
 * @returns {{originalDate: string, date: string}[]} ascending by `date`.
 */
export function expandTaskOccurrences(task, rangeStartIso, rangeEndIso) {
  const overrides = task?.overrides || {};
  const patternDates = generateTaskOccurrences(task, rangeStartIso, rangeEndIso);

  // Occurrences whose pattern date isn't naturally in range, but whose
  // override moved them INTO it — mirrors expandRecurringEvent's movedInDates.
  const movedInDates = Object.keys(overrides).filter((originalDate) => {
    if (patternDates.includes(originalDate)) return false;
    const movedTo = overrides[originalDate]?.date;
    return movedTo && movedTo >= rangeStartIso && movedTo <= rangeEndIso;
  });

  return [...patternDates, ...movedInDates]
    .map((originalDate) => ({ originalDate, date: overrides[originalDate]?.date || originalDate }))
    .filter((occ) => !overrides[occ.originalDate]?.deleted)
    // A pattern date whose override moved it OUT of [rangeStartIso, rangeEndIso]
    // must not surface here — patternDates only guarantees the ORIGINAL date is
    // in range, not the resolved one.
    .filter((occ) => occ.date >= rangeStartIso && occ.date <= rangeEndIso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Decides how a task's `dueDate`/`completedDates` should actually land when
 * `updateTask` applies a partial update to it — see
 * SchedulerContext.updateTask, which calls this once per edited task (the
 * currently-recurring one; NOT its descendants — those stay untouched by a
 * plain due-date edit, same as any other independently-editable field).
 * Two independent recurring-only guards, both no-ops for a non-recurring
 * task or an update that doesn't touch `dueDate`:
 *
 *   - Never let `dueDate` end up empty. A recurring task's due date is what
 *     it advances from each occurrence (see completeTask/computeNextDueDate)
 *     — clearing it would leave nothing to roll forward from. The task's own
 *     UI (TaskDetailModal/AddTaskModal) already blocks this at the form
 *     level, but any other caller (AI plan assistant, Todoist import, a
 *     future feature) goes through this same guard, falling back to the
 *     task's current due date rather than silently turning `isRecurring`
 *     off. Doesn't apply to a recurring task that already had no due date
 *     (a valid, pre-existing state — see utils/recurrenceState.js's computeRecurringDescendantState's
 *     doc comment) since there's nothing being "cleared" in that case.
 *
 *   - Drop any `completedDates` entries on/after the new due date. Recurring
 *     tasks never set `isCompleted` true (see completeTask) — "done for now"
 *     is tracked per-occurrence in `completedDates` instead (see
 *     isCompletedForCurrentOccurrence). Moving the due date back onto (or
 *     before) an occurrence already recorded as done is the user
 *     reopening/rescheduling it, not relabeling a done one — the same intent
 *     the plain `isCompleted` reset just above this call's site captures for
 *     a non-recurring task, which never applies to a recurring one since its
 *     `isCompleted` is never true to begin with. Entries strictly before the
 *     new due date are left alone: those are genuinely earlier occurrences
 *     that stay closed out.
 *
 * A third case, specific to a WEEKLY rule pinned to particular weekdays (e.g.
 * "every week on Mon/Wed/Fri"): if the new due date falls OFF that weekday
 * set (e.g. onto a Thursday), re-anchoring the whole series onto that date
 * would be wrong — `generateTaskOccurrences` filters every future date by the
 * same weekday set, so an off-pattern DTSTART just makes the series generate
 * nothing near it (see this repo's rebalanceEngine.js expandRecurringTasks:
 * this is what silently drops the occurrence from the scheduler and zeroes
 * its remaining hours). Instead, the move is recorded as a one-occurrence
 * `overrides` entry (see types/index.js's Task.overrides, same convention as
 * CalendarEvent.overrides) keyed by the task's current `dueDate` — the
 * pattern's own anchor/most-recent occurrence stays untouched, so the rest
 * of the series keeps landing on Mon/Wed/Fri while this one occurrence shows
 * up on Thursday instead (see utils/recurrence.js's expandTaskOccurrences).
 * day/month/year rules (and a plain weekly rule with no specific `days`) have
 * no weekday set to fall off of — every manually-picked date is legitimate
 * there, so this case doesn't apply and updateTask's planSeriesReanchor
 * (SchedulerContext.jsx) re-anchors the series onto it instead.
 *
 * @param {object} task - the task's CURRENT (pre-update) fields
 * @param {object} updates - the partial update being applied
 * @returns {{dueDate?: string, completedDates?: string[], overrides?: object}} fields to merge
 *   on top of `updates` — only the keys that actually need overriding.
 */
export function computeRecurringRescheduleUpdate(task, updates) {
  if (!task.isRecurring || !('dueDate' in updates)) return {};

  const result = {};
  const nextDueDate = updates.dueDate || task.dueDate;
  if (!updates.dueDate && task.dueDate) {
    result.dueDate = task.dueDate;
  }
  if (nextDueDate && nextDueDate !== task.dueDate) {
    const rule = task.recurrenceRule || deriveRecurrenceRule(task.recurrenceString);
    // "Off-pattern" only means something for a weekly rule pinned to specific
    // weekdays (e.g. Mon/Wed/Fri) — there, a manual move onto a day outside
    // that set is a genuine single-occurrence exception, since re-anchoring
    // would change which weekdays the whole series lands on. day/month/year
    // rules (and a plain weekly rule with no `days`) have no weekday filter
    // of their own to violate: EVERY new date is "off" the old anchor-relative
    // schedule by construction, so treating that as an exception here would
    // revert any manual due-date edit back to the old date instead of letting
    // updateTask's planSeriesReanchor (SchedulerContext.jsx) re-anchor the
    // series onto the date the user actually picked.
    const isOffPattern =
      rule &&
      rule.unit === 'week' &&
      rule.days &&
      rule.days.length > 0 &&
      task.dueDate &&
      generateTaskOccurrences(task, nextDueDate, nextDueDate).length === 0;
    if (isOffPattern) {
      // Keep the series anchored where it was; record this single move as
      // an override instead, and leave completedDates alone (nothing about
      // the pattern's own occurrences changed).
      result.dueDate = task.dueDate;
      result.overrides = { ...task.overrides, [task.dueDate]: { date: nextDueDate } };
    } else {
      result.completedDates = (updates.completedDates ?? task.completedDates ?? []).filter((d) => d < nextDueDate);
    }
  }
  return result;
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
 * `dueDate` is synced alongside recurrence: a task picking up a new
 * recurrence rule this way also picks up the recurring relative's `dueDate`
 * as its own anchor (snapped forward to the first date that actually
 * matches the rule — see computeFirstMatchingDueDate — since the two tasks
 * can have been created on different calendar dates, and a weekday-specific
 * rule like "every Wed, Sun" needs an anchor that's actually a Wed or Sun).
 * Only set when the recurring relative actually has a dueDate of its own;
 * a sub-task's dueDate is otherwise left untouched (per types/index.js, an
 * undated sub-task already borrows its nearest ancestor's dueDate for
 * scheduling urgency, so there's nothing to change).
 *
 * `isRecurring: true` is set even on a task with no `dueDate` of its own —
 * consistent with how `isRecurring` is already treated everywhere else in
 * the app (e.g. completeTask, TaskDetailModal's commitChanges), it simply
 * has no effect until a due date exists.
 *
 * @param {import('../types').Task[]} tasks
 * @returns {Map<string, {isRecurring: boolean, recurrenceString: string, recurrenceRule: object|null, dueDate?: string, isCompleted?: boolean, remainingHours?: number}>}
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

    const update = {
      isRecurring: true,
      recurrenceString: recurringSource.recurrenceString,
      recurrenceRule: deriveRecurrenceRule(recurringSource.recurrenceString),
    };
    if (recurringSource.dueDate) {
      update.dueDate = computeFirstMatchingDueDate(recurringSource.dueDate, recurringSource.recurrenceString);
    }
    // A task becoming recurring for the first time is starting a fresh
    // occurrence, not resuming one already in progress — reset a stale
    // remainingHours left over from its previous non-recurring life (most
    // commonly 0 from a task that was `isCompleted: true` before it/its
    // parent became recurring, e.g. migrateSubtasksToTasks.js's embedded
    // `sub.isCompleted` → `remainingHours: 0`; that reset never happens
    // because this path isn't completeTask's occurrence-advance, it's a
    // one-time recurring/non-recurring conversion). Also clears the
    // `isCompleted` flag a plain (non-recurring) task may still be
    // carrying — a recurring task tracks "done for now" via
    // `completedDates` instead (see isCompletedForCurrentOccurrence), never
    // via `isCompleted`.
    if (task.isCompleted || task.remainingHours <= 0) {
      update.isCompleted = false;
      update.remainingHours = task.estimatedHours;
    }
    updates.set(task.id, update);
  }
  return updates;
}

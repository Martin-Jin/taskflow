/**
 * ============================================================================
 * DATE PARSE
 * ============================================================================
 * Hand-rolled matcher for the free-text due-date phrases a user might type
 * inline in a task title — relative words ("tomorrow", "next monday", "in 3
 * days"), and absolute dates in whatever shape they naturally get typed:
 * numeric ("24/03/2025", "2/3/25", "2025-03-24"), or written out ("24 March",
 * "March 24th", "24 Mar 2025"). Deliberately scoped small — no full date-range
 * or hybrid recurrence-date parsing (e.g. "every other Tuesday starting in
 * March") — matching the project's existing no-external-date-library
 * approach (see dateUtils.js).
 *
 * Rather than hard-coding a regex per phrasing, each *kind* of phrase (small
 * word-numbers, weekday names, month names, numeric dates) is driven off a
 * small table so new aliases/abbreviations extend the table instead of
 * duplicating a pattern. Matchers are tried in most-specific-first order
 * and the first hit wins.
 * ============================================================================
 */

import { toISODate, fromISODate, addDays, dayOfWeek } from './dateUtils';

const WEEKDAY_ALIASES = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Full month name -> index (0-11); 3-letter abbreviations are derived below rather than re-typed. */
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const MONTH_ALIASES = MONTH_NAMES.reduce((acc, name, i) => {
  acc[name] = i;
  acc[name.slice(0, 3)] = i;
  return acc;
}, {});
// "sept" is a common non-3-letter abbreviation worth covering explicitly.
MONTH_ALIASES.sept = 8;

/** Small word-numbers people type instead of digits: "in a week", "in a couple of days", "in a few months". */
const WORD_NUMBERS = {
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

const UNIT_ALIASES = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  fortnight: 'fortnight',
  fortnights: 'fortnight',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};

function alternation(map) {
  return Object.keys(map)
    .sort((a, b) => b.length - a.length) // longest-first so "thurs" isn't shadowed by "thu"
    .join('|');
}

const WEEKDAY_PATTERN = alternation(WEEKDAY_ALIASES);
const MONTH_PATTERN = alternation(MONTH_ALIASES);
const WORD_NUMBER_PATTERN = alternation(WORD_NUMBERS);
const UNIT_PATTERN = alternation(UNIT_ALIASES);

/** "a"/"two"/"5" -> integer count. */
function parseCount(raw) {
  if (raw == null) return 1;
  const digits = Number(raw);
  if (!Number.isNaN(digits)) return digits;
  return WORD_NUMBERS[raw.toLowerCase()] ?? 1;
}

/** Nearest ISO date strictly after `fromIso` that falls on `targetDow` (0=Sun..6=Sat). */
function nextWeekdayFrom(fromIso, targetDow) {
  const currentDow = dayOfWeek(fromIso);
  let delta = targetDow - currentDow;
  if (delta <= 0) delta += 7;
  return addDays(fromIso, delta);
}

/** Nearest ISO date on/after `fromIso` that falls on `targetDow` — unlike nextWeekdayFrom, today itself counts. */
function thisWeekdayFrom(fromIso, targetDow) {
  const currentDow = dayOfWeek(fromIso);
  const delta = (targetDow - currentDow + 7) % 7;
  return addDays(fromIso, delta);
}

/** Last calendar day of `year`/`monthIndex` (0-11), e.g. lastDayOfMonth(2025, 1) === 28. */
function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Add N whole calendar months, clamping the day-of-month so e.g. Jan 31 + 1 month lands on Feb 28/29, not rolling into March. */
function addMonthsClamped(iso, n) {
  const date = fromISODate(iso);
  const targetMonthIndex = date.getMonth() + n;
  const year = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const monthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(date.getDate(), lastDayOfMonth(year, monthIndex));
  return toISODate(new Date(year, monthIndex, day));
}

/** Add N whole calendar years, clamping Feb 29 -> Feb 28 on non-leap target years. */
function addYearsClamped(iso, n) {
  return addMonthsClamped(iso, n * 12);
}

/**
 * Build an ISO date from a month/day (and optional 2-or-4-digit year) the
 * way a person means it: if no year was typed, use the next occurrence of
 * that month/day on or after today (so "March 24" typed in July resolves to
 * next year, not five months in the past).
 */
function resolveMonthDay(monthIndex, day, yearRaw, todayIso) {
  let year;
  if (yearRaw != null && yearRaw !== '') {
    year = Number(yearRaw);
    if (yearRaw.length <= 2) year += 2000;
  } else {
    const today = fromISODate(todayIso);
    year = today.getFullYear();
    const candidate = toISODate(new Date(year, monthIndex, day));
    if (candidate < todayIso) year += 1;
  }
  return toISODate(new Date(year, monthIndex, day));
}

/**
 * Resolve a numeric day1/day2 pair (as typed, e.g. "24/03" or "2/3") into a
 * month/day, disambiguating locale-ambiguous input: if one side can only be
 * a day (>12), that side wins as the day regardless of position; otherwise
 * default to day-first (24/03/2025 style) since that's the convention most
 * of this app's users type in.
 */
function resolveDayMonth(a, b) {
  if (a > 12 && b <= 12) return { day: a, month: b };
  if (b > 12 && a <= 12) return { day: b, month: a };
  return { day: a, month: b }; // ambiguous — default day-first
}

/**
 * Find a due-date phrase inside a longer piece of text.
 * @param {string} text
 * @param {Date} [referenceDate] - defaults to now; injectable for tests.
 * @returns {{iso: string, matchedText: string, index: number}|null}
 */
export function findDuePhrase(text, referenceDate = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();
  const todayIso = toISODate(referenceDate);

  let m = s.match(/\btoday\b/);
  if (m) return { iso: todayIso, matchedText: m[0], index: m.index };

  m = s.match(/\btomorrow\b/);
  if (m) return { iso: addDays(todayIso, 1), matchedText: m[0], index: m.index };

  m = s.match(/\byesterday\b/);
  if (m) return { iso: addDays(todayIso, -1), matchedText: m[0], index: m.index };

  // ISO "2025-03-24" — check before other numeric formats since it's unambiguous.
  m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const iso = toISODate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return { iso, matchedText: m[0], index: m.index };
  }

  // "end of month" / "end of the month" / "end of this month"
  m = s.match(/\bend of(?: this| the)? month\b/);
  if (m) {
    const today = fromISODate(todayIso);
    const iso = toISODate(new Date(today.getFullYear(), today.getMonth(), lastDayOfMonth(today.getFullYear(), today.getMonth())));
    return { iso, matchedText: m[0], index: m.index };
  }

  // "end of week" / "end of the week" -> upcoming Sunday.
  m = s.match(/\bend of(?: this| the)? week\b/);
  if (m) return { iso: thisWeekdayFrom(todayIso, 0), matchedText: m[0], index: m.index };

  // "this weekend" / "next weekend" -> upcoming Saturday.
  m = s.match(/\b(?:this|next) weekend\b/);
  if (m) {
    const sat = thisWeekdayFrom(todayIso, 6);
    return { iso: sat, matchedText: m[0], index: m.index };
  }

  // "next month" -> same day-of-month, one calendar month out.
  m = s.match(/\bnext month\b/);
  if (m) return { iso: addMonthsClamped(todayIso, 1), matchedText: m[0], index: m.index };

  // "next year" -> same month/day, one calendar year out.
  m = s.match(/\bnext year\b/);
  if (m) return { iso: addYearsClamped(todayIso, 1), matchedText: m[0], index: m.index };

  m = s.match(/\bnext week\b/);
  if (m) return { iso: addDays(todayIso, 7), matchedText: m[0], index: m.index };

  // "in <count> <unit>(s)" / "<count> <unit>(s) from now" — count may be a digit or a word
  // ("a", "few", "couple"), optionally followed by "of" ("a couple of weeks").
  const countGroup = `(?:(\\d+)|(${WORD_NUMBER_PATTERN}))`;
  m = s.match(new RegExp(`\\bin\\s+${countGroup}\\s+(?:of\\s+)?(${UNIT_PATTERN})s?\\b`));
  if (!m) m = s.match(new RegExp(`\\b${countGroup}\\s+(?:of\\s+)?(${UNIT_PATTERN})s?\\s+from now\\b`));
  if (m) {
    const count = parseCount(m[1] || m[2]);
    const unit = UNIT_ALIASES[m[3]];
    let iso;
    if (unit === 'day') iso = addDays(todayIso, count);
    else if (unit === 'week') iso = addDays(todayIso, count * 7);
    else if (unit === 'fortnight') iso = addDays(todayIso, count * 14);
    else if (unit === 'month') iso = addMonthsClamped(todayIso, count);
    else iso = addYearsClamped(todayIso, count);
    return { iso, matchedText: m[0], index: m.index };
  }

  // "a fortnight" bare (no "in"/"from now") is common enough on its own.
  m = s.match(/\ba fortnight\b/);
  if (m) return { iso: addDays(todayIso, 14), matchedText: m[0], index: m.index };

  // Written-out month dates: "24 March", "24th of March 2025", "March 24th", "Mar 24, 2025".
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?,?\\s*(\\d{4}|\\d{2})?\\b`));
  if (m && Number(m[1]) <= 31) {
    const iso = resolveMonthDay(MONTH_ALIASES[m[2]], Number(m[1]), m[3], todayIso);
    return { iso, matchedText: m[0], index: m.index };
  }
  m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4}|\\d{2})?\\b`));
  if (m && Number(m[2]) <= 31) {
    const iso = resolveMonthDay(MONTH_ALIASES[m[1]], Number(m[2]), m[3], todayIso);
    return { iso, matchedText: m[0], index: m.index };
  }

  // Numeric dates: "24/03/2025", "2/3/25", "24-03-2025", "24.03". Year optional.
  m = s.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a <= 31 && b <= 31 && (a <= 12 || b <= 12)) {
      const { day, month } = resolveDayMonth(a, b);
      if (month >= 1 && month <= 12 && day >= 1 && day <= lastDayOfMonth(2000, month - 1)) {
        const iso = resolveMonthDay(month - 1, day, m[3], todayIso);
        return { iso, matchedText: m[0], index: m.index };
      }
    }
  }

  // "the 24th" (of this month, or next month if that day already passed).
  m = s.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      const today = fromISODate(todayIso);
      let year = today.getFullYear();
      let monthIndex = today.getMonth();
      if (day <= lastDayOfMonth(year, monthIndex)) {
        let candidate = toISODate(new Date(year, monthIndex, day));
        if (candidate < todayIso) {
          monthIndex += 1;
          if (monthIndex > 11) {
            monthIndex = 0;
            year += 1;
          }
          if (day <= lastDayOfMonth(year, monthIndex)) candidate = toISODate(new Date(year, monthIndex, day));
        }
        return { iso: candidate, matchedText: m[0], index: m.index };
      }
    }
  }

  m = s.match(new RegExp(`\\bnext\\s+(${WEEKDAY_PATTERN})\\b`));
  if (m) {
    const dow = WEEKDAY_ALIASES[m[1]];
    return { iso: nextWeekdayFrom(todayIso, dow), matchedText: m[0], index: m.index };
  }

  // "this monday" -> nearest occurrence including today, unlike bare/​"next" which always look forward past today.
  m = s.match(new RegExp(`\\bthis\\s+(${WEEKDAY_PATTERN})\\b`));
  if (m) {
    const dow = WEEKDAY_ALIASES[m[1]];
    return { iso: thisWeekdayFrom(todayIso, dow), matchedText: m[0], index: m.index };
  }

  // A bare weekday mention ("sat", "monday") normally means "the next
  // occurrence of that day" as a one-off due date — EXCEPT right after a
  // recurrence lead word ("every sat", "each monday"), where it's part of
  // a recurrence phrase instead (see recurrence.js's findWeekdayRecurrenceSpan,
  // which handles multi-day spans like "every sat and every sun"). Without
  // this guard, this due-date detector — which runs before the recurrence
  // detector in smartParse.js's pipeline — would grab just the first "sat"
  // out of that phrase as a due date, leaving recurrence to see only
  // "every sun" and silently drop Saturday from the rule.
  const bareWeekdayRe = new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, 'g');
  for (const bareMatch of s.matchAll(bareWeekdayRe)) {
    const before = s.slice(0, bareMatch.index);
    if (/(?:every|ev|each)!?\s+$/.test(before)) continue;
    const dow = WEEKDAY_ALIASES[bareMatch[1]];
    return { iso: nextWeekdayFrom(todayIso, dow), matchedText: bareMatch[0], index: bareMatch.index };
  }

  return null;
}

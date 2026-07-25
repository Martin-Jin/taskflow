/**
 * ============================================================================
 * DATE PARSE
 * ============================================================================
 * Small hand-rolled matcher for the common Todoist-style relative-date
 * phrases a user might type inline in a task title ("tomorrow", "next
 * monday", "in 3 days"...). Deliberately scoped small — no full date-range
 * or hybrid recurrence-date parsing (e.g. "every other Tuesday starting in
 * March") — matching the project's existing no-external-date-library
 * approach (see dateUtils.js).
 * ============================================================================
 */

import { toISODate, addDays, dayOfWeek } from './dateUtils';

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

function weekdayPattern() {
  return Object.keys(WEEKDAY_ALIASES).join('|');
}

/** Nearest ISO date strictly after `fromIso` that falls on `targetDow` (0=Sun..6=Sat). */
function nextWeekdayFrom(fromIso, targetDow) {
  const currentDow = dayOfWeek(fromIso);
  let delta = targetDow - currentDow;
  if (delta <= 0) delta += 7;
  return addDays(fromIso, delta);
}

/**
 * Find a relative-due-date phrase inside a longer piece of text.
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

  m = s.match(/\bin\s+(\d+)\s+days?\b/);
  if (m) return { iso: addDays(todayIso, Number(m[1])), matchedText: m[0], index: m.index };

  m = s.match(/\bnext week\b/);
  if (m) return { iso: addDays(todayIso, 7), matchedText: m[0], index: m.index };

  m = s.match(new RegExp(`\\bnext\\s+(${weekdayPattern()})\\b`));
  if (m) {
    const dow = WEEKDAY_ALIASES[m[1]];
    return { iso: nextWeekdayFrom(todayIso, dow), matchedText: m[0], index: m.index };
  }

  m = s.match(new RegExp(`\\b(${weekdayPattern()})\\b`));
  if (m) {
    const dow = WEEKDAY_ALIASES[m[1]];
    return { iso: nextWeekdayFrom(todayIso, dow), matchedText: m[0], index: m.index };
  }

  return null;
}

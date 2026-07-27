/**
 * ============================================================================
 * RECURRENCE EXPANSION (calendar events)
 * ============================================================================
 * Expands a single stored recurring CalendarEvent (the "master" record, whose
 * `date`/`startTime`/`endTime` describe DTSTART — the FIRST occurrence) into
 * the set of virtual per-day instances that should be drawn for a given
 * visible date range. This is display-only: expansion never mutates or
 * persists anything, and the virtual instances it returns are never written
 * back to state — the whole point of storing a recurrence as one RRULE
 * string plus an `overrides` map is to avoid "100 duplicate events" for
 * something that just repeats.
 *
 * This is a distinct module from `recurrence.js`, which is an unrelated
 * natural-language parser for TASK due-date recurrence ("every 2 weeks") —
 * that module has nothing to do with RRULE strings or CalendarEvents.
 *
 * Supported RRULE subset (deliberately minimal — enough for common Google
 * Calendar events and simple Taskflow-created ones):
 *   - FREQ=DAILY|WEEKLY|MONTHLY (required; anything else is treated as
 *     unparseable)
 *   - INTERVAL=n (optional, default 1)
 *   - BYDAY=MO,TU,... (optional, WEEKLY only — specific weekdays per week)
 *   - COUNT=n (optional, total occurrences inclusive of DTSTART)
 *   - UNTIL=YYYYMMDD or YYYYMMDDTHHMMSSZ (optional, inclusive last date;
 *     only the date portion matters since occurrences here are day-granular)
 * Explicitly NOT supported (out of scope for this subset): BYMONTHDAY,
 * BYSETPOS, BYMONTH, BYWEEKNO, BYHOUR/MINUTE/SECOND, WKST (weeks are always
 * treated as Sun-start, matching dateUtils' dayOfWeek convention), EXDATE,
 * RDATE, SECONDLY/MINUTELY/HOURLY frequencies, and YEARLY. MONTHLY always
 * recurs on DTSTART's own day-of-month (clamped into shorter months, e.g.
 * Jan 31 -> Feb 28), never a "3rd Tuesday"-style rule.
 * ============================================================================
 */

import { addDays, dayOfWeek, diffDays } from './dateUtils';

const DAY_CODE_TO_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Safety valve for a malformed rule with no COUNT/UNTIL and a huge range, or
// a COUNT far larger than any real UI would set — not a spec requirement,
// just a guard against a runaway loop. ~2 years of daily occurrences.
const MAX_OCCURRENCES = 730;

/**
 * Parse a bare RRULE parameter string (semicolon-separated KEY=VALUE pairs,
 * no leading "RRULE:" prefix — callers strip that before storing) into a
 * plain object. Returns null if FREQ is missing or isn't one of the
 * supported values, since that's the one field this module can't operate
 * without.
 * @param {string} ruleStr - e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"
 * @returns {{freq: 'DAILY'|'WEEKLY'|'MONTHLY', interval: number, byDay: number[]|null, count: number|null, until: string|null}|null}
 */
export function parseRRule(ruleStr) {
  if (!ruleStr || typeof ruleStr !== 'string') return null;
  const parts = {};
  for (const pair of ruleStr.split(';')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined) continue;
    parts[key.trim().toUpperCase()] = value.trim();
  }

  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;

  const interval = parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10) || 1) : 1;

  const byDay = parts.BYDAY
    ? parts.BYDAY.split(',')
        .map((d) => DAY_CODE_TO_INDEX[d.trim().toUpperCase()])
        .filter((d) => d !== undefined)
    : null;

  const count = parts.COUNT ? Math.max(1, parseInt(parts.COUNT, 10) || 0) || null : null;

  let until = null;
  if (parts.UNTIL) {
    // UNTIL is "YYYYMMDDTHHMMSSZ" or "YYYYMMDD" — strip everything but
    // digits and take the date portion, since occurrences here are
    // day-granular (no need to compare the time-of-day component).
    const digits = parts.UNTIL.replace(/[^0-9]/g, '').slice(0, 8);
    if (digits.length === 8) {
      until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }

  return { freq, interval, byDay: byDay && byDay.length ? byDay : null, count, until };
}

/** Add N months to an ISO date, clamping the day-of-month if it overflows the target month (e.g. Jan 31 + 1 -> Feb 28). */
function addMonthsSameDay(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1 + n, 1);
  const lastDayOfTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDayOfTargetMonth));
  const pad = (v) => String(v).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

/** Whole-month difference between two ISO dates (b's month - a's month, ignoring day-of-month). */
function monthsBetween(isoA, isoB) {
  const [ya, ma] = isoA.split('-').map(Number);
  const [yb, mb] = isoB.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/**
 * Estimate the smallest 0-based occurrence index (counted from DTSTART)
 * whose date is likely at or just before `targetIso`, for a simple
 * fixed-step recurrence (DAILY, WEEKLY-without-BYDAY, or MONTHLY). Used only
 * for open-ended rules (no COUNT) so expansion doesn't have to walk every
 * single occurrence from DTSTART just to reach a rangeStart that might be
 * years later — a long-lived recurring Google Calendar meeting is the common
 * case this matters for. The -1 is deliberate slack (month-length variance
 * means this estimate can be off by roughly one step) — the caller walks
 * forward from here until it actually reaches the target, so undershooting
 * by a step or two just means a couple of extra harmless iterations.
 */
function estimateStartIndex(dtstartIso, freq, interval, targetIso) {
  if (targetIso <= dtstartIso) return 0;
  if (freq === 'DAILY') return Math.max(0, Math.floor(diffDays(dtstartIso, targetIso) / interval) - 1);
  if (freq === 'WEEKLY') return Math.max(0, Math.floor(diffDays(dtstartIso, targetIso) / (interval * 7)) - 1);
  return Math.max(0, Math.floor(monthsBetween(dtstartIso, targetIso) / interval) - 1); // MONTHLY
}

/**
 * Generate WEEKLY+BYDAY occurrence dates. Weeks are counted Sun-start from
 * the week containing DTSTART (this app has no WKST support — see module
 * doc), stepping `interval` weeks at a time; within each qualifying week,
 * every BYDAY match is an occurrence (except in DTSTART's own week, where
 * matches before DTSTART itself don't count — occurrences never precede
 * DTSTART).
 */
function generateWeeklyByDayDates(dtstartIso, interval, byDay, count, hardStop, rangeStartIso) {
  const dtstartDow = dayOfWeek(dtstartIso);
  const week0Start = addDays(dtstartIso, -dtstartDow);
  const sortedByDay = [...byDay].sort((a, b) => a - b);
  const dates = [];

  if (count) {
    // COUNT bounds this walk itself, so starting from DTSTART's own week is
    // always safe regardless of how far away rangeStart/hardStop are.
    let weekStart = week0Start;
    while (dates.length < count && dates.length < MAX_OCCURRENCES) {
      for (const dow of sortedByDay) {
        const candidate = addDays(weekStart, dow);
        if (candidate < dtstartIso) continue;
        if (candidate > hardStop) return dates;
        dates.push(candidate);
        if (dates.length >= count) return dates;
      }
      weekStart = addDays(weekStart, interval * 7);
      if (weekStart > hardStop) return dates;
    }
    return dates;
  }

  // Open-ended: jump the week cursor close to rangeStart's week instead of
  // walking every interval-week from DTSTART's week (see estimateStartIndex).
  const weeksToRangeStart = Math.max(0, Math.floor(diffDays(week0Start, rangeStartIso) / (interval * 7)) - 1);
  let weekStart = addDays(week0Start, weeksToRangeStart * interval * 7);
  while (dates.length < MAX_OCCURRENCES) {
    if (weekStart > hardStop) break;
    for (const dow of sortedByDay) {
      const candidate = addDays(weekStart, dow);
      if (candidate < dtstartIso || candidate < rangeStartIso) continue;
      if (candidate > hardStop) return dates;
      dates.push(candidate);
    }
    weekStart = addDays(weekStart, interval * 7);
  }
  return dates;
}

/**
 * Generate all occurrence dates for `rule` that fall within
 * [rangeStartIso, hardStop] (hardStop already folds in UNTIL, see caller),
 * honoring COUNT relative to DTSTART (occurrences before rangeStart still
 * count against COUNT, they're just not returned).
 */
function generateOccurrenceDates(dtstartIso, rule, rangeStartIso, hardStop) {
  const { freq, interval, byDay, count } = rule;

  if (freq === 'WEEKLY' && byDay) {
    return generateWeeklyByDayDates(dtstartIso, interval, byDay, count, hardStop, rangeStartIso);
  }

  const stepDays = freq === 'DAILY' ? interval : freq === 'WEEKLY' ? interval * 7 : null; // null => MONTHLY (variable-length step)
  const dateAtIndex = (n) => (freq === 'MONTHLY' ? addMonthsSameDay(dtstartIso, n * interval) : addDays(dtstartIso, n * stepDays));
  const dates = [];

  if (count) {
    // COUNT bounds this walk itself, so starting from DTSTART is always safe.
    for (let n = 0; n < count && dates.length < MAX_OCCURRENCES; n++) {
      const candidate = dateAtIndex(n);
      if (candidate > hardStop) break;
      if (candidate >= rangeStartIso) dates.push(candidate);
    }
    return dates;
  }

  // Open-ended (or UNTIL-bound only): jump close to rangeStart rather than
  // walking every occurrence from DTSTART (see estimateStartIndex).
  let n = estimateStartIndex(dtstartIso, freq, interval, rangeStartIso);
  while (dates.length < MAX_OCCURRENCES) {
    const candidate = dateAtIndex(n);
    if (candidate > hardStop) break;
    if (candidate >= rangeStartIso) dates.push(candidate);
    n++;
  }
  return dates;
}

/**
 * Expand a recurring CalendarEvent into virtual per-day instances for
 * display within [rangeStartIso, rangeEndIso] inclusive. Pure function —
 * never mutates or persists anything. If `masterEvent.recurrenceRule` is
 * falsy (or unparseable), returns `[masterEvent]` unchanged — still correct
 * to call unconditionally from a caller that doesn't know in advance which
 * events are recurring.
 * @param {import('../types').CalendarEvent} masterEvent
 * @param {string} rangeStartIso - "YYYY-MM-DD"
 * @param {string} rangeEndIso - "YYYY-MM-DD"
 * @returns {import('../types').CalendarEvent[]} virtual instances. Each is a
 *   shallow clone of masterEvent with `date` set to the occurrence's ISO
 *   date, `id` suffixed `${masterEvent.id}::${date}` (stable per-occurrence
 *   React key, and distinguishable from the master's own id), and any
 *   matching `masterEvent.overrides[date]` shallow-merged on top.
 */
export function expandRecurringEvent(masterEvent, rangeStartIso, rangeEndIso) {
  if (!masterEvent.recurrenceRule) return [masterEvent];
  const rule = parseRRule(masterEvent.recurrenceRule);
  if (!rule) return [masterEvent]; // unparseable/unsupported rule — show the master occurrence rather than silently dropping the event

  const hardStop = rule.until && rule.until < rangeEndIso ? rule.until : rangeEndIso;
  if (hardStop < masterEvent.date) return [];

  const occurrenceDates = generateOccurrenceDates(masterEvent.date, rule, rangeStartIso, hardStop);
  const overrides = masterEvent.overrides || {};

  return occurrenceDates.map((date) => ({
    ...masterEvent,
    ...(overrides[date] || null),
    date,
    id: `${masterEvent.id}::${date}`,
  }));
}

/**
 * Runs expandRecurringEvent over every recurring event in `events` and
 * passes non-recurring events through untouched (still filtered to the
 * given range for recurring ones; non-recurring events are returned as-is
 * regardless of whether their single `date` falls in range — filtering
 * those was already the caller's job before this function existed, so
 * don't change that contract).
 * @param {import('../types').CalendarEvent[]} events
 * @param {string} rangeStartIso
 * @param {string} rangeEndIso
 * @returns {import('../types').CalendarEvent[]}
 */
export function expandEventsForRange(events, rangeStartIso, rangeEndIso) {
  const out = [];
  for (const evt of events) {
    if (evt.recurrenceRule) out.push(...expandRecurringEvent(evt, rangeStartIso, rangeEndIso));
    else out.push(evt);
  }
  return out;
}

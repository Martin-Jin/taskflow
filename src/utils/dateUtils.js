/**
 * ============================================================================
 * DATE / TIME UTILITIES
 * ============================================================================
 * Small, dependency-free helpers for ISO date math and "HH:MM" time-string
 * arithmetic. We deliberately avoid pulling in a heavy date library (moment,
 * luxon) to keep the bundle lean — everything the scheduler needs is basic
 * calendar arithmetic in the user's local timezone.
 * ============================================================================
 */

/** Convert a Date object to an ISO "YYYY-MM-DD" string (local time, not UTC). */
export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse an ISO "YYYY-MM-DD" string into a local-time Date at midnight. */
export function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Add N days to an ISO date string, returning a new ISO date string. */
export function addDays(iso, n) {
  const date = fromISODate(iso);
  date.setDate(date.getDate() + n);
  return toISODate(date);
}

/** Inclusive day difference between two ISO dates (b - a), in whole days. */
export function diffDays(isoA, isoB) {
  const a = fromISODate(isoA);
  const b = fromISODate(isoB);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

/** Convert "HH:MM" -> minutes since midnight. */
export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Format "HH:MM" (24h) as a 12-hour clock string, e.g. "14:05" -> "2:05 PM". */
export function formatTime12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Convert minutes since midnight -> "HH:MM". */
export function minutesToTime(mins) {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, '0');
  const m = Math.floor(mins % 60)
    .toString()
    .padStart(2, '0');
  return `${h}:${m}`;
}

/** Hours (float) between two "HH:MM" strings. Handles same-day only. */
export function hoursBetween(startHHMM, endHHMM) {
  return (timeToMinutes(endHHMM) - timeToMinutes(startHHMM)) / 60;
}

/** Day-of-week index (0=Sun..6=Sat) for an ISO date string. */
export function dayOfWeek(iso) {
  return fromISODate(iso).getDay();
}

/** The Sun–Sat week containing `todayIso`, as `{ weekStart, weekEnd }` ISO dates (inclusive). */
export function getWeekRange(todayIso) {
  const weekStart = addDays(todayIso, -dayOfWeek(todayIso));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

/** Returns an array of ISO date strings, `count` days starting at `startIso` inclusive. */
export function dateRange(startIso, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(addDays(startIso, i));
  return out;
}

/** True if iso date is strictly before today (local). Used to skip past days when scheduling. */
export function isPast(iso) {
  return iso < toISODate(new Date());
}

/**
 * True once a scheduled block's time has fully elapsed, regardless of
 * whether its `status` was ever manually flipped to 'done' — time already
 * elapsed is simply a fact. Shared by the weekly/today progress rings (and
 * anything else that needs "is this block in the past" for a given
 * `today`/`nowMinutes` snapshot).
 */
export function isBlockPast(block, today, nowMinutes) {
  if (block.date < today) return true;
  if (block.date > today) return false;
  return timeToMinutes(block.endTime) <= nowMinutes;
}

// Re-exported so existing `import { BASE_WORD_NUMBERS } from '../utils/dateUtils'`
// call sites keep working — see wordNumbers.js for why the vocabulary itself
// lives in its own dependency-free file instead of here.
export { BASE_WORD_NUMBERS } from './wordNumbers';

/**
 * Parse a free-text duration estimate out of a task title/description, e.g.
 * "[2h]", "1.5 hours", "90 min", "30 minutes", "45m", "half an hour".
 * Returns hours (float) or null if no duration pattern is found.
 *
 * Re-exported from `durationParser.js`, which is the single source of
 * truth for duration parsing (also used by `todoistService.js` when
 * resolving a synced task's estimated hours) — kept here too so existing
 * `import { parseDurationHours } from '../utils/dateUtils'` call sites
 * keep working unchanged.
 */
export { extractDurationHours as parseDurationHours } from './durationParser';

/** First-of-month ISO date for the month containing `iso`. */
export function startOfMonth(iso) {
  const date = fromISODate(iso);
  return toISODate(new Date(date.getFullYear(), date.getMonth(), 1));
}

/** Add N months to an ISO date string, clamping to the 1st (used for month-view navigation). */
export function addMonths(iso, n) {
  const date = fromISODate(iso);
  return toISODate(new Date(date.getFullYear(), date.getMonth() + n, 1));
}

/**
 * Add N months to an ISO date, clamping the day-of-month if it overflows the
 * target month (e.g. Jan 31 + 1 -> Feb 28/29). Unlike `addMonths` above (which
 * always resets to the 1st, for month-view navigation), this preserves the
 * day-of-month — used for recurrence/date-math where "same day next month"
 * is the intent. Shared by recurrence.js (task due-date recurrence),
 * recurrenceExpansion.js (calendar RRULE expansion), and dateParse.js
 * (natural-language "next month"/"in N months" phrases).
 */
export function addMonthsClamped(iso, n) {
  const date = fromISODate(iso);
  const targetMonthIndex = date.getMonth() + n;
  const year = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const monthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(year, monthIndex + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDayOfTargetMonth);
  return toISODate(new Date(year, monthIndex, day));
}

/** Format an ISO date as "Month YYYY", e.g. "July 2026" — month-view toolbar title. */
export function formatMonthLabel(iso) {
  return fromISODate(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Format an ISO date for display, e.g. "Mon, Jul 27". */
export function formatDisplayDate(iso) {
  const date = fromISODate(iso);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a full ISO datetime (unlike the other formatters here, this takes a
 * timestamp with a time component — e.g. Comment.createdAt — not a bare
 * YYYY-MM-DD, so it goes through `new Date()` rather than `fromISODate`).
 */
export function formatDisplayDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

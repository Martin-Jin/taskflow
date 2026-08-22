/**
 * ============================================================================
 * WORK HOURS
 * ============================================================================
 * Resolves the working window for a given date from SchedulingRules.
 *
 * `rules.workDayStart`/`workDayEnd` remain the baseline — every day uses them
 * unless `rules.workHoursByDay` carries an entry for that weekday. That's
 * additive on purpose rather than replacing the two scalars with a full
 * seven-entry map:
 *
 *   - Existing saved rules (and every backup ever taken) keep working with no
 *     migration at all: no map means no overrides means exactly the old
 *     behaviour, so there's no dated migration file to remember to delete.
 *   - `notify-worker` reads `rules.workDayStart` directly to decide when to
 *     send the due-today digest, and deploys independently of the app. Removing
 *     the scalar would have broken it silently until someone redeployed it.
 *
 * A day can also be marked not-working (`enabled: false`), which resolves to a
 * zero-length window. Deliberately expressed that way rather than as a special
 * case in the capacity engine: a zero-length window already yields zero free
 * time through the existing interval maths, so nothing downstream needs to know
 * "day off" is a concept.
 * ============================================================================
 */

import { dayOfWeek } from './dateUtils';

/** 0 = Sunday, matching dateUtils.dayOfWeek and FixedRoutine.daysOfWeek. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const WEEKDAY_NAMES = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/**
 * The working window for one date.
 *
 * @param {import('../types').SchedulingRules} rules
 * @param {string} dateIso
 * @returns {{start: string, end: string, enabled: boolean, isOverride: boolean}}
 */
export function resolveWorkWindow(rules, dateIso) {
  const baseStart = rules?.workDayStart || '00:00';
  const baseEnd = rules?.workDayEnd || '23:59';
  const override = rules?.workHoursByDay?.[dayOfWeek(dateIso)];

  if (!override) return { start: baseStart, end: baseEnd, enabled: true, isOverride: false };

  // `enabled` defaults to true so an override that only narrows the times
  // doesn't have to restate it.
  const enabled = override.enabled !== false;
  const start = override.start || baseStart;
  if (!enabled) return { start, end: start, enabled: false, isOverride: true };
  return { start, end: override.end || baseEnd, enabled: true, isOverride: true };
}

/** True when any per-weekday override is in play. */
export function hasPerDayWorkHours(rules) {
  const map = rules?.workHoursByDay;
  return !!map && Object.keys(map).length > 0;
}

/**
 * A full seven-day map seeded from the baseline, for switching Settings out of
 * "same hours every day" mode — the user should see real values to edit rather
 * than empty inputs.
 *
 * @param {import('../types').SchedulingRules} rules
 */
export function seedPerDayWorkHours(rules) {
  const start = rules?.workDayStart || '09:00';
  const end = rules?.workDayEnd || '17:00';
  const map = {};
  for (const day of WEEKDAY_ORDER) {
    // Weekends default to not-working, which is the whole point of the
    // feature: modelling Saturday as identically available to Tuesday is what
    // produced the wrong schedules this replaces. Easy to switch back on, and
    // a far better first guess than the alternative.
    map[day] = day === 0 || day === 6 ? { start, end, enabled: false } : { start, end, enabled: true };
  }
  return map;
}

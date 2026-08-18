/**
 * Ensures the user always has at least one protected "Sleep" routine, so the
 * scheduler never loses track of when they sleep. Runs on every load (not a
 * one-time migration) — a one-time flag previously guarded this, but that
 * meant a user who deleted their Sleep routine after the flag was already set
 * (or never had one counted at migration time) could end up with none,
 * permanently. This is intentionally narrow: it only adds a Sleep routine
 * when none exists at all; it never touches an existing routine's protection,
 * times, or label, so a deliberately renamed or deleted Sleep routine is
 * respected — reaching zero "Sleep"-labeled routines just means one gets
 * added back.
 */

import { getDefaultRoutines } from '../services/mockData';

const SLEEP_LABEL_MATCH = 'sleep';

/**
 * @param {import('../types').FixedRoutine[]} routines
 * @returns {import('../types').FixedRoutine[]} routines with a protected Sleep
 *   routine appended if none exists; the same array reference otherwise, so
 *   the caller can skip a pointless write.
 */
export function ensureProtectedSleepRoutine(routines) {
  if (!Array.isArray(routines)) return routines;
  const hasSleep = routines.some((r) => r.label?.trim().toLowerCase() === SLEEP_LABEL_MATCH);
  if (hasSleep) return routines;
  return [...routines, ...getDefaultRoutines().filter((r) => r.id === 'rt_sleep' || r.id === 'rt_sleep_am')];
}

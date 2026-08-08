/**
 * ============================================================================
 * ONE-TIME MIGRATION — SAFE TO DELETE after ~2026-09 once telemetry/support
 * shows no remaining users with `protectedSleepRoutineMigrationDone !== true`
 * (see the call site in SchedulerContext.jsx, and that persisted flag
 * guarding it).
 *
 * Sleep routines are now seeded with `isProtected: true` (see mockData.js's
 * getDefaultRoutines) so a user can't accidentally delete the routine the
 * scheduler relies on to keep hours off-limits overnight. That only helps
 * brand-new users, though — anyone with data from before this change already
 * has their own routines.
 *
 * This migration does two independent things to existing routines:
 *
 * 1. Backfills a protected Sleep routine ONLY when the user has ZERO fixed
 *    routines at all — the narrowest possible trigger for "never had
 *    routines seeded in the first place" (this app ships every new user with
 *    7 default routines, so reaching zero takes either pre-dating that seed
 *    entirely or deleting every single one).
 *
 * 2. Marks any EXISTING routine whose label is exactly "Sleep" (case/
 *    whitespace-insensitive) as isProtected: true, without touching its
 *    times, days, active state, or id. This covers users who set up their
 *    own Sleep routine before protection existed — deliberately narrow to an
 *    exact name match so a routine renamed to something else (a deliberate
 *    choice this repo's backwards-compat conventions say to respect) is left
 *    alone. A user who deleted their Sleep routine outright has zero "Sleep"-
 *    labeled routines to match, so this step is a no-op for them too.
 * ============================================================================
 */

import { getDefaultRoutines } from '../services/mockData';

const SLEEP_LABEL_MATCH = 'sleep';

/**
 * @param {import('../types').FixedRoutine[]} routines
 * @returns {import('../types').FixedRoutine[]} routines with a protected Sleep
 *   routine backfilled if the list was completely empty, and/or any existing
 *   "Sleep"-labeled routine marked isProtected; the same array reference if
 *   neither applies, so the caller can skip a pointless write.
 */
export function migrateProtectedSleepRoutine(routines) {
  if (!Array.isArray(routines)) return routines;

  if (routines.length === 0) {
    return getDefaultRoutines().filter((r) => r.id === 'rt_sleep' || r.id === 'rt_sleep_am');
  }

  let changed = false;
  const next = routines.map((r) => {
    if (!r.isProtected && r.label?.trim().toLowerCase() === SLEEP_LABEL_MATCH) {
      changed = true;
      return { ...r, isProtected: true };
    }
    return r;
  });

  return changed ? next : routines;
}

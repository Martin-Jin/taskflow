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
 * brand-new users, though — anyone with data from before this change either
 * already has a Sleep routine (protected or not) or has already deleted
 * theirs, and in neither case should this silently reach in and change
 * their data.
 *
 * This backfills a protected Sleep routine ONLY when the user has ZERO
 * fixed routines at all. That's deliberately the narrowest possible trigger
 * (not "no routine named Sleep", which would re-add one for one of two
 * plausible reasons that don't deserve the same treatment: a user who
 * renamed their Sleep routine to something else keeps their choice, and a
 * user who deleted it outright — a deliberate decision this repo's
 * backwards-compat conventions say to respect — also keeps their choice). A
 * completely empty routines list is the one case unambiguous enough to
 * treat as "never had routines seeded in the first place" rather than "user
 * cleared them on purpose": this app ships every new user with 7 default
 * routines (see getDefaultRoutines), so reaching zero takes either pre-
 * dating that seed entirely or deleting every single one — and this
 * migration only ever adds back the one, protected, most-load-bearing
 * routine, not the other six.
 * ============================================================================
 */

import { getDefaultRoutines } from '../services/mockData';

/**
 * @param {import('../types').FixedRoutine[]} routines
 * @returns {import('../types').FixedRoutine[]} routines with a protected Sleep
 *   routine backfilled if (and only if) the list was completely empty; the
 *   same array reference otherwise, so the caller can skip a pointless write.
 */
export function migrateProtectedSleepRoutine(routines) {
  if (!Array.isArray(routines) || routines.length > 0) return routines;
  const sleepDefaults = getDefaultRoutines().filter((r) => r.id === 'rt_sleep' || r.id === 'rt_sleep_am');
  return sleepDefaults;
}

'use strict';

/**
 * ============================================================================
 * TRIGGER RULES (server-side mirror of the client's Phase 2 logic)
 * ============================================================================
 * Deliberately a PURE function — no Firestore/network access — so the
 * notification rules themselves are easy to read and verify in isolation
 * from the dedupe/send plumbing in index.js and notificationState.js.
 *
 * Mirrors src/hooks/useNotificationChecker.js field-for-field: same trigger
 * definitions (starting soon / overdue / due today), same overdue
 * once-vs-repeat split by priority. Only difference is WHERE it runs (a
 * user's full tasks/blocks arrays pulled from their Firestore doc, instead
 * of local React state) and that in-app-only settings (inAppEnabled) are
 * irrelevant here — this only ever runs for users with emailEnabled true
 * (see index.js's query), and only checks the per-TYPE toggles.
 *
 * TIMEZONE: the client evaluates "today" / "overdue" / "starting soon"
 * against the user's own browser-local clock (src/utils/dateUtils.js's
 * toISODate is explicitly local-time, not UTC). This used to be an
 * unfixable gap server-side — nothing stored a per-user IANA timezone — but
 * `notificationSettings.timezone` (captured client-side via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, see
 * src/utils/dateUtils.js's getBrowserTimeZone and its resync effect in
 * SchedulerContext.jsx) now carries it into Firestore, so this pass can
 * compute "today" and convert each block's stored local wall-clock
 * date/time into the correct UTC instant for that specific user, instead of
 * assuming UTC. `settings.timezone` is defensively defaulted to 'UTC' below
 * (existing users who haven't loaded a client build new enough to have
 * stamped it yet, or an invalid/unrecognized zone string) rather than
 * crashing — no backfill needed, since the client lazily fills it in on next
 * login. One residual imprecision: the UTC-offset used for a given instant
 * is looked up via that instant's OWN naive (UTC-assumed) reading rather
 * than iteratively resolved, so a block/boundary landing in the handful of
 * hours around a DST transition can be off by up to that zone's DST shift
 * (typically 1 hour) — accepted as a rare edge case given this worker's
 * already-approximate 5-minute cron granularity (see index.js).
 * ============================================================================
 */

const { OVERDUE_RENOTIFY_MS } = require('./constants');

/** Falls back to UTC for a missing/invalid IANA zone name instead of throwing. */
function resolveTimeZone(timeZone) {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * The UTC-offset (in ms, positive = east of UTC) in effect for `date` in
 * `timeZone` — e.g. +12h for Pacific/Auckland in NZST. Derived by formatting
 * the instant in that zone and diffing the resulting wall-clock numbers
 * (read as if they were themselves a UTC instant) against the real UTC
 * instant.
 */
function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, { type, value }) => {
      if (type !== 'literal') acc[type] = value;
      return acc;
    }, {});
  const wallClockAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wallClockAsUTC - date.getTime();
}

/** Today's calendar date (YYYY-MM-DD) as seen from `timeZone` at `epochMs`. */
function todayISOInZone(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochMs));
}

/**
 * Converts a stored local wall-clock date/time (as entered by the user, no
 * offset attached) into the actual UTC epoch ms it represents in `timeZone`
 * — the inverse of todayISOInZone. Approximates the zone's offset using the
 * naive (UTC-assumed) instant rather than resolving it exactly, which is
 * exact except within the DST-transition window itself (see file-header
 * comment).
 */
function zonedWallTimeToEpochMs(dateStr, timeStr, timeZone) {
  const naiveMs = Date.parse(`${dateStr}T${timeStr}:00Z`);
  return naiveMs - getTimeZoneOffsetMs(new Date(naiveMs), timeZone);
}

/**
 * @param {{tasks: object[], blocks: object[], settings: object, now: number}} args
 * @returns {{toNotify: object[], toClear: {stateId: string}[]}}
 *   toNotify entries: { type: 'startingSoon'|'overdue'|'dueToday', task, block?, stateId, isUrgentish?, todayISO? }
 *   toClear entries: stale dedupe-state docs to delete (task no longer overdue), independent of whether anything fires this run.
 */
function computeCandidates({ tasks, blocks, settings, now }) {
  const toNotify = [];
  const toClear = [];
  const timeZone = resolveTimeZone(settings.timezone);
  const todayISO = todayISOInZone(now, timeZone);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  if (settings.taskStartingSoon) {
    const thresholdMs = (settings.startingSoonMinutes || 10) * 60 * 1000;
    for (const block of blocks) {
      if (block.status !== 'scheduled') continue;
      // Stored date/startTime is the user's local wall-clock time — convert
      // it to the actual UTC instant using their own stored timezone (see
      // file-header comment) so it's comparable to `now`.
      const startMs = zonedWallTimeToEpochMs(block.date, block.startTime, timeZone);
      const diffMs = startMs - now;
      if (diffMs <= 0 || diffMs > thresholdMs) continue;
      const task = tasksById.get(block.taskId);
      if (!task || task.isCompleted) continue;
      toNotify.push({ type: 'startingSoon', task, block, stateId: `startingSoon_${block.id}` });
    }
  }

  if (settings.taskOverdue || settings.taskDueToday) {
    for (const task of tasks) {
      if (task.isCompleted || !task.dueDate) continue;
      const isOverdue = task.dueDate < todayISO;

      if (settings.taskOverdue && isOverdue) {
        toNotify.push({
          type: 'overdue',
          task,
          stateId: `overdue_${task.id}`,
          isUrgentish: task.priority === 'high' || task.priority === 'urgent',
        });
      } else if (settings.taskDueToday && task.dueDate === todayISO) {
        toNotify.push({ type: 'dueToday', task, stateId: `dueToday_${task.id}`, todayISO });
      }

      // Once a task is no longer overdue (completed, rescheduled forward, or
      // a recurring task's due date advanced), clear its overdue dedupe
      // state so a LATER overdue period for this same task id notifies again
      // instead of staying silently suppressed forever — mirrors the
      // client's identical reset-on-resolve behavior.
      if (!isOverdue) {
        toClear.push({ stateId: `overdue_${task.id}` });
      }
    }
  }

  return { toNotify, toClear };
}

module.exports = { computeCandidates, todayISOInZone, OVERDUE_RENOTIFY_MS };

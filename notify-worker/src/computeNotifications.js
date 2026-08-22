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
 * @param {{tasks: object[], blocks: object[], settings: object, rules: object, now: number}} args
 * @returns {{toNotify: object[], toClear: {stateId: string}[]}}
 *   toNotify entries:
 *     - { type: 'startingSoon', task, block, stateId, scheduledAt }
 *     - { type: 'dueTodayDigest', tasks: object[], stateId, todayISO } — ONE entry per user carrying
 *       every due-today task, not one per task (see index.js/emailTemplate.js for the digest send).
 *     - { type: 'missed', task, block, stateId, scheduledAt, isDueToday, dueDate } — a scheduled block
 *       whose end time passed with the task still incomplete. `isDueToday`/`dueDate` distinguish "due
 *       today AND missed" from "missed but not due today/overdue" for the email copy.
 *     - { type: 'overdue', task, stateId, isUrgentish, todayISO, dueDate } — task's own dueDate is in
 *       the past (independent of any scheduled block).
 *   dueDate/scheduledAt let notificationState.js detect a rescheduled task/block and re-arm even if it
 *   already notified once for the old date. toClear entries: stale dedupe-state docs to delete (task no
 *   longer overdue, completed, or deleted outright), independent of whether anything fires this run.
 *
 * `existingOverdueStateIds` is the set of `overdue_*` doc ids currently in the user's
 * notificationState collection (read by index.js). It's what makes clearing correct for
 * completed/deleted tasks — see the toClear loop below for why deriving it from `tasks` couldn't work.
 * Defaults to empty so callers that don't care about clearing can omit it.
 */
function computeCandidates({ tasks, blocks, settings, rules, now, existingOverdueStateIds = [] }) {
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
      // Include the block's own date+startTime so a reschedule after this
      // block already fired once is treated as a fresh occurrence instead of
      // being permanently suppressed (see notificationState.js's eligibility
      // check, which compares this against what it has stored).
      toNotify.push({
        type: 'startingSoon',
        task,
        block,
        stateId: `startingSoon_${block.id}`,
        scheduledAt: `${block.date}T${block.startTime}`,
      });
    }
  }

  // "Missed" — a scheduled block whose end time has already passed, with the
  // task still incomplete. Independent of the task's own dueDate: a task due
  // NEXT WEEK but time-blocked for a slot earlier today that passed unstarted
  // is just as much "missed" as one whose overall due date has elapsed — see
  // the 'overdue' block below for the separate dueDate<today trigger.
  if (settings.taskOverdue) {
    // Bounded to the last 24h: without this, a block that was scheduled long
    // ago, never marked 'done', and never previously reported (e.g. the
    // worker was only just turned on, or the block was untouched for weeks)
    // would count as "missed" forever and fire the instant its dedupe state
    // doesn't exist yet — flooding a first run (or any run after a gap) with
    // a backlog of stale, no-longer-relevant blocks instead of just today's.
    const MISSED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
    for (const block of blocks) {
      if (block.status === 'done') continue;
      const endMs = zonedWallTimeToEpochMs(block.date, block.endTime, timeZone);
      if (endMs > now || endMs < now - MISSED_LOOKBACK_MS) continue;
      const task = tasksById.get(block.taskId);
      if (!task || task.isCompleted) continue;
      toNotify.push({
        type: 'missed',
        task,
        block,
        stateId: `missed_${block.id}`,
        scheduledAt: `${block.date}T${block.endTime}`,
        isDueToday: task.dueDate === todayISO,
        dueDate: task.dueDate || null,
      });
    }
  }

  if (settings.taskOverdue || settings.taskDueToday) {
    const dueTodayTasks = [];
    const stillOverdueIds = new Set();
    for (const task of tasks) {
      if (task.isCompleted || !task.dueDate) continue;
      const isOverdue = task.dueDate < todayISO;

      if (settings.taskOverdue && isOverdue) {
        stillOverdueIds.add(task.id);
        toNotify.push({
          type: 'overdue',
          task,
          stateId: `overdue_${task.id}`,
          isUrgentish: task.priority === 'high' || task.priority === 'urgent',
          todayISO,
          dueDate: task.dueDate,
        });
      } else if (settings.taskDueToday && task.dueDate === todayISO) {
        dueTodayTasks.push(task);
      }
    }

    // Clear the overdue dedupe state of every task that is NOT currently
    // overdue, derived from `existingOverdueStateIds` (what's actually in
    // Firestore) rather than from a pass over `tasks`. That distinction is
    // the whole point: this used to live inside the loop above, after its
    // `if (task.isCompleted || !task.dueDate) continue`, so it was
    // unreachable for exactly the cases it exists to handle — a completed
    // task bailed at that `continue`, and a DELETED task isn't in `tasks` to
    // be iterated at all. Both leaked their state doc forever. Driving the
    // clear from the stored doc ids instead reaps completed, deleted, and
    // rescheduled-forward tasks alike.
    // Gated on taskOverdue: stillOverdueIds is only populated by the branch
    // above, which doesn't run when the user has overdue notifications off.
    // Without this guard, a user with only "due today" enabled would have
    // every overdue state doc cleared each run — then get one stale email per
    // task the moment they re-enabled overdue notifications.
    if (settings.taskOverdue) {
      for (const stateId of existingOverdueStateIds) {
        if (!stillOverdueIds.has(stateId.slice('overdue_'.length))) {
          toClear.push({ stateId });
        }
      }
    }

    // Due-today tasks are consolidated into ONE digest candidate (not one
    // per task) sent once daily at the user's own workDayStart, rather than
    // firing the instant the worker's first post-midnight tick happens to
    // land (which could be minutes after midnight, or hours later depending
    // on the 5-minute cron's timing) — see notificationState.js's dueToday
    // eligibility for the "not before workDayStart" gate this relies on.
    if (settings.taskDueToday && dueTodayTasks.length > 0) {
      const workDayStart = rules?.workDayStart || '00:00';
      const workDayStartMs = zonedWallTimeToEpochMs(todayISO, workDayStart, timeZone);
      if (now >= workDayStartMs) {
        toNotify.push({ type: 'dueTodayDigest', tasks: dueTodayTasks, stateId: 'dueTodayDigest', todayISO });
      }
    }
  }

  return { toNotify, toClear };
}

/**
 * Re-validates a candidate against a freshly-read tasks/blocks snapshot,
 * taken right before send — the snapshot `computeCandidates` originally ran
 * against can be stale by then (a transaction + network round trip per
 * candidate ahead of it), so a task/block completed in the gap would
 * otherwise still get a "missed"/"overdue"/"startingSoon" email despite
 * already being done. Pure function, no Firestore access, so the freshness
 * check itself is unit-testable in isolation — see index.js for the actual
 * re-fetch this consumes.
 */
function isCandidateStillValid(candidate, freshTasks, freshBlocks) {
  if (candidate.type === 'dueTodayDigest') return true;
  const freshTask = freshTasks.find((t) => t.id === candidate.task.id);
  if (!freshTask || freshTask.isCompleted) return false;
  if (candidate.block) {
    const freshBlock = freshBlocks.find((b) => b.id === candidate.block.id);
    if (!freshBlock || freshBlock.status === 'done') return false;
  }
  return true;
}

module.exports = { computeCandidates, todayISOInZone, isCandidateStillValid };

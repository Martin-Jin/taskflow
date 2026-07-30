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
 * TIMEZONE CAVEAT (read before trusting exact due-today/overdue boundaries):
 * the client evaluates "today" / "overdue" / "starting soon" against the
 * user's own browser-local clock (src/utils/dateUtils.js's toISODate is
 * explicitly local-time, not UTC). Nothing in this app currently stores a
 * per-user IANA timezone (checked AuthContext.jsx, notificationSettings'
 * shape, and SchedulerContext.jsx — none exist), so this server-side pass
 * has no way to know it and necessarily uses UTC "now" instead. For a user
 * whose local timezone isn't UTC, this can shift which calendar day counts
 * as "today" (so overdue/due-today can fire up to ~UTC-offset hours early or
 * late) and shift the exact "starting soon" window by the same amount. This
 * is a real gap, not a rounding error — flagged here rather than silently
 * shipped as if it were correct. Fixing it properly needs a stored per-user
 * timezone (e.g. captured once client-side via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`), which is a Phase 1/2
 * data-model change out of scope for this Phase 3 pass — left as an open
 * question alongside TODO.md #10's existing ones.
 * ============================================================================
 */

const { OVERDUE_RENOTIFY_MS } = require('./constants');

function toISODateUTC(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
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
  const todayISO = toISODateUTC(now);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  if (settings.taskStartingSoon) {
    const thresholdMs = (settings.startingSoonMinutes || 10) * 60 * 1000;
    for (const block of blocks) {
      if (block.status !== 'scheduled') continue;
      // Stored date/startTime is the user's local wall-clock time (see
      // timezone caveat above) — treated as UTC here for lack of a stored
      // per-user offset, consistent with `now` also being UTC.
      const start = new Date(`${block.date}T${block.startTime}:00Z`);
      const diffMs = start.getTime() - now;
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

module.exports = { computeCandidates, toISODateUTC, OVERDUE_RENOTIFY_MS };

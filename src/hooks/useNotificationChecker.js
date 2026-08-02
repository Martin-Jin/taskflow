import { useEffect, useRef } from 'react';
import { toISODate } from '../utils/dateUtils';
import { fireNotification } from '../services/notificationService';

// Tight enough for the smallest sane "starting soon" threshold (a few
// minutes) to be caught promptly, without polling aggressively.
const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Scans tasks/scheduled blocks on an interval and surfaces in-app
 * notification triggers (task starting soon / overdue / due today) per
 * notificationSettings' toggles (TODO.md #10, Phase 2). Fires the native
 * Notification API when permitted; falls back to the existing Toast system
 * (setNotification) when it isn't available or hasn't been granted.
 *
 * Entirely inert — no interval, no work — when in-app notifications are off
 * or no per-trigger toggle is enabled, so the feature has zero background
 * cost for users who don't use it.
 */
export function useNotificationChecker({ tasks, blocks, notificationSettings, setNotification }) {
  const { inAppEnabled, taskStartingSoon, taskOverdue, taskDueToday, startingSoonMinutes } = notificationSettings;
  const anyTriggerEnabled = taskStartingSoon || taskOverdue || taskDueToday;

  // Latest tasks/blocks, read by the interval tick without being a dependency
  // of the effect below — otherwise every task/block edit would tear down and
  // recreate the interval (and re-run the "check immediately" call) instead
  // of just ticking on its own 60s cadence.
  const tasksRef = useRef(tasks);
  const blocksRef = useRef(blocks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  // Dedupe trackers, kept across ticks in refs (not persisted — a fresh page
  // load starts clean, which is fine since every trigger here is time-
  // relative and re-evaluates correctly from scratch).
  const firedStartingSoonRef = useRef(new Map()); // blockId -> `${date}T${startTime}` last notified for
  const firedOverdueRef = useRef(new Map()); // taskId -> { date: ISO date last notified, dueDate: value at that time }
  const firedDueTodayRef = useRef(new Map()); // taskId -> { date: ISO date last notified, dueDate: value at that time }

  useEffect(() => {
    if (!inAppEnabled || !anyTriggerEnabled) return undefined;

    const notify = (toastType, title, body) => {
      if (!fireNotification(title, { body })) {
        setNotification({ type: toastType, message: `${title} — ${body}` });
      }
    };

    const check = () => {
      const now = Date.now();
      const todayISO = toISODate(new Date());
      const tasks = tasksRef.current;
      const blocks = blocksRef.current;

      if (taskStartingSoon) {
        const thresholdMs = startingSoonMinutes * 60 * 1000;
        for (const block of blocks) {
          if (block.status !== 'scheduled') continue;
          const scheduledAt = `${block.date}T${block.startTime}`;
          // A reschedule after this block already fired once is a new
          // occurrence, not a repeat — re-arm instead of permanently
          // suppressing it for the block's lifetime.
          if (firedStartingSoonRef.current.get(block.id) === scheduledAt) continue;
          const start = new Date(`${scheduledAt}:00`);
          const diffMs = start.getTime() - now;
          if (diffMs <= 0 || diffMs > thresholdMs) continue;
          const task = tasks.find((t) => t.id === block.taskId);
          if (!task || task.isCompleted) continue;
          firedStartingSoonRef.current.set(block.id, scheduledAt);
          notify('info', `Starting soon: ${task.title}`, `Starts at ${block.startTime}`);
        }
      }

      if (taskOverdue || taskDueToday) {
        for (const task of tasks) {
          if (task.isCompleted || !task.dueDate) continue;
          const isOverdue = task.dueDate < todayISO;

          // Once a task is no longer overdue (completed, rescheduled forward,
          // or its recurring due date advanced), clear its dedupe entry so a
          // LATER overdue period for this same task id notifies again
          // instead of staying silently suppressed forever.
          if (!isOverdue) {
            firedOverdueRef.current.delete(task.id);
          }

          if (taskOverdue && isOverdue) {
            // Once per calendar day regardless of priority — matches the
            // email worker's cadence (an hourly repeat for urgent/high tasks
            // used to fire ~24x/day, which read as spam). Also re-arms
            // immediately if dueDate changed, even within the same day, so a
            // reschedule is always treated as fresh news.
            const prev = firedOverdueRef.current.get(task.id);
            const dueDateChanged = prev && prev.dueDate !== task.dueDate;
            if (!prev || dueDateChanged || prev.date !== todayISO) {
              firedOverdueRef.current.set(task.id, { date: todayISO, dueDate: task.dueDate });
              notify('warning', `Overdue: ${task.title}`, `Was due ${task.dueDate}`);
            }
          } else if (taskDueToday && task.dueDate === todayISO) {
            const prev = firedDueTodayRef.current.get(task.id);
            const dueDateChanged = prev && prev.dueDate !== task.dueDate;
            if (!prev || dueDateChanged || prev.date !== todayISO) {
              firedDueTodayRef.current.set(task.id, { date: todayISO, dueDate: task.dueDate });
              notify('info', `Due today: ${task.title}`, 'Due date is today');
            }
          }
        }
      }
    };

    check(); // catch anything already due right when a toggle is turned on, not just 60s later
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [inAppEnabled, anyTriggerEnabled, taskStartingSoon, taskOverdue, taskDueToday, startingSoonMinutes, setNotification]);
}

import { useEffect, useRef } from 'react';
import { toISODate } from '../utils/dateUtils';
import { fireNotification } from '../services/notificationService';

// Tight enough for the smallest sane "starting soon" threshold (a few
// minutes) to be caught promptly, without polling aggressively.
const CHECK_INTERVAL_MS = 60 * 1000;

// High/urgent overdue tasks re-notify periodically instead of once (see
// TODO.md #10's confirmed decisions — exact cadence was left an open
// question). Once per hour keeps a still-overdue urgent task surfaced
// several times across a working day without spamming on every 60s tick.
const OVERDUE_RENOTIFY_MS = 60 * 60 * 1000;

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
  const firedStartingSoonRef = useRef(new Set()); // blockId -> already notified
  const firedOverdueOnceRef = useRef(new Set()); // taskId -> low/medium overdue, notified once
  const lastOverdueRenotifyRef = useRef(new Map()); // taskId -> ms timestamp, high/urgent throttled repeat
  const firedDueTodayRef = useRef(new Map()); // taskId -> ISO date string last notified

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
          if (firedStartingSoonRef.current.has(block.id)) continue;
          const start = new Date(`${block.date}T${block.startTime}:00`);
          const diffMs = start.getTime() - now;
          if (diffMs <= 0 || diffMs > thresholdMs) continue;
          const task = tasks.find((t) => t.id === block.taskId);
          if (!task || task.isCompleted) continue;
          firedStartingSoonRef.current.add(block.id);
          notify('info', `Starting soon: ${task.title}`, `Starts at ${block.startTime}`);
        }
      }

      if (taskOverdue || taskDueToday) {
        for (const task of tasks) {
          if (task.isCompleted || !task.dueDate) continue;
          const isOverdue = task.dueDate < todayISO;

          // Once a task is no longer overdue (completed, rescheduled forward,
          // or its recurring due date advanced), clear its dedupe entries so
          // a LATER overdue period for this same task id notifies again
          // instead of staying silently suppressed forever.
          if (!isOverdue) {
            firedOverdueOnceRef.current.delete(task.id);
            lastOverdueRenotifyRef.current.delete(task.id);
          }

          if (taskOverdue && isOverdue) {
            const isUrgentish = task.priority === 'high' || task.priority === 'urgent';
            if (isUrgentish) {
              const lastFired = lastOverdueRenotifyRef.current.get(task.id) || 0;
              if (now - lastFired >= OVERDUE_RENOTIFY_MS) {
                lastOverdueRenotifyRef.current.set(task.id, now);
                notify('warning', `Overdue: ${task.title}`, `Was due ${task.dueDate}`);
              }
            } else if (!firedOverdueOnceRef.current.has(task.id)) {
              firedOverdueOnceRef.current.add(task.id);
              notify('warning', `Overdue: ${task.title}`, `Was due ${task.dueDate}`);
            }
          } else if (taskDueToday && task.dueDate === todayISO) {
            if (firedDueTodayRef.current.get(task.id) !== todayISO) {
              firedDueTodayRef.current.set(task.id, todayISO);
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

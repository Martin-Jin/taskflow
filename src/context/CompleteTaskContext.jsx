/**
 * ============================================================================
 * CompleteTaskContext
 * ============================================================================
 * Intercepts task completion when a Pomodoro timer (TimerContext) exists for
 * that task. Without this, completing a task left its timer running/paused
 * forever (never stopped, never cleared) and no record was kept of how long
 * it actually ran.
 *
 * All three completion call sites in the app (BoardView, TaskDetailModal,
 * TaskListPanel) go through `requestComplete(taskId)` instead of calling
 * SchedulerContext.completeTask directly, so the "does this task have a
 * timer" check lives in exactly one place:
 *   - No timer for the task -> completes immediately, no popup (unchanged
 *     behavior for the common case).
 *   - Timer exists, task is recurring -> timers don't carry across
 *     recurrence cycles, so the timer is stopped silently and the task
 *     completes as normal (no popup — matches Todoist's "checking off a
 *     recurring task advances it" behavior, which isn't a final completion).
 *   - Timer exists, task is not recurring -> completion is held pending a
 *     confirmation (see `pending` below, rendered by the global
 *     CompleteTaskConfirmModal singleton in App.jsx) showing the live
 *     elapsed time, editable, so the user can log what they actually worked
 *     (e.g. lowering it if they completed the task later than when they
 *     stopped working). Confirming stops the timer and completes the task
 *     with that value as `Task.actualHours`; cancelling leaves both the task
 *     and its timer untouched.
 *
 * `pending` is context (not local component state) because completion can be
 * triggered from three different components, but the confirmation popup is
 * a single global singleton — it needs one shared place to read from.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useState } from 'react';
import { useScheduler } from './SchedulerContext';
import { useTimers, getLiveRemaining } from './TimerContext';

const CompleteTaskContext = createContext(null);

export function CompleteTaskProvider({ children }) {
  const { tasks, completeTask } = useScheduler();
  const { getTimerForTask, stopTimer } = useTimers();
  // { taskId, taskTitle, elapsedHours } | null — at most one pending
  // confirmation at a time (completion is a discrete user click, not
  // something fired concurrently from multiple places).
  const [pending, setPending] = useState(null);

  const requestComplete = useCallback(
    (taskId) => {
      const timer = getTimerForTask(taskId);
      if (!timer) {
        completeTask(taskId);
        return true;
      }
      const task = tasks.find((t) => t.id === taskId);
      if (task?.isRecurring) {
        stopTimer(taskId);
        completeTask(taskId);
        return true;
      }
      const elapsedSeconds = Math.max(0, timer.durationSeconds - getLiveRemaining(timer));
      setPending({ taskId, taskTitle: timer.taskTitle, elapsedHours: elapsedSeconds / 3600 });
      return false;
    },
    [getTimerForTask, completeTask, tasks, stopTimer]
  );

  const confirmComplete = useCallback(
    (actualHours) => {
      if (!pending) return;
      stopTimer(pending.taskId);
      completeTask(pending.taskId, actualHours);
      setPending(null);
    },
    [pending, stopTimer, completeTask]
  );

  const cancelComplete = useCallback(() => setPending(null), []);

  const value = { pending, requestComplete, confirmComplete, cancelComplete };

  return <CompleteTaskContext.Provider value={value}>{children}</CompleteTaskContext.Provider>;
}

export function useCompleteTask() {
  const ctx = useContext(CompleteTaskContext);
  if (!ctx) throw new Error('useCompleteTask must be used within a CompleteTaskProvider');
  return ctx;
}

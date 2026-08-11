/**
 * ============================================================================
 * TimerContext
 * ============================================================================
 * Per-task Pomodoro-style countdown timers. Kept as its own sibling context
 * (rather than folded into SchedulerContext, which is already 1700+ lines)
 * since timers are an independent concern: they don't touch tasks/blocks,
 * don't participate in Undo/Redo, and have their own persistence shape.
 *
 * Multiple timers can run concurrently — state is a map keyed by taskId, so
 * starting a timer for one task never affects any other task's timer.
 *
 * PERSISTENCE MODEL: each timer stores `remainingSeconds` (a snapshot taken
 * at the last start/pause/reset) plus `startedAt` (the ms timestamp it was
 * last (re)started, or null while paused). While running, the *live*
 * remaining time is always derived as `remainingSeconds - elapsed since
 * startedAt` (see getLiveRemaining/getSignedLiveRemaining) rather than
 * trusting a stale snapshot — this is what makes a running timer read
 * correctly immediately after a page refresh, instead of resuming from
 * whatever `remainingSeconds` was at the moment of the last write.
 *
 * There is no automatic 'done' status: a running timer is never stopped by
 * the passage of time alone. Once live remaining time hits zero it keeps
 * counting into negative "overtime" (still status 'running') until the user
 * explicitly pauses, stops, or marks the task done — consumers that want a
 * "time's up" indicator compute it themselves from the sign of the live
 * remaining value rather than reading a status. `status: 'done'` remains a
 * legal persisted value purely for backward compatibility with timers
 * written before this change; nothing sets it anymore, and the handful of
 * remaining reads of it (see TimerWidget/TaskDetailModal) treat it the same
 * as 'paused' with zero time left.
 *
 * This context no longer runs its own 1-second ticking interval: forcing a
 * re-render on every tick here would re-render every consumer of this
 * context (including ones with no visible timer UI), so each UI that shows
 * a live countdown (TimerWidget, TaskDetailModal's TaskTimerControl) ticks
 * its own local interval + forceTick state instead, scoped to just itself.
 *
 * Intentionally local-only: `timers` is persisted via localStorage only and
 * is deliberately excluded from cloud sync (`cloudSyncState`) and from
 * export/import + cloud backup (`BACKUP_FIELDS`), same as theme and
 * dashboard widget visibility. An in-progress Pomodoro is tied to whatever
 * device you're sitting at right now, not something worth restoring on a
 * different device or after a backup restore.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadPersisted, savePersisted } from '../utils/persistence.js';

const TimerContext = createContext(null);

// Classic Pomodoro length, used whenever a task has no estimatedHours set.
export const DEFAULT_TIMER_SECONDS = 25 * 60;

/** Task.estimatedHours -> whole seconds, falling back to the Pomodoro default. */
export function getDefaultDurationSeconds(task) {
  const hours = Number(task?.estimatedHours);
  if (!hours || hours <= 0) return DEFAULT_TIMER_SECONDS;
  return Math.round(hours * 3600);
}

/**
 * Signed live remaining seconds for a single timer entry — positive while
 * time is left, zero at the instant it runs out, and NEGATIVE once it's
 * running into overtime (a running timer is never auto-stopped at zero — see
 * the persistence-model note above). Callers that need a "can't go below
 * zero" number for display should clamp with getLiveRemaining instead;
 * callers that need overtime-aware elapsed time (stats, "Time left"
 * deductions, overtime display) should use this or getSignedElapsedSeconds.
 */
export function getSignedLiveRemaining(timer, now = Date.now()) {
  if (!timer) return 0;
  if (timer.status !== 'running' || !timer.startedAt) return timer.remainingSeconds;
  const elapsed = (now - timer.startedAt) / 1000;
  return timer.remainingSeconds - elapsed;
}

/** Live remaining seconds for a single timer entry, clamped to >= 0. */
export function getLiveRemaining(timer, now = Date.now()) {
  return Math.max(0, getSignedLiveRemaining(timer, now));
}

/**
 * Elapsed seconds since the timer's original duration started counting down,
 * including any overtime (i.e. can exceed `durationSeconds`). This is the
 * value stats/completion/"Time left" deductions should use — unlike the
 * clamped display remaining, elapsed time keeps growing past zero for as
 * long as the timer keeps running.
 */
export function getSignedElapsedSeconds(timer, now = Date.now()) {
  if (!timer) return 0;
  return timer.durationSeconds - getSignedLiveRemaining(timer, now);
}

export function TimerProvider({ children }) {
  // Map keyed by taskId: { taskId, taskTitle, durationSeconds, remainingSeconds, status: 'running'|'paused'|'done', startedAt }
  const [timers, setTimers] = useState(() => loadPersisted('timers', {}) ?? {});

  useEffect(() => {
    savePersisted('timers', timers);
  }, [timers]);

  const startTimer = useCallback((task, durationSeconds) => {
    setTimers((prev) => ({
      ...prev,
      [task.id]: {
        taskId: task.id,
        taskTitle: task.title,
        durationSeconds: durationSeconds ?? getDefaultDurationSeconds(task),
        remainingSeconds: durationSeconds ?? getDefaultDurationSeconds(task),
        status: 'running',
        startedAt: Date.now(),
      },
    }));
  }, []);

  const pauseTimer = useCallback((taskId) => {
    setTimers((prev) => {
      const timer = prev[taskId];
      if (!timer || timer.status !== 'running') return prev;
      // Snapshot the SIGNED remaining (can be negative if paused mid-overtime)
      // so a paused-while-overtime timer keeps showing overtime instead of
      // silently resetting to 0 until resumed.
      return {
        ...prev,
        [taskId]: { ...timer, remainingSeconds: getSignedLiveRemaining(timer), status: 'paused', startedAt: null },
      };
    });
  }, []);

  const resumeTimer = useCallback((taskId) => {
    setTimers((prev) => {
      const timer = prev[taskId];
      if (!timer || timer.status === 'running') return prev;
      return { ...prev, [taskId]: { ...timer, status: 'running', startedAt: Date.now() } };
    });
  }, []);

  const resetTimer = useCallback((taskId) => {
    setTimers((prev) => {
      const timer = prev[taskId];
      if (!timer) return prev;
      return { ...prev, [taskId]: { ...timer, remainingSeconds: timer.durationSeconds, status: 'paused', startedAt: null } };
    });
  }, []);

  const stopTimer = useCallback((taskId) => {
    setTimers((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const getTimerForTask = useCallback((taskId) => timers[taskId] || null, [timers]);

  const activeTimers = useMemo(
    () => Object.values(timers).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)),
    [timers]
  );

  const value = useMemo(
    () => ({
      timers,
      activeTimers,
      getTimerForTask,
      startTimer,
      pauseTimer,
      resumeTimer,
      resetTimer,
      stopTimer,
    }),
    [timers, activeTimers, getTimerForTask, startTimer, pauseTimer, resumeTimer, resetTimer, stopTimer]
  );

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

/** Formats whole seconds as "M:SS" (or "H:MM:SS" past an hour) for display. */
export function formatTimerDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function useTimers() {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error('useTimers must be used within a TimerProvider');
  return ctx;
}

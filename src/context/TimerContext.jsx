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
 * startedAt` (see getLiveRemaining) rather than trusting a stale snapshot —
 * this is what makes a running timer read correctly immediately after a
 * page refresh, instead of resuming from whatever `remainingSeconds` was at
 * the moment of the last write.
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

/** Live remaining seconds for a single timer entry, clamped to >= 0. */
export function getLiveRemaining(timer, now = Date.now()) {
  if (!timer) return 0;
  if (timer.status !== 'running' || !timer.startedAt) return Math.max(0, timer.remainingSeconds);
  const elapsed = (now - timer.startedAt) / 1000;
  return Math.max(0, timer.remainingSeconds - elapsed);
}

export function TimerProvider({ children }) {
  // Map keyed by taskId: { taskId, taskTitle, durationSeconds, remainingSeconds, status: 'running'|'paused'|'done', startedAt }
  const [timers, setTimers] = useState(() => loadPersisted('timers', {}) ?? {});

  useEffect(() => {
    savePersisted('timers', timers);
  }, [timers]);

  // Ticks once a second purely to force consumers to re-render and re-derive
  // getLiveRemaining — the underlying `timers` state doesn't change on every
  // tick, only on start/pause/resume/reset/stop/completion, so this doesn't
  // spam localStorage. The same tick also flips any running timer that's hit
  // zero to 'done', so the widget shows a finished state instead of
  // freezing at 00:00 while still "running".
  const [, setTick] = useState(0);
  useEffect(() => {
    const hasRunning = Object.values(timers).some((t) => t.status === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      const now = Date.now();
      setTimers((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const timer of Object.values(prev)) {
          if (timer.status === 'running' && getLiveRemaining(timer, now) <= 0) {
            next[timer.taskId] = { ...timer, status: 'done', remainingSeconds: 0, startedAt: null };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
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
      return {
        ...prev,
        [taskId]: { ...timer, remainingSeconds: getLiveRemaining(timer), status: 'paused', startedAt: null },
      };
    });
  }, []);

  const resumeTimer = useCallback((taskId) => {
    setTimers((prev) => {
      const timer = prev[taskId];
      if (!timer || timer.status === 'running') return prev;
      return {
        ...prev,
        [taskId]: {
          ...timer,
          // A resumed 'done' timer restarts a fresh countdown from its
          // original duration rather than instantly re-completing at 0.
          remainingSeconds: timer.status === 'done' ? timer.durationSeconds : timer.remainingSeconds,
          status: 'running',
          startedAt: Date.now(),
        },
      };
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

  const value = {
    timers,
    activeTimers,
    getTimerForTask,
    startTimer,
    pauseTimer,
    resumeTimer,
    resetTimer,
    stopTimer,
  };

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

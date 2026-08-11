/**
 * TimerWidget — its own independently-positioned, draggable floating window
 * listing every currently active Pomodoro timer (see TimerContext), each
 * with a live countdown (ticking into overtime past zero) and pause/resume/
 * stop/mark-as-done controls. Mounted once at the app shell level (outside
 * .floating-notifications, see App.jsx) so timers stay visible no matter
 * which tab/modal is open.
 *
 * Ticks its own local 1-second interval (forceTick) so its countdown updates
 * live — TimerContext deliberately doesn't force a re-render on every tick
 * itself (that would re-render every context consumer app-wide), so each UI
 * that shows a countdown owns its own interval, same pattern as
 * TaskDetailModal's TaskTimerControl.
 *
 * Collapses to a small pill showing just the count + soonest countdown when
 * there's more than one timer, to avoid crowding small screens — click to
 * expand the full list. Draggable by its header at any time, in either
 * state; position is persisted per-device only (see timerWidgetPosition.js).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Timer, Pause, Play, Square, CheckCircle, ChevronUp, ChevronDown } from 'lucide-react';
import {
  useTimers,
  getSignedLiveRemaining,
  getSignedElapsedSeconds,
  formatTimerDuration,
} from '../../context/TimerContext';
import { useScheduler } from '../../context/SchedulerContext';
import { useCompleteTask } from '../../context/CompleteTaskContext';
import { computeRemainingHoursPatchAfterElapsed } from '../../utils/taskHierarchy';
import useDraggableWindowPosition from '../../hooks/useDraggableWindowPosition';

/** Signed MM:SS (or H:MM:SS), with a leading "+"/"-" once in overtime. */
function formatSignedDuration(seconds) {
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${formatTimerDuration(Math.abs(seconds))}`;
}

export default function TimerWidget() {
  const { activeTimers, pauseTimer, resumeTimer, stopTimer } = useTimers();
  const { tasks, updateTask } = useScheduler();
  const { requestComplete } = useCompleteTask();
  const [collapsed, setCollapsed] = useState(false);
  const { style, handlers, headerRef } = useDraggableWindowPosition({ onClick: () => setCollapsed((v) => !v) });

  // A task can be deleted while its timer is still running/paused — drop
  // that timer rather than leaving an orphaned row pointing at nothing.
  useEffect(() => {
    const taskIds = new Set(tasks.map((t) => t.id));
    activeTimers.forEach((timer) => {
      if (!taskIds.has(timer.taskId)) stopTimer(timer.taskId);
    });
  }, [tasks, activeTimers, stopTimer]);

  // Ticks once a second while any timer is running, purely to force this
  // component to re-render and re-derive the live countdown/overtime — see
  // module doc comment.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!activeTimers.some((t) => t.status === 'running')) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTimers]);

  if (activeTimers.length === 0) return null;

  // Stop: log elapsed time (including overtime) against "Time left", then
  // remove the timer — a plain state update, no confirmation needed.
  function handleStop(timer) {
    const task = tasks.find((t) => t.id === timer.taskId);
    if (task) {
      const elapsedHours = Math.max(0, getSignedElapsedSeconds(timer)) / 3600;
      const patch = computeRemainingHoursPatchAfterElapsed(task, elapsedHours);
      if (patch) updateTask(task.id, patch);
    }
    stopTimer(timer.taskId);
  }

  // Mark as done: route through the normal completion flow (dependency
  // checks, recurring-task handling, the elapsed-time confirmation for a
  // one-off task) — it already reads this timer's own elapsed time via
  // getTimerForTask, so nothing else needs to happen here. If completion is
  // blocked (unmet dependency), requestComplete leaves the timer untouched.
  function handleMarkDone(timer) {
    requestComplete(timer.taskId);
  }

  const soonest = activeTimers.reduce((min, t) => {
    const r = getSignedLiveRemaining(t);
    return min === null ? r : Math.min(min, r);
  }, null);

  return (
    <div className="timer-widget" style={style}>
      <button
        type="button"
        ref={headerRef}
        className="timer-widget-header"
        {...handlers}
      >
        <Timer size={14} aria-hidden="true" />
        <span>
          {collapsed
            ? `${activeTimers.length} timer${activeTimers.length === 1 ? '' : 's'} · ${formatSignedDuration(soonest)}`
            : `${activeTimers.length} timer${activeTimers.length === 1 ? '' : 's'} running`}
        </span>
        {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>

      {!collapsed && (
        <ul className="timer-widget-list">
          {activeTimers.map((timer) => (
            <TimerRow
              key={timer.taskId}
              timer={timer}
              onPause={() => pauseTimer(timer.taskId)}
              onResume={() => resumeTimer(timer.taskId)}
              onStop={() => handleStop(timer)}
              onMarkDone={() => handleMarkDone(timer)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TimerRow({ timer, onPause, onResume, onStop, onMarkDone }) {
  // Re-derived every render; the widget re-renders every second while any
  // timer is running (see the forceTick effect above).
  const remaining = getSignedLiveRemaining(timer);
  const isOvertime = timer.status === 'running' && remaining < 0;

  return (
    <li className={`timer-widget-row ${isOvertime ? 'is-overtime' : ''}`}>
      <div className="timer-widget-row-info">
        <span className="timer-widget-row-title" title={timer.taskTitle}>
          {timer.taskTitle}
        </span>
        <span className="timer-widget-row-time">{formatSignedDuration(remaining)}</span>
      </div>
      <div className="timer-widget-row-actions">
        {timer.status === 'running' ? (
          <button type="button" className="btn btn-icon" onClick={onPause} title="Pause" aria-label="Pause timer">
            <Pause size={13} />
          </button>
        ) : (
          <button type="button" className="btn btn-icon" onClick={onResume} title="Resume" aria-label="Resume timer">
            <Play size={13} />
          </button>
        )}
        <button
          type="button"
          className="btn btn-icon"
          onClick={onMarkDone}
          title="Mark as done"
          aria-label="Mark task as done"
        >
          <CheckCircle size={13} />
        </button>
        <button type="button" className="btn btn-icon" onClick={onStop} title="Stop" aria-label="Stop timer">
          <Square size={13} />
        </button>
      </div>
    </li>
  );
}

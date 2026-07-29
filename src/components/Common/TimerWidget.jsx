/**
 * TimerWidget — floating panel listing every currently active Pomodoro
 * timer (see TimerContext), each with a live countdown and pause/resume/
 * stop controls. Mounted once at the app shell level so timers stay visible
 * (and keep running) no matter which tab/modal is open.
 *
 * Collapses to a small pill showing just the count + soonest countdown when
 * there's more than one timer, to avoid crowding small screens — click to
 * expand the full list.
 */

import React, { useEffect, useState } from 'react';
import { Timer, Pause, Play, Square, ChevronUp, ChevronDown } from 'lucide-react';
import { useTimers, getLiveRemaining, formatTimerDuration } from '../../context/TimerContext';
import { useScheduler } from '../../context/SchedulerContext';

export default function TimerWidget() {
  const { activeTimers, pauseTimer, resumeTimer, stopTimer } = useTimers();
  const { tasks } = useScheduler();
  const [collapsed, setCollapsed] = useState(false);

  // A task can be deleted while its timer is still running/paused — drop
  // that timer rather than leaving an orphaned row pointing at nothing.
  useEffect(() => {
    const taskIds = new Set(tasks.map((t) => t.id));
    activeTimers.forEach((timer) => {
      if (!taskIds.has(timer.taskId)) stopTimer(timer.taskId);
    });
  }, [tasks, activeTimers, stopTimer]);

  if (activeTimers.length === 0) return null;

  return (
    <div className="timer-widget">
      <button type="button" className="timer-widget-header" onClick={() => setCollapsed((v) => !v)}>
        <Timer size={14} aria-hidden="true" />
        <span>
          {activeTimers.length} timer{activeTimers.length === 1 ? '' : 's'} running
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
              onStop={() => stopTimer(timer.taskId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TimerRow({ timer, onPause, onResume, onStop }) {
  // Re-derived every render; the widget's parent re-renders every second
  // while any timer is running (see TimerContext's tick effect).
  const remaining = getLiveRemaining(timer);
  const isDone = timer.status === 'done';

  return (
    <li className={`timer-widget-row ${isDone ? 'is-done' : ''}`}>
      <div className="timer-widget-row-info">
        <span className="timer-widget-row-title" title={timer.taskTitle}>
          {timer.taskTitle}
        </span>
        <span className="timer-widget-row-time">{isDone ? "Time's up" : formatTimerDuration(remaining)}</span>
      </div>
      <div className="timer-widget-row-actions">
        {timer.status === 'running' ? (
          <button type="button" className="btn btn-icon" onClick={onPause} title="Pause" aria-label="Pause timer">
            <Pause size={13} />
          </button>
        ) : (
          <button type="button" className="btn btn-icon" onClick={onResume} title={isDone ? 'Restart' : 'Resume'} aria-label={isDone ? 'Restart timer' : 'Resume timer'}>
            <Play size={13} />
          </button>
        )}
        <button type="button" className="btn btn-icon" onClick={onStop} title="Stop" aria-label="Stop timer">
          <Square size={13} />
        </button>
      </div>
    </li>
  );
}

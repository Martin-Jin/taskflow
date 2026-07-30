import React from 'react';
import { Play, ArrowRight, ExternalLink, Coffee } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useNowAndNext } from '../../hooks/useNowAndNext';
import { timeToMinutes, toISODate, formatTime12h as formatTime } from '../../utils/dateUtils';

/** A task's `link` field (see utils/smartParse.js) makes its title a click-through to that URL instead of plain text. */
function TaskTitle({ task, className }) {
  const title = task?.title || 'Untitled task';
  if (!task?.link) return <span className={className}>{title}</span>;
  return (
    <a href={task.link} target="_blank" rel="noopener noreferrer" className={`${className} task-title-link`} title={`Open link: ${task.link}`}>
      {title}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

function minutesUntil(now, block) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let target = timeToMinutes(block.startTime);
  const isToday = block.date === toISODate(now);
  if (!isToday) return null;
  return Math.max(0, target - nowMinutes);
}

export default function NowNextCard() {
  const { tasks, blocks } = useScheduler();
  const { now, current, next } = useNowAndNext(tasks, blocks);
  const nextInMinutes = next ? minutesUntil(now, next.block) : null;

  return (
    <div className="card dashboard-card now-next-card">
      <div className="dashboard-card-header">
        <h3>Right now</h3>
      </div>

      {current ? (
        <div className="now-block">
          <div className="now-block-title-row">
            <Play size={13} className="now-block-icon" />
            <TaskTitle task={current.task} className="now-block-title" />
          </div>
          <div className="now-block-time">
            {formatTime(current.block.startTime)} – {formatTime(current.block.endTime)}
          </div>
          <div
            className="now-progress-track"
            role="progressbar"
            aria-label={`Progress through ${current.task?.title || 'current task'}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(current.progress * 100)}
          >
            <div className="now-progress-fill" style={{ width: `${current.progress * 100}%` }} />
          </div>
        </div>
      ) : (
        <div className="now-empty">
          <Coffee size={20} className="empty-state-icon" aria-hidden="true" />
          Nothing scheduled right now — enjoy the gap.
        </div>
      )}

      {next && (
        <div className="next-block">
          <ArrowRight size={13} className="next-block-icon" />
          <div className="next-block-info">
            <TaskTitle task={next.task} className="next-block-title" />
            <span className="next-block-meta">
              {formatTime(next.block.startTime)}
              {nextInMinutes != null && ` · in ${nextInMinutes} min`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

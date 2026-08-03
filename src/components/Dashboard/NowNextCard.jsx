import React from 'react';
import { Play, ArrowRight, ExternalLink, Coffee } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useNowAndNext } from '../../hooks/useNowAndNext';
import { timeToMinutes, toISODate, formatTime12h as formatTime } from '../../utils/dateUtils';

/** A task's `link` field (see utils/smartParse.js) makes its title a click-through to that URL instead of plain text. */
function ItemTitle({ item, className }) {
  const link = item?.kind === 'block' ? item.task?.link : null;
  const title = item?.kind === 'block' ? item.task?.title || 'Untitled task' : item?.event?.title || 'Untitled event';
  if (!link) return <span className={className}>{title}</span>;
  return (
    <a href={link} target="_blank" rel="noopener noreferrer" className={`${className} task-title-link`} title={`Open link: ${link}`}>
      {title}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

function minutesUntil(now, item) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const target = timeToMinutes(item.startTime);
  const isToday = item.date === toISODate(now);
  if (!isToday) return null;
  return Math.max(0, target - nowMinutes);
}

export default function NowNextCard() {
  const { tasks, blocks, events } = useScheduler();
  const { now, current, next } = useNowAndNext(tasks, blocks, events);
  const nextInMinutes = next ? minutesUntil(now, next) : null;

  return (
    <div className="card dashboard-card now-next-card">
      <div className="dashboard-card-header">
        <h3>Right now</h3>
      </div>

      {current ? (
        <div className="now-block">
          <div className="now-block-title-row">
            <Play size={13} className="now-block-icon" />
            <ItemTitle item={current} className="now-block-title" />
            {current.overlapCount > 0 && (
              <span className="now-overlap-badge" title="Other things also happening right now">
                +{current.overlapCount} more
              </span>
            )}
          </div>
          <div className="now-block-time">
            {formatTime(current.startTime)} – {formatTime(current.endTime)}
          </div>
          <div
            className="now-progress-track"
            role="progressbar"
            aria-label={`Progress through ${current.kind === 'block' ? current.task?.title || 'current task' : current.event?.title || 'current event'}`}
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
            <ItemTitle item={next} className="next-block-title" />
            <span className="next-block-meta">
              {formatTime(next.startTime)}
              {nextInMinutes != null && ` · in ${nextInMinutes} min`}
              {next.overlapCount > 0 && ` · +${next.overlapCount} more`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

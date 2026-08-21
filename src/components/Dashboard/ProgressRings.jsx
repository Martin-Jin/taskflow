import React, { useMemo } from 'react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, getWeekRange, isBlockPast } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import EmptyState from '../Common/EmptyState';

const RADIUS = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Replaces what used to be TodayProgressRing + WeeklyProgressRing (two
// near-identical data wrappers, differing only in date range) handing off to
// a shared ProgressRingCard — one configurable ring, computed for both
// periods here, rendered as one compact strip instead of two full-size
// `.card`s (see W8 in TODO.md: progress is a supporting stat, not a hero).
function computeRangeProgress(blocks, matchesRange, today, nowMinutes) {
  const rangeBlocks = blocks.filter(matchesRange);
  const totalHours = rangeBlocks.reduce((sum, b) => sum + b.durationHours, 0);
  const completedHours = rangeBlocks
    .filter((b) => isBlockPast(b, today, nowMinutes))
    .reduce((sum, b) => sum + b.durationHours, 0);
  return {
    percent: totalHours > 0 ? Math.round((completedHours / totalHours) * 100) : 0,
    completedHours,
    totalHours,
  };
}

function MiniRing({ label, emptyMessage, percent, completedHours, totalHours }) {
  const offset = CIRCUMFERENCE * (1 - percent / 100);
  return (
    <div className="progress-ring-mini">
      {totalHours > 0 ? (
        <>
          <svg
            width="60"
            height="60"
            viewBox="0 0 60 60"
            className="progress-ring-mini-svg"
            role="img"
            aria-label={`${label}: ${percent}% done`}
          >
            <circle cx="30" cy="30" r={RADIUS} className="progress-ring-mini-track" />
            <circle
              cx="30"
              cy="30"
              r={RADIUS}
              className="progress-ring-mini-fill"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
            />
            <text x="30" y="34" textAnchor="middle" className="progress-ring-mini-percent">
              {percent}%
            </text>
          </svg>
          <div className="progress-ring-mini-detail">
            <span className="progress-ring-mini-label">{label}</span>
            <span className="progress-ring-mini-hours">
              {formatHours(completedHours)} of {formatHours(totalHours)}
            </span>
          </div>
        </>
      ) : (
        <div className="progress-ring-mini-detail">
          <span className="progress-ring-mini-label">{label}</span>
          <EmptyState className="progress-ring-mini-empty">{emptyMessage}</EmptyState>
        </div>
      )}
    </div>
  );
}

export default function ProgressRings() {
  const { blocks } = useScheduler();

  const { todayProgress, weekProgress } = useMemo(() => {
    const now = new Date();
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const { weekStart, weekEnd } = getWeekRange(today);
    return {
      todayProgress: computeRangeProgress(blocks, (b) => b.date === today, today, nowMinutes),
      weekProgress: computeRangeProgress(blocks, (b) => b.date >= weekStart && b.date <= weekEnd, today, nowMinutes),
    };
  }, [blocks]);

  return (
    <div className="card dashboard-card progress-rings-strip">
      <MiniRing label="Today" emptyMessage="Nothing scheduled today" {...todayProgress} />
      <MiniRing label="This week" emptyMessage="Nothing scheduled this week" {...weekProgress} />
    </div>
  );
}

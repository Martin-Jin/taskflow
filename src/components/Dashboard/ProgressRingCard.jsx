import React from 'react';
import { formatHours } from '../../utils/formatHours';

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Shared SVG-ring presentation for "percent of scheduled hours completed"
 * cards — WeeklyProgressRing and TodayProgressRing both compute their own
 * percent/hours (different date ranges) and hand them to this component so
 * the ring markup/styling only lives in one place.
 */
export default function ProgressRingCard({ title, percent, completedHours, totalHours, emptyMessage }) {
  const offset = CIRCUMFERENCE * (1 - percent / 100);

  return (
    <div className="card dashboard-card progress-ring-card">
      <div className="dashboard-card-header">
        <h3>{title}</h3>
      </div>
      {totalHours > 0 ? (
        <div className="progress-ring-body">
          <svg
            width="104"
            height="104"
            viewBox="0 0 104 104"
            className="progress-ring-svg"
            role="img"
            aria-label={`${percent}% of ${title.toLowerCase()}`}
          >
            <circle cx="52" cy="52" r={RADIUS} className="progress-ring-track" />
            <circle
              cx="52"
              cy="52"
              r={RADIUS}
              className="progress-ring-fill"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
            />
            <text x="52" y="57" textAnchor="middle" className="progress-ring-percent">
              {percent}%
            </text>
          </svg>
          <div className="progress-ring-detail">
            <span className="progress-ring-hours">{formatHours(completedHours)}</span>
            <span className="progress-ring-of"> of {formatHours(totalHours)} done</span>
          </div>
        </div>
      ) : (
        <div className="now-empty">{emptyMessage}</div>
      )}
    </div>
  );
}

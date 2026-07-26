import React, { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, getWeekRange, formatTime12h as formatTime, formatDisplayDate } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import { getMissedTaskItems } from '../../utils/missedTasks';
import { getOverdueTasks } from '../../utils/overdueTasks';
import { ALL_TASKS_PROJECT_ID } from '../../utils/projectConstants';
import StatListModal from './StatListModal';

function StatTile({ label, value, accent, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className={`card dashboard-stat-tile ${clickable ? 'dashboard-stat-tile-clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="dashboard-stat-label">{label}</div>
      <div className="dashboard-stat-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}

export default function DashboardStats({ onSelectProject }) {
  const { tasks, blocks } = useScheduler();
  const [openPopup, setOpenPopup] = useState(null); // null | 'missed' | 'overdue'

  const stats = useMemo(() => {
    const today = toISODate(new Date());
    const activeTasks = tasks.filter((t) => !t.isCompleted);

    const dueToday = activeTasks.filter((t) => t.dueDate === today).length;
    const overdueItems = getOverdueTasks(tasks);
    const missedItems = getMissedTaskItems(tasks, blocks);

    const { weekStart, weekEnd } = getWeekRange(today);
    const hoursThisWeek = blocks
      .filter((b) => b.date >= weekStart && b.date <= weekEnd)
      .reduce((sum, b) => sum + b.durationHours, 0);

    return { dueToday, overdueItems, missedItems, hoursThisWeek };
  }, [tasks, blocks]);

  return (
    <div className="dashboard-stats-strip">
      <StatTile label="Due today" value={stats.dueToday} onClick={() => onSelectProject?.(ALL_TASKS_PROJECT_ID)} />
      <StatTile
        label="Overdue"
        value={stats.overdueItems.length}
        accent={stats.overdueItems.length > 0 ? 'var(--color-danger)' : undefined}
        onClick={() => setOpenPopup('overdue')}
      />
      <StatTile
        label="Missed"
        value={stats.missedItems.length}
        accent={stats.missedItems.length > 0 ? 'var(--color-danger)' : undefined}
        onClick={() => setOpenPopup('missed')}
      />
      <StatTile label="Scheduled this week" value={formatHours(stats.hoursThisWeek)} />

      {openPopup === 'missed' && (
        <StatListModal
          title="Missed tasks"
          items={stats.missedItems}
          emptyMessage="Nothing missed — nice."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <li key={item.id} className="missed-tasks-item">
              <AlertCircle size={13} className="missed-tasks-icon" aria-hidden="true" />
              <span className="missed-tasks-time">{formatTime(item.startTime)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="missed-tasks-title task-title-link"
                  title={`Open link: ${item.link}`}
                >
                  {item.title}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                <span className="missed-tasks-title">{item.title}</span>
              )}
            </li>
          )}
        />
      )}

      {openPopup === 'overdue' && (
        <StatListModal
          title="Overdue tasks"
          items={stats.overdueItems}
          emptyMessage="Nothing overdue — nice."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <li key={item.id} className="missed-tasks-item">
              <AlertTriangle size={13} className="missed-tasks-icon" aria-hidden="true" />
              <span className="missed-tasks-time overdue-list-date">{formatDisplayDate(item.dueDate)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="missed-tasks-title task-title-link"
                  title={`Open link: ${item.link}`}
                >
                  {item.title}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                <span className="missed-tasks-title">{item.title}</span>
              )}
            </li>
          )}
        />
      )}
    </div>
  );
}

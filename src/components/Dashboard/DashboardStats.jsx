import React, { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, getWeekRange, formatTime12h as formatTime, formatDisplayDate, timeToMinutes } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import { getMissedTaskItems } from '../../utils/missedTasks';
import { getOverdueTasks } from '../../utils/overdueTasks';
import { ALL_TASKS_PROJECT_ID } from '../../utils/projectConstants';
import StatListModal from './StatListModal';
import TaskDetailModal from '../Modals/TaskDetailModal';

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

export default function DashboardStats({ onSelectProject, onOpenCalendar }) {
  const { tasks, blocks } = useScheduler();
  const [openPopup, setOpenPopup] = useState(null); // null | 'missed' | 'overdue'
  const [editingTaskId, setEditingTaskId] = useState(null);

  function openTaskFromPopup(taskId) {
    setOpenPopup(null);
    setEditingTaskId(taskId);
  }

  const stats = useMemo(() => {
    const today = toISODate(new Date());
    const activeTasks = tasks.filter((t) => !t.isCompleted);

    // "Due today" (a task's deadline) is distinct from "Scheduled today"
    // (a task with actual calendar blocks today) — a paced task can be
    // scheduled today without being due today, and vice versa.
    const dueTodayCount = activeTasks.filter((t) => t.dueDate === today).length;

    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const blocksToday = blocks
      .filter((b) => b.date === today)
      .slice()
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    const seenTaskIds = new Set();
    const scheduledTodayItems = [];
    blocksToday.forEach((b) => {
      if (seenTaskIds.has(b.taskId)) return;
      const task = taskById.get(b.taskId);
      if (!task) return;
      seenTaskIds.add(b.taskId);
      scheduledTodayItems.push({ id: task.id, title: task.title, link: task.link || null, startTime: b.startTime });
    });

    const overdueItems = getOverdueTasks(tasks);
    const missedItems = getMissedTaskItems(tasks, blocks);

    const { weekStart, weekEnd } = getWeekRange(today);
    const hoursThisWeek = blocks
      .filter((b) => b.date >= weekStart && b.date <= weekEnd)
      .reduce((sum, b) => sum + b.durationHours, 0);

    return { dueTodayCount, scheduledTodayItems, overdueItems, missedItems, hoursThisWeek };
  }, [tasks, blocks]);

  return (
    <div className="dashboard-stats-strip">
      <StatTile
        label="Scheduled today"
        value={
          <>
            {stats.scheduledTodayItems.length}
            {stats.dueTodayCount > 0 && (
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginLeft: 4 }}>
                ({stats.dueTodayCount} Due today)
              </span>
            )}
          </>
        }
        onClick={() => setOpenPopup('scheduledToday')}
      />
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
      <StatTile label="Scheduled this week" value={formatHours(stats.hoursThisWeek)} onClick={onOpenCalendar} />

      {openPopup === 'scheduledToday' && (
        <StatListModal
          title="Scheduled today"
          items={stats.scheduledTodayItems}
          emptyMessage="Nothing scheduled today."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <li
              key={item.id}
              className="missed-tasks-item scheduled-today-item is-openable"
              role="button"
              tabIndex={0}
              onClick={() => openTaskFromPopup(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openTaskFromPopup(item.id);
                }
              }}
            >
              <span className="missed-tasks-time">{formatTime(item.startTime)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="missed-tasks-title task-title-link"
                  title={`Open link: ${item.link}`}
                  onClick={(e) => e.stopPropagation()}
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

      {openPopup === 'missed' && (
        <StatListModal
          title="Missed tasks"
          items={stats.missedItems}
          emptyMessage="Nothing missed — nice."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <li
              key={item.id}
              className="missed-tasks-item is-openable"
              role="button"
              tabIndex={0}
              onClick={() => openTaskFromPopup(item.taskId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openTaskFromPopup(item.taskId);
                }
              }}
            >
              <AlertCircle size={13} className="missed-tasks-icon" aria-hidden="true" />
              <span className="missed-tasks-time">{formatTime(item.startTime)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="missed-tasks-title task-title-link"
                  title={`Open link: ${item.link}`}
                  onClick={(e) => e.stopPropagation()}
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
            <li
              key={item.id}
              className="missed-tasks-item is-openable"
              role="button"
              tabIndex={0}
              onClick={() => openTaskFromPopup(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openTaskFromPopup(item.id);
                }
              }}
            >
              <AlertTriangle size={13} className="missed-tasks-icon" aria-hidden="true" />
              <span className="missed-tasks-time overdue-list-date">{formatDisplayDate(item.dueDate)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="missed-tasks-title task-title-link"
                  title={`Open link: ${item.link}`}
                  onClick={(e) => e.stopPropagation()}
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

      {editingTaskId && (() => {
        const task = tasks.find((t) => t.id === editingTaskId);
        return task ? <TaskDetailModal task={task} onClose={() => setEditingTaskId(null)} /> : null;
      })()}
    </div>
  );
}

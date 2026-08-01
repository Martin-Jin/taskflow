import React, { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, getWeekRange, formatTime12h as formatTime, formatDisplayDate, timeToMinutes } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import { getMissedTaskItems, isBlockTaskCompleted } from '../../utils/missedTasks';
import { getOverdueTasks } from '../../utils/overdueTasks';
import { ALL_TASKS_PROJECT_ID } from '../../utils/projectConstants';
import StatListModal from './StatListModal';
import TaskDetailModal from '../Modals/TaskDetailModal';

function StatListItem({ item, taskId, icon: Icon, timeLabel, timeClassName, itemClassName, onOpen }) {
  return (
    <li
      className={`missed-tasks-item is-openable${itemClassName ? ` ${itemClassName}` : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(taskId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(taskId);
        }
      }}
    >
      {Icon && <Icon size={13} className="missed-tasks-icon" aria-hidden="true" />}
      <span className={`missed-tasks-time${timeClassName ? ` ${timeClassName}` : ''}`}>{timeLabel}</span>
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
  );
}

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
  const [openPopup, setOpenPopup] = useState(null); // null | 'scheduledToday' | 'overdueMissed' | 'completedToday'
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
    const completedTodayItems = [];
    blocksToday.forEach((b) => {
      if (seenTaskIds.has(b.taskId)) return;
      const task = taskById.get(b.taskId);
      if (!task) return;
      // A task whose due date has already passed is overdue, not "today's" —
      // it's already surfaced by the "Overdue & missed" tile below (with its
      // own click-through detail popup), so counting it here too would show
      // it in two places and, once it's completed, would misleadingly count
      // as "completed today" even though its due date never actually moved
      // to today. Applies whether the task ends up completed or not.
      if (task.dueDate && task.dueDate < today) return;
      seenTaskIds.add(b.taskId);
      scheduledTodayItems.push({ id: task.id, title: task.title, link: task.link || null, startTime: b.startTime });
      if (isBlockTaskCompleted(b, task)) {
        completedTodayItems.push({ id: task.id, title: task.title, link: task.link || null, startTime: b.startTime });
      }
    });

    // Merged into one "Overdue & missed" tile — both are "this task needs
    // attention" signals, just for different reasons (deadline passed vs.
    // today's scheduled slot for it passed), so users don't need to check
    // two separate tiles/popups to see everything that needs attention.
    const overdueAndMissedItems = [
      ...getOverdueTasks(tasks).map((item) => ({ ...item, kind: 'overdue' })),
      ...getMissedTaskItems(tasks, blocks).map((item) => ({ ...item, kind: 'missed' })),
    ];

    const { weekStart, weekEnd } = getWeekRange(today);
    const hoursThisWeek = blocks
      .filter((b) => b.date >= weekStart && b.date <= weekEnd)
      .reduce((sum, b) => sum + b.durationHours, 0);

    return { dueTodayCount, scheduledTodayItems, completedTodayItems, overdueAndMissedItems, hoursThisWeek };
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
        label="Overdue & missed"
        value={stats.overdueAndMissedItems.length}
        accent={stats.overdueAndMissedItems.length > 0 ? 'var(--color-danger)' : undefined}
        onClick={() => setOpenPopup('overdueMissed')}
      />
      <StatTile
        label="Completed today"
        value={stats.completedTodayItems.length}
        accent={stats.completedTodayItems.length > 0 ? 'var(--color-success)' : undefined}
        onClick={() => setOpenPopup('completedToday')}
      />
      <StatTile label="Scheduled this week" value={formatHours(stats.hoursThisWeek)} onClick={onOpenCalendar} />

      {openPopup === 'scheduledToday' && (
        <StatListModal
          title="Scheduled today"
          items={stats.scheduledTodayItems}
          emptyMessage="Nothing scheduled today."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <StatListItem
              key={item.id}
              item={item}
              taskId={item.id}
              timeLabel={formatTime(item.startTime)}
              itemClassName="scheduled-today-item"
              onOpen={openTaskFromPopup}
            />
          )}
        />
      )}

      {openPopup === 'overdueMissed' && (
        <StatListModal
          title="Overdue & missed"
          items={stats.overdueAndMissedItems}
          emptyMessage="Nothing overdue or missed — nice."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) =>
            item.kind === 'overdue' ? (
              <StatListItem
                key={`overdue-${item.id}`}
                item={item}
                taskId={item.id}
                icon={AlertTriangle}
                timeLabel={formatDisplayDate(item.dueDate)}
                timeClassName="overdue-list-date"
                onOpen={openTaskFromPopup}
              />
            ) : (
              <StatListItem
                key={`missed-${item.taskId}`}
                item={item}
                taskId={item.taskId}
                icon={AlertCircle}
                timeLabel={formatTime(item.startTime)}
                onOpen={openTaskFromPopup}
              />
            )
          }
        />
      )}

      {openPopup === 'completedToday' && (
        <StatListModal
          title="Completed today"
          items={stats.completedTodayItems}
          emptyMessage="Nothing completed yet today."
          onClose={() => setOpenPopup(null)}
          renderItem={(item) => (
            <StatListItem
              key={item.id}
              item={item}
              taskId={item.id}
              icon={CheckCircle2}
              timeLabel={formatTime(item.startTime)}
              itemClassName="completed-today-item"
              onOpen={openTaskFromPopup}
            />
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

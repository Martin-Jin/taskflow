import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, AlertCircle } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useNowAndNext } from '../../hooks/useNowAndNext';
import { toISODate, timeToMinutes, formatTime12h as formatTime, formatDisplayDateTime } from '../../utils/dateUtils';
import { isBlockMissed, isBlockCompletedLate, isBlockTaskCompleted } from '../../utils/missedTasks';
import TaskDetailModal from '../Modals/TaskDetailModal';
import EventDetailModal from '../Modals/EventDetailModal';
import MarqueeText from '../Common/MarqueeText';

export default function TodayAgenda() {
  const { tasks, blocks, events } = useScheduler();
  const { current } = useNowAndNext(tasks, blocks);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const listRef = useRef(null);
  const currentItemRef = useRef(null);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingEventId, setEditingEventId] = useState(null);

  const items = useMemo(() => {
    const now = new Date();
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const blockItems = blocks
      .filter((b) => b.date === today)
      .filter((b) => {
        const task = taskById.get(b.taskId);
        // An overdue task (due date already passed) isn't really "today's",
        // even if a block for it landed on today's calendar — it's already
        // covered by the "Overdue & missed" tile's own detail popup, whether
        // or not this task has since been completed (see DashboardStats).
        return !(task?.dueDate && task.dueDate < today);
      })
      .map((b) => {
        const task = taskById.get(b.taskId);
        return {
          id: b.id,
          taskId: task?.id || null,
          startTime: b.startTime,
          endTime: b.endTime,
          title: task?.title || 'Untitled task',
          link: task?.link || null,
          isMissed: isBlockMissed(b, task, today, nowMinutes),
          isDueToday: task?.dueDate === today,
          isCompleted: isBlockTaskCompleted(b, task),
          isCompletedLate: isBlockCompletedLate(b, task),
          completedAt: task?.completedAt ?? null,
        };
      });
    const eventItems = (events || [])
      .filter((e) => e.date === today)
      .map((e) => ({ id: e.id, eventId: e.id, startTime: e.startTime, endTime: e.endTime, title: e.title, isMissed: false }));
    return [...blockItems, ...eventItems].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }, [blocks, events, taskById]);

  const currentId = current?.block.id ?? null;

  useEffect(() => {
    const container = listRef.current;
    const currentItem = currentItemRef.current;
    if (!container || !currentItem) return;
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const targetScrollTop = Math.min(currentItem.offsetTop, maxScrollTop);
    container.scrollTop = Math.max(0, targetScrollTop);
  }, [currentId, items]);

  if (items.length === 0) {
    return (
      <div className="card dashboard-card today-agenda">
        <div className="dashboard-card-header">
          <h3>Today's agenda</h3>
        </div>
        <div className="now-empty">Nothing on the calendar today.</div>
      </div>
    );
  }

  return (
    <div className="card dashboard-card today-agenda">
      <div className="dashboard-card-header">
        <h3>Today's agenda</h3>
      </div>
      <ul className="today-agenda-list" ref={listRef}>
        {items.map((item) => {
          const isCurrent = currentId === item.id;
          const openItem = item.taskId
            ? () => setEditingTaskId(item.taskId)
            : item.eventId
              ? () => setEditingEventId(item.eventId)
              : null;
          const isOpenable = !!openItem;
          return (
            <li
              key={item.id}
              ref={isCurrent ? currentItemRef : null}
              className={`today-agenda-item ${isCurrent ? 'is-current' : ''} ${item.isMissed ? 'is-missed' : item.isDueToday ? 'is-due-today' : ''} ${isOpenable ? 'is-openable' : ''} ${item.isCompleted ? 'is-completed' : ''}`}
              role={isOpenable ? 'button' : undefined}
              tabIndex={isOpenable ? 0 : undefined}
              onClick={isOpenable ? openItem : undefined}
              onKeyDown={
                isOpenable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openItem();
                      }
                    }
                  : undefined
              }
            >
              {isCurrent && <span className="today-agenda-pulse" />}
              {!item.isCompleted && item.isMissed && <AlertCircle size={13} className="today-agenda-missed-icon" aria-hidden="true" />}
              <span className="today-agenda-time">
                <span className="today-agenda-time-full">
                  {formatTime(item.startTime)}{'–'}{formatTime(item.endTime)}
                </span>
                <span className="today-agenda-time-compact">{formatTime(item.startTime)}</span>
              </span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="today-agenda-title task-title-link"
                  title={`Open link: ${item.link}`}
                  onClick={(e) => e.stopPropagation()}
                  style={item.isCompleted ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}
                >
                  <MarqueeText text={item.title} className="today-agenda-title-marquee" />
                  <ExternalLink size={11} aria-hidden="true" className="today-agenda-title-link-icon" />
                </a>
              ) : (
                <span
                  className="today-agenda-title"
                  style={item.isCompleted ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}
                >
                  <MarqueeText text={item.title} className="today-agenda-title-marquee" />
                </span>
              )}
              {item.isCompleted ? (
                <span className={item.isCompletedLate ? 'today-agenda-completed-late-label' : 'today-agenda-completed-label'}>
                  <span className="today-agenda-status-full">{item.isCompletedLate ? 'Completed late' : 'Completed'}</span>
                  <span className="today-agenda-status-compact">Completed</span>
                  {item.completedAt ? (
                    <span className="today-agenda-completed-timestamp">  {formatDisplayDateTime(item.completedAt)}</span>
                  ) : null}
                </span>
              ) : (
                <>
                  {item.isMissed && <span className="today-agenda-missed-label">Missed</span>}
                  {!item.isMissed && item.isDueToday && (
                    <span className="today-agenda-due-label">
                      <span className="today-agenda-status-full">Due today</span>
                      <span className="today-agenda-status-compact">Due</span>
                    </span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {editingTaskId && (() => {
        const task = tasks.find((t) => t.id === editingTaskId);
        return task ? <TaskDetailModal task={task} onClose={() => setEditingTaskId(null)} /> : null;
      })()}
      {editingEventId && (() => {
        const event = (events || []).find((e) => e.id === editingEventId);
        return event ? (
          <EventDetailModal
            event={event}
            onClose={() => setEditingEventId(null)}
            onDeleted={() => setEditingEventId(null)}
          />
        ) : null;
      })()}
    </div>
  );
}

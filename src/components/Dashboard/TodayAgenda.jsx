import React, { useEffect, useMemo, useRef } from 'react';
import { ExternalLink, AlertCircle } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useNowAndNext } from '../../hooks/useNowAndNext';
import { toISODate, timeToMinutes, formatTime12h as formatTime } from '../../utils/dateUtils';
import { isBlockMissed } from '../../utils/missedTasks';

export default function TodayAgenda() {
  const { tasks, blocks, events } = useScheduler();
  const { current } = useNowAndNext(tasks, blocks);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const listRef = useRef(null);
  const currentItemRef = useRef(null);

  const items = useMemo(() => {
    const now = new Date();
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const blockItems = blocks
      .filter((b) => b.date === today)
      .map((b) => {
        const task = taskById.get(b.taskId);
        return {
          id: b.id,
          startTime: b.startTime,
          endTime: b.endTime,
          title: task?.title || 'Untitled task',
          link: task?.link || null,
          isMissed: isBlockMissed(b, task, today, nowMinutes),
        };
      });
    const eventItems = (events || [])
      .filter((e) => e.date === today)
      .map((e) => ({ id: e.id, startTime: e.startTime, endTime: e.endTime, title: e.title, isMissed: false }));
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
          return (
            <li
              key={item.id}
              ref={isCurrent ? currentItemRef : null}
              className={`today-agenda-item ${isCurrent ? 'is-current' : ''} ${item.isMissed ? 'is-missed' : ''}`}
            >
              {isCurrent && <span className="today-agenda-pulse" />}
              {item.isMissed && <AlertCircle size={13} className="today-agenda-missed-icon" aria-hidden="true" />}
              <span className="today-agenda-time">{formatTime(item.startTime)}</span>
              {item.link ? (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="today-agenda-title task-title-link"
                  title={`Open link: ${item.link}`}
                >
                  {item.title}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                <span className="today-agenda-title">{item.title}</span>
              )}
              {item.isMissed && <span className="today-agenda-missed-label">Missed</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

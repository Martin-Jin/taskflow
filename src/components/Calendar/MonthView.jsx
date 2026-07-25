/**
 * ============================================================================
 * MonthView
 * ============================================================================
 * A Google-Calendar-style month grid: 6 fixed rows x 7 columns, always
 * starting on a Sunday, showing every day that touches `monthStart`'s month
 * (days from the adjacent months are dimmed). Each cell lists its scheduled
 * blocks/events as small chips rather than the full time-grid WeekView uses
 * — there's no room to draw a real timeline, so this is a density-first
 * overview. A run of short tasks (see WeekView's own SHORT_TASK_MAX_MIN
 * clustering) is collapsed into one "N short tasks" chip so a busy day
 * doesn't get crowded out by tiny slivers here either.
 *
 * Clicking a day number, an overflow "+N more" chip, or a short-task cluster
 * chip hands off to `onSelectDay` — CalendarPage uses this to jump into Day
 * view for the full time-grid detail, matching how Google Calendar's month
 * view drills into a day.
 * ============================================================================
 */

import React, { useMemo } from 'react';
import { useScheduler } from '../../context/SchedulerContext';
import { addDays, dateRange, dayOfWeek, timeToMinutes, toISODate } from '../../utils/dateUtils';
import { priorityColor } from '../../utils/priorityColor';

const DOW_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MAX_VISIBLE_ITEMS = 3; // per day cell before collapsing into "+N more"
const SHORT_TASK_MAX_MIN = 15; // matches WeekView's own cluster threshold

export default function MonthView({ monthStart, onSelectBlock, onSelectEvent, onSelectDay }) {
  const { tasks, blocks, events } = useScheduler();
  const todayIso = toISODate(new Date());
  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);

  const gridStart = useMemo(() => addDays(monthStart, -dayOfWeek(monthStart)), [monthStart]);
  const days = useMemo(() => dateRange(gridStart, 42), [gridStart]);
  const currentMonth = monthStart.slice(0, 7); // "YYYY-MM"

  const blocksByDay = useMemo(() => {
    const map = new Map();
    for (const b of blocks) {
      if (!map.has(b.date)) map.set(b.date, []);
      map.get(b.date).push(b);
    }
    return map;
  }, [blocks]);

  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    }
    return map;
  }, [events]);

  return (
    <div className="month-grid">
      {DOW_LABELS.map((label) => (
        <div key={label} className="month-dow-header">
          {label}
        </div>
      ))}
      {days.map((day) => {
        const inMonth = day.slice(0, 7) === currentMonth;
        const dayEvents = (eventsByDay.get(day) || [])
          .slice()
          .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
        const dayBlocks = (blocksByDay.get(day) || [])
          .slice()
          .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

        const shortBlocks = dayBlocks.filter(
          (b) => !b.isPassive && timeToMinutes(b.endTime) - timeToMinutes(b.startTime) <= SHORT_TASK_MAX_MIN
        );
        const shortBlockIds = new Set(shortBlocks.map((b) => b.id));
        const normalBlocks = dayBlocks.filter((b) => !shortBlockIds.has(b.id));

        // Short tasks only bother clustering when there's more than one —
        // a single 5-minute task is just a normal chip.
        const items = [
          ...dayEvents.map((e) => ({ kind: 'event', data: e })),
          ...normalBlocks.map((b) => ({ kind: 'block', data: b })),
          ...(shortBlocks.length > 1
            ? [{ kind: 'cluster', data: shortBlocks }]
            : shortBlocks.map((b) => ({ kind: 'block', data: b }))),
        ];

        const visible = items.slice(0, MAX_VISIBLE_ITEMS);
        const hiddenCount = items.length - visible.length;

        return (
          <div key={day} className={`month-cell ${inMonth ? '' : 'is-outside'} ${day === todayIso ? 'today' : ''}`}>
            <button className="month-cell-daynum" onClick={() => onSelectDay?.(day)}>
              {Number(day.slice(8, 10))}
            </button>
            <div className="month-cell-items">
              {visible.map((item, i) => {
                if (item.kind === 'event') {
                  const evt = item.data;
                  return (
                    <div
                      key={`evt_${evt.id}`}
                      className="month-chip month-chip-event"
                      onClick={() => onSelectEvent?.(evt)}
                      title={evt.title}
                    >
                      {evt.title}
                    </div>
                  );
                }
                if (item.kind === 'cluster') {
                  return (
                    <div
                      key={`cluster_${i}`}
                      className="month-chip month-chip-cluster"
                      onClick={() => onSelectDay?.(day)}
                      title={`${item.data.length} short tasks`}
                    >
                      {item.data.length} short tasks
                    </div>
                  );
                }
                const block = item.data;
                const task = taskById[block.taskId];
                if (!task) return null;
                return (
                  <div
                    key={`blk_${block.id}`}
                    className="month-chip"
                    style={{ borderLeftColor: priorityColor(task.priority) }}
                    onClick={() => onSelectBlock?.(block)}
                    title={`${task.title} · ${block.startTime}–${block.endTime}`}
                  >
                    {task.title}
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <button className="month-chip month-chip-more" onClick={() => onSelectDay?.(day)}>
                  +{hiddenCount} more
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

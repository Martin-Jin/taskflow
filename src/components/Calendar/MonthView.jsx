/**
 * ============================================================================
 * MonthView
 * ============================================================================
 * A Google-Calendar-style month grid: 6 fixed rows x 7 columns, always
 * starting on a Sunday, showing every day that touches `monthStart`'s month
 * (days from the adjacent months are dimmed). Each cell lists its scheduled
 * blocks/events as small chips rather than the full time-grid WeekView uses
 * — there's no room to draw a real timeline, so this is a density-first
 * overview. A run of short tasks (see WeekView's own SHORT_BLOCK_MAX_MIN
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
import { SHORT_BLOCK_MAX_MIN, groupItemsByDay } from '../../utils/calendarGrouping';
import { makeSelectionKey } from '../../hooks/useMultiSelect';
import { useLongPressSelect } from '../../hooks/useLongPressSelect';

const DOW_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MAX_VISIBLE_ITEMS = 3; // per day cell before collapsing into "+N more"

export default function MonthView({
  monthStart,
  onSelectBlock,
  onSelectEvent,
  onSelectDay,
  // See WeekView's matching props for why these default to raw context
  // state and what the unfiltered/filterIsActive pair is for.
  blocks: blocksProp,
  events: eventsProp,
  unfilteredBlocks,
  unfilteredEvents,
  filterIsActive = false,
  onClearFilter,
  // Bulk multi-select (see hooks/useMultiSelect.js, lifted into CalendarPage
  // since Week/Month share one selection). Unlike WeekView, MonthView's
  // chips have no competing drag gesture at all (clicking one either opens
  // its detail modal or drills into Day view — see the module doc comment),
  // so long-press-to-select has nothing to conflict with here and is wired
  // up normally (see onLongPressSelect below).
  selectionMode = false,
  selectedKeys,
  onToggleSelectKey,
  onSelectManyKeys,
  onLongPressSelect,
}) {
  const { tasks, blocks: contextBlocks, events: contextEvents } = useScheduler();
  const blocks = blocksProp ?? contextBlocks;
  const events = eventsProp ?? contextEvents;
  const todayIso = toISODate(new Date());
  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const longPressSelect = useLongPressSelect({
    disabled: selectionMode,
    onLongPress: (key) => onLongPressSelect?.(key),
  });

  const gridStart = useMemo(() => addDays(monthStart, -dayOfWeek(monthStart)), [monthStart]);
  const days = useMemo(() => dateRange(gridStart, 42), [gridStart]);
  const currentMonth = monthStart.slice(0, 7); // "YYYY-MM"

  const { blocksByDay, eventsByDay } = useMemo(() => groupItemsByDay(blocks, events, days, taskById), [blocks, events, days, taskById]);

  // Same empty-filter-overlay logic as WeekView — see its own comment for
  // why the check is scoped to whether THIS visible range had anything
  // before filtering, not just whether the filter itself is active.
  const showEmptyFilterOverlay = useMemo(() => {
    if (!filterIsActive || !unfilteredBlocks || !unfilteredEvents) return false;
    if (blocksByDay.size > 0 || eventsByDay.size > 0) return false;
    const unfiltered = groupItemsByDay(unfilteredBlocks, unfilteredEvents, days);
    return unfiltered.blocksByDay.size > 0 || unfiltered.eventsByDay.size > 0;
  }, [filterIsActive, unfilteredBlocks, unfilteredEvents, blocksByDay, eventsByDay, days]);

  return (
    <div className="month-grid" style={{ position: 'relative' }}>
      {showEmptyFilterOverlay && (
        <div className="calendar-empty-filter-overlay">
          <div className="calendar-empty-filter-message">
            <p>Nothing matches your filters.</p>
            <button type="button" className="btn btn-primary" onClick={onClearFilter}>
              Clear filters
            </button>
          </div>
        </div>
      )}
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
          (b) => !b.isPassive && timeToMinutes(b.endTime) - timeToMinutes(b.startTime) <= SHORT_BLOCK_MAX_MIN
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

        // Every key this day cell's chips collectively represent — used by
        // the overflow "+N more" chip below to select everything hidden
        // behind it (see selectManyKeys usage). Deliberately every item
        // (visible + hidden), not just the hidden ones, matching the
        // cluster's own "selects ALL items it represents" behavior.
        const allDayKeys = items.flatMap((item) =>
          item.kind === 'cluster'
            ? item.data.map((b) => makeSelectionKey('block', b.id))
            : [makeSelectionKey(item.kind, item.data.id)]
        );

        return (
          <div key={day} className={`month-cell ${inMonth ? '' : 'is-outside'} ${day === todayIso ? 'today' : ''}`}>
            <button className="month-cell-daynum" onClick={() => onSelectDay?.(day)}>
              {Number(day.slice(8, 10))}
            </button>
            <div className="month-cell-items">
              {visible.map((item, i) => {
                if (item.kind === 'event') {
                  const evt = item.data;
                  const key = makeSelectionKey('event', evt.id);
                  const isSelected = selectionMode && !!selectedKeys?.has(key);
                  return (
                    <div
                      key={`evt_${evt.id}`}
                      className={`month-chip month-chip-event ${evt.isFreeTime ? 'free-time' : ''} ${evt.canEdit === false ? 'is-readonly' : ''} ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => (selectionMode ? onToggleSelectKey?.(key) : onSelectEvent?.(evt))}
                      onTouchStart={selectionMode ? undefined : (e) => longPressSelect.onTouchStart(e, key)}
                      title={evt.title}
                    >
                      {selectionMode && <input type="checkbox" className="bulk-select-checkbox" checked={isSelected} readOnly />}
                      {evt.title}
                    </div>
                  );
                }
                if (item.kind === 'cluster') {
                  // "N short tasks" cluster — clicking it in selection mode
                  // selects every underlying block at once (see this
                  // feature's cluster/overflow-chip note), not the chip
                  // itself (there's no chip-level entity to select).
                  const clusterKeys = item.data.map((b) => makeSelectionKey('block', b.id));
                  const allSelected = selectionMode && clusterKeys.every((k) => selectedKeys?.has(k));
                  return (
                    <div
                      key={`cluster_${i}`}
                      className={`month-chip month-chip-cluster ${allSelected ? 'is-selected' : ''}`}
                      onClick={() => (selectionMode ? onSelectManyKeys?.(clusterKeys) : onSelectDay?.(day))}
                      title={`${item.data.length} short tasks`}
                    >
                      {selectionMode && <input type="checkbox" className="bulk-select-checkbox" checked={allSelected} readOnly />}
                      {item.data.length} short tasks
                    </div>
                  );
                }
                const block = item.data;
                const task = taskById[block.taskId];
                if (!task) return null;
                // A sub-task's chip shows its PARENT task's name instead of its
                // own — the parent is the user-facing "goal" here, the actual
                // sub-task title is only revealed once the chip is opened (see
                // BlockDetailModal) — see WeekView for the same treatment.
                const parentTask = task.parentId ? taskById[task.parentId] : null;
                const displayTitle = parentTask?.title || task.title;
                const key = makeSelectionKey('block', block.id);
                const isSelected = selectionMode && !!selectedKeys?.has(key);
                return (
                  <div
                    key={`blk_${block.id}`}
                    className={`month-chip ${isSelected ? 'is-selected' : ''}`}
                    style={{ borderLeftColor: priorityColor(task.priority) }}
                    onClick={() => (selectionMode ? onToggleSelectKey?.(key) : onSelectBlock?.(block))}
                    onTouchStart={selectionMode ? undefined : (e) => longPressSelect.onTouchStart(e, key)}
                    title={`${displayTitle} · ${block.startTime}–${block.endTime}`}
                  >
                    {selectionMode && <input type="checkbox" className="bulk-select-checkbox" checked={isSelected} readOnly />}
                    {displayTitle}
                  </div>
                );
              })}
            </div>
            {hiddenCount > 0 && (
              <button
                className="month-chip month-chip-more"
                // "+N more" represents EVERY item in this day cell (visible
                // + hidden) — clicking it in selection mode selects all of
                // them at once, same "represents several underlying items"
                // treatment as the short-task cluster chip above. Rendered
                // as a sibling of .month-cell-items (not inside it) so it
                // never competes with the visible chips for the same
                // clipped flex space — a cramped cell shrinks/clips the
                // chips above it, never this overflow indicator itself.
                onClick={() => (selectionMode ? onSelectManyKeys?.(allDayKeys) : onSelectDay?.(day))}
              >
                +{hiddenCount} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

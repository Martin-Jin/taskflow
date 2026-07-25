/**
 * ============================================================================
 * WeekView
 * ============================================================================
 * The primary interactive calendar surface. Renders a 7-day time grid
 * (06:00-24:00, the full day) with ScheduledBlocks and CalendarEvents
 * positioned absolutely by time.
 *
 * Interaction model:
 *   - Drag a block to a new day/time -> updateBlock() with new date/times.
 *   - Drag the bottom edge of a block -> resize (change duration).
 *   - Click the lock icon -> toggleBlockLock() so the rebalance engine will
 *     never move it again.
 *   - Click a block -> opens BlockDetailModal for full editing.
 * ============================================================================
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Unlock, Wind } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { addDays, dateRange, dayOfWeek, formatDisplayDate, timeToMinutes, minutesToTime, toISODate } from '../../utils/dateUtils';
import { priorityColor } from '../../utils/priorityColor';
import { formatHours } from '../../utils/formatHours';

const GRID_START_MIN = 6 * 60; // 06:00
const GRID_END_MIN = 24 * 60; // 24:00
const SNAP_MIN = 15; // drag/resize snaps to 15-minute increments

// Ctrl+scroll / pinch zoom levels for the time axis, in px-per-minute.
// 0.8 (48px/hour) was the app's original fixed density; levels below it
// zoom out, levels above it zoom in further for finer control over densely
// packed days. Defaults to the top of the range (max zoom-in).
export const ZOOM_LEVELS_PX_PER_MIN = [0.55, 0.65, 0.8, 1.0, 1.25];
export const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS_PX_PER_MIN.length - 1;

// A run of tiny tasks (e.g. several 5-minute defaults back-to-back) renders
// as unreadable slivers if drawn individually — see clusterShortBlocks below.
const SHORT_BLOCK_MAX_MIN = 15; // blocks this short (or shorter) are cluster-eligible
const CLUSTER_MAX_GAP_MIN = 30; // merge short blocks separated by no more than this gap
const TWO_LINE_MIN_HEIGHT = 30; // below this px height, drop the time-range line rather than clip it

// Floor height for any single block/cluster, and the breathing room left
// between two boxes stacked back-to-back in the same lane — see packLane.
const MIN_BLOCK_HEIGHT_PX = 26;
const BLOCK_GAP_PX = 2;

const DOW_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Fixed viewport coordinates for a cluster's popover, anchored to the
// clicked chip's own bounding rect (see openCluster state in WeekView) —
// clamped so it never runs off-screen, and flipped above the chip when
// there isn't room below, matching how a native dropdown behaves.
const POPOVER_WIDTH = 260;
const POPOVER_EST_HEIGHT = 220;
const POPOVER_GAP = 6;
function computeClusterPopoverStyle(rect) {
  let left = rect.left;
  if (left + POPOVER_WIDTH > window.innerWidth - 8) left = window.innerWidth - POPOVER_WIDTH - 8;
  if (left < 8) left = 8;
  const fitsBelow = rect.bottom + POPOVER_GAP + POPOVER_EST_HEIGHT <= window.innerHeight - 8;
  return fitsBelow
    ? { left, top: rect.bottom + POPOVER_GAP }
    : { left, bottom: window.innerHeight - rect.top + POPOVER_GAP };
}

/**
 * Group consecutive short blocks (<= SHORT_BLOCK_MAX_MIN long, separated by
 * no more than CLUSTER_MAX_GAP_MIN) into a single "cluster" item so a run of
 * tiny tasks — several 5-minute defaults placed back-to-back, say — renders
 * as one readable chip ("4 short tasks") instead of a stack of slivers.
 * Passive tasks are left alone since they intentionally overlap other work
 * rather than sitting in a sequential run. Runs of exactly one short block
 * are left as a normal single item — nothing to cluster with.
 */
function clusterShortBlocks(items) {
  const out = [];
  let run = [];

  function flushRun() {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push({ kind: 'single', block: run[0].block, start: run[0].start, end: run[0].end });
    } else {
      out.push({
        kind: 'cluster',
        blocks: run.map((r) => r.block),
        start: run[0].start,
        end: run[run.length - 1].end,
      });
    }
    run = [];
  }

  for (const item of items) {
    const isShort = !item.block.isPassive && item.end - item.start <= SHORT_BLOCK_MAX_MIN;
    if (!isShort) {
      flushRun();
      out.push({ kind: 'single', block: item.block, start: item.start, end: item.end });
      continue;
    }
    if (run.length > 0 && item.start - run[run.length - 1].end > CLUSTER_MAX_GAP_MIN) flushRun();
    run.push(item);
  }
  flushRun();
  return out;
}

/**
 * Assign each item in a single day a {lane, totalLanes} pair so items that
 * overlap in time (normally impossible, but passive tasks are allowed to —
 * see allocator.js) render side-by-side instead of stacking on top of each
 * other. Items are grouped into "overlap groups" of mutually-overlapping
 * time ranges first, so a lane count only applies within the group it's
 * needed for — an unrelated item later in the day still gets full width.
 * Short blocks are pre-merged into cluster items (see clusterShortBlocks)
 * before lane assignment so a cluster occupies one lane like any other item.
 */
function layoutDayBlocks(dayBlocks) {
  const items = dayBlocks
    .map((block) => ({ block, start: timeToMinutes(block.startTime), end: timeToMinutes(block.endTime) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const clustered = clusterShortBlocks(items);

  const results = [];
  let overlapGroup = [];
  let groupEnd = -Infinity;

  function flushGroup() {
    if (overlapGroup.length === 0) return;
    const laneEnds = []; // end minute of the last item placed in each lane
    for (const item of overlapGroup) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      results.push({ ...item, lane });
    }
    const totalLanes = laneEnds.length;
    for (let i = results.length - overlapGroup.length; i < results.length; i++) results[i].totalLanes = totalLanes;
    overlapGroup = [];
  }

  for (const item of clustered) {
    if (overlapGroup.length === 0 || item.start < groupEnd) {
      overlapGroup.push(item);
      groupEnd = Math.max(groupEnd, item.end);
    } else {
      flushGroup();
      overlapGroup = [item];
      groupEnd = item.end;
    }
  }
  flushGroup();

  return results;
}

/**
 * Assign a final {top, height} in px to every item in a lane, guaranteeing
 * zero overlap no matter how many short items are packed back-to-back.
 * Each box's top is clamped to at least the *actual rendered* bottom of the
 * previous box in its lane (not just the next item's natural start time),
 * so a chain of short blocks/clusters pushes each subsequent box down as
 * far as needed — mirroring how Google Calendar visually stretches a dense
 * run of short meetings rather than letting their boxes collide.
 */
function packLane(items, pxPerMin) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  let prevBottom = -Infinity;
  return sorted.map((item) => {
    const naturalTop = (item.start - GRID_START_MIN) * pxPerMin;
    const naturalHeight = Math.max(MIN_BLOCK_HEIGHT_PX, (item.end - item.start) * pxPerMin);
    // Round to whole pixels so block edges land on the same pixel grid as
    // the hour lines (painted at integer --hour-height multiples) — left
    // unrounded, sub-hour offsets go fractional at non-default zoom levels
    // (e.g. 0.55 px/min -> 8.25px per 15min) and drift out of alignment.
    const top = Math.round(Math.max(naturalTop, prevBottom));
    const height = Math.round(naturalHeight);
    prevBottom = top + height + BLOCK_GAP_PX;
    return { ...item, top, height };
  });
}

/** Runs packLane independently within each lane so side-by-side (genuinely
 * overlapping-in-time) items don't interfere with each other's stacking. */
function computeDayPositions(items, pxPerMin) {
  const byLane = new Map();
  for (const item of items) {
    if (!byLane.has(item.lane)) byLane.set(item.lane, []);
    byLane.get(item.lane).push(item);
  }
  const out = [];
  for (const laneItems of byLane.values()) out.push(...packLane(laneItems, pxPerMin));
  return out;
}

export default function WeekView({
  weekStart,
  dayCount = 7,
  isMobile = false,
  pxPerMin,
  onZoomDelta,
  onSelectBlock,
  onSelectEvent,
  onCreateEvent,
}) {
  const { tasks, blocks, events, updateBlock, toggleBlockLock } = useScheduler();
  const days = useMemo(() => dateRange(weekStart, dayCount), [weekStart, dayCount]);
  const todayIso = toISODate(new Date());

  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);

  // Group once per `blocks`/`events` change rather than filtering the full
  // array once per visible day, and pre-compute each day's cluster/lane
  // layout with useMemo — this is otherwise redone on every render,
  // including every dragover event that fires continuously while dragging.
  const blocksByDay = useMemo(() => {
    const map = new Map();
    for (const b of blocks) {
      const list = map.get(b.date);
      if (list) list.push(b);
      else map.set(b.date, [b]);
    }
    return map;
  }, [blocks]);
  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      const list = map.get(e.date);
      if (list) list.push(e);
      else map.set(e.date, [e]);
    }
    return map;
  }, [events]);
  const dayBlocksByDay = useMemo(() => {
    const map = new Map();
    for (const day of days) {
      map.set(day, computeDayPositions(layoutDayBlocks(blocksByDay.get(day) || []), pxPerMin));
    }
    return map;
  }, [days, blocksByDay, pxPerMin]);

  const [dragState, setDragState] = useState(null); // { blockId, mode: 'move'|'resize' }
  const [dragOverDay, setDragOverDay] = useState(null);
  const [createDrag, setCreateDrag] = useState(null); // { day, startMin, currentMin } — drag-to-block-out-time
  const gridRef = useRef(null);

  // Ctrl+scroll / trackpad-pinch zoom. JSX's onWheel is attached passively by
  // React, so preventDefault() there is silently ignored — a native listener
  // with {passive:false} is required to actually stop the page from zooming.
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !onZoomDelta) return;
    function onWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoomDelta(e.deltaY < 0 ? 1 : -1);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoomDelta]);

  // Transient "48px/hr" pill, shown whenever pxPerMin actually changes (i.e.
  // the zoom level took effect) rather than inside the wheel handler itself
  // — the handler's own closure still sees the pre-zoom value, so deriving
  // the hint from the prop change is what keeps it in sync with what's
  // actually on screen.
  const [zoomHint, setZoomHint] = useState(null);
  const zoomHintTimer = useRef(null);
  const skipFirstHint = useRef(true);
  useEffect(() => {
    if (skipFirstHint.current) {
      skipFirstHint.current = false;
      return;
    }
    setZoomHint(`${Math.round(pxPerMin * 60)}px/hr`);
    clearTimeout(zoomHintTimer.current);
    zoomHintTimer.current = setTimeout(() => setZoomHint(null), 1200);
  }, [pxPerMin]);
  useEffect(() => () => clearTimeout(zoomHintTimer.current), []);

  // Which short-task cluster chip (see clusterShortBlocks) has its popover
  // open, plus the chip's own viewport rect at click time so the popover can
  // be positioned as a fixed-position overlay (portal'd to <body>) rather
  // than absolutely inside the densely-packed day column — anchoring it to
  // the chip's DOM box instead means it's never obscured by, or blended
  // into, whatever's scheduled immediately after it in the same lane.
  const [openCluster, setOpenCluster] = useState(null); // { key, rect }
  const clusterPopoverRef = useRef(null);
  useEffect(() => {
    if (!openCluster) return;
    function onDocMouseDown(e) {
      if (clusterPopoverRef.current && !clusterPopoverRef.current.contains(e.target)) setOpenCluster(null);
    }
    // A portal'd fixed-position popover would otherwise float away from its
    // chip the instant the grid (or the page) scrolls — simplest correct
    // behavior is to just close it, same as an outside click. But the
    // popover's own item list can scroll internally (capture:true on window
    // means even that non-bubbling scroll reaches this listener), and that
    // shouldn't close it.
    function onScroll(e) {
      if (clusterPopoverRef.current && clusterPopoverRef.current.contains(e.target)) return;
      setOpenCluster(null);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    gridRef.current?.addEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      gridRef.current?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [openCluster]);

  // Live "now" line — recomputed every 30s so it visibly creeps down the
  // current day's column like Google Calendar's own current-time indicator.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNowLine = nowMinutes >= GRID_START_MIN && nowMinutes <= GRID_END_MIN;

  const hourMarks = useMemo(() => {
    const marks = [];
    for (let m = GRID_START_MIN; m <= GRID_END_MIN; m += 60) marks.push(m);
    return marks;
  }, []);

  const gridHeight = (GRID_END_MIN - GRID_START_MIN) * pxPerMin;
  // Rounded to whole pixels so event/now-line edges land on the same pixel
  // grid as the hour lines (see packLane's matching rounding, above).
  const timeToY = (hhmm) => Math.round((timeToMinutes(hhmm) - GRID_START_MIN) * pxPerMin);

  // --- Drag handlers (native HTML5 DnD for cross-day moves) -----------------
  function handleDragStart(e, block) {
    if (block.isLocked) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', block.id);
    setDragState({ blockId: block.id, mode: 'move' });
  }

  function handleDragOverDay(e, day) {
    e.preventDefault();
    setDragOverDay(day);
  }

  function handleDropOnDay(e, day) {
    e.preventDefault();
    const blockId = e.dataTransfer.getData('text/plain');
    const block = blocks.find((b) => b.id === blockId);
    setDragOverDay(null);
    if (!block) return;

    // Determine drop Y position relative to the day column to compute new start time.
    const columnEl = e.currentTarget;
    const rect = columnEl.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    let newStartMin = GRID_START_MIN + relY / pxPerMin;
    newStartMin = Math.round(newStartMin / SNAP_MIN) * SNAP_MIN;

    const duration = timeToMinutes(block.endTime) - timeToMinutes(block.startTime);
    // Clamp so a drop near either edge of the grid can't push the block's
    // start before GRID_START_MIN or its end past GRID_END_MIN, which would
    // otherwise produce an out-of-range "HH:MM" string (e.g. "24:15") that
    // corrupts every downstream time comparison.
    newStartMin = Math.min(Math.max(newStartMin, GRID_START_MIN), GRID_END_MIN - duration);
    const newEndMin = newStartMin + duration;

    updateBlock(block.id, {
      date: day,
      startTime: minutesToTime(newStartMin),
      endTime: minutesToTime(newEndMin),
      isAutoScheduled: false,
    });
  }

  // --- Resize handlers (mouse-based, vertical only) --------------------------
  function handleResizeStart(e, block) {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const originalEndMin = timeToMinutes(block.endTime);

    function onMove(moveEvent) {
      const deltaY = moveEvent.clientY - startY;
      const deltaMin = Math.round(deltaY / pxPerMin / SNAP_MIN) * SNAP_MIN;
      let newEndMin = originalEndMin + deltaMin;
      newEndMin = Math.min(Math.max(timeToMinutes(block.startTime) + SNAP_MIN, newEndMin), GRID_END_MIN);
      const el = document.getElementById(`block-${block.id}`);
      if (el) el.style.height = `${(newEndMin - timeToMinutes(block.startTime)) * pxPerMin}px`;
    }

    function onUp(upEvent) {
      const deltaY = upEvent.clientY - startY;
      const deltaMin = Math.round(deltaY / pxPerMin / SNAP_MIN) * SNAP_MIN;
      let newEndMin = originalEndMin + deltaMin;
      newEndMin = Math.min(Math.max(timeToMinutes(block.startTime) + SNAP_MIN, newEndMin), GRID_END_MIN);
      updateBlock(block.id, { endTime: minutesToTime(newEndMin), isAutoScheduled: false });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // --- Drag-to-block-out-time (mousedown+drag on empty grid space) ----------
  // Only fires when the mousedown lands directly on the day-column element
  // itself (not one of its absolutely-positioned block/event children), so
  // it never fights with dragging an existing block or clicking an event.
  function handleColumnMouseDown(e, day) {
    if (isMobile || e.target !== e.currentTarget || e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();

    function minuteFromEvent(evt) {
      const relY = evt.clientY - rect.top;
      return Math.round((GRID_START_MIN + relY / pxPerMin) / SNAP_MIN) * SNAP_MIN;
    }

    const startMin = minuteFromEvent(e);
    // Track the live drag extent in a plain closure variable rather than
    // reading state back — `onCreateEvent` below needs to fire as its own
    // top-level setState call once the drag ends, not nested inside another
    // component's state updater function (which React flags as "setState
    // while rendering a different component").
    let currentMin = startMin + SNAP_MIN;
    setCreateDrag({ day, startMin, currentMin });

    function onMove(moveEvent) {
      currentMin = minuteFromEvent(moveEvent);
      setCreateDrag({ day, startMin, currentMin });
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setCreateDrag(null);
      const from = Math.min(startMin, currentMin);
      const to = Math.max(startMin, currentMin, startMin + SNAP_MIN);
      onCreateEvent?.(day, minutesToTime(from), minutesToTime(to));
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className="week-grid"
      ref={gridRef}
      style={{
        gridTemplateRows: `auto ${gridHeight}px`,
        gridTemplateColumns: `56px repeat(${dayCount}, 1fr)`,
        '--hour-height': `${pxPerMin * 60}px`,
      }}
    >
      {zoomHint && <div className="zoom-hint">{zoomHint}</div>}
      <div className="time-gutter-cell" />
      {days.map((day, i) => (
        <div key={day} className={`day-header ${day === todayIso ? 'today' : ''} ${i === days.length - 1 ? 'is-last-col' : ''}`}>
          <div className="dow">{DOW_LABELS[dayOfWeek(day)]}</div>
          <div className="dom">{day.slice(8, 10)}</div>
        </div>
      ))}

      <div style={{ position: 'relative', height: gridHeight }}>
        {hourMarks.map((m) => (
          <div
            key={m}
            className="time-label"
            style={{ position: 'absolute', top: Math.max(0, (m - GRID_START_MIN) * pxPerMin - 6), right: 0 }}
          >
            {minutesToTime(m)}
          </div>
        ))}
      </div>

      {days.map((day) => {
        const dayBlocks = dayBlocksByDay.get(day) || [];
        const dayEvents = eventsByDay.get(day) || [];
        return (
          <div
            key={day}
            className={`day-column ${dragOverDay === day ? 'is-dragover' : ''}`}
            style={{ height: gridHeight }}
            onDragOver={(e) => handleDragOverDay(e, day)}
            onDragLeave={() => setDragOverDay(null)}
            onDrop={(e) => handleDropOnDay(e, day)}
            onMouseDown={(e) => handleColumnMouseDown(e, day)}
          >
            {showNowLine && day === todayIso && (
              <div className="now-line" style={{ top: timeToY(minutesToTime(nowMinutes)) }}>
                <span className="now-line-dot" />
              </div>
            )}

            {createDrag && createDrag.day === day && (
              <div
                className="cal-event-ghost"
                style={{
                  top: timeToY(minutesToTime(Math.min(createDrag.startMin, createDrag.currentMin))),
                  height: Math.max(
                    20,
                    (Math.max(createDrag.startMin, createDrag.currentMin) - Math.min(createDrag.startMin, createDrag.currentMin)) * pxPerMin
                  ),
                }}
              >
                Block time
              </div>
            )}

            {dayEvents.map((evt) => (
              <div
                key={evt.id}
                className={`cal-event ${evt.isFreeTime ? 'free-time' : ''} ${evt.source === 'manual' ? 'manual' : ''}`}
                style={{ top: timeToY(evt.startTime), height: Math.max(20, timeToY(evt.endTime) - timeToY(evt.startTime)) }}
                title={evt.isFreeTime ? `${evt.title} (marked as free time — schedulable)` : evt.title}
                onClick={() => onSelectEvent?.(evt)}
              >
                {evt.title}
              </div>
            ))}

            {dayBlocks.map((item) => {
              const { lane, totalLanes } = item;
              // Blocks side-by-side within an overlap group — see
              // layoutDayBlocks above. totalLanes is 1 for the common case
              // (no overlap), so this is a no-op then.
              const laneWidthPct = 100 / totalLanes;
              const laneStyle =
                totalLanes > 1
                  ? { left: `calc(3px + ${lane * laneWidthPct}%)`, right: 'auto', width: `calc(${laneWidthPct}% - 6px)` }
                  : null;

              if (item.kind === 'cluster') {
                const clusterKey = `${day}_${item.start}`;
                const totalMinutes = item.blocks.reduce(
                  (sum, b) => sum + (timeToMinutes(b.endTime) - timeToMinutes(b.startTime)),
                  0
                );
                // top/height are pre-packed by computeDayPositions so this
                // box can never overlap whatever comes before/after it in
                // its lane, regardless of how many short items are chained.
                const { top, height } = item;
                // Below TWO_LINE_MIN_HEIGHT there isn't room for both the
                // title and time-range lines, so the time line is dropped
                // rather than left to clip into the block below.
                const showTimeLine = height >= TWO_LINE_MIN_HEIGHT;
                const isOpen = openCluster?.key === clusterKey;
                return (
                  <div
                    key={clusterKey}
                    className={`cal-block cal-cluster ${isOpen ? 'is-open' : ''}`}
                    style={{ top, height, ...laneStyle }}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isOpen) {
                        setOpenCluster(null);
                      } else {
                        setOpenCluster({ key: clusterKey, rect: e.currentTarget.getBoundingClientRect(), blocks: item.blocks });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (isOpen) {
                          setOpenCluster(null);
                        } else {
                          setOpenCluster({ key: clusterKey, rect: e.currentTarget.getBoundingClientRect(), blocks: item.blocks });
                        }
                      }
                    }}
                    title={`${item.blocks.length} short tasks · ${minutesToTime(item.start)}–${minutesToTime(item.end)}`}
                  >
                    <div className="cal-block-title">{item.blocks.length} short tasks</div>
                    {showTimeLine && (
                      <div className="cal-block-time">
                        {minutesToTime(item.start)}–{minutesToTime(item.end)} · {formatHours(totalMinutes / 60)}
                      </div>
                    )}
                  </div>
                );
              }

              const { block, top, height } = item;
              const task = taskById[block.taskId];
              if (!task) return null;
              const showTimeLine = height >= TWO_LINE_MIN_HEIGHT;
              return (
                <div
                  key={block.id}
                  id={`block-${block.id}`}
                  className={`cal-block ${block.isLocked ? 'locked' : ''} ${isMobile ? 'is-mobile' : ''} ${block.isPassive ? 'passive' : ''}`}
                  style={{
                    top,
                    height,
                    borderLeftColor: priorityColor(task.priority),
                    ...laneStyle,
                  }}
                  draggable={!isMobile && !block.isLocked}
                  onDragStart={isMobile ? undefined : (e) => handleDragStart(e, block)}
                  onClick={() => onSelectBlock?.(block)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectBlock?.(block);
                    }
                  }}
                  title={`${task.title}${block.isPassive ? ' (runs unattended)' : ''} · ${block.startTime}–${block.endTime}`}
                >
                  <button
                    className="lock-indicator"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBlockLock(block.id);
                    }}
                    title={block.isLocked ? 'Unlock block (allow rebalancing)' : 'Lock block (protect from rebalancing)'}
                  >
                    {block.isLocked ? <Lock size={11} /> : <Unlock size={11} />}
                  </button>
                  <div className="cal-block-title">
                    {block.isPassive && <Wind size={12} style={{ verticalAlign: -2, marginRight: 3 }} />}
                    {task.title}
                  </div>
                  {showTimeLine && (
                    <div className="cal-block-time">
                      {block.startTime}–{block.endTime}
                    </div>
                  )}
                  {!isMobile && !block.isLocked && (
                    <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, block)} />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {openCluster &&
        createPortal(
          <div
            className="cal-cluster-popover"
            ref={clusterPopoverRef}
            style={{ position: 'fixed', ...computeClusterPopoverStyle(openCluster.rect) }}
            onClick={(e) => e.stopPropagation()}
          >
            {openCluster.blocks.map((b) => {
              const t = taskById[b.taskId];
              if (!t) return null;
              return (
                <button
                  key={b.id}
                  className="cal-cluster-popover-item"
                  onClick={() => {
                    setOpenCluster(null);
                    onSelectBlock?.(b);
                  }}
                >
                  <span className="cal-cluster-popover-time">
                    {b.startTime}–{b.endTime}
                  </span>
                  <span className="cal-cluster-popover-title">{t.title}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

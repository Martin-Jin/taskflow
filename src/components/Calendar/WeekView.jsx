/**
 * ============================================================================
 * WeekView
 * ============================================================================
 * The primary interactive calendar surface. Renders a 1/3/7-day time grid
 * (06:00-24:00, 18 of the 24 hours — a block/event starting before 06:00
 * would render off the top of the grid; column count set by `dayCount` —
 * Day/3 Day/Week in CalendarPage all render this same component) with ScheduledBlocks
 * and CalendarEvents positioned absolutely by time.
 *
 * Interaction model:
 *   - Click a day-of-week/day-of-month header -> onSelectDay jumps the
 *     calendar into Day view on that date, same as MonthView's day cells.
 *   - Drag a block or event to a new day/time -> updateBlock()/updateEvent()
 *     with new date/times. Desktop uses native HTML5 DnD (mouse); mobile has
 *     no such API, so touch gets its own long-press-then-drag path instead
 *     (see handleItemTouchStart) — a normal short tap still just selects.
 *     A read-only event (`canEdit === false` — a subscribed/shared calendar
 *     the user can't write to on Google) isn't draggable/resizable for the
 *     same reason a locked block isn't: updateEvent would try to push the
 *     change to Google and fail.
 *   - Drag the bottom edge of a block or event -> resize (change duration),
 *     via mouse or touch (see handleResizeStart).
 *   - Click the lock icon -> toggleBlockLock() so the rebalance engine will
 *     never move it again. Events have no lock concept.
 *   - Click a block/event -> opens its detail modal for full editing.
 *   - Two or more overlapping blocks/events pack into side-by-side lanes;
 *     any that are shorter than 30min collapse into a single "N events"
 *     chip instead (mobile's narrow columns make this matter most, but the
 *     same 30min cutoff applies on desktop too) — see layoutDayItems.
 * ============================================================================
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Unlock, Wind, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { addDays, dateRange, dayOfWeek, formatDisplayDate, timeToMinutes, minutesToTime, toISODate } from '../../utils/dateUtils';
import { expandRecurringEvent, resolveEventId } from '../../utils/recurrenceExpansion';
import { priorityColor } from '../../utils/priorityColor';
import { formatHours } from '../../utils/formatHours';
import { SHORT_BLOCK_MAX_MIN, groupItemsByDay } from '../../utils/calendarGrouping';
import { areDependenciesMet } from '../../utils/dependencyUtils';
import { isBlockCompletedLate, isBlockTaskCompleted } from '../../utils/missedTasks';
import HoverPreviewCard from './HoverPreviewCard';

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
// (SHORT_BLOCK_MAX_MIN itself lives in calendarGrouping.js, shared with MonthView.)
const CLUSTER_MAX_GAP_MIN = 30; // merge short blocks separated by no more than this gap
const TWO_LINE_MIN_HEIGHT = 36; // below this px height, drop the time-range line rather than clip it (title line + time line + padding needs ~35px)
// A sub-task's block gets an extra "parent task" subtitle line (see the
// block render below) — below this height there isn't room for title +
// parent line + time line together, so the time line is dropped in favor
// of the parent context, which is the more useful of the two at a glance.
const THREE_LINE_MIN_HEIGHT = 50;

// Within an overlap group (see layoutDayItems), an item this long or longer
// always gets its own visible side-by-side lane, even if it overlaps
// something shorter. Items below this duration are candidates to fold into
// an "N events" chip alongside other short items they actually overlap.
// Applies to a whole `kind: 'cluster'` run's own span, not its individual
// blocks — a cluster is already one unit by the time layoutDayItems sees it.
const LONG_ITEM_MIN = 30;

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
 *
 * Operates on generic `{ type: 'block'|'event', data, start, end }` items.
 * Events are never cluster-eligible (folding a real user event's title into
 * an anonymous "N short tasks" chip would hide it), so this only ever groups
 * `type === 'block'` items — the resulting `kind: 'cluster'` item's `.blocks`
 * array is therefore always `ScheduledBlock[]`.
 */
function clusterShortBlocks(items) {
  const out = [];
  let run = [];

  function flushRun() {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push({ kind: 'single', type: run[0].type, data: run[0].data, start: run[0].start, end: run[0].end });
    } else {
      out.push({
        kind: 'cluster',
        blocks: run.map((r) => r.data),
        start: run[0].start,
        end: run[run.length - 1].end,
      });
    }
    run = [];
  }

  for (const item of items) {
    const isShort = item.type === 'block' && !item.data.isPassive && item.end - item.start <= SHORT_BLOCK_MAX_MIN;
    if (!isShort) {
      flushRun();
      out.push({ kind: 'single', type: item.type, data: item.data, start: item.start, end: item.end });
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
 *
 * `dayItems` is a generic `{ type: 'block'|'event', data, start, end }[]`
 * (blocks and events already merged, see dayItemsByDay) — the caller is
 * responsible for computing `start`/`end` via timeToMinutes beforehand.
 *
 * Side-by-side lanes get thin on both mobile and (to a lesser extent)
 * desktop once 3+ items overlap, so within each overlap group, items whose
 * OWN duration is under LONG_ITEM_MIN are further split out and re-grouped
 * by mutual overlap *among themselves* (a gap between two short items is
 * only "one group" if a long item happens to bridge them into the same
 * overlap group — removing the long item can split them into two
 * time-disjoint short-runs, which must become two separate chips, not one
 * spanning the gap). Each short-run of 2+ collapses into a single synthetic
 * `kind: 'overlapChip'` item (a tappable "N events" chip, see WeekView's
 * render); a short-run of exactly 1 stays a normal item — nothing to
 * collapse into. Items >= LONG_ITEM_MIN always keep an individual lane,
 * whether that's alongside something shorter or another long item.
 * Long items and chips are then lane-packed together in one pass (sorted by
 * start) so a chip that overlaps a long item in time still gets a distinct
 * lane rather than visually colliding with it.
 */
function layoutDayItems(dayItems) {
  const items = [...dayItems].sort((a, b) => a.start - b.start || a.end - b.end);

  const clustered = clusterShortBlocks(items);

  const results = [];
  let overlapGroup = [];
  let groupEnd = -Infinity;

  function packLanes(laneItems) {
    const laneEnds = []; // end minute of the last item placed in each lane
    for (const item of laneItems) {
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
    for (let i = results.length - laneItems.length; i < results.length; i++) results[i].totalLanes = totalLanes;
  }

  function flushGroup() {
    if (overlapGroup.length === 0) return;

    const longItems = overlapGroup.filter((it) => it.end - it.start >= LONG_ITEM_MIN);
    const shortItems = overlapGroup.filter((it) => it.end - it.start < LONG_ITEM_MIN);

    // Re-sweep just the short items (already start-sorted, as a subsequence
    // of `clustered`) for their own mutual-overlap runs, independent of any
    // long item(s) that pulled them into the same overlapGroup.
    const laneItems = [...longItems];
    let shortRun = [];
    let shortRunEnd = -Infinity;
    function flushShortRun() {
      if (shortRun.length === 0) return;
      if (shortRun.length === 1) {
        laneItems.push(shortRun[0]);
      } else {
        laneItems.push({
          kind: 'overlapChip',
          items: shortRun.map((g) => ({ type: g.type, data: g.data, kind: g.kind, blocks: g.blocks })),
          start: Math.min(...shortRun.map((g) => g.start)),
          end: Math.max(...shortRun.map((g) => g.end)),
        });
      }
      shortRun = [];
    }
    for (const item of shortItems) {
      if (shortRun.length === 0 || item.start < shortRunEnd) {
        shortRun.push(item);
        shortRunEnd = Math.max(shortRunEnd, item.end);
      } else {
        flushShortRun();
        shortRun = [item];
        shortRunEnd = item.end;
      }
    }
    flushShortRun();

    laneItems.sort((a, b) => a.start - b.start);
    packLanes(laneItems);
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

/**
 * Shared drop-position math used by both the mouse (native HTML5 DnD) and
 * touch (long-press) drag paths (see handleDropOnDay / handleItemTouchStart)
 * — converts a Y position relative to a day column's own bounding rect into
 * a 15-minute-snapped start minute, clamped so the moved item's new start
 * can never push its end past GRID_END_MIN (or its start before
 * GRID_START_MIN), which would otherwise produce an out-of-range "HH:MM"
 * string (e.g. "24:15") that corrupts every downstream time comparison.
 */
function computeSnappedStartMinute(relY, pxPerMin, duration) {
  // relY is the cursor/finger's Y position, which should land at the
  // dragged block's CENTER rather than its top edge — otherwise the block
  // visibly jumps to put its top under the cursor, offset by however far
  // below the top the user originally grabbed it.
  let newStartMin = GRID_START_MIN + relY / pxPerMin - duration / 2;
  newStartMin = Math.round(newStartMin / SNAP_MIN) * SNAP_MIN;
  return Math.min(Math.max(newStartMin, GRID_START_MIN), GRID_END_MIN - duration);
}

/** Normalizes a mouse OR touch event down to its clientY, so drag/resize
 * handlers can be wired to both `mousemove`/`mouseup` and `touchmove`/
 * `touchend` without duplicating the math for each input type. */
function getClientY(evt) {
  return evt.touches?.[0]?.clientY ?? evt.changedTouches?.[0]?.clientY ?? evt.clientY;
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
  onSelectDay,
}) {
  const { tasks, blocks, events, projects, updateBlock, toggleBlockLock, updateEvent, scheduleTaskManually, manualPlanTodayMode } = useScheduler();
  const days = useMemo(() => dateRange(weekStart, dayCount), [weekStart, dayCount]);
  const todayIso = toISODate(new Date());

  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  // "Unscheduled" tray (below) — tasks with unplaced work the user can drag
  // (or, on touch, long-press-drag) straight onto a day column to place a
  // block manually, instead of waiting for Re-balance/Plan today. Mirrors
  // rebalanceEngine's own schedulability rules (container parents and
  // undated top-level tasks are never directly schedulable; a task with
  // unmet dependencies is held back) so this tray never offers something the
  // engine itself wouldn't consider real, placeable work.
  //
  // IMPORTANT: `task.remainingHours` is NOT live-updated as blocks get
  // placed (rebalance/planToday only ever recompute a throwaway local value
  // for their own allocation math — see rebalanceEngine.js — the persisted
  // field only changes on task create/complete/estimate-edit). Using it
  // directly here would keep every task in the tray forever, even once it's
  // fully covered by existing blocks. Instead, `unplacedHours` below is
  // computed fresh from `estimatedHours` minus whatever's ALREADY on the
  // calendar for that task (any block, any date, locked or not) — the same
  // "spent hours" idea rebalanceEngine uses, just against every existing
  // block rather than only historical+locked ones, since (unlike a full
  // rebalance) nothing here is about to wipe and replan those blocks.
  const unscheduledTasks = useMemo(() => {
    const parentIds = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId));
    const taskByIdMap = new Map(tasks.map((t) => [t.id, t])); // areDependenciesMet needs a Map, unlike the plain-object taskById above
    const scheduledHoursByTask = new Map();
    for (const b of blocks) {
      scheduledHoursByTask.set(b.taskId, (scheduledHoursByTask.get(b.taskId) || 0) + b.durationHours);
    }
    return tasks
      .filter(
        (t) =>
          !t.isLocked &&
          !t.isCompleted &&
          !(t.isRecurring && t.completedDates?.includes(todayIso)) &&
          !parentIds.has(t.id) &&
          (!!t.dueDate || !!t.parentId) &&
          areDependenciesMet(t, taskByIdMap)
      )
      .map((t) => ({ ...t, unplacedHours: Math.max(0, t.estimatedHours - (scheduledHoursByTask.get(t.id) || 0)) }))
      .filter((t) => t.unplacedHours > 0)
      .sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31'));
  }, [tasks, blocks]);
  const unscheduledTaskById = useMemo(() => new Map(unscheduledTasks.map((t) => [t.id, t])), [unscheduledTasks]);
  const [trayExpanded, setTrayExpanded] = useState(true);

  // Group once per `blocks`/`events` change rather than filtering the full
  // array once per visible day, and pre-compute each day's cluster/lane
  // layout with useMemo — this is otherwise redone on every render,
  // including every dragover event that fires continuously while dragging.
  const { blocksByDay, eventsByDay } = useMemo(() => groupItemsByDay(blocks, events, days), [blocks, events, days]);
  // Blocks and events are laid out together (one lane-packing pass sees
  // both) so an overlapping block+event pair packs into side-by-side lanes
  // (or, if short enough, collapses into one "N events" chip) exactly like
  // two overlapping blocks would — see layoutDayItems. isMobile isn't part
  // of this computation itself (both platforms share the same lane/chip
  // layout now) — only the render below branches on it, for styling.
  const dayItemsByDay = useMemo(() => {
    const map = new Map();
    for (const day of days) {
      const blockItems = (blocksByDay.get(day) || []).map((b) => ({
        type: 'block',
        data: b,
        start: timeToMinutes(b.startTime),
        end: timeToMinutes(b.endTime),
      }));
      const eventItems = (eventsByDay.get(day) || []).map((e) => ({
        type: 'event',
        data: e,
        start: timeToMinutes(e.startTime),
        end: timeToMinutes(e.endTime),
      }));
      const merged = [...blockItems, ...eventItems].sort((a, b) => a.start - b.start || a.end - b.end);
      map.set(day, computeDayPositions(layoutDayItems(merged), pxPerMin));
    }
    return map;
  }, [days, blocksByDay, eventsByDay, pxPerMin]);

  // Live drag/resize feedback state. `dragState` marks the item currently
  // being moved (mouse or touch) so it can be styled as lifted out of the
  // grid, and carries its duration so a drop target's ghost knows how tall
  // to be; `dragPreview` is that ghost — the snapped slot the item would
  // land in, labelled with its would-be start–end time; `resizePreview`
  // drives the live height and time readout of the item being resized.
  const [dragState, setDragState] = useState(null); // { id, type, duration }
  const [dragOverDay, setDragOverDay] = useState(null);
  const [createDrag, setCreateDrag] = useState(null); // { day, startMin, currentMin } — drag-to-block-out-time
  const [dragPreview, setDragPreview] = useState(null); // { day, startMin, duration }
  const [resizePreview, setResizePreview] = useState(null); // { id, type, endMin }
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

  // Two-finger pinch zoom (mobile). Mirrors the ctrl+wheel path above but
  // driven by the distance between the two touch points instead of wheel
  // delta — each time that distance grows/shrinks past a fixed ratio from
  // where it last stepped, we bump the zoom index by one and reset the
  // baseline, so a long pinch can walk through several zoom levels.
  const pinchRef = useRef(null); // { lastDist } while exactly 2 touches are down
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !onZoomDelta) return;
    const PINCH_STEP_RATIO = 1.15;
    function touchDist(touches) {
      const [a, b] = touches;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function onTouchStart(e) {
      if (e.touches.length === 2) pinchRef.current = { lastDist: touchDist(e.touches) };
    }
    function onTouchMove(e) {
      if (e.touches.length !== 2 || !pinchRef.current) return;
      // Non-passive so this can actually stop the browser's own page-zoom
      // gesture from firing alongside our own (see the wheel handler above
      // for the same passive-listener caveat).
      if (e.cancelable) e.preventDefault();
      const dist = touchDist(e.touches);
      const ratio = dist / pinchRef.current.lastDist;
      if (ratio >= PINCH_STEP_RATIO) {
        onZoomDelta(1);
        pinchRef.current.lastDist = dist;
      } else if (ratio <= 1 / PINCH_STEP_RATIO) {
        onZoomDelta(-1);
        pinchRef.current.lastDist = dist;
      }
    }
    function onTouchEnd(e) {
      if (e.touches.length < 2) pinchRef.current = null;
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
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

  // Desktop-only hover preview (see HoverPreviewCard) for a single block/event
  // whose title may be truncated in its compact grid box — shows the full
  // title/time/priority/project without opening the detail modal. Mobile has
  // no hover concept, so this is only ever wired up when !isMobile below.
  // A short delay avoids a flash of preview cards while the pointer merely
  // passes over several densely-packed items on its way somewhere else.
  const [hoverPreview, setHoverPreview] = useState(null); // { rect, ...content }
  const hoverTimer = useRef(null);
  const HOVER_DELAY_MS = 350;
  function scheduleHoverPreview(rect, content) {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverPreview({ rect, ...content }), HOVER_DELAY_MS);
  }
  function cancelHoverPreview() {
    clearTimeout(hoverTimer.current);
    setHoverPreview(null);
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // The card is anchored to a rect captured at hover time — once the grid (or
  // the page) scrolls, that rect is stale, so just drop the preview rather
  // than let it float away from the item it's describing.
  useEffect(() => {
    if (!hoverPreview) return;
    function onScroll() {
      cancelHoverPreview();
    }
    gridRef.current?.addEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      gridRef.current?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [hoverPreview]);

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

  // --- Drag handlers (native HTML5 DnD for cross-day moves, mouse/desktop) ---
  // `item` is one of dayItemsByDay's `{ type: 'block'|'event', data, ... }`
  // entries — generalized so a block and an event share the exact same
  // move/resize math, only branching on `type` at the point they call back
  // into SchedulerContext (updateBlock vs updateEvent).
  function handleDragStart(e, item) {
    cancelHoverPreview();
    if (item.type === 'block' && item.data.isLocked) {
      e.preventDefault();
      return;
    }
    // A completed task's block is frozen in place as a historical record —
    // dragging it to a new time wouldn't make sense once the work is done.
    if (item.type === 'block' && isBlockTaskCompleted(item.data, taskById[item.data.taskId])) {
      e.preventDefault();
      return;
    }
    // Read-only events (calendars the user can't write to on Google) mustn't
    // be movable here either — dragging calls updateEvent below just like
    // the detail modal's Save does, which would attempt to push a change
    // to a calendar the user doesn't own. Mirrors the isLocked check above.
    if (item.type === 'event' && item.data.canEdit === false) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.data.id, type: item.type }));
    setDragState({
      id: item.data.id,
      type: item.type,
      duration: timeToMinutes(item.data.endTime) - timeToMinutes(item.data.startTime),
    });
  }

  function endDrag() {
    setDragOverDay(null);
    setDragState(null);
    setDragPreview(null);
  }

  function handleDragOverDay(e, day) {
    e.preventDefault();
    setDragOverDay(day);
    // The payload isn't readable during dragover (only on drop), so the
    // ghost's size comes from dragState instead — which also means a drag
    // that didn't start in this grid simply gets no preview.
    if (!dragState) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const startMin = computeSnappedStartMinute(e.clientY - rect.top, pxPerMin, dragState.duration);
    // dragover fires continuously for as long as the pointer is over the
    // column; returning the previous object unchanged when the snapped slot
    // hasn't actually moved lets React bail out of the re-render entirely,
    // so the whole grid only reconciles once per 15-minute step.
    setDragPreview((prev) =>
      prev && prev.day === day && prev.startMin === startMin && prev.duration === dragState.duration
        ? prev
        : { day, startMin, duration: dragState.duration }
    );
  }

  /** Drag source for an "Unscheduled" tray chip — see applyDrop's 'task'
   * branch for what happens on drop. */
  function handleTaskChipDragStart(e, task) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ id: task.id, type: 'task' }));
  }

  /** Shared by the mouse-drop handler and the touch-drag-end handler — looks
   * up the dragged block/event, applies the same snap/clamp math, and calls
   * the right updater for its type. `id` may be a VIRTUAL event id
   * (`${masterId}::${date}`, see recurrenceExpansion.resolveEventId) for a
   * single occurrence of a recurring Google event — `events` (raw context
   * state) only ever holds the real master row, never the virtual id
   * itself, so it must be resolved back to the master and re-expanded for
   * just that one date to read its current (override-merged) start/end
   * time before computing the drag's new time. `updateEvent` (called below)
   * defaults to 'this' scope, so dragging one occurrence only moves that
   * occurrence, same as dragging any single event. */
  function applyDrop(type, id, day, relY) {
    // A dragged-in unscheduled task (see the "Unscheduled" tray below) has no
    // existing block to move — it creates a brand new one instead, sized to
    // whatever's left of its remaining hours (clamped to its own chunk-size
    // rules, same clamp the allocator itself uses when placing a single
    // day's worth of work — see allocator.js's placeAndRecordBlocks).
    if (type === 'task') {
      const task = unscheduledTaskById.get(id);
      if (!task) return;
      const durationHours = Math.max(task.minChunkHours ?? 0.5, Math.min(task.unplacedHours || 1, task.maxChunkHours ?? 4));
      const newStartMin = computeSnappedStartMinute(relY, pxPerMin, Math.round(durationHours * 60));
      // If Manual Plan Today mode is enabled, force all manual placements to
      // land on today's column regardless of which day the user dropped onto.
      const targetDay = manualPlanTodayMode ? todayIso : day;
      scheduleTaskManually(id, targetDay, minutesToTime(newStartMin), durationHours);
      return;
    }
    let source;
    if (type === 'block') {
      source = blocks.find((b) => b.id === id);
    } else {
      const { masterId, occurrenceDate, isVirtual } = resolveEventId(id);
      if (isVirtual) {
        const master = events.find((e) => e.id === masterId);
        source = master ? expandRecurringEvent(master, occurrenceDate, occurrenceDate)[0] : null;
      } else {
        source = events.find((e) => e.id === id);
      }
    }
    if (!source) return;
    const duration = timeToMinutes(source.endTime) - timeToMinutes(source.startTime);
    const newStartMin = computeSnappedStartMinute(relY, pxPerMin, duration);
    const newEndMin = newStartMin + duration;
    const updates = { date: day, startTime: minutesToTime(newStartMin), endTime: minutesToTime(newEndMin) };
    if (type === 'block') {
      updateBlock(id, { ...updates, isAutoScheduled: false });
    } else {
      updateEvent(id, updates);
    }
  }

  function handleDropOnDay(e, day) {
    e.preventDefault();
    endDrag();
    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData('text/plain'));
    } catch {
      return; // not a drag we started (or a stale/foreign payload) — ignore
    }
    if (!payload?.id || !payload?.type) return;

    // Determine drop Y position relative to the day column to compute new start time.
    const columnEl = e.currentTarget;
    const rect = columnEl.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    applyDrop(payload.type, payload.id, day, relY);
  }

  // --- Touch drag (long-press then move) — mobile has no native HTML5 DnD ---
  // Mirrors handleDragStart/handleDropOnDay above but driven by touchmove
  // instead of the browser's own drag events, since those don't exist for
  // touch. A short (~250ms) long-press delay distinguishes "the user means
  // to drag this item" from "the user is scrolling the page" — if the touch
  // moves more than a few px before the timer fires, it's treated as a
  // scroll and the drag is aborted with no side effects.
  const LONG_PRESS_MS = 250;
  const DRAG_START_THRESHOLD_PX = 8;

  /**
   * Shared core of the touch-drag path: long-press `e`'s starting touch,
   * then track the finger across day columns via `elementFromPoint` (there's
   * no native touch drag-and-drop API) until release, calling `onDrop(day,
   * relY)` with the final column/offset. `duration` (minutes) only affects
   * the live snap preview (touchDragPreview) — the actual placement math is
   * entirely up to `onDrop`. Used by both handleItemTouchStart (moving an
   * existing block/event) and the unscheduled-task tray's chip drag below
   * (placing a brand new block).
   */
  function trackTouchDragToColumn(e, duration, dragIdentity, onDrop) {
    const touch = e.touches?.[0];
    if (!touch) return;
    const startX = touch.clientX;
    const startY = touch.clientY;
    let dragging = false;
    let lastDay = null;
    let lastRelY = null;

    const longPressTimer = setTimeout(() => {
      dragging = true;
      // Same "this item is in the air" styling the mouse path gets — the
      // long press is the only feedback the user has otherwise.
      setDragState({ ...dragIdentity, duration });
    }, LONG_PRESS_MS);

    function cleanup() {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      endDrag();
    }

    function onMove(moveEvent) {
      const t = moveEvent.touches?.[0];
      if (!t) return;
      if (!dragging) {
        if (Math.hypot(t.clientX - startX, t.clientY - startY) > DRAG_START_THRESHOLD_PX) {
          clearTimeout(longPressTimer);
          cleanup();
        }
        return;
      }
      // Once actually dragging, stop the page itself from scrolling under
      // the finger — safe to call now since the initial scroll-vs-drag
      // ambiguity (handled above) has already been resolved in favor of drag.
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const columnEl = document.elementFromPoint(t.clientX, t.clientY)?.closest('.day-column');
      if (!columnEl) return;
      const day = columnEl.dataset.day;
      const rect = columnEl.getBoundingClientRect();
      const relY = t.clientY - rect.top;
      lastDay = day;
      lastRelY = relY;
      setDragOverDay(day);
      setDragPreview({ day, startMin: computeSnappedStartMinute(relY, pxPerMin, duration), duration });
    }

    function onEnd(endEvent) {
      clearTimeout(longPressTimer);
      if (dragging && lastDay != null && lastRelY != null) {
        if (endEvent.cancelable) endEvent.preventDefault();
        onDrop(lastDay, lastRelY);
      }
      cleanup();
    }

    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }

  function handleItemTouchStart(e, item) {
    if (item.type === 'block' && item.data.isLocked) return;
    if (item.type === 'block' && isBlockTaskCompleted(item.data, taskById[item.data.taskId])) return;
    if (item.type === 'event' && item.data.canEdit === false) return;
    // Stop this touch from bubbling up to CalendarPage's swipe-navigation
    // listener — without this, dragging an item sideways across columns
    // also reads as a horizontal swipe there, so releasing the drag could
    // additionally page the view to the next/prev day (touchend keeps
    // targeting this same element per the touch event spec, but the guard
    // in CalendarPage's handleTouchEnd only holds if its handleTouchStart
    // never ran, hence stopping propagation here rather than on end).
    e.stopPropagation();
    const duration = timeToMinutes(item.data.endTime) - timeToMinutes(item.data.startTime);
    trackTouchDragToColumn(e, duration, { id: item.data.id, type: item.type }, (day, relY) => applyDrop(item.type, item.data.id, day, relY));
  }

  /** Long-press-drag a chip from the "Unscheduled" tray onto a day column —
   * the touch-input equivalent of dragging it via native HTML5 DnD (see
   * the tray's `draggable` chips below and applyDrop's 'task' branch). */
  function handleTaskChipTouchStart(e, task) {
    e.stopPropagation();
    const durationHours = Math.max(task.minChunkHours ?? 0.5, Math.min(task.unplacedHours || 1, task.maxChunkHours ?? 4));
    trackTouchDragToColumn(e, Math.round(durationHours * 60), { id: task.id, type: 'task' }, (day, relY) => applyDrop('task', task.id, day, relY));
  }

  // --- Resize handlers (vertical only; mouse OR touch) ------------------------
  // The live height is driven by `resizePreview` state (rather than poking
  // the element's style.height directly, as this used to) so the box can also
  // show its new end time as it grows/shrinks — a direct DOM write would be
  // undone by the very next React render of the grid anyway. It only ever
  // re-renders when the snapped 15-minute end actually changes, not on every
  // pointer move.
  function handleResizeStart(e, item) {
    e.stopPropagation();
    e.preventDefault();
    cancelHoverPreview();
    const startY = getClientY(e);
    const originalEndMin = timeToMinutes(item.data.endTime);
    const startMin = timeToMinutes(item.data.startTime);

    /** Snapped end minute for a pointer position, clamped to at least one
     * snap step long and to the bottom of the grid. */
    function endMinuteFor(evt) {
      const deltaMin = Math.round((getClientY(evt) - startY) / pxPerMin / SNAP_MIN) * SNAP_MIN;
      return Math.min(Math.max(startMin + SNAP_MIN, originalEndMin + deltaMin), GRID_END_MIN);
    }

    function onMove(moveEvent) {
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const endMin = endMinuteFor(moveEvent);
      setResizePreview((prev) =>
        prev && prev.id === item.data.id && prev.type === item.type && prev.endMin === endMin
          ? prev
          : { id: item.data.id, type: item.type, endMin }
      );
    }

    function onUp(upEvent) {
      const newEndMin = endMinuteFor(upEvent);
      setResizePreview(null);
      if (item.type === 'block') {
        updateBlock(item.data.id, { endTime: minutesToTime(newEndMin), isAutoScheduled: false });
      } else {
        updateEvent(item.data.id, { endTime: minutesToTime(newEndMin) });
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
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

  /**
   * Live drag/resize state for a single block/event: whether it's the item
   * currently in the air (so it can be styled as lifted out of the grid),
   * and — while it's being resized — the height and end time it should
   * render at instead of its packed ones. Neighbours deliberately keep
   * their packed positions during a resize; nothing repacks until the
   * resize is committed.
   */
  function itemLiveState(item) {
    const isDragging = dragState?.type === item.type && dragState.id === item.data.id;
    const isResizing = resizePreview?.type === item.type && resizePreview.id === item.data.id;
    const height = isResizing
      ? Math.max(MIN_BLOCK_HEIGHT_PX, (resizePreview.endMin - timeToMinutes(item.data.startTime)) * pxPerMin)
      : item.height;
    return {
      isDragging,
      isResizing,
      height,
      endTime: isResizing ? minutesToTime(resizePreview.endMin) : item.data.endTime,
      // A box resized down to a sliver has room for exactly one line, and
      // mid-resize the live time is the more useful one — so the title gives
      // way to it there, the same trade-off renderGhost makes.
      liveTimeOnly: isResizing && height < TWO_LINE_MIN_HEIGHT,
    };
  }

  /**
   * The dashed "this is where it lands" box, shared by the drag-to-create
   * and drag-to-move previews — labelled with the live snapped time range,
   * which is the point of it: the browser's own drag image is a frozen
   * snapshot taken at dragstart, so this ghost is the only thing that can
   * tell the user what time they're actually about to drop on. Below
   * TWO_LINE_MIN_HEIGHT there's only room for one line, and the time is
   * the more useful of the two (same trade-off the blocks themselves make).
   */
  function renderGhost(startMin, endMin, label) {
    const height = Math.max(20, (endMin - startMin) * pxPerMin);
    const timeText = `${minutesToTime(startMin)}–${minutesToTime(endMin)}`;
    return (
      <div className="cal-event-ghost" style={{ top: timeToY(minutesToTime(startMin)), height }}>
        {height >= TWO_LINE_MIN_HEIGHT && <div className="cal-block-title">{label}</div>}
        <div className="cal-block-time">{timeText}</div>
      </div>
    );
  }

  return (
    // A single flex-column wrapper — CalendarPage's own wrapping div lays
    // WeekView out as one flex ROW child (sized via .week-grid's flex:1), so
    // the tray needs its own outer element here (not a bare Fragment) to
    // stack above the grid vertically without fighting that outer layout.
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {/* Unscheduled tray: lets the user drag any task the allocator
          couldn't place onto a day itself. Only shown once the user has
          opted into Manual Plan Today mode (see the drop handler above,
          which forces drags from this tray onto today's column) — otherwise
          these draggable chips would clutter the calendar when automatic
          scheduling is the primary workflow. */}
      {manualPlanTodayMode && unscheduledTasks.length > 0 && (
        <div className="unscheduled-tray">
          <button className="unscheduled-tray-toggle" onClick={() => setTrayExpanded((v) => !v)}>
            {trayExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Unscheduled Today ({unscheduledTasks.length})
          </button>
          {trayExpanded && (
            <div className="unscheduled-tray-chips">
              {unscheduledTasks.map((task) => (
                <div
                  key={task.id}
                  className="unscheduled-chip"
                  style={{ borderLeftColor: priorityColor(task.priority) }}
                  draggable={!isMobile}
                  onDragStart={isMobile ? undefined : (e) => handleTaskChipDragStart(e, task)}
                  onTouchStart={(e) => handleTaskChipTouchStart(e, task)}
                  title={`Drag onto a day to schedule "${task.title}" (${formatHours(task.unplacedHours)} unplaced)`}
                >
                  <GripVertical size={12} className="unscheduled-chip-grip" />
                  <span className="unscheduled-chip-title">{task.title}</span>
                  <span className="unscheduled-chip-hours">{formatHours(task.unplacedHours)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
        <div
          key={day}
          className={`day-header ${day === todayIso ? 'today' : ''} ${i === days.length - 1 ? 'is-last-col' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelectDay?.(day)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectDay?.(day);
            }
          }}
        >
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
        const dayItems = dayItemsByDay.get(day) || [];
        return (
          <div
            key={day}
            data-day={day}
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

            {createDrag &&
              createDrag.day === day &&
              renderGhost(
                Math.min(createDrag.startMin, createDrag.currentMin),
                Math.max(createDrag.startMin, createDrag.currentMin),
                'New event'
              )}

            {dragPreview &&
              dragPreview.day === day &&
              renderGhost(dragPreview.startMin, dragPreview.startMin + dragPreview.duration, 'Move here')}

            {dayItems.map((item) => {
              const { lane, totalLanes } = item;
              // Items side-by-side within an overlap group — see
              // layoutDayItems above. totalLanes is 1 for the common case
              // (no overlap, or a lone item next to a collapsed overlapChip),
              // so this is a no-op then.
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
                const isAllCompleted = item.blocks.every((b) => isBlockTaskCompleted(b, taskById[b.taskId]));
                const openThisCluster = (rect) =>
                  setOpenCluster({ key: clusterKey, rect, items: item.blocks.map((b) => ({ type: 'block', data: b })) });
                return (
                  <div
                    key={clusterKey}
                    className={`cal-block cal-cluster ${isOpen ? 'is-open' : ''} ${isAllCompleted ? 'cal-cluster-completed' : ''}`}
                    style={{ top, height, ...laneStyle }}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isOpen) setOpenCluster(null);
                      else openThisCluster(e.currentTarget.getBoundingClientRect());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (isOpen) setOpenCluster(null);
                        else openThisCluster(e.currentTarget.getBoundingClientRect());
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

              if (item.kind === 'overlapChip') {
                const chipKey = `${day}_overlap_${item.start}`;
                const { top, height } = item;
                const isOpen = openCluster?.key === chipKey;
                // Flatten so the popover lists every real block/event as its
                // own tappable row — a nested "N short tasks" sub-cluster
                // inside the group expands out to its individual blocks here
                // rather than the popover having to render yet another
                // nested cluster chip.
                const flatItems = item.items.flatMap((it) =>
                  it.kind === 'cluster' ? it.blocks.map((b) => ({ type: 'block', data: b })) : [{ type: it.type, data: it.data }]
                );
                // Events have no "completed" concept, so a chip containing any
                // live event is never fully completed — only true when every
                // underlying block is a completed-task block.
                const isAllCompleted = flatItems.every((it) => it.type === 'block' && isBlockTaskCompleted(it.data, taskById[it.data.taskId]));
                const openThisOverlap = (rect) => setOpenCluster({ key: chipKey, rect, items: flatItems });
                return (
                  <div
                    key={chipKey}
                    className={`cal-block cal-overlap-chip ${isOpen ? 'is-open' : ''} ${isAllCompleted ? 'cal-cluster-completed' : ''}`}
                    style={{ top, height, ...laneStyle }}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isOpen) setOpenCluster(null);
                      else openThisOverlap(e.currentTarget.getBoundingClientRect());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (isOpen) setOpenCluster(null);
                        else openThisOverlap(e.currentTarget.getBoundingClientRect());
                      }
                    }}
                    title={`${item.items.length} events · ${minutesToTime(item.start)}–${minutesToTime(item.end)}`}
                  >
                    <div className="cal-block-title">{item.items.length} events</div>
                  </div>
                );
              }

              if (item.type === 'event') {
                const evt = item.data;
                const { top } = item;
                const { isDragging, isResizing, endTime, height, liveTimeOnly } = itemLiveState(item);
                return (
                  <div
                    key={evt.id}
                    id={`event-${evt.id}`}
                    className={`cal-event cal-event-item ${evt.isFreeTime ? 'free-time' : ''} ${evt.canEdit === false ? 'is-readonly' : ''} ${isMobile ? 'is-mobile' : ''} ${isDragging ? 'is-dragging' : ''} ${isResizing ? 'is-resizing' : ''}`}
                    style={{ top, height, ...laneStyle }}
                    // Desktop gets the richer HoverPreviewCard instead (see
                    // below) — mobile has no hover, so it keeps the native
                    // title tooltip (which does nothing there anyway, but
                    // costs nothing to leave as an accessibility fallback).
                    title={isMobile ? (evt.isFreeTime ? `${evt.title} (marked as free time — schedulable)` : evt.title) : undefined}
                    draggable={!isMobile && evt.canEdit !== false}
                    onDragStart={isMobile ? undefined : (e) => handleDragStart(e, item)}
                    onDragEnd={isMobile ? undefined : endDrag}
                    onTouchStart={(e) => handleItemTouchStart(e, item)}
                    onClick={() => onSelectEvent?.(evt)}
                    onMouseEnter={
                      isMobile
                        ? undefined
                        : (e) =>
                            scheduleHoverPreview(e.currentTarget.getBoundingClientRect(), {
                              title: evt.title,
                              timeText: `${evt.startTime}–${evt.endTime}`,
                            })
                    }
                    onMouseLeave={isMobile ? undefined : cancelHoverPreview}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectEvent?.(evt);
                      }
                    }}
                  >
                    {!liveTimeOnly && <div className="cal-block-title">{evt.title}</div>}
                    {(height >= TWO_LINE_MIN_HEIGHT || isResizing) && (
                      <div className={`cal-block-time ${isResizing ? 'is-live' : ''}`}>
                        {evt.startTime}–{endTime}
                      </div>
                    )}
                    {evt.canEdit !== false && (
                      <div
                        className="resize-handle"
                        onMouseDown={(e) => handleResizeStart(e, item)}
                        onTouchStart={(e) => handleResizeStart(e, item)}
                      />
                    )}
                  </div>
                );
              }

              const block = item.data;
              const { top } = item;
              const { isDragging, isResizing, endTime, height, liveTimeOnly } = itemLiveState(item);
              const task = taskById[block.taskId];
              if (!task) return null;
              // A sub-task's block gets a second, muted line naming its parent task
              // right under the title, so which goal it belongs to is readable
              // without opening the block — see THREE_LINE_MIN_HEIGHT above.
              const parentTask = task.parentId ? taskById[task.parentId] : null;
              const showParentLine = !!parentTask && height >= TWO_LINE_MIN_HEIGHT;
              const showTimeLine = height >= (parentTask ? THREE_LINE_MIN_HEIGHT : TWO_LINE_MIN_HEIGHT);
              const isCompleted = isBlockTaskCompleted(block, task);
              const isCompletedLate = isBlockCompletedLate(block, task);
              return (
                <div
                  key={block.id}
                  id={`block-${block.id}`}
                  className={`cal-block ${block.isLocked ? 'locked' : ''} ${isMobile ? 'is-mobile' : ''} ${block.isPassive ? 'passive' : ''} ${isDragging ? 'is-dragging' : ''} ${isResizing ? 'is-resizing' : ''} ${isCompleted ? 'block-completed' : ''} ${isCompletedLate ? 'block-completed-late' : ''}`}
                  style={{
                    top,
                    height,
                    borderLeftColor: priorityColor(task.priority),
                    ...laneStyle,
                  }}
                  draggable={!isMobile && !block.isLocked && !isCompleted}
                  onDragStart={isMobile ? undefined : (e) => handleDragStart(e, item)}
                  onDragEnd={isMobile ? undefined : endDrag}
                  onTouchStart={(e) => handleItemTouchStart(e, item)}
                  onClick={() => onSelectBlock?.(block)}
                  onMouseEnter={
                    isMobile
                      ? undefined
                      : (e) =>
                          scheduleHoverPreview(e.currentTarget.getBoundingClientRect(), {
                            title: task.title,
                            timeText: `${block.startTime}–${block.endTime}`,
                            priority: task.priority,
                            projectName: projectById[task.projectId]?.name,
                            parentTitle: parentTask?.title,
                            isPassive: block.isPassive,
                            completedAt: task?.completedAt ?? null,
                          })
                  }
                  onMouseLeave={isMobile ? undefined : cancelHoverPreview}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectBlock?.(block);
                    }
                  }}
                  // Desktop gets the richer HoverPreviewCard instead (see
                  // below) — mobile keeps this as its native tooltip fallback.
                  title={
                    isMobile
                      ? `${task.title}${parentTask ? ` (sub-task of ${parentTask.title})` : ''}${block.isPassive ? ' (runs unattended)' : ''} · ${block.startTime}–${block.endTime}`
                      : undefined
                  }
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
                  {!liveTimeOnly && (
                    <div className="cal-block-title">
                      {block.isPassive && <Wind size={12} style={{ verticalAlign: -2, marginRight: 3 }} />}
                      {task.title}
                    </div>
                  )}
                  {showParentLine && <div className="cal-block-parent">{parentTask.title}</div>}
                  {/* Mid-resize this is the live readout of the new end time
                      (see itemLiveState), highlighted so the change is
                      obvious — otherwise it's the block's own time range. */}
                  {(showTimeLine || isResizing) && (
                    <div className={`cal-block-time ${isResizing ? 'is-live' : ''}`}>
                      {block.startTime}–{endTime}
                    </div>
                  )}
                  {!block.isLocked && !isCompleted && (
                    <div
                      className="resize-handle"
                      onMouseDown={(e) => handleResizeStart(e, item)}
                      onTouchStart={(e) => handleResizeStart(e, item)}
                    />
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
            {openCluster.items.map((it) => {
              if (it.type === 'block') {
                const t = taskById[it.data.taskId];
                if (!t) return null;
                return (
                  <button
                    key={`block-${it.data.id}`}
                    className="cal-cluster-popover-item"
                    onClick={() => {
                      setOpenCluster(null);
                      onSelectBlock?.(it.data);
                    }}
                  >
                    <span className="cal-cluster-popover-time">
                      {it.data.startTime}–{it.data.endTime}
                    </span>
                    <span className={`cal-cluster-popover-title ${isBlockTaskCompleted(it.data, t) ? 'is-completed' : ''}`}>{t.title}</span>
                  </button>
                );
              }
              return (
                <button
                  key={`event-${it.data.id}`}
                  className="cal-cluster-popover-item"
                  onClick={() => {
                    setOpenCluster(null);
                    onSelectEvent?.(it.data);
                  }}
                >
                  <span className="cal-cluster-popover-time">
                    {it.data.startTime}–{it.data.endTime}
                  </span>
                  <span className="cal-cluster-popover-title">{it.data.title}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
      </div>

      {hoverPreview && <HoverPreviewCard {...hoverPreview} />}
    </div>
  );
}

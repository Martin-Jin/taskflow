/**
 * CalendarPage — top-level container for the calendar tab: navigation
 * toolbar (prev/next/today on desktop, a date-picker dropdown, and a
 * hamburger view-switcher menu) + the WeekView/MonthView grid itself, a
 * floating "+" button for creating events, plus the block detail modal
 * when a block is selected.
 *
 * Only the selected block's *id* is tracked in state; the block object
 * passed to BlockDetailModal is derived fresh from context on every render
 * so drag/resize/lock changes made elsewhere are reflected immediately if
 * the modal happens to still be open.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Menu, Plus, Zap, RefreshCw, PenSquare, X, Search } from 'lucide-react';
import WeekView, { ZOOM_LEVELS_PX_PER_MIN, DEFAULT_ZOOM_INDEX } from './WeekView';
import MonthView from './MonthView';
import CalendarDatePickerDropdown from './CalendarDatePickerDropdown';
import CalendarFilterMenu from './CalendarFilterMenu';
import BlockDetailModal from '../Modals/BlockDetailModal';
import EventDetailModal from '../Modals/EventDetailModal';
import TaskDetailModal from '../Modals/TaskDetailModal';
import { addDays, addMonths, dayOfWeek, formatDisplayDate, formatMonthLabel, startOfMonth, toISODate } from '../../utils/dateUtils';
import { expandRecurringEvent, resolveEventId } from '../../utils/recurrenceExpansion';
import { useScheduler } from '../../context/SchedulerContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { DEFAULT_CALENDAR_FILTER, filterCalendarItems, isCalendarFilterActive, normalizeCalendarFilter } from '../../utils/calendarFilter';
import HelpTooltip from '../Common/HelpTooltip';

function getWeekStart(iso) {
  const dow = dayOfWeek(iso);
  return addDays(iso, -dow); // Sunday-start week
}

// Fraction of the viewport's width a drag must cross before release commits
// to the next/prev page instead of springing back to the current one —
// mirrors Google Calendar's mobile swipe-to-page feel (a >30%-of-screen drag
// "wins" the page, matching how far most carousel components in the wild
// pick their commit threshold).
const SWIPE_COMMIT_FRACTION = 0.3;
// Below this many px of movement, a touch's direction (horizontal page-swipe
// vs. vertical scroll) hasn't been determined yet — see the direction-lock
// logic in the swipe effect below.
const DIRECTION_LOCK_PX = 10;

// Views mirror Google Calendar's own switcher: Day/3 Day/Week give the full
// time-grid (WeekView, sized to 1, 3, or 7 columns), Month trades timeline
// precision for a density-first overview (MonthView).
const VIEWS = [
  { key: 'day', label: 'Day' },
  { key: 'threeDay', label: '3 Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

export default function CalendarPage({ dayJumpRequest, onOpenSearch } = {}) {
  const [anchorDate, setAnchorDate] = useState(toISODate(new Date()));
  const isMobile = useIsMobile();
  const [view, setView] = useState(() => (isMobile ? 'day' : 'week'));
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [creatingEvent, setCreatingEvent] = useState(null); // { date, startTime, endTime } while the "block time" modal is open
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  // Speed-dial state for the bottom-right FAB (see .calendar-fab below) —
  // expands into mini-FABs instead of the FAB's single always-visible
  // action: Re-balance schedule + New event.
  const [fabExpanded, setFabExpanded] = useState(false);
  const dateTitleBtnRef = useRef(null);
  const viewMenuTriggerRef = useRef(null);
  const fabGroupRef = useRef(null);
  const fabTriggerRef = useRef(null);
  const {
    blocks,
    events,
    tasks,
    runRebalance,
    isLoading,
    googleConnected,
    syncNow,
    isSyncing,
    ensureGoogleRangeSynced,
  } = useScheduler();

  // Calendar filter (show mode + project/tag multi-select) — device-local,
  // like Tasks' own filterByView, so not part of BACKUP_FIELDS/cloud sync
  // (see CLAUDE.md's Backups section). normalizeCalendarFilter guards
  // against a stale/partial persisted shape from an earlier version.
  const [rawCalendarFilter, setCalendarFilter] = usePersistedState('taskflow_calendar_filter_v1', DEFAULT_CALENDAR_FILTER);
  const calendarFilter = normalizeCalendarFilter(rawCalendarFilter);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const { filteredBlocks, filteredEvents } = useMemo(
    () => filterCalendarItems(blocks, events, calendarFilter, taskById),
    [blocks, events, calendarFilter, taskById]
  );
  // Whether ANY filter is currently narrowing the calendar — WeekView/
  // MonthView each compute their own visible-range-specific "did the filter
  // hide something in THIS range" check (see their filterIsActive prop use)
  // since only they know which days are on screen.
  const calendarFilterIsActive = isCalendarFilterActive(calendarFilter);
  // ---- Mobile swipe-to-page carousel --------------------------------------
  // A live-tracking 3-page carousel (prev/current/next, see the render below)
  // instead of the old "detect a swipe past a threshold, then jump" — the
  // track follows the finger 1:1 during the drag (imperative style writes in
  // the native listener below, not React state, so it doesn't re-render on
  // every touchmove) and on release either settles onto the adjacent page or
  // springs back to center, matching Google Calendar's mobile paging feel.
  const swipeViewportRef = useRef(null);
  const swipeTrackRef = useRef(null);
  const swipeGesture = useRef({ startX: 0, startY: 0, dragging: false, direction: null, lastDx: 0 });
  // null while idle/dragging (no transition — the track just follows touch
  // input directly); 'next'/'prev'/'cancel' during the post-release settle
  // animation, so the CSS transition only applies for that brief animation.
  const [swipeSettlePhase, setSwipeSettlePhase] = useState(null);

  // Positions the date-picker dropdown — anchored under the title button on
  // desktop (where there's room to spare), but forced into useMenuPosition's
  // centered-with-backdrop mode on mobile: the title now sits near the left
  // edge of the mobile toolbar bar (right after the hamburger menu, see
  // render below), so anchoring the ~320px-wide picker under it would run
  // most of it off the right edge of a phone screen. This also replaces the
  // old manual outside-click effect — useMenuPosition owns that already.
  const {
    menuRef: datePickerRef,
    mode: datePickerMode,
    style: datePickerStyle,
  } = useMenuPosition({
    isOpen: showDatePicker,
    anchorRef: dateTitleBtnRef,
    onClose: () => setShowDatePicker(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => ({
      left: Math.max(8, anchorRect.left + anchorRect.width / 2 - menuRect.width / 2),
      top: anchorRect.bottom + 6,
    }),
  });

  // Positions the hamburger view-switcher menu — anchored under the trigger
  // on desktop, forced into useMenuPosition's centered-with-backdrop mode on
  // mobile, same treatment as the date-picker dropdown above (see its
  // comment for why: a corner-anchored menu rarely has room on a phone
  // screen). This also replaces the old shared-ref outside-click effect,
  // which was buggy on mobile: CalendarPage renders TWO DOM copies of the
  // trigger/menu (mobile vs. desktop, swapped via isMobile), so a single ref
  // shared between them could point at a stale node right as isMobile's
  // async matchMedia listener updated, making the very tap that opened the
  // menu register as "outside" and immediately re-close it.
  const {
    menuRef: viewMenuRef,
    mode: viewMenuMode,
    style: viewMenuStyle,
  } = useMenuPosition({
    isOpen: showViewMenu,
    anchorRef: viewMenuTriggerRef,
    onClose: () => setShowViewMenu(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => ({
      left: anchorRect.right - menuRect.width,
      top: anchorRect.bottom + 6,
    }),
  });

  useEffect(() => {
    if (!fabExpanded) return undefined;
    function onDocMouseDown(e) {
      if (fabGroupRef.current && !fabGroupRef.current.contains(e.target)) setFabExpanded(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [fabExpanded]);
  // _v2: the zoom level table gained more zoom-in steps above the original
  // max, so a v1 key persisted from before that change would pin returning
  // users to what is now a mid-range level instead of the new top/default.
  const [zoomIndex, setZoomIndex] = usePersistedState('taskflow_calendar_zoom_index_v2', DEFAULT_ZOOM_INDEX);
  const pxPerMin = ZOOM_LEVELS_PX_PER_MIN[zoomIndex];

  function handleZoomDelta(direction) {
    setZoomIndex((i) => Math.min(ZOOM_LEVELS_PX_PER_MIN.length - 1, Math.max(0, i + direction)));
  }

  const selectedBlock = selectedBlockId ? blocks.find((b) => b.id === selectedBlockId) || null : null;
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) || null : null;

  // Jump from a block's placement modal into the full task edit modal —
  // closes BlockDetailModal first rather than stacking both, matching how
  // this app avoids nested modals elsewhere.
  function handleOpenTask(taskId) {
    setSelectedBlockId(null);
    setSelectedTaskId(taskId);
  }
  // selectedEventId may be a VIRTUAL id (`${masterId}::${date}`) — every
  // displayed recurring Google Calendar event (a true RRULE series is
  // stored as one master row, expanded to virtual per-day instances only
  // for display, see recurrenceExpansion.js) carries one of these instead
  // of a real row id. Re-derive the effective (override-merged) occurrence
  // fresh from the raw `events` array on every render — same "derived, not
  // stored" pattern as selectedBlock above — by resolving back to the real
  // master row and re-running the same single-day expansion used for
  // display, rather than (as before this fix) looking the virtual id up
  // directly in `events`, which can never match since it's display-only.
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    const { masterId, occurrenceDate, isVirtual } = resolveEventId(selectedEventId);
    const master = events.find((e) => e.id === masterId);
    if (!master) return null;
    if (!isVirtual) return master;
    const [occurrence] = expandRecurringEvent(master, occurrenceDate, occurrenceDate);
    return occurrence || null; // this occurrence was deleted (scope:'this' delete) since being displayed
  }, [selectedEventId, events]);

  const dayCount = view === 'day' ? 1 : view === 'threeDay' ? 3 : 7;
  const step = view === 'day' ? 1 : view === 'threeDay' ? 3 : 7;
  // Day/3 Day are anchored directly at anchorDate (so "today" as the anchor
  // shows "today, tomorrow, day after" for 3 Day, matching Google Calendar's
  // own 3-day view) — only Week snaps back to its Sunday start.
  const rangeStart = view === 'week' ? getWeekStart(anchorDate) : anchorDate;
  const rangeEnd = addDays(rangeStart, dayCount - 1);
  const monthStart = startOfMonth(anchorDate);
  const todayISO = toISODate(new Date());
  // Whether the visible range already includes today — the mobile-only
  // solo Today button (see below) only needs to show up when tapping it
  // would actually go somewhere, i.e. the user has navigated away from the
  // current day/week/month.
  const isViewingToday =
    view === 'month' ? monthStart.slice(0, 7) === todayISO.slice(0, 7) : rangeStart <= todayISO && todayISO <= rangeEnd;

  // ---- On-demand Google Calendar sync for the visible range -----------------
  // The background sync (useGoogleCalendarSync) only routinely keeps a small
  // rolling window around today fresh — scrolling the calendar to a date
  // outside that window needs its own fetch. Debounced so rapid prev/next
  // clicks or a fast swipe through several pages settle on one fetch for
  // wherever navigation actually stops, rather than firing one per page;
  // ensureGoogleRangeSynced itself also no-ops instantly if the range is
  // already covered, so this is cheap even for in-window navigation.
  const viewedRangeEnd = view === 'month' ? addDays(addMonths(monthStart, 1), -1) : rangeEnd;
  const viewedRangeStart = view === 'month' ? monthStart : rangeStart;
  useEffect(() => {
    if (!googleConnected) return undefined;
    const handle = setTimeout(() => {
      ensureGoogleRangeSynced(viewedRangeStart, viewedRangeEnd);
    }, 400);
    return () => clearTimeout(handle);
  }, [googleConnected, viewedRangeStart, viewedRangeEnd, ensureGoogleRangeSynced]);

  function goPrev() {
    setAnchorDate(view === 'month' ? addMonths(anchorDate, -1) : addDays(anchorDate, -step));
  }

  function goNext() {
    setAnchorDate(view === 'month' ? addMonths(anchorDate, 1) : addDays(anchorDate, step));
  }

  function goToday() {
    setAnchorDate(toISODate(new Date()));
  }

  // Shared by MonthView's day cells and WeekView's day headers — jumping
  // into Day view for the full time-grid detail, matching how most
  // calendar apps handle month/week -> day navigation.
  function jumpToDay(date) {
    setAnchorDate(date);
    setView('day');
  }

  // Lets a component outside the Calendar tab (e.g. SchedulingConflictsModal)
  // jump straight to a specific day — mirrors App's requestSettingsSection
  // pattern: a bumped requestId (not just the date) so re-requesting the same
  // date still re-triggers the effect below.
  useEffect(() => {
    if (dayJumpRequest?.requestId) jumpToDay(dayJumpRequest.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayJumpRequest?.requestId]);

  // Renders one page of the swipe carousel — `base` is a weekStart/day (for
  // Day/3 Day/Week, passed straight to WeekView) or a monthStart (for
  // Month). Shared by the prev/current/next panels below so all three stay
  // in lockstep with whatever the current `view` mode is.
  function renderCalendarPage(base) {
    if (view === 'month') {
      return (
        <MonthView
          monthStart={base}
          blocks={filteredBlocks}
          events={filteredEvents}
          unfilteredBlocks={blocks}
          unfilteredEvents={events}
          filterIsActive={calendarFilterIsActive}
          onClearFilter={() => setCalendarFilter(DEFAULT_CALENDAR_FILTER)}
          onSelectBlock={(block) => setSelectedBlockId(block.id)}
          onSelectEvent={(evt) => setSelectedEventId(evt.id)}
          onSelectDay={jumpToDay}
        />
      );
    }
    return (
      <WeekView
        weekStart={base}
        dayCount={dayCount}
        isMobile={isMobile}
        pxPerMin={pxPerMin}
        blocks={filteredBlocks}
        events={filteredEvents}
        unfilteredBlocks={blocks}
        unfilteredEvents={events}
        filterIsActive={calendarFilterIsActive}
        onClearFilter={() => setCalendarFilter(DEFAULT_CALENDAR_FILTER)}
        onZoomDelta={handleZoomDelta}
        onSelectBlock={(block) => setSelectedBlockId(block.id)}
        onSelectEvent={(evt) => setSelectedEventId(evt.id)}
        onCreateEvent={(date, startTime, endTime) => setCreatingEvent({ date, startTime, endTime })}
        onSelectDay={jumpToDay}
      />
    );
  }

  const swipePrevBase = view === 'month' ? addMonths(monthStart, -1) : addDays(rangeStart, -step);
  const swipeCenterBase = view === 'month' ? monthStart : rangeStart;
  const swipeNextBase = view === 'month' ? addMonths(monthStart, 1) : addDays(rangeStart, step);

  // Memoized so an unrelated CalendarPage re-render (selecting a block,
  // opening a modal — neither touches SchedulerContext at all) doesn't
  // re-render the two OFF-SCREEN pages' full WeekView/MonthView trees, each
  // with their own drag/touch effects. Only the visible center page below
  // re-renders on every render, same as the desktop (non-swipe) path always
  // has. Deliberately omits renderCalendarPage/the onSelect*/onCreateEvent
  // callbacks it closes over from the dep list — they only ever call stable
  // setState setters, so a stale closure reference behaves identically to a
  // fresh one and isn't worth invalidating the memo over.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const swipePrevPage = useMemo(() => renderCalendarPage(swipePrevBase), [swipePrevBase, view, dayCount, isMobile, pxPerMin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const swipeNextPage = useMemo(() => renderCalendarPage(swipeNextBase), [swipeNextBase, view, dayCount, isMobile, pxPerMin]);

  // Native (non-passive) listeners, same reasoning as WeekView's own touch
  // handlers (see its wheel/touch effects) — React's synthetic onTouchMove is
  // passive by default, so preventDefault() there is silently ignored and
  // can't actually stop the vertical scroll/bounce a horizontal page-swipe
  // needs to suppress.
  useEffect(() => {
    if (!isMobile) return undefined;
    const viewport = swipeViewportRef.current;
    const track = swipeTrackRef.current;
    if (!viewport || !track) return undefined;

    function setLiveOffset(px, animated) {
      track.style.transition = animated ? 'transform 220ms ease' : 'none';
      track.style.transform = `translateX(calc(-33.3333% + ${px}px))`;
    }

    function onTouchStart(e) {
      // A second finger joining means this is a pinch (zoom) — WeekView's
      // own touch listeners own that gesture, so don't treat it as a swipe.
      if (e.touches.length !== 1) return;
      swipeGesture.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, dragging: true, direction: null, lastDx: 0 };
    }

    function onTouchMove(e) {
      const g = swipeGesture.current;
      if (!g.dragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - g.startX;
      const dy = e.touches[0].clientY - g.startY;
      // Direction lock: the first ~10px of movement decide whether this
      // gesture is a horizontal page-swipe or a vertical scroll — once
      // decided it can't flip mid-gesture, matching how most swipeable
      // carousels disambiguate from a scrollable list beneath them.
      if (g.direction === null) {
        if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) return;
        g.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (g.direction === 'vertical') {
          g.dragging = false; // let the native vertical scroll take over untouched
          return;
        }
      }
      if (g.direction !== 'horizontal') return;
      if (e.cancelable) e.preventDefault();
      g.lastDx = dx;
      setLiveOffset(dx, false);
    }

    function onTouchEnd() {
      const g = swipeGesture.current;
      if (!g.dragging || g.direction !== 'horizontal') {
        g.dragging = false;
        return;
      }
      g.dragging = false;
      const width = viewport.offsetWidth || 1;
      const dx = g.lastDx;
      if (Math.abs(dx) > width * SWIPE_COMMIT_FRACTION) {
        setLiveOffset(dx < 0 ? -width : width, true);
        setSwipeSettlePhase(dx < 0 ? 'next' : 'prev');
      } else {
        setLiveOffset(0, true);
        setSwipeSettlePhase('cancel');
      }
    }

    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd);
    viewport.addEventListener('touchcancel', onTouchEnd);
    return () => {
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isMobile]);

  // Fires once the post-release settle transition finishes. For 'next'/'prev'
  // this is where the date actually advances — until now the carousel was
  // just showing the adjacent page's already-rendered content slid into
  // view, nothing about `anchorDate` has changed yet. Resetting the track's
  // transform back to its resting position happens in the same tick (with
  // transitions off), so the freshly-centered page doesn't visibly animate
  // in again on top of the swipe that just finished.
  function handleSwipeTransitionEnd(e) {
    if (e.target !== swipeTrackRef.current || swipeSettlePhase === null) return;
    if (swipeSettlePhase === 'next') goNext();
    else if (swipeSettlePhase === 'prev') goPrev();
    setSwipeSettlePhase(null);
    if (swipeTrackRef.current) {
      swipeTrackRef.current.style.transition = 'none';
      swipeTrackRef.current.style.transform = 'translateX(-33.3333%)';
    }
  }

  const title =
    view === 'month'
      ? formatMonthLabel(monthStart)
      : view === 'day'
        ? formatDisplayDate(rangeStart)
        : `${formatDisplayDate(rangeStart)} – ${formatDisplayDate(rangeEnd)}`;

  return (
    <div className="calendar-container">
      <div className="calendar-toolbar">
        <div className="calendar-toolbar-left">
          {/* Prev/Today/Next are desktop-only — mobile navigates by swiping
              the grid itself (see the swipe-carousel effect above), so a
              duplicate tap target for the same thing would be redundant there. */}
          {!isMobile && (
            <>
              <button className="btn btn-icon calendar-nav-prev" onClick={goPrev} aria-label="Previous">
                <ChevronLeft size={16} />
              </button>
              <button className="btn calendar-today-btn" onClick={goToday}>
                Today
              </button>
              <button className="btn btn-icon calendar-nav-next" onClick={goNext} aria-label="Next">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {/* Mobile: hamburger view-switcher leads the bar, matching Google
              Calendar's own mobile top bar (menu icon, then the date title).
              Desktop keeps it trailing the title (see calendar-view-menu-wrap
              order below via CSS on mobile, not DOM order, isn't worth the
              complexity — it's simplest as an explicit mobile-only duplicate
              of the trigger placed first in the DOM). */}
          {isMobile && (
            <div className="calendar-view-menu-wrap">
              <button
                ref={viewMenuTriggerRef}
                className="btn btn-icon calendar-view-menu-trigger"
                onClick={() => setShowViewMenu((v) => !v)}
                aria-label="Change view"
                aria-haspopup="true"
                aria-expanded={showViewMenu}
              >
                <Menu size={16} />
              </button>
              {showViewMenu &&
                createPortal(
                  <>
                    {viewMenuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setShowViewMenu(false)} />}
                    <div
                      ref={viewMenuRef}
                      className={`calendar-view-menu ${viewMenuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      style={viewMenuMode === 'anchored' ? viewMenuStyle : undefined}
                    >
                      {VIEWS.map((v) => (
                        <button
                          key={v.key}
                          className={view === v.key ? 'active' : ''}
                          onClick={() => {
                            setView(v.key);
                            setShowViewMenu(false);
                          }}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body
                )}
            </div>
          )}
          <div className="calendar-title-wrap">
            <button
              ref={dateTitleBtnRef}
              className={`calendar-toolbar-title-btn ${showDatePicker ? 'is-open' : ''}`}
              onClick={() => setShowDatePicker((v) => !v)}
              aria-haspopup="true"
              aria-expanded={showDatePicker}
            >
              <span className="calendar-toolbar-title">{title}</span>
              <ChevronDown size={14} className="chevron" />
            </button>
            {showDatePicker &&
              createPortal(
                <>
                  {datePickerMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setShowDatePicker(false)} />}
                  <div
                    ref={datePickerRef}
                    className={`calendar-date-picker-dropdown ${datePickerMode === 'centered' ? 'menu-popover-centered' : ''}`}
                    style={datePickerMode === 'anchored' ? datePickerStyle : undefined}
                  >
                    <CalendarDatePickerDropdown
                      value={anchorDate}
                      onSelect={(date) => {
                        setAnchorDate(date);
                        setShowDatePicker(false);
                      }}
                    />
                  </div>
                </>,
                document.body
              )}
          </div>
          {!isMobile && (
            <div className="calendar-view-menu-wrap">
              <button
                ref={viewMenuTriggerRef}
                className="btn btn-icon calendar-view-menu-trigger"
                onClick={() => setShowViewMenu((v) => !v)}
                aria-label="Change view"
                aria-haspopup="true"
                aria-expanded={showViewMenu}
              >
                <Menu size={16} />
              </button>
              {showViewMenu &&
                createPortal(
                  <>
                    {viewMenuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setShowViewMenu(false)} />}
                    <div
                      ref={viewMenuRef}
                      className={`calendar-view-menu ${viewMenuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      style={viewMenuMode === 'anchored' ? viewMenuStyle : undefined}
                    >
                      {VIEWS.map((v) => (
                        <button
                          key={v.key}
                          className={view === v.key ? 'active' : ''}
                          onClick={() => {
                            setView(v.key);
                            setShowViewMenu(false);
                          }}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body
                )}
            </div>
          )}
          {/* Only worth showing once the user has actually navigated away from
              the current day/week/month — tapping it when it's already
              showing today would be a no-op. Trails the title/view-menu
              cluster, pushed to the right edge alongside the refresh icon. */}
          {isMobile && !isViewingToday && (
            <button className="btn calendar-today-btn-solo" onClick={goToday}>
              Today
            </button>
          )}
          {/* Mobile only — on desktop this stays in .calendar-toolbar-actions
              alongside Re-balance. On mobile it's placed here,
              at the right edge of the bar, pushed there via margin-left: auto
              (see calendar.css) unless Today-solo is also showing, in which
              case Today sits just left of it. Only useful once
              Google Calendar is actually connected — hidden rather than
              shown-but-disabled, matching how Settings' own Google controls
              are gated on googleConnected. Shares isSyncing with Settings'
              "Sync now"/"Push to Google Calendar" so this button, that
              button, and any other sync action all show a consistent busy
              state if one is already running. */}
          {isMobile && googleConnected && (
            <button
              className="btn btn-icon calendar-refresh-btn-mobile"
              onClick={syncNow}
              disabled={isSyncing}
              aria-label="Refresh Google Calendar events"
              title="Refresh Google Calendar events"
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : undefined} />
            </button>
          )}
          {/* Mobile: filter trigger joins the same trailing cluster as
              Today/refresh (see calendar.css's margin-left: auto handling
              for the first of that cluster) — desktop's copy lives in
              .calendar-toolbar-actions below instead. */}
          {isMobile && <CalendarFilterMenu filter={calendarFilter} onChange={setCalendarFilter} />}
        </div>
        <div className="calendar-toolbar-actions">
          {/* Desktop only — on mobile this moves into the FAB speed-dial
              below (see .calendar-fab) instead of wrapping onto its own row. */}
          {!isMobile && (
            <>
              <CalendarFilterMenu filter={calendarFilter} onChange={setCalendarFilter} />
              <button className="btn btn-primary" data-tour="rebalance" onClick={runRebalance} disabled={isLoading}>
                <Zap size={14} />
                Re-balance schedule
              </button>
              {/* Kept right-most in the toolbar, matching the "one help button
                  per cluster" pattern used elsewhere. */}
              <HelpTooltip label="How does Re-balance schedule work?">
                <strong>Re-balance schedule</strong> re-plans every unlocked block across your work hours and buffer
                days — weighting urgency by due date, priority, and whatever depends on it, splitting work across
                free gaps, and falling back to a task's fixed time if it has one.
              </HelpTooltip>
              {/* Only useful once Google Calendar is actually connected — hidden
                  rather than shown-but-disabled, matching how Settings' own
                  Google controls are gated on googleConnected. Shares isSyncing
                  with Settings' "Sync now"/"Push to Google Calendar" so this
                  button, that button, and any other sync action all show a
                  consistent busy state if one is already running. */}
              {googleConnected && (
                <button
                  className="btn btn-icon calendar-refresh-btn"
                  onClick={syncNow}
                  disabled={isSyncing}
                  aria-label="Refresh Google Calendar events"
                  title="Refresh Google Calendar events"
                >
                  <RefreshCw size={14} className={isSyncing ? 'spin' : undefined} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {isMobile ? (
          // Three pages (prev/current/next) sit side by side in a track 3x
          // the viewport's width, permanently positioned to show the middle
          // one (see the -33.3333% base offset) — the swipe effect above
          // drags this track live, then either settles it onto the
          // prev/next page or springs it back, at which point handleSwipe-
          // TransitionEnd advances `anchorDate` and resets the track.
          <div className="calendar-swipe-viewport" ref={swipeViewportRef}>
            <div
              className="calendar-swipe-track"
              ref={swipeTrackRef}
              style={{ transform: 'translateX(-33.3333%)' }}
              onTransitionEnd={handleSwipeTransitionEnd}
            >
              <div className="calendar-swipe-page">{swipePrevPage}</div>
              <div className="calendar-swipe-page">{renderCalendarPage(swipeCenterBase)}</div>
              <div className="calendar-swipe-page">{swipeNextPage}</div>
            </div>
          </div>
        ) : (
          renderCalendarPage(view === 'month' ? monthStart : rangeStart)
        )}
      </div>

      {/* Floating action button — replaces the old inline "New event"
          toolbar button, matching TaskListPanel's "Add task" FAB style
          (see .calendar-fab in calendar.css, mirroring .add-task-btn). On
          mobile it expands into a two-item speed-dial (Re-balance schedule +
          New event), since that toolbar button was removed from the mobile
          toolbar above to save vertical space, as a pair of mini-FABs — same
          .fab-mini shell/animation as mobile's, not a dropdown list — mirrors
          AddTaskFabGroup's expand/collapse pattern throughout. */}
      <div className="calendar-fab-group" ref={fabGroupRef}>
        {onOpenSearch && (
          <button
            className="btn btn-primary fab-round mobile-search-fab"
            onClick={onOpenSearch}
            aria-label="Open command palette"
            title="Search / commands"
          >
            <Search size={22} />
          </button>
        )}
        {fabExpanded && (
          <>
            {isMobile && (
              <>
                <button
                  className="btn btn-primary fab-mini"
                  data-tour="rebalance"
                  onClick={() => {
                    setFabExpanded(false);
                    runRebalance();
                  }}
                  disabled={isLoading}
                  aria-label="Re-balance schedule"
                  title="Re-balance schedule"
                >
                  <Zap size={16} />
                </button>
              </>
            )}
            <button
              className="btn btn-primary fab-mini"
              data-tour="new-event"
              onClick={() => {
                setFabExpanded(false);
                setCreatingEvent({
                  date: view === 'day' || view === 'threeDay' ? anchorDate : toISODate(new Date()),
                  startTime: '',
                  endTime: '',
                });
              }}
              aria-label="New event"
              title="New event"
            >
              <Plus size={16} />
            </button>
          </>
        )}
        <button
          ref={fabTriggerRef}
          className="btn btn-primary calendar-fab"
          data-tour={isMobile ? undefined : 'new-event'}
          onClick={() => setFabExpanded((v) => !v)}
          aria-label={fabExpanded ? 'Close' : 'Actions'}
          aria-expanded={fabExpanded}
        >
          {fabExpanded ? <X size={22} /> : <PenSquare size={22} />}
        </button>
      </div>

      {selectedBlock && (
        <BlockDetailModal block={selectedBlock} onClose={() => setSelectedBlockId(null)} onOpenTask={handleOpenTask} />
      )}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEventId(null)}
          onDeleted={() => setSelectedEventId(null)}
        />
      )}
      {creatingEvent && <EventDetailModal event={null} initial={creatingEvent} onClose={() => setCreatingEvent(null)} />}
      {selectedTask && <TaskDetailModal task={selectedTask} onClose={() => setSelectedTaskId(null)} />}
    </div>
  );
}

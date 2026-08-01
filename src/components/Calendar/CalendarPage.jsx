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
import { ChevronLeft, ChevronRight, ChevronDown, Menu, Plus, Zap, Sunrise, RefreshCw, PenSquare, X } from 'lucide-react';
import WeekView, { ZOOM_LEVELS_PX_PER_MIN, DEFAULT_ZOOM_INDEX } from './WeekView';
import MonthView from './MonthView';
import CalendarDatePickerDropdown from './CalendarDatePickerDropdown';
import BlockDetailModal from '../Modals/BlockDetailModal';
import EventDetailModal from '../Modals/EventDetailModal';
import TaskDetailModal from '../Modals/TaskDetailModal';
import { addDays, addMonths, dayOfWeek, formatDisplayDate, formatMonthLabel, startOfMonth, toISODate } from '../../utils/dateUtils';
import { expandRecurringEvent, resolveEventId } from '../../utils/recurrenceExpansion';
import { useScheduler } from '../../context/SchedulerContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePersistedState } from '../../hooks/usePersistedState';

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

export default function CalendarPage({ dayJumpRequest } = {}) {
  const [anchorDate, setAnchorDate] = useState(toISODate(new Date()));
  const isMobile = useIsMobile();
  const [view, setView] = useState(() => (isMobile ? 'day' : 'week'));
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [creatingEvent, setCreatingEvent] = useState(null); // { date, startTime, endTime } while the "block time" modal is open
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  // Mobile-only speed-dial state for the bottom-right FAB (see .calendar-fab
  // below) — expands into "Re-balance schedule" + "New event" mini-FABs
  // instead of the desktop FAB's single always-visible "New event" action,
  // mirroring AddTaskFabGroup's mobile expand/collapse pattern.
  const [fabExpanded, setFabExpanded] = useState(false);
  const dateWrapRef = useRef(null);
  const viewMenuWrapRef = useRef(null);
  const fabGroupRef = useRef(null);
  const {
    blocks,
    events,
    tasks,
    runRebalance,
    runPlanToday,
    isLoading,
    googleConnected,
    syncNow,
    isSyncing,
    ensureGoogleRangeSynced,
  } = useScheduler();
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

  // Close the date-picker/view-menu dropdowns on an outside click — each ref
  // wraps BOTH its trigger button and its dropdown panel, so clicks on the
  // trigger itself (which already toggles open/closed in its own onClick)
  // don't get double-handled here.
  useEffect(() => {
    if (!showDatePicker) return;
    function onDocMouseDown(e) {
      if (dateWrapRef.current && !dateWrapRef.current.contains(e.target)) setShowDatePicker(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [showDatePicker]);

  useEffect(() => {
    if (!showViewMenu) return;
    function onDocMouseDown(e) {
      if (viewMenuWrapRef.current && !viewMenuWrapRef.current.contains(e.target)) setShowViewMenu(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [showViewMenu]);

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
              <button className="btn" onClick={goToday}>
                Today
              </button>
              <button className="btn btn-icon calendar-nav-next" onClick={goNext} aria-label="Next">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {/* Only worth showing once the user has actually navigated away from
              the current day/week/month — tapping it when it's already
              showing today would be a no-op. Sits directly to the left of the
              date dropdown so it reads as part of the same control cluster. */}
          {isMobile && !isViewingToday && (
            <button className="btn calendar-today-btn-solo" onClick={goToday}>
              Today
            </button>
          )}
          <div className="calendar-title-wrap" ref={dateWrapRef}>
            <button
              className={`calendar-toolbar-title-btn ${showDatePicker ? 'is-open' : ''}`}
              onClick={() => setShowDatePicker((v) => !v)}
              aria-haspopup="true"
              aria-expanded={showDatePicker}
            >
              <span className="calendar-toolbar-title">{title}</span>
              <ChevronDown size={14} className="chevron" />
            </button>
            {showDatePicker && (
              <CalendarDatePickerDropdown
                value={anchorDate}
                onSelect={(date) => {
                  setAnchorDate(date);
                  setShowDatePicker(false);
                }}
              />
            )}
          </div>
          <div className="calendar-view-menu-wrap" ref={viewMenuWrapRef}>
            <button
              className="btn btn-icon"
              onClick={() => setShowViewMenu((v) => !v)}
              aria-label="Change view"
              aria-haspopup="true"
              aria-expanded={showViewMenu}
            >
              <Menu size={16} />
            </button>
            {showViewMenu && (
              <div className="calendar-view-menu">
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
            )}
          </div>
        </div>
        <div className="calendar-toolbar-actions">
          {/* Desktop only — on mobile this moves into the FAB speed-dial
              below (see .calendar-fab) instead of wrapping onto its own row. */}
          {!isMobile && (
            <>
              <button className="btn btn-primary" data-tour="rebalance" onClick={runRebalance} disabled={isLoading}>
                <Zap size={14} />
                Re-balance schedule
              </button>
              {/* Lighter sibling of Re-balance: only touches today's unlocked
                  blocks instead of the whole visible horizon — see
                  algorithms/rebalanceEngine.planToday for why this can't just
                  reuse the full rebalance and discard the rest. */}
              <button className="btn" data-tour="plan-today" onClick={runPlanToday} disabled={isLoading}>
                <Sunrise size={14} />
                Plan today
              </button>
            </>
          )}
          {/* Only useful once Google Calendar is actually connected — hidden
              rather than shown-but-disabled, matching how Settings' own
              Google controls are gated on googleConnected. Shares isSyncing
              with Settings' "Sync now"/"Push to Google Calendar" so this
              button, that button, and any other sync action all show a
              consistent busy state if one is already running. */}
          {googleConnected && (
            <button
              className="btn btn-icon"
              onClick={syncNow}
              disabled={isSyncing}
              aria-label="Refresh Google Calendar events"
              title="Refresh Google Calendar events"
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : undefined} />
            </button>
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
          desktop it still opens "New event" directly with a single click. On
          mobile it expands into a three-item speed-dial (Re-balance schedule +
          Plan today + New event) instead, since those toolbar buttons were
          removed from the mobile toolbar above to save vertical space —
          mirrors AddTaskFabGroup's mobile expand/collapse pattern. */}
      <div className="calendar-fab-group" ref={fabGroupRef}>
        {isMobile && fabExpanded && (
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
            <button
              className="btn btn-primary fab-mini"
              data-tour="plan-today"
              onClick={() => {
                setFabExpanded(false);
                runPlanToday();
              }}
              disabled={isLoading}
              aria-label="Plan today"
              title="Plan today"
            >
              <Sunrise size={16} />
            </button>
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
          className="btn btn-primary calendar-fab"
          data-tour={isMobile ? undefined : 'new-event'}
          onClick={() => {
            if (isMobile) {
              setFabExpanded((v) => !v);
            } else {
              setCreatingEvent({
                date: view === 'day' || view === 'threeDay' ? anchorDate : toISODate(new Date()),
                startTime: '',
                endTime: '',
              });
            }
          }}
          aria-label={isMobile && fabExpanded ? 'Close' : 'New event'}
          aria-expanded={isMobile ? fabExpanded : undefined}
        >
          {isMobile ? fabExpanded ? <X size={22} /> : <PenSquare size={22} /> : <Plus size={22} />}
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

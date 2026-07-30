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
import { ChevronLeft, ChevronRight, ChevronDown, Menu, Plus, Zap, RefreshCw } from 'lucide-react';
import WeekView, { ZOOM_LEVELS_PX_PER_MIN, DEFAULT_ZOOM_INDEX } from './WeekView';
import MonthView from './MonthView';
import CalendarDatePickerDropdown from './CalendarDatePickerDropdown';
import BlockDetailModal from '../Modals/BlockDetailModal';
import EventDetailModal from '../Modals/EventDetailModal';
import { addDays, addMonths, dayOfWeek, formatDisplayDate, formatMonthLabel, startOfMonth, toISODate } from '../../utils/dateUtils';
import { expandRecurringEvent, resolveEventId } from '../../utils/recurrenceExpansion';
import { useScheduler } from '../../context/SchedulerContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePersistedState } from '../../hooks/usePersistedState';

function getWeekStart(iso) {
  const dow = dayOfWeek(iso);
  return addDays(iso, -dow); // Sunday-start week
}

// Minimum horizontal drag distance (px) before a touch gesture counts as a
// swipe rather than a tap/scroll — low enough to feel responsive, high
// enough to not fire on incidental vertical-scroll touches.
const SWIPE_THRESHOLD_PX = 50;

// Views mirror Google Calendar's own switcher: Day/3 Day/Week give the full
// time-grid (WeekView, sized to 1, 3, or 7 columns), Month trades timeline
// precision for a density-first overview (MonthView).
const VIEWS = [
  { key: 'day', label: 'Day' },
  { key: 'threeDay', label: '3 Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

export default function CalendarPage() {
  const [anchorDate, setAnchorDate] = useState(toISODate(new Date()));
  const isMobile = useIsMobile();
  const [view, setView] = useState(() => (isMobile ? 'day' : 'week'));
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [creatingEvent, setCreatingEvent] = useState(null); // { date, startTime, endTime } while the "block time" modal is open
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const dateWrapRef = useRef(null);
  const viewMenuWrapRef = useRef(null);
  const { blocks, events, runRebalance, isLoading, googleConnected, syncNow, isSyncing } = useScheduler();
  const touchStartX = useRef(null);

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
  // _v2: the zoom level table gained more zoom-in steps above the original
  // max, so a v1 key persisted from before that change would pin returning
  // users to what is now a mid-range level instead of the new top/default.
  const [zoomIndex, setZoomIndex] = usePersistedState('taskflow_calendar_zoom_index_v2', DEFAULT_ZOOM_INDEX);
  const pxPerMin = ZOOM_LEVELS_PX_PER_MIN[zoomIndex];

  function handleZoomDelta(direction) {
    setZoomIndex((i) => Math.min(ZOOM_LEVELS_PX_PER_MIN.length - 1, Math.max(0, i + direction)));
  }

  const selectedBlock = selectedBlockId ? blocks.find((b) => b.id === selectedBlockId) || null : null;
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

  function handleTouchStart(e) {
    // A second finger joining mid-gesture means this is a pinch (zoom),
    // not a swipe — WeekView's own touch listeners own that gesture, so
    // bail out here and don't treat the eventual lift-off as a swipe.
    if (e.touches.length !== 1) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e) {
    if (touchStartX.current === null) return;
    // Still-active touches after this one lifts means a pinch is (or was)
    // in progress — same reasoning as handleTouchStart above.
    if (e.touches.length > 0) {
      touchStartX.current = null;
      return;
    }
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    if (deltaX < 0) goNext();
    else goPrev();
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
              the grid itself (see handleTouchStart/End), so a duplicate tap
              target for the same thing would be redundant there. */}
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
          <button className="btn btn-primary" data-tour="rebalance" onClick={runRebalance} disabled={isLoading}>
            <Zap size={14} />
            Re-balance schedule
          </button>
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

      <div
        style={{ flex: 1, minHeight: 0, display: 'flex' }}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
      >
        {view === 'month' ? (
          <MonthView
            monthStart={monthStart}
            onSelectBlock={(block) => setSelectedBlockId(block.id)}
            onSelectEvent={(evt) => setSelectedEventId(evt.id)}
            onSelectDay={jumpToDay}
          />
        ) : (
          <WeekView
            weekStart={rangeStart}
            dayCount={dayCount}
            isMobile={isMobile}
            pxPerMin={pxPerMin}
            onZoomDelta={handleZoomDelta}
            onSelectBlock={(block) => setSelectedBlockId(block.id)}
            onSelectEvent={(evt) => setSelectedEventId(evt.id)}
            onCreateEvent={(date, startTime, endTime) => setCreatingEvent({ date, startTime, endTime })}
            onSelectDay={jumpToDay}
          />
        )}
      </div>

      {/* Floating "+" action button — replaces the old inline "New event"
          toolbar button, matching TaskListPanel's "Add task" FAB style
          (see .calendar-fab in calendar.css, mirroring .add-task-btn). */}
      <button
        className="btn btn-primary calendar-fab"
        data-tour="new-event"
        onClick={() =>
          setCreatingEvent({
            date: view === 'day' || view === 'threeDay' ? anchorDate : toISODate(new Date()),
            startTime: '',
            endTime: '',
          })
        }
        aria-label="New event"
      >
        <Plus size={22} />
      </button>

      {selectedBlock && <BlockDetailModal block={selectedBlock} onClose={() => setSelectedBlockId(null)} />}
      {selectedEvent && <EventDetailModal event={selectedEvent} onClose={() => setSelectedEventId(null)} />}
      {creatingEvent && <EventDetailModal event={null} initial={creatingEvent} onClose={() => setCreatingEvent(null)} />}
    </div>
  );
}

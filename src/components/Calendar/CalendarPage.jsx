/**
 * CalendarPage — top-level container for the calendar tab: navigation
 * toolbar (prev/next week, today, view switch) + the WeekView grid itself,
 * plus the block detail modal when a block is selected.
 *
 * Only the selected block's *id* is tracked in state; the block object
 * passed to BlockDetailModal is derived fresh from context on every render
 * so drag/resize/lock changes made elsewhere are reflected immediately if
 * the modal happens to still be open.
 */

import React, { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Zap, CalendarPlus, RefreshCw } from 'lucide-react';
import WeekView, { ZOOM_LEVELS_PX_PER_MIN, DEFAULT_ZOOM_INDEX } from './WeekView';
import MonthView from './MonthView';
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

// Views mirror Google Calendar's own switcher: Day/Week give the full
// time-grid (WeekView, sized to 1 or 7 columns), Month trades timeline
// precision for a density-first overview (MonthView).
const VIEWS = [
  { key: 'day', label: 'Day' },
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
  const { blocks, events, runRebalance, isLoading, googleConnected, syncNow, isSyncing } = useScheduler();
  const touchStartX = useRef(null);
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

  const dayCount = view === 'day' ? 1 : 7;
  const step = view === 'day' ? 1 : 7;
  const rangeStart = view === 'day' ? anchorDate : getWeekStart(anchorDate);
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
          <button className="btn btn-icon calendar-nav-prev" onClick={goPrev} aria-label="Previous">
            <ChevronLeft size={16} />
          </button>
          {/* Desktop keeps Today inline here (prev/Today/next/date, unchanged).
              On mobile it's hidden here and re-rendered underneath the date
              row instead (see calendar-today-btn-solo below) — the date/
              arrows row becomes a plain "< Date >", reordered via CSS (see
              calendar.css) rather than here, so this DOM order stays what
              desktop needs. */}
          {!isMobile && (
            <button className="btn" onClick={goToday}>
              Today
            </button>
          )}
          <button className="btn btn-icon calendar-nav-next" onClick={goNext} aria-label="Next">
            <ChevronRight size={16} />
          </button>
          <div className="calendar-toolbar-title">{title}</div>
        </div>
        {/* Only worth showing once the user has actually navigated away from
            the current day/week/month — tapping it when it's already
            showing today would be a no-op. */}
        {isMobile && !isViewingToday && (
          <button className="btn calendar-today-btn-solo" onClick={goToday}>
            Today
          </button>
        )}
        <div className="calendar-toolbar-actions">
          <div className="view-switch">
            {VIEWS.map((v) => (
              <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <button
            className="btn"
            data-tour="new-event"
            onClick={() =>
              setCreatingEvent({ date: view === 'day' ? anchorDate : toISODate(new Date()), startTime: '', endTime: '' })
            }
          >
            <CalendarPlus size={14} />
            New event
          </button>
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
            onSelectDay={(date) => {
              setAnchorDate(date);
              setView('day');
            }}
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
          />
        )}
      </div>

      {selectedBlock && <BlockDetailModal block={selectedBlock} onClose={() => setSelectedBlockId(null)} />}
      {selectedEvent && <EventDetailModal event={selectedEvent} onClose={() => setSelectedEventId(null)} />}
      {creatingEvent && <EventDetailModal event={null} initial={creatingEvent} onClose={() => setCreatingEvent(null)} />}
    </div>
  );
}

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

import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Zap, CalendarPlus } from 'lucide-react';
import WeekView, { ZOOM_LEVELS_PX_PER_MIN, DEFAULT_ZOOM_INDEX } from './WeekView';
import MonthView from './MonthView';
import BlockDetailModal from '../Modals/BlockDetailModal';
import EventDetailModal from '../Modals/EventDetailModal';
import { addDays, addMonths, dayOfWeek, formatDisplayDate, formatMonthLabel, startOfMonth, toISODate } from '../../utils/dateUtils';
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
  const { blocks, events, runRebalance, isLoading } = useScheduler();
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
  const selectedEvent = selectedEventId ? events.find((e) => e.id === selectedEventId) || null : null;

  const dayCount = view === 'day' ? 1 : 7;
  const step = view === 'day' ? 1 : 7;
  const rangeStart = view === 'day' ? anchorDate : getWeekStart(anchorDate);
  const rangeEnd = addDays(rangeStart, dayCount - 1);
  const monthStart = startOfMonth(anchorDate);

  function goPrev() {
    setAnchorDate(view === 'month' ? addMonths(anchorDate, -1) : addDays(anchorDate, -step));
  }

  function goNext() {
    setAnchorDate(view === 'month' ? addMonths(anchorDate, 1) : addDays(anchorDate, step));
  }

  function handleTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e) {
    if (touchStartX.current === null) return;
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
          <button className="btn btn-icon" onClick={goPrev} aria-label="Previous">
            <ChevronLeft size={16} />
          </button>
          <button className="btn" onClick={() => setAnchorDate(toISODate(new Date()))}>
            Today
          </button>
          <button className="btn btn-icon" onClick={goNext} aria-label="Next">
            <ChevronRight size={16} />
          </button>
          <div className="calendar-toolbar-title">{title}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="view-switch">
            {VIEWS.map((v) => (
              <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <button
            className="btn"
            onClick={() =>
              setCreatingEvent({ date: view === 'day' ? anchorDate : toISODate(new Date()), startTime: '', endTime: '' })
            }
          >
            <CalendarPlus size={14} />
            Block time
          </button>
          <button className="btn btn-primary" onClick={runRebalance} disabled={isLoading}>
            <Zap size={14} />
            Re-balance schedule
          </button>
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
            onZoomDelta={isMobile ? undefined : handleZoomDelta}
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

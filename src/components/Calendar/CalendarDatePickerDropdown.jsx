/**
 * CalendarDatePickerDropdown — drops down from the toolbar's date/range
 * title (see CalendarPage), mirroring Google Calendar mobile's own date
 * picker: a horizontally scrollable strip of month tabs on top, and a mini
 * month grid below it for tapping an exact date.
 *
 * The month-tab strip is a fixed range (+/- MONTH_TAB_RADIUS months around
 * whichever month the dropdown opened on) rather than growing as the user
 * scrolls, same as a real slider with fixed bounds — plain horizontal
 * scroll/swipe (native `overflow-x: auto`) is what lets the user move
 * between months, tapping a tab (or scrolling) changes which month's grid
 * is shown below. Selecting a day calls `onSelect` with its ISO date; the
 * caller (CalendarPage) is responsible for closing the dropdown afterward.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMonths, dateRange, dayOfWeek, fromISODate, startOfMonth, toISODate } from '../../utils/dateUtils';

const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_TAB_RADIUS = 12; // months shown on each side of the opening month

function monthTabLabel(monthStartIso) {
  return fromISODate(monthStartIso).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

export default function CalendarDatePickerDropdown({ value, onSelect }) {
  const [pickerMonth, setPickerMonth] = useState(() => startOfMonth(value));
  const todayIso = toISODate(new Date());
  const activeTabRef = useRef(null);

  // Generated once on mount so the strip's bounds stay put while open —
  // recomputing it off `pickerMonth` would keep the active tab pinned to
  // the middle instead of letting the user actually scroll past it.
  const monthTabs = useMemo(() => {
    const base = startOfMonth(value);
    const tabs = [];
    for (let i = -MONTH_TAB_RADIUS; i <= MONTH_TAB_RADIUS; i++) tabs.push(addMonths(base, i));
    return tabs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Center the active tab on open — otherwise the strip starts scrolled to
  // its leftmost (oldest) tab, hiding the current month off-screen.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, []);

  const gridStart = useMemo(() => addDays(pickerMonth, -dayOfWeek(pickerMonth)), [pickerMonth]);
  const days = useMemo(() => dateRange(gridStart, 42), [gridStart]);
  const currentMonthStr = pickerMonth.slice(0, 7);

  // No wrapping div of its own — the caller (CalendarPage) applies the
  // `.calendar-date-picker-dropdown` class (visual styling + z-index)
  // directly to its portaled, `position: fixed` wrapper, the same pattern
  // `.calendar-view-menu` already uses. z-index only takes effect on a
  // positioned element, so splitting position and z-index across two nested
  // divs (as this used to) silently drops the z-index — the portal's
  // wrapper would win the position but lose the stacking order, letting
  // WeekView content underneath intercept clicks meant for this dropdown.
  return (
    <>
      <div className="calendar-date-picker-months">
        {monthTabs.map((m) => (
          <button
            key={m}
            ref={m === pickerMonth ? activeTabRef : undefined}
            className={`calendar-date-picker-month-tab ${m === pickerMonth ? 'active' : ''}`}
            onClick={() => setPickerMonth(m)}
          >
            {monthTabLabel(m)}
          </button>
        ))}
      </div>
      <div className="calendar-date-picker-dow-row">
        {DOW_LABELS.map((label, i) => (
          <div key={i} className="calendar-date-picker-dow">
            {label}
          </div>
        ))}
      </div>
      <div className="calendar-date-picker-grid">
        {days.map((day) => {
          const inMonth = day.slice(0, 7) === currentMonthStr;
          return (
            <button
              key={day}
              className={`calendar-date-picker-day ${inMonth ? '' : 'is-outside'} ${day === todayIso ? 'is-today' : ''} ${day === value ? 'is-selected' : ''}`}
              onClick={() => onSelect(day)}
            >
              {Number(day.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </>
  );
}

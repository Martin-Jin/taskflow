/**
 * ============================================================================
 * CALENDAR GROUPING
 * ============================================================================
 * Small helpers shared between WeekView and MonthView — the two components
 * that render ScheduledBlocks/CalendarEvents onto a day-by-day grid and
 * therefore need the same "which items land on which day" grouping logic.
 * ============================================================================
 */

import { expandEventsForRange } from './recurrenceExpansion';

// A block this short (or shorter) is eligible to collapse into a "short
// tasks" cluster chip rather than rendering as its own sliver — used by both
// WeekView (time-grid clustering) and MonthView (month-cell clustering) so
// the same run of tiny tasks reads the same way in either view.
export const SHORT_BLOCK_MAX_MIN = 15;

/**
 * Group blocks and (expanded, recurrence-aware) events by their ISO date.
 * Recurring events are stored once (the master's date/times describe
 * DTSTART) and expanded into virtual per-day instances here, at display
 * time only — never written back to state — so a repeating event shows up
 * on every day it recurs without becoming N duplicate records.
 *
 * `days` bounds the event-expansion range (expandEventsForRange only needs
 * the first/last day of whatever range the caller is currently rendering);
 * blocks aren't range-filtered here since neither caller needs that — each
 * only reads back the dates it cares about via the returned maps.
 *
 * @param {ScheduledBlock[]} blocks
 * @param {CalendarEvent[]} events
 * @param {string[]} days ISO dates, in order, spanning the rendered range
 * @returns {{ blocksByDay: Map<string, object[]>, eventsByDay: Map<string, object[]> }}
 */
export function groupItemsByDay(blocks, events, days) {
  const blocksByDay = new Map();
  for (const b of blocks) {
    const list = blocksByDay.get(b.date);
    if (list) list.push(b);
    else blocksByDay.set(b.date, [b]);
  }

  const eventsByDay = new Map();
  const expanded = expandEventsForRange(events, days[0], days[days.length - 1]);
  for (const e of expanded) {
    const list = eventsByDay.get(e.date);
    if (list) list.push(e);
    else eventsByDay.set(e.date, [e]);
  }

  return { blocksByDay, eventsByDay };
}

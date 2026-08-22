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
import { toISODate } from './dateUtils';

// A block this short (or shorter) is eligible to collapse into a "short
// tasks" cluster chip rather than rendering as its own sliver — used by both
// WeekView (time-grid clustering) and MonthView (month-cell clustering) so
// the same run of tiny tasks reads the same way in either view.
export const SHORT_BLOCK_MAX_MIN = 15;

/**
 * Should `block` (on a given calendar `day`) still render? Completed tasks
 * are meant to stay visible on their originally-scheduled day indefinitely —
 * the Calendar doubles as a completion history, not just a forward-looking
 * plan — so completion alone never hides a block. The one case that DOES
 * hide a block: a task completed BEFORE the day it was scheduled for (i.e.
 * finished early/in advance) never actually happened on that future day, so
 * that block disappears rather than sitting there as a misleading "still to
 * do" (or falsely-completed) slot once the day is reached. A block on or
 * before the task's completion date is unaffected. Recurring tasks are
 * excluded entirely (never marked `completed` on finishing an occurrence —
 * see `Task.isRecurring`), so callers should only apply this to non-recurring
 * completed tasks; everything else always renders.
 */
export function isCompletedOnDay(task, day) {
  if (!task || task.isRecurring || !task.isCompleted) return true;
  if (!task.completedAt) return true;
  return day <= toISODate(new Date(task.completedAt));
}

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
 * `taskById` (optional, `{ [id]: Task }` — same shape both callers already
 * keep for their own lookups) drives the completed-early-hides-future-block
 * filter above (see isCompletedOnDay) — a block whose task can't be found is
 * left in as-is (matches how the rest of the calendar already tolerates a
 * dangling taskId), and callers that don't pass it (existing behavior) skip
 * the filter entirely.
 *
 * @param {ScheduledBlock[]} blocks
 * @param {CalendarEvent[]} events
 * @param {string[]} days ISO dates, in order, spanning the rendered range
 * @param {Object<string, object>} [taskById]
 * @returns {{ blocksByDay: Map<string, object[]>, eventsByDay: Map<string, object[]> }}
 */
export function groupItemsByDay(blocks, events, days, taskById) {
  const blocksByDay = new Map();
  for (const b of blocks) {
    if (taskById && !isCompletedOnDay(taskById[b.taskId], b.date)) continue;
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

/**
 * A task's scheduled blocks, oldest first — a task's hours can be split across
 * several days, so there can be more than one.
 *
 * For a recurring task every future occurrence gets its own block too, so the
 * list is narrowed to the current occurrence's date instead of every
 * occurrence out to the scheduling horizon. That is normally the earliest
 * block's date, EXCEPT when the current occurrence was moved off-pattern (see
 * resolveCurrentOccurrenceDueDate): its block sits on the moved-to date, which
 * can sort after an older, not-yet-rebalanced block from a prior occurrence.
 * Preferring the resolved due date keeps this in step with the due-date field.
 *
 * When the current occurrence has no block of its own (typically an overdue
 * one: its day has passed, so the scheduler never re-placed it), the list falls
 * forward to the next block on or after that date. It must NOT fall back to the
 * earliest block overall: finished occurrences keep their blocks as a record, so
 * that is an old, crossed-out block from days ago, which made a daily task look
 * as if it had never been rescheduled. With nothing on or after the date the
 * list is empty, since any block before it belongs to a closed-out occurrence.
 *
 * Shared by TaskDetailModal and the task list's "Log time" button so both
 * hand the same block list to setRemainingHoursWithBlockInference.
 */
import { resolveCurrentOccurrenceDueDate } from './recurrence';

export function getTaskScheduledBlocks(task, blocks) {
  const sorted = blocks
    .filter((b) => b.taskId === task.id)
    .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
  if (!task.isRecurring || sorted.length === 0) return sorted;
  const currentOccurrenceDate = resolveCurrentOccurrenceDueDate(task);
  if (!currentOccurrenceDate) return sorted.filter((b) => b.date === sorted[0].date);
  const targetDate = sorted.find((b) => b.date >= currentOccurrenceDate)?.date;
  return targetDate ? sorted.filter((b) => b.date === targetDate) : [];
}

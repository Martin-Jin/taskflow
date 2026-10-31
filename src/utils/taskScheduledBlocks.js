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
 * Preferring the resolved due date (falling back to the earliest block, e.g.
 * before any rebalance has run) keeps this in step with the due-date field.
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
  const targetDate = sorted.some((b) => b.date === currentOccurrenceDate) ? currentOccurrenceDate : sorted[0].date;
  return sorted.filter((b) => b.date === targetDate);
}

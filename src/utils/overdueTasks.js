/**
 * ============================================================================
 * OVERDUE TASKS
 * ============================================================================
 * An "overdue" task is an incomplete task whose due date has already passed
 * (strictly before today — a task due today is "due today", not overdue).
 * This is the single source of truth for that definition, mirroring the
 * pattern in missedTasks.js — used by DashboardStats (count tile) and the
 * "Overdue" popup so both stay in agreement.
 *
 * "Due date" here means the date the task actually SHOWS to the user right
 * now, not necessarily its raw stored `dueDate` field. A recurring task can
 * have a per-occurrence `overrides` entry (see recurrence.js's
 * resolveCurrentOccurrenceDueDate) that moves its current occurrence to a
 * different date without touching the underlying `dueDate` — e.g. a
 * recurring sub-task automatically nudged when its recurring parent's due
 * date changes (see recurrenceState.js's
 * computeRecurringDescendantDueDateOverrides). Comparing the raw field
 * directly would keep flagging that sub-task as overdue even after the
 * override moved it to today or later, contradicting what every other
 * screen (e.g. the task detail view) already shows for it.
 * ============================================================================
 */
import { toISODate } from './dateUtils';
import { resolveCurrentOccurrenceDueDate } from './recurrence';

/**
 * Builds the list of overdue tasks for "right now" (defaults to `new Date()`),
 * sorted with the most overdue task (oldest due date) first.
 */
export function getOverdueTasks(tasks, now = new Date()) {
  const today = toISODate(now);

  return tasks
    .map((t) => ({ task: t, dueDate: resolveCurrentOccurrenceDueDate(t) }))
    .filter(({ task, dueDate }) => !task.isCompleted && dueDate && dueDate < today)
    .map(({ task, dueDate }) => ({ id: task.id, dueDate, title: task.title, link: task.link || null }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/**
 * ============================================================================
 * OVERDUE TASKS
 * ============================================================================
 * An "overdue" task is an incomplete task whose due date has already passed
 * (strictly before today — a task due today is "due today", not overdue).
 * This is the single source of truth for that definition, mirroring the
 * pattern in missedTasks.js — used by DashboardStats (count tile) and the
 * "Overdue" popup so both stay in agreement.
 * ============================================================================
 */
import { toISODate } from './dateUtils';

/**
 * Builds the list of overdue tasks for "right now" (defaults to `new Date()`),
 * sorted with the most overdue task (oldest due date) first.
 */
export function getOverdueTasks(tasks, now = new Date()) {
  const today = toISODate(now);

  return tasks
    .filter((t) => !t.isCompleted && t.dueDate && t.dueDate < today)
    .map((t) => ({ id: t.id, dueDate: t.dueDate, title: t.title, link: t.link || null }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

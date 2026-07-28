/**
 * ============================================================================
 * MISSED TASKS
 * ============================================================================
 * A "missed" item is a today's scheduled block whose end time has already
 * elapsed, attached to a task that hasn't been marked complete. This is the
 * single source of truth for that definition — it's used by DashboardStats
 * (count tile + "Missed" popup) and TodayAgenda (inline highlighting), so
 * both stay in agreement without recomputing slightly-different logic
 * twice.
 * ============================================================================
 */
import { toISODate, timeToMinutes } from './dateUtils';

/** Is `block` (joined with its `task`) missed, given `today`/`nowMinutes`? */
export function isBlockMissed(block, task, today, nowMinutes) {
  if (!task || task.isCompleted) return false;
  if (block.date !== today) return false;
  return timeToMinutes(block.endTime) <= nowMinutes;
}

/**
 * Builds the list of missed items for "right now" (defaults to `new Date()`),
 * joined with task title/link, sorted by start time.
 */
export function getMissedTaskItems(tasks, blocks, now = new Date()) {
  const today = toISODate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  return blocks
    .map((block) => ({ block, task: taskById.get(block.taskId) }))
    .filter(({ block, task }) => isBlockMissed(block, task, today, nowMinutes))
    .map(({ block, task }) => ({
      id: block.id,
      taskId: task.id,
      startTime: block.startTime,
      endTime: block.endTime,
      title: task.title,
      link: task.link || null,
    }))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

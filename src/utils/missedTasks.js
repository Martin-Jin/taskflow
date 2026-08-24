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
import { toISODate, timeToMinutes, fromISODate } from './dateUtils';

/**
 * Was `block`'s occurrence of `task` completed? A plain (non-recurring) task
 * stays `isCompleted: true` once done, but a recurring task's `isCompleted`
 * flips back to `false` the moment it's completed (advancing to its next
 * occurrence — see SchedulerContext.completeTask) even though TODAY's block
 * for the occurrence just closed out is deliberately kept around as a
 * historical record. So for a recurring task, "was this specific block's
 * occurrence completed" is answered by `completedDates` (which occurrence-
 * dates have been closed out) instead of the task's current `isCompleted`.
 */
export function isBlockTaskCompleted(block, task) {
  if (!task) return false;
  if (task.isRecurring) return !!task.completedDates?.includes(block.date);
  return !!task.isCompleted;
}

/**
 * Was THIS block's own slice of work marked done (see SchedulerContext's
 * markBlockDone/unmarkBlockDone and ScheduledBlock.status's doc comment),
 * independent of whether the whole task is complete? A multi-day task's
 * block for one day being done is exactly the case isBlockTaskCompleted
 * alone can't express — that's the reason this field/function exists.
 */
export function isBlockDone(block) {
  return block?.status === 'done';
}

/**
 * True if the block should read as "done" for display/missed-detection
 * purposes: either the whole task is completed, OR this specific block was
 * marked done on its own (see isBlockDone). This is the function every
 * consumer that used to call isBlockTaskCompleted alone for that purpose
 * should use instead — isBlockTaskCompleted itself stays as the narrower
 * "is the TASK completed" check, still needed on its own by
 * isBlockCompletedLate below (a block-level completion has no completedAt
 * timestamp to compare against, so "completed late" doesn't apply to it).
 */
export function isBlockOrTaskDone(block, task) {
  return isBlockTaskCompleted(block, task) || isBlockDone(block);
}

/** Is `block` (joined with its `task`) missed, given `today`/`nowMinutes`? */
export function isBlockMissed(block, task, today, nowMinutes) {
  if (!task || isBlockOrTaskDone(block, task)) return false;
  if (block.date !== today) return false;
  return timeToMinutes(block.endTime) <= nowMinutes;
}

/**
 * Was `block`'s occurrence (already completed) marked done after its
 * scheduled end time had already elapsed? Used to give "completed late" a
 * visually distinct look from a plain on-time completion.
 */
export function isBlockCompletedLate(block, task) {
  if (!isBlockTaskCompleted(block, task) || !task.completedAt) return false;
  const blockEnd = fromISODate(block.date);
  const [h, m] = block.endTime.split(':').map(Number);
  blockEnd.setHours(h, m, 0, 0);
  return new Date(task.completedAt) > blockEnd;
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

/**
 * ============================================================================
 * TASK HIERARCHY HELPERS
 * ============================================================================
 * Shared read-only helpers for the "container-only parent" rule (see
 * types/index.js's Task.estimatedHours/remainingHours doc comments): once a
 * task has ≥1 sub-task, its own estimatedHours/remainingHours stop being a
 * directly-editable number and become a live rollup of its children's own
 * effective hours instead — cascading naturally, since a child that itself
 * has children returns ITS rollup rather than a raw stored number.
 *
 * Deliberately a pure, on-demand derivation rather than something that
 * mutates/caches a computed value onto the stored Task object — a cached sum
 * would drift the moment a child's own hours change and nothing re-synced it
 * (see CLAUDE.md's guidance on derived vs. stored values). Callers that
 * display a task's hours (TaskListPanel, BoardView, TaskDetailModal) should
 * use these instead of reading `task.estimatedHours`/`remainingHours`
 * directly whenever the task might have children.
 *
 * NOT used by the scheduler itself: a container parent is excluded from
 * allocation entirely (see rebalanceEngine.js's `parentIds` check), so it
 * never needs a rolled-up hours figure to schedule against — only leaf
 * tasks (or subtasks-of-subtasks that are themselves leaves) ever get their
 * own calendar blocks, using their own real stored hours.
 * ============================================================================
 */

/** Direct children of `taskId` (one level) — a child that itself has children is not expanded here. */
export function getDirectChildren(taskId, tasks) {
  return tasks.filter((t) => t.parentId === taskId);
}

/** True if `taskId` has at least one direct sub-task. */
export function hasChildTasks(taskId, tasks) {
  return tasks.some((t) => t.parentId === taskId);
}

/**
 * Recursive rollup, generic over which hours field to sum (`estimatedHours`
 * or `remainingHours`) — a leaf task (no children) just returns its own
 * stored value for that field. `visited` guards against a hand-edited/
 * corrupted backup introducing a `parentId` cycle, mirroring the same
 * defensive pattern used elsewhere for parentId walks (e.g.
 * SchedulerContext's getDescendantIds).
 */
function rollupHours(task, tasks, field, visited) {
  if (visited.has(task.id)) return task[field] || 0; // cycle guard — treat as a leaf rather than recursing forever
  const children = getDirectChildren(task.id, tasks);
  if (children.length === 0) return task[field] || 0;
  visited.add(task.id);
  return children.reduce((sum, child) => sum + rollupHours(child, tasks, field, visited), 0);
}

/** A task's effective `estimatedHours`: its own value if it's a leaf, otherwise the sum of its children's effective estimatedHours. */
export function getEffectiveEstimatedHours(task, tasks) {
  return rollupHours(task, tasks, 'estimatedHours', new Set());
}

/** A task's effective `remainingHours`: its own value if it's a leaf, otherwise the sum of its children's effective remainingHours. */
export function getEffectiveRemainingHours(task, tasks) {
  return rollupHours(task, tasks, 'remainingHours', new Set());
}

/**
 * Walk up `task.parentId` (arbitrarily deep — nesting is capped at 2 levels
 * by the UI, but this walk stays general/defensive rather than assuming
 * that) to find the nearest ancestor with its own `dueDate`. Returns null if
 * `task` has no parent, or every ancestor up the chain is also undated.
 * `visited` guards against a hand-edited/corrupted backup introducing a
 * cycle, mirroring the same defensive pattern used elsewhere for parentId
 * walks (e.g. SchedulerContext's getDescendantIds).
 *
 * Used to enforce that a sub-task's own due date can never be scheduled past
 * its parent goal's deadline — see TaskDetailModal's due-date validation and
 * WeekView/MonthView's drag-to-reschedule guard. This mirrors (but is a
 * separate copy of) allocator.js's private findAncestorDueDate, which feeds
 * the same date in as soft pacing pressure for undated sub-tasks rather than
 * a hard validation boundary — kept here instead of exported from
 * allocator.js so UI code doesn't reach into the scheduling engine's
 * internals for an unrelated purpose.
 */
export function findNearestAncestorDueDate(task, tasksById) {
  if (!task.parentId) return null;
  const visited = new Set([task.id]);
  let current = task;
  while (current.parentId) {
    const parent = tasksById.get ? tasksById.get(current.parentId) : tasksById[current.parentId];
    if (!parent || visited.has(parent.id)) return null;
    if (parent.dueDate) return parent.dueDate;
    visited.add(parent.id);
    current = parent;
  }
  return null;
}

/**
 * Is `task` "done for now"? For a plain task this is just `isCompleted`. For
 * a recurring task, `isCompleted` is deliberately never set true on a normal
 * completion (see SchedulerContext.completeTask) — instead each closed-out
 * occurrence's date is recorded into `completedDates`, so "done for now"
 * means today's date is in there. This is purely a "does today's occurrence
 * still need doing" check — it says nothing about whether the task will ever
 * be permanently done, which is why TaskDetailModal (editing the recurring
 * task itself) should keep reading `isCompleted` directly rather than this;
 * it's meant for list-style views that want to show "done for today".
 */
export function isCompletedForCurrentOccurrence(task, todayIso) {
  if (task.isRecurring) return !!task.completedDates?.includes(todayIso);
  return !!task.isCompleted;
}

/**
 * Should `task` render as checked/struck-through in a list-style view (e.g.
 * TaskListPanel's Overdue/Today/Upcoming rows)? Not the same question as
 * isCompletedForCurrentOccurrence: that helper answers "was TODAY's date
 * recorded as done", which is only meaningful for the occurrence a recurring
 * task is CURRENTLY sitting on. Completing an occurrence advances `dueDate`
 * to the next, not-yet-completed one (see recurrenceState.js), while today's
 * date stays in the rolling `completedDates` window for days afterward — so
 * a recurring task already rolled forward into the future (shown in
 * "Upcoming") would otherwise still read as checked off of that stale
 * window, even though its actual current occurrence hasn't happened yet.
 * Gating on `dueDate <= todayIso` for a recurring task fixes that: only a
 * recurring task whose occurrence is due today (or overdue) can be "done for
 * now" in this sense. A non-recurring task has no such window to be misled
 * by, so it keeps behaving exactly as isCompletedForCurrentOccurrence alone.
 */
export function isCheckedForListDisplay(task, todayIso) {
  if (!task.isRecurring) return isCompletedForCurrentOccurrence(task, todayIso);
  return !!task.dueDate && task.dueDate <= todayIso && isCompletedForCurrentOccurrence(task, todayIso);
}

/**
 * True if `taskId` has at least one direct sub-task and every one of them is
 * "done for now" (see isCompletedForCurrentOccurrence) — the rollup that
 * drives auto-completing a parent once its whole checklist is done for the
 * current cycle (see SchedulerContext.completeTask's upward cascade). A task
 * with no children is never "all children done" (there's nothing to roll
 * up), so this is false for a leaf — callers should gate on hasChildTasks
 * first if they need to tell "no children" apart from "children, not all
 * done".
 */
export function areAllChildrenCompletedForCurrentOccurrence(taskId, tasks, todayIso) {
  const children = getDirectChildren(taskId, tasks);
  if (children.length === 0) return false;
  return children.every((child) => isCompletedForCurrentOccurrence(child, todayIso));
}

/**
 * All descendants of `taskId` (children, grandchildren, ...) as full Task
 * objects, via the `parentId` chain — used by TaskDetailModal's "Apply to
 * all sub-tasks" action, which cascades a parent's shared fields down its
 * whole subtree (not just direct children), same depth as any other
 * subtree-wide operation (see SchedulerContext's own getDescendantIds, used
 * for completeTask/deleteTask's cascades — kept as a separate copy here
 * since that one is module-private and returns ids only). `visited` guards
 * against a hand-edited/corrupted backup introducing a `parentId` cycle.
 */
export function getAllDescendants(taskId, tasks) {
  const childrenByParentId = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const siblings = childrenByParentId.get(t.parentId) || [];
    siblings.push(t);
    childrenByParentId.set(t.parentId, siblings);
  }
  const descendants = [];
  const visited = new Set([taskId]);
  const queue = [...(childrenByParentId.get(taskId) || [])];
  while (queue.length > 0) {
    const t = queue.pop();
    if (visited.has(t.id)) continue;
    visited.add(t.id);
    descendants.push(t);
    queue.push(...(childrenByParentId.get(t.id) || []));
  }
  return descendants;
}

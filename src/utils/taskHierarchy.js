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

/**
 * ============================================================================
 * DEPENDENCY HELPERS
 * ============================================================================
 * Shared between the scheduling engine (rebalanceEngine excludes a task from
 * allocation until its dependencies are done) and the task-editing UI (which
 * needs to stop a user from picking a dependency that would create a cycle).
 * ============================================================================
 */

/** True if every task in `task.dependsOn` is completed (or the list is empty/absent). */
export function areDependenciesMet(task, taskById) {
  const deps = task.dependsOn;
  if (!deps || deps.length === 0) return true;
  return deps.every((depId) => taskById.get(depId)?.isCompleted);
}

/**
 * IDs that must NOT be offered as a dependency for `taskId`: itself, plus
 * every task that (directly or transitively) already depends on it. Picking
 * one of those would create a cycle — two tasks each waiting on the other to
 * finish first, which the scheduler could never resolve.
 * @param {string} taskId
 * @param {import('../types').Task[]} tasks
 * @returns {Set<string>}
 */
export function getIneligibleDependencyIds(taskId, tasks) {
  const dependents = new Map(); // taskId -> ids of tasks that list it in their own dependsOn
  for (const t of tasks) {
    for (const depId of t.dependsOn || []) {
      if (!dependents.has(depId)) dependents.set(depId, []);
      dependents.get(depId).push(t.id);
    }
  }

  const blocked = new Set([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dependentId of dependents.get(current) || []) {
      if (!blocked.has(dependentId)) {
        blocked.add(dependentId);
        queue.push(dependentId);
      }
    }
  }
  return blocked;
}

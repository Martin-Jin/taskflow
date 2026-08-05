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
 * Map from a task's id to the ids of tasks that directly list it in their
 * own `dependsOn` (its direct "dependents" — tasks blocked on it finishing).
 * Shared by the cycle check below and by allocator.js, which uses it both to
 * detect blocker tasks (for greedy blocker-clearing) and to propagate a
 * dependent's urgency backward onto its blocker.
 * @param {import('../types').Task[]} tasks
 * @returns {Map<string, string[]>}
 */
export function getDependentsMap(tasks) {
  const dependents = new Map();
  for (const t of tasks) {
    for (const depId of t.dependsOn || []) {
      if (!dependents.has(depId)) dependents.set(depId, []);
      dependents.get(depId).push(t.id);
    }
  }
  return dependents;
}

/**
 * All ids that `taskId` (directly or transitively) depends on — the full
 * upstream chain, not just its immediate `dependsOn` list. Used by
 * localSearch.js to enforce "every chunk of a dependent task must be placed
 * after the LAST placed chunk of every dependency, direct or transitive"
 * without needing to walk the chain by hand at every move-validation call.
 * `taskById` should cover the full task graph (a dependency might not be in
 * the schedulable subset a caller is otherwise working with). Defensive
 * against cycles via a `visited` set, mirroring this file's other traversals.
 * @param {string} taskId
 * @param {Map<string, import('../types').Task>} taskById
 * @returns {Set<string>}
 */
export function getTransitiveDependencyIds(taskId, taskById) {
  const result = new Set();
  const queue = [taskId];
  const visited = new Set([taskId]);
  while (queue.length > 0) {
    const current = queue.pop();
    const task = taskById.get(current);
    for (const depId of task?.dependsOn || []) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      result.add(depId);
      queue.push(depId);
    }
  }
  return result;
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
  const dependents = getDependentsMap(tasks);

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

/**
 * ============================================================================
 * TASK VALIDATION
 * ============================================================================
 * Standalone, pure extraction of the four per-field validation gates
 * TaskDetailModal's sidebar has always computed inline as component-local
 * `const` expressions (dueDateError, dueDateRequiredError, fixedTimeError,
 * enforcingAncestor). Pulled out here so the SAME checks can run per-item
 * inside the bulk-edit engine (utils/bulkEditEngine.js), not just against
 * TaskDetailModal's own local form state — this is a behavior-preserving
 * refactor: TaskDetailModal calls these instead of duplicating the logic, so
 * there's exactly one implementation of each check.
 *
 * Every function here takes plain arguments (a task, candidate next values, a
 * taskById Map) and returns a value with no side effects — no React state, no
 * closures over component-local refs — so they're trivially unit-testable and
 * safe to call from a plain loop over several tasks at once.
 * ============================================================================
 */

import { findNearestAncestorDueDate } from './taskHierarchy';
import { formatDisplayDate } from './dateUtils';

/**
 * A sub-task's own due date can never be later than its nearest dated
 * ancestor's — that ancestor's due date is the hard "finish everything toward
 * this goal by this day" deadline (see allocator.js's resolveDueDate/
 * getTaskWindow). Returns an empty string when there's no violation (matching
 * the inline `const dueDateError = ... : ''` convention this replaces), or a
 * user-facing message naming the parent and its due date.
 * @param {import('../types').Task} task
 * @param {string} nextDueDate - candidate due date (ISO, or '' for none)
 * @param {Map<string, import('../types').Task>} tasksById
 * @returns {string}
 */
export function computeDueDateError(task, nextDueDate, tasksById) {
  const ancestorDueDate = findNearestAncestorDueDate(task, tasksById);
  if (!ancestorDueDate || !nextDueDate || nextDueDate <= ancestorDueDate) return '';
  const parentTitle = tasksById.get(task.parentId)?.title || 'parent task';
  return `Can't be later than "${parentTitle}"'s due date (${formatDisplayDate(ancestorDueDate)}).`;
}

/**
 * Recurring tasks are scheduled off their due date advancing each occurrence
 * (see completeTask/computeNextDueDate) — a recurring task with no due date
 * has nothing to advance from, so clearing it (or making a task recurring
 * with no due date set) is blocked here the same way dueDateError blocks an
 * incomplete edit above.
 * @param {boolean} isRecurring - candidate isRecurring value
 * @param {string} nextDueDate - candidate due date (ISO, or '' for none)
 * @returns {string}
 */
export function computeDueDateRequiredError(isRecurring, nextDueDate) {
  return isRecurring && !nextDueDate ? 'Recurring tasks need a due date — pick one, or turn off "Repeats".' : '';
}

/**
 * Checking "Fixed time" with no time chosen yet is an incomplete edit — block
 * it from silently autosaving (or from an explicit Save/bulk-apply) until a
 * time is actually picked.
 * @param {boolean} fixedTimeEnabled - candidate "Fixed time" checkbox state
 * @param {string} fixedTime - candidate "HH:MM" value
 * @returns {string}
 */
export function computeFixedTimeError(fixedTimeEnabled, fixedTime) {
  return fixedTimeEnabled && !fixedTime ? 'Pick a time, or turn off "Fixed time".' : '';
}

/**
 * Is this task's enforceDueDate being forced on by an ancestor (see
 * computeEnforceDueDateSyncUpdates)? Walks the parentId chain looking for the
 * nearest ancestor with both `enforceDueDate` and a `dueDate` of its own —
 * that ancestor is returned (or null if none), so a caller can both disable
 * an "enforce due date" checkbox AND explain why (mirrors the guard against a
 * corrupted-backup parentId cycle used elsewhere in this codebase, e.g.
 * utils/recurrence.js's computeEnforceDueDateSyncUpdates).
 * @param {import('../types').Task} task
 * @param {Map<string, import('../types').Task>} tasksById
 * @returns {import('../types').Task|null}
 */
export function computeEnforcingAncestor(task, tasksById) {
  if (!task.parentId) return null;
  const visited = new Set([task.id]);
  let current = task;
  while (current.parentId) {
    const parent = tasksById.get(current.parentId);
    if (!parent || visited.has(parent.id)) return null;
    if (parent.enforceDueDate && parent.dueDate) return parent;
    visited.add(parent.id);
    current = parent;
  }
  return null;
}

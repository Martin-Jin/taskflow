/**
 * ============================================================================
 * BULK EDIT ENGINE
 * ============================================================================
 * Backs the shared docked bottom bar (Common/BulkActionBar.jsx) used by List,
 * Board, Calendar, and TaskDetailModal's sub-task list once 1+ items are
 * selected (see hooks/useMultiSelect.js). Two concerns live here:
 *
 *   1. computeBulkEditableFields — pure function: given the current
 *      selection (each item tagged with its entity kind), decide which
 *      fields the bottom bar should offer at all. Per this feature's design
 *      table: a Task/sub-task or a task-backed ScheduledBlock support every
 *      field; a standalone CalendarEvent only supports a date/time shift,
 *      recurrence (its own RRULE system), and delete. A MIXED selection only
 *      offers the INTERSECTION — e.g. selecting a Task alongside a
 *      standalone Event hides project/tags/priority/status entirely, since
 *      those have no meaning for the Event half of the selection. Recurrence
 *      is a special case: Task and CalendarEvent recurrence are two
 *      unrelated systems (word-based recurrenceString vs. RRULE — see
 *      utils/recurrence.js vs. utils/recurrenceExpansion.js) with no shared
 *      format, so a mixed Task+Event selection hides recurrence entirely
 *      rather than risk applying one system's rule shape to the other kind
 *      of item — simpler and safer than running two parallel edit paths for
 *      one field.
 *
 *   2. applyBulkEdit — orchestrates the actual per-item commit: validates
 *      each item with the SAME extracted gates TaskDetailModal's own single-
 *      edit path uses (utils/taskValidation.js) plus the dependency-cycle
 *      check (utils/dependencyUtils.js) where relevant, skips (doesn't
 *      apply to) any item that fails, and applies to every item that
 *      passes — deliberately NOT an atomic all-or-nothing transaction (see
 *      this feature's spec: "apply edits per-item, not all-or-nothing").
 *      Delegates every actual write to the existing SchedulerContext mutators
 *      (updateTask/updateEvent/deleteTask/deleteEvent) passed in as plain
 *      callbacks — this file reimplements no cascade logic of its own.
 * ============================================================================
 */

import { computeDueDateError, computeDueDateRequiredError, computeFixedTimeError } from './taskValidation';
import { getIneligibleDependencyIds } from './dependencyUtils';

// Every field this engine can offer, and which entity kinds support it — the
// single source of truth computeBulkEditableFields intersects against.
// 'event' only ever offers dueDate (meaning: date/time shift) and recurrence
// (meaning: its own RRULE, never a Task's recurrenceString) — see the module
// doc comment for why a mixed selection hides recurrence rather than merge
// the two systems.
const FIELD_SUPPORT = {
  dueDate: new Set(['task', 'block', 'event']),
  recurrence: new Set(['task', 'block', 'event']),
  project: new Set(['task', 'block']),
  labels: new Set(['task', 'block']),
  priority: new Set(['task', 'block']),
  status: new Set(['task', 'block']),
};

/**
 * @param {Array<{kind: 'task'|'block'|'event'}>} selectedEntities - resolved
 *   items (not just keys) the caller has already looked up from live state.
 * @returns {{dueDate: boolean, recurrence: boolean, project: boolean, labels: boolean, priority: boolean, status: boolean, delete: boolean}}
 */
export function computeBulkEditableFields(selectedEntities) {
  const kinds = new Set(selectedEntities.map((e) => e.kind));
  const result = { delete: kinds.size > 0 };
  for (const [field, supportedKinds] of Object.entries(FIELD_SUPPORT)) {
    // A mixed Task+Event selection loses recurrence entirely (see module doc
    // comment) — every OTHER field already excludes 'event' from its
    // supported-kinds set, so the plain "every kind present is supported"
    // check below already produces the right answer for those; recurrence
    // needs its own extra rule since 'event' nominally "supports" it (its own
    // RRULE), but not in a way compatible with a Task/block sharing the
    // selection.
    if (field === 'recurrence' && kinds.has('event') && (kinds.has('task') || kinds.has('block'))) {
      result[field] = false;
      continue;
    }
    result[field] = kinds.size > 0 && [...kinds].every((k) => supportedKinds.has(k));
  }
  return result;
}

/**
 * Validates ONE task-like item (a Task, or a ScheduledBlock's underlying
 * Task) against `updates` using the same gates TaskDetailModal's single-edit
 * path applies, plus a dependency-cycle check when `updates.dependsOn` is
 * present. Returns null when the edit is fine to apply, or a user-facing
 * skip reason string otherwise.
 * @param {import('../types').Task} task - current (pre-update) task
 * @param {object} updates - candidate partial update (same shape updateTask takes)
 * @param {Map<string, import('../types').Task>} tasksById
 * @returns {string|null}
 */
export function validateTaskBulkUpdate(task, updates, tasksById) {
  const nextDueDate = 'dueDate' in updates ? updates.dueDate || '' : task.dueDate || '';
  const nextIsRecurring = 'isRecurring' in updates ? !!updates.isRecurring : !!task.isRecurring;
  const nextFixedTimeEnabled = 'fixedTime' in updates ? !!updates.fixedTime : !!task.fixedTime;
  const nextFixedTime = 'fixedTime' in updates ? updates.fixedTime || '' : task.fixedTime || '';

  const dueDateError = computeDueDateError(task, nextDueDate, tasksById);
  if (dueDateError) return dueDateError;

  const dueDateRequiredError = computeDueDateRequiredError(nextIsRecurring, nextDueDate);
  if (dueDateRequiredError) return dueDateRequiredError;

  const fixedTimeError = computeFixedTimeError(nextFixedTimeEnabled, nextFixedTime);
  if (fixedTimeError) return fixedTimeError;

  if (updates.dependsOn) {
    const ineligible = getIneligibleDependencyIds(task.id, [...tasksById.values()]);
    if (updates.dependsOn.some((depId) => ineligible.has(depId))) {
      return "Would create a circular dependency — skipped that part of the edit.";
    }
  }

  return null;
}

/**
 * Runs the bulk commit across every selected item, per-item (skip-and-
 * continue, never all-or-nothing — see module doc comment). Each entry in
 * `items` is `{ kind: 'task'|'block'|'event', id, task? }` — `task` is the
 * resolved underlying Task for a 'task' or 'block' kind (a block's own edits
 * apply to its underlying task, per this feature's design table), absent for
 * 'event'. Delete is handled by the SAME shape but with `updates: null` and
 * the caller signaling `isDelete: true`, so one function handles both an
 * edit batch and a delete batch with one shared skip-and-continue loop.
 *
 * @param {object} params
 * @param {Array<{kind: 'task'|'block'|'event', id: string, task?: import('../types').Task}>} params.items
 * @param {object|null} params.updates - partial update to apply to every task-like item (null for delete)
 * @param {'this'|'following'|'all'} [params.eventScope] - scope for CalendarEvent updates/deletes (see updateEvent/deleteEvent)
 * @param {Map<string, import('../types').Task>} params.tasksById
 * @param {boolean} [params.isDelete]
 * @param {(taskId: string, updates: object) => void} params.updateTask
 * @param {(eventId: string, updates: object, scope: string) => void} params.updateEvent
 * @param {(taskId: string) => void} params.deleteTask
 * @param {(eventId: string, scope: string) => void} params.deleteEvent
 * @returns {{ appliedCount: number, skipped: Array<{ id: string, title: string, reason: string }> }}
 */
export function applyBulkEdit({
  items,
  updates,
  eventScope = 'this',
  tasksById,
  isDelete = false,
  updateTask,
  updateEvent,
  deleteTask,
  deleteEvent,
}) {
  const skipped = [];
  let appliedCount = 0;
  // A task and its own sub-task can both be selected at once — deleteTask
  // already cascades to descendants (see SchedulerContext), so once a
  // selected task's ancestor has been deleted in this same batch, deleting
  // the descendant again is redundant (harmless/idempotent, but avoided here
  // to keep the per-item summary accurate rather than double-counting).
  const deletedTaskIds = new Set();

  for (const item of items) {
    if (item.kind === 'event') {
      if (isDelete) {
        deleteEvent(item.id, eventScope);
        appliedCount++;
      } else {
        updateEvent(item.id, updates, eventScope);
        appliedCount++;
      }
      continue;
    }

    // 'task' or 'block' — both resolve to editing/deleting the underlying Task.
    const task = item.task || tasksById.get(item.id);
    if (!task) {
      skipped.push({ id: item.id, title: item.id, reason: 'No longer exists.' });
      continue;
    }
    if (deletedTaskIds.has(task.id)) continue; // already removed as another selected item's descendant

    if (isDelete) {
      deleteTask(task.id);
      deletedTaskIds.add(task.id);
      appliedCount++;
      continue;
    }

    const reason = validateTaskBulkUpdate(task, updates, tasksById);
    if (reason) {
      skipped.push({ id: task.id, title: task.title, reason });
      continue;
    }
    updateTask(task.id, updates);
    appliedCount++;
  }

  return { appliedCount, skipped };
}

/**
 * Builds the "Applied to N of M; K skipped: ..." summary message shown after
 * a bulk edit/delete batch completes (see SchedulerContext.setNotification,
 * reused here rather than a bespoke toast component).
 * @param {number} appliedCount
 * @param {number} totalCount
 * @param {Array<{title: string, reason: string}>} skipped
 * @returns {string}
 */
export function formatBulkEditSummary(appliedCount, totalCount, skipped) {
  if (skipped.length === 0) {
    return `Applied to ${appliedCount} item${appliedCount === 1 ? '' : 's'}.`;
  }
  const reasonList = skipped.map((s) => `"${s.title}" — ${s.reason}`).join('; ');
  return `Applied to ${appliedCount} of ${totalCount}; ${skipped.length} skipped: ${reasonList}`;
}

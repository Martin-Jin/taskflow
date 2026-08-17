/**
 * ============================================================================
 * useTaskBulkEditActions
 * ============================================================================
 * Shared bulk-edit action set for a Task-only selection surface — List view
 * and Board view both select plain Tasks (no ScheduledBlock/CalendarEvent mix
 * the way Calendar does — see WeekView/MonthView/CalendarPage for that
 * richer case), so both wire up this exact same set of handlers against
 * utils/bulkEditEngine.js rather than duplicating the glue twice.
 *
 * Returns the editable-field set for the current selection plus one handler
 * per action the shared BulkActionBar can invoke — every handler funnels
 * through applyBulkEdit (which validates per-item via utils/taskValidation.js
 * gates and skips-and-continues rather than an all-or-nothing transaction),
 * and reports a summary via SchedulerContext's setNotification, reusing the
 * app's existing toast rather than a bespoke result component.
 */

import { useMemo } from 'react';
import { useScheduler } from '../context/SchedulerContext';
import { useCompleteTask } from '../context/CompleteTaskContext';
import { useConfirm } from '../context/ConfirmContext';
import { computeBulkEditableFields, applyBulkEdit, formatBulkEditSummary } from '../utils/bulkEditEngine';
import { buildRecurrenceString } from '../utils/recurrence';

// applyBulkEdit's shape covers both Task and CalendarEvent items — a
// Task-only caller has no event mutators to give it, so these no-op stand-ins
// keep the shared engine's signature intact without every call site here
// needing to know that.
function noop() {}

/**
 * @param {import('../types').Task[]} selectedTasks - resolved Task objects for the current selection
 * @param {() => void} exitSelectionMode
 * @returns {{
 *   editableFields: object,
 *   applyField: (field: string, value: any) => void,
 *   markComplete: () => void,
 *   markIncomplete: () => void,
 *   handleDelete: () => Promise<void>,
 * }}
 */
export function useTaskBulkEditActions(selectedTasks, exitSelectionMode) {
  const { tasks, updateTask, deleteTask, uncompleteTask, setNotification } = useScheduler();
  const { requestComplete } = useCompleteTask();
  const confirm = useConfirm();

  const editableFields = useMemo(
    () => computeBulkEditableFields(selectedTasks.map(() => ({ kind: 'task' }))),
    [selectedTasks]
  );

  function runBatch(taskList, updates) {
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const items = taskList.map((t) => ({ kind: 'task', id: t.id, task: t }));
    return applyBulkEdit({
      items,
      updates,
      tasksById,
      updateTask,
      updateEvent: noop,
      deleteTask: noop,
      deleteEvent: noop,
    });
  }

  function applyAndReport(updates) {
    const { appliedCount, skipped } = runBatch(selectedTasks, updates);
    setNotification({
      type: skipped.length > 0 ? 'warning' : 'success',
      message: formatBulkEditSummary(appliedCount, selectedTasks.length, skipped),
    });
  }

  function applyField(field, value) {
    if (field === 'dueDate') {
      applyAndReport({ dueDate: value || null });
    } else if (field === 'project') {
      applyAndReport({ projectId: value || null, sectionId: null, sectionName: null });
    } else if (field === 'priority') {
      applyAndReport({ priority: value });
    } else if (field === 'labels') {
      // Adds the tag rather than replacing the whole labelIds array — each
      // task keeps whatever tags it already had, matching how a single
      // task's own LabelPicker only ever adds/removes one chip at a time.
      selectedTasks.forEach((t) => {
        if (!t.labelIds?.includes(value)) updateTask(t.id, { labelIds: [...(t.labelIds || []), value] });
      });
    } else if (field === 'recurrence') {
      if (value === null) {
        applyAndReport({ isRecurring: false });
      } else {
        // Recurring tasks need a due date to advance from — an item with
        // none is skipped by validateTaskBulkUpdate's dueDateRequiredError,
        // surfaced in the summary the same as any other per-item skip.
        applyAndReport({ isRecurring: true, recurrenceString: buildRecurrenceString(value.count, value.unit) });
      }
    }
  }

  function markComplete() {
    selectedTasks.forEach((t) => requestComplete(t.id));
    exitSelectionMode();
  }

  function markIncomplete() {
    selectedTasks.forEach((t) => uncompleteTask(t.id));
    exitSelectionMode();
  }

  async function handleDelete() {
    const count = selectedTasks.length;
    if (count === 0) return;
    if (!(await confirm(`Delete ${count} task${count === 1 ? '' : 's'}? This can't be undone.`, { confirmLabel: 'Delete' }))) return;
    // deleteTask already cascades to a deleted task's own descendants (see
    // SchedulerContext) — if a selected task's ancestor is ALSO selected and
    // gets deleted first, deleting the descendant again afterward is a
    // harmless no-op (it's already gone), so no extra bookkeeping is needed
    // here to avoid double-processing.
    selectedTasks.forEach((t) => deleteTask(t.id));
    exitSelectionMode();
  }

  return { editableFields, applyField, markComplete, markIncomplete, handleDelete };
}

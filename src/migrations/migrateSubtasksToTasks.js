/**
 * ============================================================================
 * ONE-TIME MIGRATION — SAFE TO DELETE after ~2026-09 once telemetry/support
 * shows no remaining users with `subtasksMigrationDone !== true` (see the
 * call site in SchedulerContext.jsx, and the `subtasksMigrationDone`
 * persisted flag guarding it).
 *
 * Subtasks used to be a nested `Subtask[]` array embedded directly on the
 * parent Task (see the old `Subtask` typedef, since removed from
 * types/index.js). They're now standalone Task objects linked by
 * `parentId`, so they get the exact same editing surface (TaskDetailModal)
 * as every other task — including notes-link handling, which the old
 * embedded Subtask type never had.
 *
 * This converts each embedded subtask into a real Task: reuses the
 * subtask's own `id` (so it stays stable across the migration and nothing
 * that referenced it — e.g. a Todoist `todoistId` mapping — breaks), and
 * fills in the Task fields a Subtask never had with conservative defaults.
 * `dueDate` is deliberately left null — a migrated subtask is still
 * immediately schedulable at baseline urgency without one (see
 * allocator.js's prioritizeTasks/resolveDueDate), it just doesn't jump the
 * queue the way an explicitly-dated task would.
 *
 * Idempotent: a no-op on any task with no (or an empty) `subtasks` array,
 * which is every task after the first run.
 * @param {import('../types').Task[]} tasks
 * @returns {import('../types').Task[]} tasks with every legacy embedded subtask promoted to its own top-level entry
 */
export function migrateSubtasksToTasks(tasks) {
  if (!Array.isArray(tasks)) return tasks;
  const now = new Date().toISOString();
  const migratedChildren = [];

  const migratedParents = tasks.map((task) => {
    if (!task.subtasks || task.subtasks.length === 0) return task;

    task.subtasks.forEach((sub) => {
      migratedChildren.push({
        id: sub.id,
        title: sub.title,
        notes: sub.notes || '',
        noteLinks: [],
        isCompleted: !!sub.isCompleted,
        parentId: task.id,
        estimatedHours: 0.5,
        remainingHours: sub.isCompleted ? 0 : 0.5,
        priority: task.priority || 'medium',
        dueDate: null,
        isRecurring: false,
        recurrenceString: null,
        projectId: task.projectId ?? null,
        sectionId: task.sectionId ?? null,
        sectionName: task.sectionName ?? null,
        source: task.source || 'manual',
        todoistId: sub.todoistId,
        isLocked: false,
        minChunkHours: 0.5,
        maxChunkHours: 4,
        dependsOn: [],
        isPassive: false,
        earliestDate: null,
        enforceDueDate: false,
        link: null,
        labelIds: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    const { subtasks, ...parentWithoutSubtasks } = task;
    return parentWithoutSubtasks;
  });

  return [...migratedParents, ...migratedChildren];
}

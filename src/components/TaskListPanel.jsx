/**
 * TaskListPanel — sortable/filterable list of all tasks, with quick actions
 * (lock, complete, delete) and an "Add task" entry point. Lives in the main
 * content area alongside the calendar on the Tasks tab.
 *
 * Subtasks are never listed as their own rows here — they're rolled up
 * into a small progress indicator ("2/3 subtasks") under their parent, and
 * fully editable from the task's detail modal, matching Todoist's grouping.
 *
 * LIVE-UPDATING EDIT MODAL: we track only the *id* of the task being
 * edited, not a snapshot of the task object itself. The actual task object
 * passed to TaskDetailModal is derived fresh from `tasks` on every render
 * (see `editingTask` below), so any background mutation — a subtask
 * checkbox flipped, a Todoist sync completing, etc. — is reflected in the
 * open modal immediately instead of requiring a close/reopen. (Previously
 * this held the whole task object in state, which froze it at whatever it
 * looked like the moment the modal opened.)
 */

import React, { useMemo, useState } from 'react';
import { Plus, Repeat, Wind, SquareCheck, Ban, Lock, Unlock, Check, X } from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import AddTaskModal from './Modals/AddTaskModal';
import TaskDetailModal from './Modals/TaskDetailModal';
import SearchBar, { taskMatchesQuery } from './Common/SearchBar';
import { formatDisplayDate } from '../utils/dateUtils';
import { formatHours } from '../utils/formatHours';
import { areDependenciesMet } from '../utils/dependencyUtils';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

export default function TaskListPanel() {
  const { tasks, toggleTaskLock, completeTask, deleteTask, searchQuery } = useScheduler();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [filter, setFilter] = useState('active'); // active | completed | all

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const visibleTasks = useMemo(() => {
    let list = tasks;
    // "Active" means scheduled: not completed and has a due date (the
    // scheduler only ever places blocks for tasks with a due date — see
    // the "Won't be auto-scheduled without a due date" hint in
    // TaskDetailModal). "All" is everything, including completed and
    // unscheduled (no-due-date) tasks — otherwise the two filters look
    // identical for the common case of mostly-uncompleted tasks.
    if (filter === 'active') list = list.filter((t) => !t.isCompleted && !!t.dueDate);
    if (filter === 'completed') list = list.filter((t) => t.isCompleted);
    list = list.filter((t) => taskMatchesQuery(t, searchQuery));
    return [...list].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [tasks, filter, searchQuery]);

  return (
    <div>
      <div className="tasklist-toolbar">
        <div className="view-switch" role="group" aria-label="Filter tasks">
          {['active', 'completed', 'all'].map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <SearchBar />
        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={14} />
          Add task
        </button>
      </div>

      <div className="tasklist-rows">
        {visibleTasks.length === 0 && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
            No tasks {searchQuery ? 'match your search' : 'here yet'}.
          </div>
        )}
        {visibleTasks.map((task) => {
          const subtaskTotal = task.subtasks?.length || 0;
          const subtaskDone = task.subtasks?.filter((s) => s.isCompleted).length || 0;
          return (
            <div key={task.id} className="card task-row" onClick={() => setEditingTaskId(task.id)}>
              <button
                className={`task-checkbox ${task.priority} ${task.isCompleted ? 'checked' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!task.isCompleted) completeTask(task.id);
                }}
                disabled={task.isCompleted}
                title={task.isCompleted ? 'Completed' : task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
                aria-label={task.isCompleted ? `${task.title} completed` : `Mark ${task.title} complete`}
              >
                {task.isCompleted && <Check size={12} aria-hidden="true" />}
              </button>
              <div className="task-row-main">
                <div style={{ fontWeight: 600, textDecoration: task.isCompleted ? 'line-through' : 'none', opacity: task.isCompleted ? 0.5 : 1 }}>
                  {task.isRecurring && (
                    <Repeat size={13} style={{ verticalAlign: -2, marginRight: 4 }} title={task.recurrenceString || 'Repeats'} />
                  )}
                  {task.isPassive && <Wind size={13} style={{ verticalAlign: -2, marginRight: 4 }} title="Can run unattended" />}
                  {task.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3 }}>
                  <span>
                    {formatHours(task.remainingHours)} remaining of {formatHours(task.estimatedHours)}
                    {task.dueDate ? ` · due ${formatDisplayDate(task.dueDate)}` : ' · no due date'}
                    {task.sectionName ? ` · ${task.sectionName}` : ''}
                  </span>
                  {subtaskTotal > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {' · '}
                      <SquareCheck size={12} />
                      {subtaskDone}/{subtaskTotal} subtasks
                    </span>
                  )}
                  {!task.isCompleted && !areDependenciesMet(task, taskById) && (
                    <span style={{ color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {' · '}
                      <Ban size={12} />
                      blocked by dependency
                    </span>
                  )}
                </div>
              </div>
              <div className="task-row-actions">
                <span className={`badge ${task.priority}`}>{task.priority}</span>
                <button
                  className="btn btn-icon"
                  title={task.isLocked ? 'Unlock' : 'Lock'}
                  aria-label={task.isLocked ? `Unlock ${task.title}` : `Lock ${task.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTaskLock(task.id);
                  }}
                >
                  {task.isLocked ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
                </button>
                <button
                  className="btn btn-icon btn-x"
                  title="Delete"
                  aria-label={`Delete ${task.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTask(task.id);
                  }}
                  style={{ color: 'var(--danger)' }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showAddModal && <AddTaskModal onClose={() => setShowAddModal(false)} />}
      {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
    </div>
  );
}

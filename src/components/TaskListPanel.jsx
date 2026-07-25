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
import { Plus, Repeat, Wind, SquareCheck, Ban, Check } from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import AddTaskModal from './Modals/AddTaskModal';
import TaskDetailModal from './Modals/TaskDetailModal';
import BoardView from './Board/BoardView';
import GanttChart from './Gantt/GanttChart';
import SearchBar, { taskMatchesQuery } from './Common/SearchBar';
import { formatDisplayDate, toISODate } from '../utils/dateUtils';
import { formatHours } from '../utils/formatHours';
import { areDependenciesMet } from '../utils/dependencyUtils';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

const FILTER_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
  { key: 'noDueDate', label: 'No due date' },
];

// The Tasks page's own view switch — List/Board/Gantt are three
// presentations of the same underlying tasks, so they live under one nav
// entry rather than three, matching Calendar's Day/Week/Month pattern.
const PAGE_VIEWS = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'gantt', label: 'Gantt' },
];

export default function TaskListPanel({ view, onChangeView }) {
  const { tasks, labels, completeTask, searchQuery } = useScheduler();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [filter, setFilter] = useState('active'); // active | completed | all | noDueDate

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  const visibleTasks = useMemo(() => {
    let list = tasks;
    // "Active" means scheduled: not completed and has a due date (the
    // scheduler only ever places blocks for tasks with a due date — see
    // the "Won't be auto-scheduled without a due date" hint in
    // TaskDetailModal). "All" is everything with a due date, completed or
    // not — undated tasks live exclusively under "No due date" now rather
    // than also being folded into "All", so the two don't overlap.
    if (filter === 'active') list = list.filter((t) => !t.isCompleted && !!t.dueDate);
    if (filter === 'completed') list = list.filter((t) => t.isCompleted);
    if (filter === 'all') list = list.filter((t) => !!t.dueDate);
    if (filter === 'noDueDate') list = list.filter((t) => !t.dueDate);
    list = list.filter((t) => taskMatchesQuery(t, searchQuery, labels));
    return [...list].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [tasks, filter, searchQuery, labels]);

  // Grouped into a "Today" section so what's due today stands out instead
  // of being buried in one priority-sorted list. Only meaningful for the
  // dated tabs — "Completed" and "No due date" render as a flat list.
  const showGroups = filter === 'active' || filter === 'all';
  const taskGroups = useMemo(() => {
    if (!showGroups) return null;
    const today = toISODate(new Date());
    const todayTasks = [];
    const upcoming = [];
    for (const task of visibleTasks) {
      if (task.dueDate === today) todayTasks.push(task);
      else upcoming.push(task);
    }
    return [
      { key: 'today', label: 'Today', tasks: todayTasks },
      { key: 'upcoming', label: 'Upcoming', tasks: upcoming },
    ].filter((group) => group.tasks.length > 0);
  }, [visibleTasks, showGroups]);

  function renderTaskRow(task) {
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
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3 }}>
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
              <span style={{ color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {' · '}
                <Ban size={12} />
                blocked by dependency
              </span>
            )}
          </div>
          <div className="task-row-badges">
            <span className={`badge ${task.priority}`}>{task.priority}</span>
            {(task.labelIds || []).map((labelId) => {
              const label = labelById.get(labelId);
              if (!label) return null;
              return (
                <span key={label.id} className="badge tag-pill" style={{ background: `${label.color}22`, color: label.color }}>
                  {label.name}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="taskpage">
      <div className="taskpage-view-switch" data-tour="tasks-view-switch" role="group" aria-label="Task view">
        {PAGE_VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? 'active' : ''} aria-pressed={view === v.key} onClick={() => onChangeView(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {view === 'board' && <BoardView />}
      {view === 'gantt' && <GanttChart />}

      {view === 'list' && (
        <>
          <div className="tasklist-toolbar">
            <div className="view-switch" role="group" aria-label="Filter tasks">
              {FILTER_TABS.map((f) => (
                <button key={f.key} className={filter === f.key ? 'active' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <SearchBar />
            <button
              className="btn btn-primary add-task-btn"
              data-tour="add-task"
              onClick={() => setShowAddModal(true)}
              aria-label="Add task"
            >
              <Plus size={14} />
              <span className="add-task-btn-label">Add task</span>
            </button>
          </div>

          <div className="tasklist-rows">
            {visibleTasks.length === 0 && (
              <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                No tasks {searchQuery ? 'match your search' : 'here yet'}.
              </div>
            )}
            {taskGroups
              ? taskGroups.map((group) => (
                  <div key={group.key} className="tasklist-section">
                    <h3 className="tasklist-section-header">
                      {group.label}
                      <span className="tasklist-section-count">{group.tasks.length}</span>
                    </h3>
                    {group.tasks.map((task) => renderTaskRow(task))}
                  </div>
                ))
              : visibleTasks.map((task) => renderTaskRow(task))}
          </div>

          {showAddModal && <AddTaskModal onClose={() => setShowAddModal(false)} />}
          {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
        </>
      )}
    </div>
  );
}

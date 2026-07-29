/**
 * TaskListPanel — sortable/filterable list of all tasks, with quick actions
 * (lock, complete, delete) and an "Add task" entry point. Lives in the main
 * content area alongside the calendar on the Tasks tab.
 *
 * SUB-TASKS: a task with `parentId` set is a real row here too, nested
 * directly under its parent (then its own children, to arbitrary depth),
 * indented per depth and rendered flatter (no card background) so the
 * hierarchy reads as a checklist rather than a stack of equal-weight cards
 * — see `renderTaskRow`'s `depth` param and `childrenByParentId` below. A
 * parent with children gets a collapse/expand chevron (default expanded;
 * collapse state is local/unpersisted). Only *top-level* tasks (`!task.
 * parentId`) go through the project/tab/search filtering and Overdue/
 * Today/Upcoming grouping below — a child is always rendered under its
 * parent regardless of the active filter tab, matching how TaskDetailModal
 * always lists a task's full child set regardless of its own hide-completed
 * toggle. (Board/Gantt keep the older rolled-up-badge presentation instead —
 * see BoardView.jsx/GanttChart.jsx.)
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Repeat, Wind, Ban, Check, ExternalLink, FolderKanban, ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import { useCompleteTask } from '../context/CompleteTaskContext';
import { useSound } from '../context/SoundContext';
import AddTaskModal from './Modals/AddTaskModal';
import TaskDetailModal from './Modals/TaskDetailModal';
import BoardView from './Board/BoardView';
import GanttChart from './Gantt/GanttChart';
import SearchBar, { taskMatchesQuery } from './Common/SearchBar';
import SelectMenu from './Common/SelectMenu';
import ProjectActionsMenu from './Common/ProjectActionsMenu';
import ViewFilterMenu from './Common/ViewFilterMenu';
import { formatDisplayDate, toISODate } from '../utils/dateUtils';
import { formatHours } from '../utils/formatHours';
import { areDependenciesMet } from '../utils/dependencyUtils';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, filterTasksByProject, filterTasksByStatus } from '../utils/projectConstants';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

// The Tasks page's own view switch — List/Board/Gantt are three
// presentations of the same underlying tasks, so they live under one nav
// entry rather than three, matching Calendar's Day/Week/Month pattern.
const PAGE_VIEWS = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'gantt', label: 'Gantt' },
];

// Each view keeps its own filter (see ViewFilterMenu) rather than sharing
// one — defaults match what each view showed before the filter became
// user-selectable: List defaulted to "Scheduled", Board/Gantt showed every
// non-completed task regardless of due date ("All").
const DEFAULT_FILTER_BY_VIEW = { list: 'active', board: 'all', gantt: 'all' };

export default function TaskListPanel({
  view,
  onChangeView,
  activeProjectId,
  onChangeActiveProject,
  onResolveBoardProject,
  onOpenManageProjects,
  openAddTaskSignal,
}) {
  const { tasks, labels, projects, uncompleteTask, searchQuery, renameProject, togglePinProject, deleteProject } = useScheduler();
  const { requestComplete } = useCompleteTask();
  const { playUncomplete } = useSound();
  const [showAddModal, setShowAddModal] = useState(false);
  // The "new task" shortcut (see useKeyboardShortcuts in App.jsx) bumps this
  // from anywhere in the app to open "Add task" here, since this modal's open
  // state is local to the Tasks tab rather than lifted — App.jsx switches to
  // this tab and increments the signal, this just reacts to the change.
  // lastHandledSignalRef starts at the *current* signal value (not 0) so that
  // remounting this component (e.g. switching away from and back to the Tasks
  // tab) doesn't immediately reopen the modal just because the signal was
  // already bumped earlier in the session — only a genuine new increment
  // after this mount should open it.
  const lastHandledSignalRef = useRef(openAddTaskSignal);
  useEffect(() => {
    if (openAddTaskSignal !== lastHandledSignalRef.current) {
      lastHandledSignalRef.current = openAddTaskSignal;
      setShowAddModal(true);
    }
  }, [openAddTaskSignal]);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [filterByView, setFilterByView] = useState(DEFAULT_FILTER_BY_VIEW);
  const filter = filterByView[view]; // active | completed | all | noDueDate
  function setFilter(key) {
    setFilterByView((prev) => ({ ...prev, [view]: key }));
  }
  // Ids of parent tasks whose children are currently hidden — collapsed is
  // opt-in per row, so anything not in this set renders expanded (the
  // default), and it's plain local state rather than persisted.
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  // Managing projects now lives in the sidebar's "Manage projects" button
  // (desktop) / this SelectMenu footer action (mobile, which has no sidebar).
  const footerActions = onOpenManageProjects
    ? [{ icon: FolderKanban, label: 'See / manage all projects', onClick: onOpenManageProjects }]
    : undefined;

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  // Direct children (parentId chain) per task id — the basis for the
  // recursive nested rows below (renderTaskRow reads this at every depth).
  const childrenByParentId = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!t.parentId) continue;
      const siblings = map.get(t.parentId) || [];
      siblings.push(t);
      map.set(t.parentId, siblings);
    }
    return map;
  }, [tasks]);

  function toggleCollapsed(taskId) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }
  const activeProject = activeProjectId === ALL_TASKS_PROJECT_ID ? null : projects.find((p) => p.id === activeProjectId);

  // If activeProjectId points at a project that no longer exists (e.g.
  // deleted from another tab, or via Todoist sync), fall back to "All
  // Tasks" instead of leaving the project select and page title
  // disagreeing with each other — unlike Board, List always has a valid
  // "All Tasks" fallback so there's no need to pick a substitute project.
  useEffect(() => {
    if (activeProjectId === ALL_TASKS_PROJECT_ID) return;
    if (!projects.some((p) => p.id === activeProjectId)) onChangeActiveProject(ALL_TASKS_PROJECT_ID);
  }, [activeProjectId, projects, onChangeActiveProject]);
  const projectSelectOptions = useMemo(
    () => [{ value: ALL_TASKS_PROJECT_ID, label: ALL_TASKS_PROJECT_LABEL }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
    [projects]
  );

  const visibleTasks = useMemo(() => {
    // Sub-tasks (parentId set) never go through this top-level filter/sort —
    // they're always rendered nested under their own parent instead (see
    // childrenByParentId/renderTaskRow), unaffected by which tab/search is
    // active up here (matching TaskDetailModal, which always lists a task's
    // full child set regardless of its own filters).
    // Completed tasks live only under the "Completed" filter (auto-deleted
    // 30 days after completion, see SchedulerContext's retention sweep) —
    // see filterTasksByStatus for what each filter key means.
    let list = filterTasksByProject(tasks, activeProjectId).filter((t) => !t.parentId);
    list = filterTasksByStatus(list, filter);
    list = list.filter((t) => taskMatchesQuery(t, searchQuery, labels));
    return [...list].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [tasks, activeProjectId, filter, searchQuery, labels]);

  function startRenameProject() {
    if (!activeProject) return;
    setProjectNameDraft(activeProject.name);
    setIsRenamingProject(true);
  }

  function commitRenameProject() {
    if (activeProject && projectNameDraft.trim()) renameProject(activeProject.id, projectNameDraft);
    setIsRenamingProject(false);
  }

  function handleDeleteProject() {
    if (!activeProject) return;
    if (window.confirm(`Delete "${activeProject.name}"? Its tasks will move to All Tasks.`)) {
      deleteProject(activeProject.id);
      onChangeActiveProject(ALL_TASKS_PROJECT_ID);
    }
  }

  // Grouped into Overdue/Today/Upcoming sections so what needs attention
  // stands out instead of being buried in one priority-sorted list. Only
  // meaningful for the dated tabs — "Completed" and "No due date" render
  // as a flat list. Overdue is its own bucket (dueDate strictly before
  // today) rather than being silently lumped into "Upcoming" — it's
  // surfaced first since it's the most urgent thing in the list.
  const showGroups = filter === 'active' || filter === 'all';
  const taskGroups = useMemo(() => {
    if (!showGroups) return null;
    const today = toISODate(new Date());
    const overdue = [];
    const todayTasks = [];
    const upcoming = [];
    const undated = [];
    for (const task of visibleTasks) {
      if (!task.dueDate) undated.push(task);
      else if (task.dueDate < today) overdue.push(task);
      else if (task.dueDate === today) todayTasks.push(task);
      else upcoming.push(task);
    }
    return [
      { key: 'overdue', label: 'Overdue', tasks: overdue },
      { key: 'today', label: 'Today', tasks: todayTasks },
      { key: 'upcoming', label: 'Upcoming', tasks: upcoming },
      // Only "All" ever surfaces undated tasks here — "Active" already
      // filters them out above, so this group is empty (and hidden) there.
      { key: 'noDueDate', label: 'No due date', tasks: undated },
    ].filter((group) => group.tasks.length > 0);
  }, [visibleTasks, showGroups]);

  /**
   * Renders a task row and, recursively, every descendant nested beneath it
   * (see childrenByParentId) — `depth` drives both the indent (a
   * `--space-5` multiple, matching this codebase's spacing scale) and
   * whether the row gets the full `.card` container (depth 0, top-level) or
   * the flatter `.task-row-child` styling (depth > 0, a sub-task) so the
   * hierarchy reads as a checklist rather than a stack of equal-weight cards.
   */
  function renderTaskRow(task, depth = 0) {
    const children = childrenByParentId.get(task.id) || [];
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedIds.has(task.id);
    return (
      <React.Fragment key={task.id}>
        <div
          className={`task-row ${depth === 0 ? 'card' : 'task-row-child'}`}
          style={depth > 0 ? { marginLeft: `calc(var(--space-5) * ${depth})` } : undefined}
          onClick={() => setEditingTaskId(task.id)}
        >
          {hasChildren ? (
            <button
              type="button"
              className="btn btn-icon task-row-collapse"
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapsed(task.id);
              }}
              aria-label={isCollapsed ? `Expand ${task.title}` : `Collapse ${task.title}`}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : (
            depth > 0 && <span className="task-row-collapse-spacer" aria-hidden="true" />
          )}
          <button
            className={`task-checkbox ${task.priority} ${task.isCompleted ? 'checked' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!task.isCompleted) requestComplete(task.id);
            }}
            disabled={task.isCompleted}
            title={task.isCompleted ? 'Completed' : task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
            aria-label={task.isCompleted ? `${task.title} completed` : `Mark ${task.title} complete`}
          >
            {task.isCompleted && <Check size={12} aria-hidden="true" />}
          </button>
          <div className="task-row-main">
            <div style={{ fontWeight: 600, textDecoration: task.isCompleted ? 'line-through' : 'none', opacity: task.isCompleted ? 0.5 : 1 }}>
              {task.link ? (
                <a
                  href={task.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="task-title-link"
                  onClick={(e) => e.stopPropagation()}
                  title={`Open link: ${task.link}`}
                >
                  {task.title}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                task.title
              )}
              {task.isRecurring && (
                <Repeat size={13} style={{ verticalAlign: -2, marginLeft: 6 }} title={task.recurrenceString || 'Repeats'} />
              )}
              {task.isPassive && <Wind size={13} style={{ verticalAlign: -2, marginLeft: 6 }} title="Can run unattended" />}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                marginTop: 2,
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 3,
              }}
            >
              <span>
                {formatHours(task.remainingHours)} remaining of {formatHours(task.estimatedHours)}
                {task.dueDate ? ` · due ${formatDisplayDate(task.dueDate)}` : ' · no due date'}
                {task.sectionName ? ` · ${task.sectionName}` : ''}
              </span>
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
          {task.isCompleted && (
            <button
              type="button"
              className="btn btn-icon task-row-restore"
              onClick={(e) => {
                e.stopPropagation();
                uncompleteTask(task.id);
                playUncomplete();
              }}
              title="Restore to active"
              aria-label={`Restore ${task.title}`}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        {hasChildren && !isCollapsed && children.map((child) => renderTaskRow(child, depth + 1))}
      </React.Fragment>
    );
  }

  return (
    <div className="taskpage">
      <div className="taskpage-view-switch-row">
        <ViewFilterMenu
          view={view}
          onChangeView={onChangeView}
          viewOptions={PAGE_VIEWS.filter((v) => v.key !== 'board' || activeProjectId !== ALL_TASKS_PROJECT_ID)}
          filter={filter}
          onChangeFilter={setFilter}
        />
        {activeProject && (
          <ProjectActionsMenu
            isPinned={!!activeProject.isPinned}
            ariaLabel={`Actions for ${activeProject.name}`}
            onRename={startRenameProject}
            onTogglePin={() => togglePinProject(activeProject.id)}
            onDelete={handleDeleteProject}
          />
        )}
      </div>

      <div className="taskpage-project-header">
        <SelectMenu
          value={activeProjectId}
          options={projectSelectOptions}
          onChange={onChangeActiveProject}
          ariaLabel="Switch project"
          footerActions={footerActions}
        />
        {isRenamingProject ? (
          <input
            autoFocus
            className="taskpage-project-title-input"
            aria-label={`Rename project "${activeProject?.name || ''}"`}
            value={projectNameDraft}
            onChange={(e) => setProjectNameDraft(e.target.value)}
            onBlur={commitRenameProject}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRenameProject();
              }
              if (e.key === 'Escape') setIsRenamingProject(false);
            }}
          />
        ) : (
          <h2
            className={`taskpage-project-title ${activeProject ? 'editable' : ''}`}
            title={activeProject ? 'Click to rename' : undefined}
            role={activeProject ? 'button' : undefined}
            tabIndex={activeProject ? 0 : undefined}
            onClick={startRenameProject}
            onKeyDown={(e) => {
              if (activeProject && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                startRenameProject();
              }
            }}
          >
            {activeProject ? activeProject.name : ALL_TASKS_PROJECT_LABEL}
          </h2>
        )}
      </div>

      {view === 'board' && <BoardView projectId={activeProjectId} onProjectChange={onResolveBoardProject} filter={filter} />}
      {view === 'gantt' && <GanttChart activeProjectId={activeProjectId} filter={filter} />}

      {view === 'list' && (
        <>
          <div className="tasklist-toolbar">
            <SearchBar onSelectProject={onChangeActiveProject} />
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
                  <h3 className={`tasklist-section-header ${group.key === 'overdue' ? 'is-overdue' : ''}`}>
                    {group.label}
                    <span className="tasklist-section-count">{group.tasks.length}</span>
                  </h3>
                  {group.tasks.map((task) => renderTaskRow(task))}
                </div>
              ))
              : visibleTasks.map((task) => renderTaskRow(task))}
          </div>

          {showAddModal && (
            <AddTaskModal onClose={() => setShowAddModal(false)} initialProjectId={activeProject ? activeProject.id : ''} />
          )}
          {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
        </>
      )}
    </div>
  );
}

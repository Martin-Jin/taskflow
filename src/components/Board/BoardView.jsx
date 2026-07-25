/**
 * ============================================================================
 * BoardView
 * ============================================================================
 * A Kanban-style board that mirrors Todoist's own Board view: pick one
 * Project from the filter dropdown (like Todoist, this shows one project's
 * board at a time rather than every project stacked together), then one
 * column per Section within that project, plus a leading "No Section"
 * column for tasks that aren't assigned to one. Cards show priority, due
 * date, hours, and a subtask progress indicator. Clicking a card opens the
 * same TaskDetailModal used everywhere else, so editing stays consistent
 * across views.
 *
 * Columns respect the shared search query — a task (or any of its
 * subtasks) matching the query keeps its card visible; the column itself
 * always renders (even empty) so the layout matches Todoist's board.
 *
 * SHOWS EVERY TASK IN THE PROJECT, regardless of due date or scheduling
 * status — Boards mirrors Todoist's own board, not the calendar. A task
 * with no due date (and therefore never auto-scheduled) still gets a card
 * here, same as an undated task shows up normally on Todoist's board.
 *
 * Section editing: column headers are click-to-rename, each has a delete
 * button, and a trailing "+ Add section" column creates a new one — all
 * synced to Todoist via SchedulerContext when a token is configured.
 *
 * LIVE-UPDATING EDIT MODAL: only the editing task's *id* is tracked in
 * state; the task object itself is derived fresh from `tasks` on every
 * render (see `editingTask` below), so background changes (subtask
 * toggles, Todoist sync completions, etc.) show up immediately in an open
 * modal without needing a close/reopen.
 * ============================================================================
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X, RefreshCw, Pause, Circle, Repeat, Wind, SquareCheck, Ban, Lock, Unlock } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import AddTaskModal from '../Modals/AddTaskModal';
import TaskDetailModal from '../Modals/TaskDetailModal';
import SearchBar, { taskMatchesQuery } from '../Common/SearchBar';
import { formatDisplayDate } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import { areDependenciesMet } from '../../utils/dependencyUtils';
import { priorityColor } from '../../utils/priorityColor';

export default function BoardView() {
  const { tasks, sections, projects, searchQuery, toggleTaskLock, completeTask, addProject, addSection, renameSection, deleteSection, todoistEnabled, syncActive } =
    useScheduler();
  // Track only the id — deriving the task object live from `tasks` (below)
  // ensures edits made in the modal (e.g. removing a subtask) show up
  // immediately instead of requiring a close/reopen.
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [addingToSectionId, setAddingToSectionId] = useState(undefined); // undefined = modal closed
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [editingColumnId, setEditingColumnId] = useState(null); // null | 'no-section' | sectionId
  const [editingColumnTitle, setEditingColumnTitle] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const [addingBoard, setAddingBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);
  // Set right after a board is created; used to auto-select it once it
  // shows up in `projects` (see the effect below `sortedProjects`).
  const [pendingSelectName, setPendingSelectName] = useState(null);

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const sortedProjects = useMemo(() => [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [projects]);

  // Default to the first project once projects load, so the board isn't
  // empty on first render (mirrors Todoist always showing *some* project's
  // board rather than an "all projects" view).
  useEffect(() => {
    if (!selectedProjectId && sortedProjects.length > 0) {
      setSelectedProjectId(sortedProjects[0].id);
    }
  }, [sortedProjects, selectedProjectId]);

  const projectSections = useMemo(
    () =>
      sections
        .filter((s) => s.projectId === selectedProjectId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [sections, selectedProjectId]
  );

  const columns = useMemo(() => {
    const cols = [{ id: null, name: 'No Section', isNoSection: true }, ...projectSections];

    return cols.map((col) => {
      // Every non-completed task in this project/section shows up here,
      // regardless of due date — Boards mirrors Todoist's board, which has
      // no concept of "too far out to show" or "not schedulable."
      const columnTasks = tasks
        .filter((t) => !t.isCompleted)
        .filter((t) => t.projectId === selectedProjectId)
        .filter((t) => (col.id === null ? !t.sectionId : t.sectionId === col.id))
        .filter((t) => taskMatchesQuery(t, searchQuery));
      return { ...col, tasks: columnTasks };
    });
  }, [tasks, projectSections, selectedProjectId, searchQuery]);

  function startEditingColumn(col) {
    if (col.isNoSection) return; // "No Section" is a synthetic bucket, not a real editable Section
    setEditingColumnId(col.id);
    setEditingColumnTitle(col.name);
  }

  function commitColumnEdit() {
    if (editingColumnId && editingColumnTitle.trim()) {
      renameSection(editingColumnId, editingColumnTitle);
    }
    setEditingColumnId(null);
    setEditingColumnTitle('');
  }

  function handleDeleteColumn(col) {
    if (col.isNoSection) return;
    if (col.tasks.length > 0 && !window.confirm(`Delete "${col.name}"? Its ${col.tasks.length} task(s) will move to No Section.`)) {
      return;
    }
    deleteSection(col.id);
  }

  function handleAddSection() {
    if (!newSectionName.trim() || !selectedProjectId) return;
    addSection(selectedProjectId, newSectionName);
    setNewSectionName('');
    setAddingSection(false);
  }

  async function handleAddBoard() {
    const trimmed = newBoardName.trim();
    if (!trimmed || isCreatingBoard) return;
    setIsCreatingBoard(true);
    try {
      const result = await addProject(trimmed);
      if (result.ok) {
        setNewBoardName('');
        setAddingBoard(false);
        // Selecting the new board happens once `projects` updates and flows
        // back down as `sortedProjects` — handled by the effect below.
        setPendingSelectName(trimmed);
      }
    } finally {
      setIsCreatingBoard(false);
    }
  }

  // After a new board is created, `projects` updates asynchronously (either
  // immediately for local-only boards, or once the Todoist create call
  // resolves) — this selects it by name as soon as it shows up, rather than
  // leaving the board switcher on whatever was previously selected.
  useEffect(() => {
    if (!pendingSelectName) return;
    const match = projects.find((p) => p.name === pendingSelectName);
    if (match) {
      setSelectedProjectId(match.id);
      setPendingSelectName(null);
    }
  }, [pendingSelectName, projects]);

  const selectedProject = sortedProjects.find((p) => p.id === selectedProjectId);

  return (
    <div className="board-page">
      <div className="board-toolbar">
        <select
          className="board-project-select"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          aria-label="Filter board by project"
        >
          {sortedProjects.length === 0 && <option value="">No projects</option>}
          {sortedProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {addingBoard ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              autoFocus
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              placeholder="Board name…"
              disabled={isCreatingBoard}
              style={{
                background: 'var(--bg-surface-raised)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '7px 10px',
                color: 'var(--text-primary)',
                fontSize: 13,
                width: 160,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddBoard();
                }
                if (e.key === 'Escape') {
                  setAddingBoard(false);
                  setNewBoardName('');
                }
              }}
            />
            <button className="btn btn-primary" onClick={handleAddBoard} disabled={isCreatingBoard || !newBoardName.trim()}>
              {isCreatingBoard ? '…' : 'Create'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setAddingBoard(false);
                setNewBoardName('');
              }}
              disabled={isCreatingBoard}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setAddingBoard(true)} title="Create a new board (Todoist project)">
            <Plus size={14} />
            Add board
          </button>
        )}

        <SearchBar placeholder="Search board…" />
        <span className={`board-sync-badge ${syncActive ? 'enabled' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {syncActive ? (
            <>
              <RefreshCw size={12} /> Synced with Todoist
            </>
          ) : todoistEnabled ? (
            <>
              <Pause size={12} /> Todoist sync paused
            </>
          ) : (
            <>
              <Circle size={12} /> Local only (no Todoist token configured)
            </>
          )}
        </span>
      </div>

      {!selectedProject ? (
        <div className="board-column-empty" style={{ padding: 30 }}>
          No projects available yet.
        </div>
      ) : (
        <div className="board-columns">
          {columns.map((col) => (
            <div key={col.id ?? 'no-section'} className={`board-column ${col.isNoSection ? 'no-section' : ''}`}>
              <div className="board-column-header">
                {editingColumnId === col.id ? (
                  <input
                    autoFocus
                    className="board-column-title-input"
                    value={editingColumnTitle}
                    onChange={(e) => setEditingColumnTitle(e.target.value)}
                    onBlur={commitColumnEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitColumnEdit();
                      }
                      if (e.key === 'Escape') {
                        setEditingColumnId(null);
                        setEditingColumnTitle('');
                      }
                    }}
                  />
                ) : (
                  <span
                    className="board-column-title"
                    title={col.isNoSection ? undefined : 'Click to rename'}
                    role={col.isNoSection ? undefined : 'button'}
                    tabIndex={col.isNoSection ? undefined : 0}
                    onClick={() => startEditingColumn(col)}
                    onKeyDown={(e) => {
                      if (!col.isNoSection && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        startEditingColumn(col);
                      }
                    }}
                  >
                    {col.name}
                  </span>
                )}
                <span className="board-column-count">{col.tasks.length}</span>
                {!col.isNoSection && (
                  <button className="board-column-delete" title="Delete section" onClick={() => handleDeleteColumn(col)}>
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="board-column-body">
                {col.tasks.map((task) => {
                  const subtaskTotal = task.subtasks?.length || 0;
                  const subtaskDone = task.subtasks?.filter((s) => s.isCompleted).length || 0;
                  return (
                    <div
                      key={task.id}
                      className="board-card"
                      style={{ borderLeftColor: priorityColor(task.priority) }}
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditingTaskId(task.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setEditingTaskId(task.id);
                        }
                      }}
                    >
                      <button
                        className="board-card-check"
                        title={task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
                        onClick={(e) => {
                          e.stopPropagation();
                          completeTask(task.id);
                        }}
                      >
                        <Circle size={16} strokeWidth={1.75} />
                      </button>
                      <div className="board-card-body">
                        <div className="board-card-title">
                          {task.isRecurring && (
                            <Repeat size={13} style={{ verticalAlign: -2, marginRight: 4 }} title={task.recurrenceString || 'Repeats'} />
                          )}
                          {task.isPassive && <Wind size={13} style={{ verticalAlign: -2, marginRight: 4 }} title="Can run unattended" />}
                          {task.title}
                        </div>
                        <div className="board-card-meta" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3 }}>
                          <span>
                            {formatHours(task.remainingHours)} left
                            {task.dueDate ? (
                              <span className="board-card-due"> · due {formatDisplayDate(task.dueDate)}</span>
                            ) : (
                              <span> · no due date</span>
                            )}
                          </span>
                          {subtaskTotal > 0 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {' · '}
                              <SquareCheck size={12} />
                              {subtaskDone}/{subtaskTotal}
                            </span>
                          )}
                          {!areDependenciesMet(task, taskById) && (
                            <span style={{ color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {' · '}
                              <Ban size={12} />
                              blocked
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                          <span className={`badge ${task.priority}`}>{task.priority}</span>
                          <button
                            className="btn btn-icon"
                            style={{ padding: '2px 6px', marginLeft: 'auto' }}
                            title={task.isLocked ? 'Unlock' : 'Lock'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleTaskLock(task.id);
                            }}
                          >
                            {task.isLocked ? <Lock size={13} /> : <Unlock size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {col.tasks.length === 0 && <div className="board-column-empty">No tasks{searchQuery ? ' match your search' : ''}.</div>}
              </div>

              <button className="board-add-task" onClick={() => setAddingToSectionId(col.id ?? '')}>
                <Plus size={13} />
                Add task
              </button>
            </div>
          ))}

          <div className="board-add-column">
            {addingSection ? (
              <div className="board-add-column-form">
                <input
                  autoFocus
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                  placeholder="Section name…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddSection();
                    }
                    if (e.key === 'Escape') {
                      setAddingSection(false);
                      setNewSectionName('');
                    }
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleAddSection}>
                    Add
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setAddingSection(false);
                      setNewSectionName('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="board-add-column-btn" onClick={() => setAddingSection(true)}>
                <Plus size={13} />
                Add section
              </button>
            )}
          </div>
        </div>
      )}

      {addingToSectionId !== undefined && (
        <AddTaskModal
          initialSectionId={addingToSectionId}
          initialProjectId={selectedProjectId}
          onClose={() => setAddingToSectionId(undefined)}
        />
      )}
      {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
    </div>
  );
}

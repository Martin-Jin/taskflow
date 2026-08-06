/**
 * ============================================================================
 * BoardView
 * ============================================================================
 * A Kanban-style board that mirrors Todoist's own Board view: shows one
 * Project's board at a time (the project is shared state — see `projectId`/
 * `onProjectChange` props — set from the sidebar, the shared project header,
 * or the search bar, so it stays in sync with List view), with one column
 * per Section within that project, plus a leading "No Section" column for
 * tasks that aren't assigned to one. Cards show priority, due date, hours,
 * and a sub-task progress indicator. Clicking a card opens the same
 * TaskDetailModal used everywhere else, so editing stays consistent across
 * views.
 *
 * SUB-TASKS: a task with `parentId` set is never its own card here — it's
 * rolled up into its parent's "x/y" progress badge instead (see
 * `childrenByParentId`/renderCard below). Unlike TaskListPanel (which now
 * renders sub-tasks as nested rows under their parent), Board keeps this
 * rolled-up-only presentation. Gantt differs: a sub-task gets its own row
 * there (its container parent gets none) — see GanttChart's SUB-TASKS note.
 *
 * If the project has NO sections at all, the board renders as a single flat
 * task list instead of a one-column kanban — a project the user hasn't
 * split into sections shouldn't visually look like a board with one lonely
 * "No Section" column.
 *
 * Columns respect the shared search query — a task matching the query
 * keeps its card visible; the column itself always renders (even empty) so
 * the layout matches Todoist's board.
 *
 * By default shows every non-completed task in the project regardless of
 * due date or scheduling status — Boards mirrors Todoist's own board, not
 * the calendar. A task with no due date (and therefore never
 * auto-scheduled) still gets a card here, same as an undated task shows up
 * normally on Todoist's board. `filter` (see TaskListPanel's ViewFilterMenu)
 * can narrow this down to just Scheduled/No due date/Completed, same as
 * List/Gantt — see filterTasksByStatus.
 *
 * Section editing: column headers are click-to-rename, each has a delete
 * button, and a trailing "+ Add section" column creates a new one — all
 * synced to Todoist via SchedulerContext when a token is configured.
 *
 * COLUMN REORDER: columns are drag-to-reorder by their header grip handle,
 * with the order persisted per project in localStorage (see
 * utils/boardColumnOrder.js — it's deliberately local rather than written
 * back onto the Todoist-synced Section.order). The gesture deliberately
 * starts only from the grip, not the whole column: a column is itself a drop
 * target for card drags, and making the entire thing draggable would make
 * "drag a card out of column A" ambiguous with "drag column A". The two
 * drags also carry different dataTransfer types for the same reason.
 * Desktop only, matching the card drag (no drag gesture on touch).
 * The synthetic "No Section" column is not reorderable — it isn't a real
 * Section and always leads, so it has no persisted id.
 *
 * CARD MOTION: cards are framer-motion elements so that a card leaving a
 * column (completed, deleted, dragged to another column, filtered out) lets
 * the ones below it slide up into place instead of snapping — the same FLIP
 * treatment TaskListPanel's rows get, and skipped entirely when motion is
 * off (see useMotionEnabled). A cross-column drag is deliberately NOT a
 * shared-layout (`layoutId`) transition: the card unmounts from one column
 * and remounts in another, so a shared layout animation would need both
 * copies alive at once, which fights AnimatePresence's exit and misbehaves
 * inside the columns' own scroll containers. It fades out of the old column
 * and in to the new one instead, with the survivors closing the gap.
 *
 * LIVE-UPDATING EDIT MODAL: only the editing task's *id* is tracked in
 * state; the task object itself is derived fresh from `tasks` on every
 * render (see `editingTask` below), so background changes (subtask
 * toggles, Todoist sync completions, etc.) show up immediately in an open
 * modal without needing a close/reopen.
 * ============================================================================
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, X, Circle, Repeat, Wind, SquareCheck, Ban, ExternalLink, GripVertical } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import { useCompleteTask } from '../../context/CompleteTaskContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMotionEnabled } from '../../hooks/useMotionEnabled';
import { usePersistedState } from '../../hooks/usePersistedState';
import AddTaskModal from '../Modals/AddTaskModal';
import AIQuickAddModal from '../Modals/AIQuickAddModal';
import TaskDetailModal from '../Modals/TaskDetailModal';
import { taskMatchesQuery } from '../Common/SearchBar';
import AddTaskFabGroup from '../Common/AddTaskFabGroup';
import { formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatHours';
import { areDependenciesMet } from '../../utils/dependencyUtils';
import { priorityColor } from '../../utils/priorityColor';
import { ALL_TASKS_PROJECT_ID, filterTasksByProject, filterTasksByStatus } from '../../utils/projectConstants';
import { getEffectiveRemainingHours, isCompletedForCurrentOccurrence } from '../../utils/taskHierarchy';
import { BOARD_COLUMN_ORDER_KEY, applySavedColumnOrder, moveColumn } from '../../utils/boardColumnOrder';
import { computeEffectiveRole } from '../../utils/sharedProjectAccess';

// Card reorder/removal motion — see CARD MOTION above. Mirrors
// TaskListPanel's row timings (the CSS --duration-base/--ease-standard
// tokens), and `layout: 'position'` keeps a card's own box from being
// scaled mid-animation.
const CARD_TRANSITION = { duration: 0.2, ease: [0.2, 0, 0, 1] };
const CARD_EXIT = { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.3, 0, 1, 1] } };

// Custom dataTransfer type marking a column-reorder drag, so it's
// distinguishable from the card drag's `text/plain` payload (see COLUMN
// REORDER in the doc comment above). Must be lowercase — the DnD spec
// lowercases format strings, so a mixed-case type wouldn't match on read.
const COLUMN_DRAG_TYPE = 'application/x-taskflow-column';

// Baseline for the openAIQuickAddSignal prop below — kept at module scope
// (not a component-instance ref) because BoardView unmounts/remounts on
// every List/Board switch, see the effect below for the full rationale.
// Seeded to 0 (matching aiQuickAddSignal's initial useState(0) in App.jsx),
// not left `undefined` — otherwise `0 !== undefined` on BoardView's very
// first mount of the session, which used to auto-open AI Quick Add the
// first time anyone ever switched to the Board view.
let lastHandledBoardAIQuickAddSignal = 0;

export default function BoardView({ projectId, onProjectChange, filter = 'all', onOpenSearch, openAIQuickAddSignal, onSelectTaskRef }) {
  const {
    tasks,
    sections,
    projects,
    labels,
    searchQuery,
    addSection,
    renameSection,
    deleteSection,
    updateTask,
    sharedProjects,
  } = useScheduler();
  const { user } = useAuth();
  const { requestComplete } = useCompleteTask();
  // Recurring subtasks never set isCompleted true (see completeTask) —
  // "done for now" is tracked per-occurrence via completedDates instead, so
  // the card's subtask tally below needs isCompletedForCurrentOccurrence
  // rather than raw isCompleted (see taskHierarchy.js).
  const today = toISODate(new Date());
  // Track only the id — deriving the task object live from `tasks` (below)
  // ensures edits made in the modal (e.g. removing a subtask) show up
  // immediately instead of requiring a close/reopen.
  const [editingTaskId, setEditingTaskId] = useState(null);
  // The search bar itself now renders in TaskListPanel's shared sticky header
  // (see its own comment for why), not here — but "select a task from the
  // dropdown" still needs to open *this* view's own local editingTaskId
  // state, so TaskListPanel writes its setter into this ref on mount instead
  // of the SearchBar living here and calling it directly.
  useEffect(() => {
    if (onSelectTaskRef) onSelectTaskRef.current = setEditingTaskId;
    return () => {
      if (onSelectTaskRef && onSelectTaskRef.current === setEditingTaskId) onSelectTaskRef.current = null;
    };
  }, [onSelectTaskRef]);
  const [addingToSectionId, setAddingToSectionId] = useState(undefined); // undefined = modal closed
  const [showAIQuickAdd, setShowAIQuickAdd] = useState(false);
  // Command palette's "Quick Add with AI" action (see App.jsx's
  // aiQuickAddSignal, forwarded via TaskListPanel) — same signal-counter
  // pattern as TaskListPanel's own openAddTaskSignal, since this modal's open
  // state is local to Board rather than lifted. The "last handled" baseline
  // lives at module scope, not in a component-instance ref: Board remounts
  // every time the user switches away from and back to the Board view (or
  // leaves and returns to the Tasks tab), and a per-instance ref would forget
  // it already handled the current signal value, reopening the modal on
  // every return visit — see TaskListPanel's matching effect for the same
  // fix and full rationale.
  useEffect(() => {
    if (openAIQuickAddSignal !== lastHandledBoardAIQuickAddSignal) {
      lastHandledBoardAIQuickAddSignal = openAIQuickAddSignal;
      setShowAIQuickAdd(true);
    }
  }, [openAIQuickAddSignal]);
  const [editingColumnId, setEditingColumnId] = useState(null); // null | sectionId
  const [editingColumnTitle, setEditingColumnTitle] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  // Native HTML5 DnD for cross-column moves (mirrors WeekView's block drag)
  // — disabled on mobile, where there's no drag gesture to hook into.
  const isMobile = useIsMobile();
  const motionEnabled = useMotionEnabled();
  const [dragTaskId, setDragTaskId] = useState(null);
  const [dragOverColumnId, setDragOverColumnId] = useState(undefined); // undefined = none, null = "No Section" column
  // Column reordering — a separate drag from the card drag above, started
  // only from the header's grip handle so it can't hijack a card drop (see
  // COLUMN REORDER in the module doc). Persisted per project; see
  // utils/boardColumnOrder.js for why this is local-only rather than written
  // back onto the synced Section records.
  const [columnOrder, setColumnOrder] = usePersistedState(BOARD_COLUMN_ORDER_KEY, {});
  const [dragColumnId, setDragColumnId] = useState(null);
  const [dragOverReorderId, setDragOverReorderId] = useState(null);

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Direct children (parentId chain) per task id — used for the card's
  // rolled-up "x/y" sub-task progress badge below. Board never lists a
  // sub-task as its own card (see the `!t.parentId` filter in `columns`);
  // it stays rolled up into its parent's badge instead.
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

  const sortedProjects = useMemo(() => [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [projects]);

  // Board always needs one concrete project selected (unlike List's "All
  // Tasks" pseudo view) — if the shared selection is the "All Tasks"
  // pseudo id or doesn't match a real project, fall back to the first one
  // and report it back up so List view/sidebar reflect the resolved pick.
  useEffect(() => {
    if (sortedProjects.length === 0) return;
    const isValid = projectId !== ALL_TASKS_PROJECT_ID && sortedProjects.some((p) => p.id === projectId);
    if (!isValid) onProjectChange(sortedProjects[0].id);
  }, [projectId, sortedProjects, onProjectChange]);

  const selectedProjectId = projectId;
  const selectedProject = sortedProjects.find((p) => p.id === selectedProjectId);

  // A viewer on a shared project may look at the board but not touch its
  // sections — same precedent as TaskDetailModal's read-only comment
  // composer for a viewer. Rules already refuse the write server-side; this
  // just keeps the UI from showing controls that would silently fail.
  const isSectionsReadOnly =
    !!selectedProject?.sharedProjectId &&
    computeEffectiveRole(sharedProjects[selectedProject.sharedProjectId], user?.uid) === 'viewer';

  // Natural (synced) order, then the user's local drag arrangement layered on
  // top — see utils/boardColumnOrder.js.
  const projectSections = useMemo(
    () => applySavedColumnOrder(sections.filter((s) => s.projectId === selectedProjectId), columnOrder[selectedProjectId]),
    [sections, selectedProjectId, columnOrder]
  );

  const hasSections = projectSections.length > 0;

  const columns = useMemo(() => {
    const cols = [{ id: null, name: 'No Section', isNoSection: true }, ...projectSections];

    const withTasks = cols.map((col) => {
      // Sub-tasks (parentId set) are excluded from this top-level card
      // list — they're rolled up into their parent's progress badge instead
      // (see renderCard). `filter` defaults to "all" (every non-completed
      // task, dated or not), matching Board's original always-show-everything
      // behavior — see filterTasksByStatus.
      const columnTasks = filterTasksByStatus(filterTasksByProject(tasks, selectedProjectId).filter((t) => !t.parentId), filter)
        .filter((t) => (col.id === null ? !t.sectionId : t.sectionId === col.id))
        .filter((t) => taskMatchesQuery(t, searchQuery, labels));
      return { ...col, tasks: columnTasks };
    });

    // Only show the synthetic "No Section" column when there's actually an
    // unsectioned task to put in it — a project whose tasks are all sorted
    // into real Sections shouldn't show a permanently-empty leading column.
    return withTasks.filter((col) => !col.isNoSection || col.tasks.length > 0);
  }, [tasks, projectSections, selectedProjectId, filter, searchQuery, labels]);

  // Flat mode has exactly one synthetic "No Section" column (there are no
  // real sections yet), so its tasks are just columns[0].tasks.
  const flatTasks = columns[0]?.tasks ?? [];

  function startEditingColumn(col) {
    if (col.isNoSection || isSectionsReadOnly) return; // "No Section" is a synthetic bucket, not a real editable Section
    setEditingColumnId(col.id);
    setEditingColumnTitle(col.name);
  }

  function commitColumnEdit() {
    if (editingColumnId && editingColumnTitle.trim() && !isSectionsReadOnly) {
      renameSection(editingColumnId, editingColumnTitle);
    }
    setEditingColumnId(null);
    setEditingColumnTitle('');
  }

  function handleDeleteColumn(col) {
    if (col.isNoSection || isSectionsReadOnly) return;
    if (col.tasks.length > 0 && !window.confirm(`Delete "${col.name}"? Its ${col.tasks.length} task(s) will move to No Section.`)) {
      return;
    }
    deleteSection(col.id);
  }

  function handleAddSection() {
    if (!newSectionName.trim() || !selectedProjectId || isSectionsReadOnly) return;
    addSection(selectedProjectId, newSectionName);
    setNewSectionName('');
    setAddingSection(false);
  }

  // --- Drag handlers (native HTML5 DnD for cross-column moves) --------------
  function handleCardDragStart(e, task) {
    e.dataTransfer.setData('text/plain', task.id);
    setDragTaskId(task.id);
  }

  function handleColumnDragOver(e, col) {
    e.preventDefault();
    setDragOverColumnId(col.id);
  }

  function handleColumnDrop(e, col) {
    e.preventDefault();
    setDragOverColumnId(undefined);
    setDragTaskId(null);
    // A column-reorder drag passes over column bodies on its way to its drop
    // target; ignore it here so it can't also be treated as a card drop.
    // Checks the dataTransfer type rather than only `dragColumnId`, so the
    // payload itself is what disambiguates the two gestures.
    if (dragColumnId || e.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return;
    const taskId = e.dataTransfer.getData('text/plain');
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.sectionId === col.id) return; // no-op: dropped back on its current section
    updateTask(taskId, { sectionId: col.id, sectionName: col.isNoSection ? null : col.name });
  }

  // --- Column reorder (drag the header grip; see COLUMN REORDER note) --------
  function handleColumnReorderStart(e, col) {
    // Distinct dataTransfer type from the card drag's `text/plain`, so the two
    // gestures can never be confused for one another.
    e.dataTransfer.setData(COLUMN_DRAG_TYPE, col.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragColumnId(col.id);
  }

  function handleColumnReorderOver(e, col) {
    if (!dragColumnId || col.isNoSection || col.id === dragColumnId) return;
    e.preventDefault();
    e.stopPropagation(); // don't also light up the card-drop target underneath
    setDragOverReorderId(col.id);
  }

  function handleColumnReorderDrop(e, col) {
    if (!dragColumnId || col.isNoSection) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = dragColumnId;
    setDragColumnId(null);
    setDragOverReorderId(null);
    if (draggedId === col.id) return;
    const nextIds = moveColumn(projectSections, draggedId, col.id);
    setColumnOrder((prev) => ({ ...prev, [selectedProjectId]: nextIds }));
  }

  function handleColumnReorderEnd() {
    setDragColumnId(null);
    setDragOverReorderId(null);
  }

  function renderCard(task) {
    const children = childrenByParentId.get(task.id) || [];
    const subtaskTotal = children.length;
    const subtaskDone = children.filter((c) => isCompletedForCurrentOccurrence(c, today)).length;
    // Same fix as TaskListPanel's renderTaskRow: the Repeat/Wind icons render
    // inline before the title (13px + 4px margin-right = 17px each), pushing
    // the title's text right of the card's left edge — match that on the
    // meta line below so the two lines' text shares the same left edge.
    const titleIconOffset = (task.isRecurring ? 17 : 0) + (task.isPassive ? 17 : 0);
    return (
      <motion.div
        key={task.id}
        layout={motionEnabled ? 'position' : false}
        transition={CARD_TRANSITION}
        exit={motionEnabled ? CARD_EXIT : undefined}
        className={`board-card ${dragTaskId === task.id ? 'is-dragging' : ''}`}
        style={{ borderLeftColor: priorityColor(task.priority) }}
        role="button"
        tabIndex={0}
        // framer-motion normally swallows onDragStart/onDragEnd (they're its
        // own gesture props) — it only forwards them to the DOM when
        // `draggable` is set, which is exactly the desktop case below, so
        // native HTML5 DnD keeps working. Mobile passes neither.
        draggable={!isMobile}
        onDragStart={isMobile ? undefined : (e) => handleCardDragStart(e, task)}
        onDragEnd={isMobile ? undefined : () => setDragTaskId(null)}
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
            requestComplete(task.id);
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
          </div>
          <div
            className="board-card-meta"
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3, paddingLeft: titleIconOffset }}
          >
            <span>
              {/* A container (has sub-tasks — see subtaskTotal above) shows its rolled-up remaining
                  hours here rather than its own frozen/independent number — see utils/taskHierarchy.js. */}
              {formatHours(subtaskTotal > 0 ? getEffectiveRemainingHours(task, tasks) : task.remainingHours)} left
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
              <span style={{ color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {' · '}
                <Ban size={12} />
                blocked
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <span className={`badge ${task.priority}`}>{task.priority}</span>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="board-page">
      <AddTaskFabGroup
        onAddTask={() => setAddingToSectionId('')}
        onAIQuickAdd={() => setShowAIQuickAdd(true)}
        onOpenSearch={onOpenSearch}
      />

      {!selectedProject ? (
        <div className="board-column-empty" style={{ padding: 30 }}>
          No projects yet — add one from the sidebar.
        </div>
      ) : !hasSections ? (
        <div className="board-flat-list">
          {/* `initial={false}` leaves the first paint alone — the cards
              already there keep the plain `.board-card` CSS enter animation
              rather than all animating in through framer. */}
          <AnimatePresence initial={false}>{flatTasks.map((task) => renderCard(task))}</AnimatePresence>
          {flatTasks.length === 0 && <div className="board-column-empty">No tasks{searchQuery ? ' match your search' : ''}.</div>}
          {!isSectionsReadOnly && (
          <div className="board-flat-list-footer">
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
          )}
        </div>
      ) : (
        <div className="board-columns">
          {columns.map((col) => (
            <div
              key={col.id ?? 'no-section'}
              className={`board-column ${col.isNoSection ? 'no-section' : ''} ${
                dragColumnId === col.id ? 'is-column-dragging' : ''
              } ${dragOverReorderId === col.id ? 'is-column-dragover' : ''}`}
              // Reorder drop target is the whole column, so there's a generous
              // area to aim at; the *start* of the gesture is still limited to
              // the grip handle below.
              onDragOver={isMobile ? undefined : (e) => handleColumnReorderOver(e, col)}
              onDrop={isMobile ? undefined : (e) => handleColumnReorderDrop(e, col)}
            >
              <div className="board-column-header">
                {!col.isNoSection && !isMobile && (
                  <span
                    className="board-column-grip"
                    title="Drag to reorder column"
                    aria-hidden="true"
                    draggable
                    onDragStart={(e) => handleColumnReorderStart(e, col)}
                    onDragEnd={handleColumnReorderEnd}
                  >
                    <GripVertical size={13} />
                  </span>
                )}
                {!col.isNoSection && editingColumnId === col.id ? (
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
                    title={col.isNoSection || isSectionsReadOnly ? undefined : 'Click to rename'}
                    role={col.isNoSection || isSectionsReadOnly ? undefined : 'button'}
                    tabIndex={col.isNoSection || isSectionsReadOnly ? undefined : 0}
                    onClick={() => startEditingColumn(col)}
                    onKeyDown={(e) => {
                      if (!col.isNoSection && !isSectionsReadOnly && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        startEditingColumn(col);
                      }
                    }}
                  >
                    {col.name}
                  </span>
                )}
                <span className="board-column-count">{col.tasks.length}</span>
                {!col.isNoSection && !isSectionsReadOnly && (
                  <button className="board-column-delete" title="Delete section" onClick={() => handleDeleteColumn(col)}>
                    <X size={13} />
                  </button>
                )}
              </div>

              <div
                className={`board-column-body ${dragOverColumnId === col.id ? 'is-dragover' : ''}`}
                onDragOver={isMobile ? undefined : (e) => handleColumnDragOver(e, col)}
                onDragLeave={isMobile ? undefined : () => setDragOverColumnId(undefined)}
                onDrop={isMobile ? undefined : (e) => handleColumnDrop(e, col)}
              >
                <AnimatePresence initial={false}>{col.tasks.map((task) => renderCard(task))}</AnimatePresence>
                {col.tasks.length === 0 && <div className="board-column-empty">No tasks{searchQuery ? ' match your search' : ''}.</div>}
              </div>

              <button className="board-add-task" onClick={() => setAddingToSectionId(col.id ?? '')}>
                <Plus size={13} />
                Add task
              </button>
            </div>
          ))}

          {!isSectionsReadOnly && (
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
          )}
        </div>
      )}

      {addingToSectionId !== undefined && (
        <AddTaskModal
          initialSectionId={addingToSectionId}
          initialProjectId={selectedProjectId}
          onClose={() => setAddingToSectionId(undefined)}
        />
      )}
      {showAIQuickAdd && <AIQuickAddModal onClose={() => setShowAIQuickAdd(false)} />}
      {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
    </div>
  );
}

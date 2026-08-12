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
 * SUB-TASK DRAG: dragging one row onto another makes the dragged task a
 * sub-task of the row it was dropped on (mouse on desktop, long-press on
 * touch) — see hooks/useReparentDrag.js, shared with BoardView's cards. This
 * is the list's only drag gesture, so unlike Board there's nothing for it to
 * be confused with; the drop still has to land clearly inside a row's body
 * rather than graze its edge, so merely dragging past a row doesn't arm it.
 *
 * ROW MOTION: rows are framer-motion elements so that reordering (a
 * priority change, a new sort/filter, a task completing and leaving the
 * list) slides the survivors into their new positions instead of snapping
 * them there — a FLIP animation, which is the one thing plain CSS can't do
 * since it needs the before/after positions measured across a re-render.
 * `flattenRows` exists for the same reason: AnimatePresence only tracks its
 * own direct children, so the recursive parent/sub-task render has to be
 * flattened into one keyed list (which is what the DOM already was — see
 * SUB-TASKS above). All of it is skipped when motion is off (see
 * useMotionEnabled), leaving plain divs behind.
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Repeat, Wind, Ban, Check, ExternalLink, ChevronRight, ChevronDown, RotateCcw, Inbox, ListChecks } from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import { useCompleteTask } from '../context/CompleteTaskContext';
import { useSound } from '../context/SoundContext';
import AddTaskModal from './Modals/AddTaskModal';
import AIQuickAddModal from './Modals/AIQuickAddModal';
import TaskDetailModal from './Modals/TaskDetailModal';
import BoardView from './Board/BoardView';
import GanttChart from './Gantt/GanttChart';
import SearchBar, { taskMatchesQuery } from './Common/SearchBar';
import AddTaskFabGroup from './Common/AddTaskFabGroup';
import ReparentDropHint from './Common/ReparentDropHint';
import SelectMenu from './Common/SelectMenu';
import ProjectActionsMenu from './Common/ProjectActionsMenu';
import PresenceAvatars from './Common/PresenceAvatars';
import SharedProjectBadge from './Common/SharedProjectBadge';
import ViewFilterMenu from './Common/ViewFilterMenu';
import MarqueeText from './Common/MarqueeText';
import AccountButton from './Nav/AccountButton';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMotionEnabled } from '../hooks/useMotionEnabled';
import { usePersistedState } from '../hooks/usePersistedState';
import { useReparentDrag } from '../hooks/useReparentDrag';
import { formatDisplayDate, toISODate } from '../utils/dateUtils';
import { formatHours } from '../utils/formatHours';
import { areDependenciesMet } from '../utils/dependencyUtils';
import { getEffectiveEstimatedHours, getEffectiveRemainingHours, isCheckedForListDisplay } from '../utils/taskHierarchy';
import { resolveCurrentOccurrenceDueDate } from '../utils/recurrence';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, filterTasksByProject, filterTasksByStatus } from '../utils/projectConstants';
import { computeEffectiveRole } from '../utils/sharedProjectAccess';

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

// Baselines for the openAddTaskSignal/openAIQuickAddSignal props below — kept
// at module scope (not component-instance refs) because this component
// unmounts/remounts every time the user leaves and returns to the Tasks tab,
// and a per-instance "last handled" ref would forget it already handled the
// current signal value, reopening the modal on every return visit. Seeded to
// 0 (matching both signals' initial useState(0) in App.jsx), not left
// `undefined` — otherwise `0 !== undefined` on this component's very first
// mount of the session, which used to auto-open both modals the first time
// anyone ever visited the Tasks tab.
let lastHandledAddTaskSignal = 0;
let lastHandledAIQuickAddSignal = 0;

// Row reorder/removal motion (see the ROW MOTION note above). `layout:
// 'position'` animates a row's position only, never its size — a row whose
// text reflows would otherwise visibly squash/stretch mid-animation. Timing
// mirrors the CSS tokens (--duration-base / --ease-standard) everything else
// in the app animates with, and exit is deliberately quicker than the
// reflow so a completed row is gone before the gap closes behind it.
const ROW_TRANSITION = { duration: 0.2, ease: [0.2, 0, 0, 1] };
const ROW_EXIT = { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.3, 0, 1, 1] } };

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
  openAIQuickAddSignal,
  onOpenSettings,
  onOpenSearch,
  onShareProject,
}) {
  const { tasks, blocks, labels, projects, updateTask, uncompleteTask, searchQuery, renameProject, togglePinProject, deleteProject, viewersByProject, sharedProjects } = useScheduler();
  const { requestComplete } = useCompleteTask();
  const { playUncomplete } = useSound();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const motionEnabled = useMotionEnabled();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAIQuickAdd, setShowAIQuickAdd] = useState(false);
  // The "new task" shortcut (see useKeyboardShortcuts in App.jsx) bumps this
  // from anywhere in the app to open "Add task" here, since this modal's open
  // state is local to the Tasks tab rather than lifted — App.jsx switches to
  // this tab and increments the signal, this just reacts to the change.
  //
  // A signal-bumping caller always does `setTab('tasks')` + the increment in
  // the same event handler (same React batch), so on the *first* trigger of
  // a session this component can mount for the first time already carrying
  // the bumped value. The "last handled" baseline therefore can't live in a
  // ref local to this component instance: this component unmounts every time
  // the user leaves the Tasks tab (App.jsx only renders it while `tab ===
  // 'tasks'`), so a per-instance "have I observed a signal yet" flag resets
  // on every remount and would spuriously reopen the modal just because the
  // signal was already bumped earlier in the session, the first time the
  // user navigates back to Tasks. Module-scope variables survive remounts
  // (this page is effectively a singleton), so the baseline lives there
  // instead — updated as soon as it's read, before the modal opens, so a
  // re-render triggered by opening the modal can't re-read the same "changed"
  // signal as new again.
  useEffect(() => {
    if (openAddTaskSignal !== lastHandledAddTaskSignal) {
      lastHandledAddTaskSignal = openAddTaskSignal;
      setShowAddModal(true);
    }
  }, [openAddTaskSignal]);
  // Same signal pattern, for the command palette's "Quick Add with AI" action
  // (see App.jsx's aiQuickAddSignal) — opens the List view's own AI Quick Add
  // modal directly; Board view gets the equivalent effect on the same prop,
  // forwarded down below, since it owns its own copy of this modal's state.
  useEffect(() => {
    if (openAIQuickAddSignal !== lastHandledAIQuickAddSignal) {
      lastHandledAIQuickAddSignal = openAIQuickAddSignal;
      setShowAIQuickAdd(true);
    }
  }, [openAIQuickAddSignal]);
  // Fades in the sticky header's blurred backdrop (see .taskpage-sticky-header)
  // and pulls it a little closer to the top of the screen, as the page
  // scrolls, rather than snapping both the instant it docks — measured
  // against .main-content (the app's one real scroll container, see
  // global.css) since that's what actually scrolls this page's content
  // underneath it. Driven directly off scrollTop rather than the header's
  // distance to its sticky `top` offset: that resting distance is only
  // ~28px on desktop and effectively 0 on mobile (a narrower .main-content
  // top padding there — see global.css's `.is-mobile .main-content`), so it
  // doesn't leave enough room for a distance-based fade to start at 0 on
  // every screen size the way a scrollTop-based one does. The same fraction
  // drives both effects so they land together instead of at two different
  // scroll speeds. The docking distance itself is done here (a JS-driven
  // translateY), not via `position: sticky`'s own `top` offset, since a
  // negative `top` only changes *when* the element locks, not how far above
  // its resting position it ends up once locked — there's no sticky-only
  // way to make "docked" measurably closer to the top than "resting".
  const stickyHeaderRef = useRef(null);
  const [headerScrollFraction, setHeaderScrollFraction] = useState(0);
  useEffect(() => {
    const node = stickyHeaderRef.current;
    if (!node) return undefined;
    const scrollContainer = node.closest('.main-content');
    if (!scrollContainer) return undefined;
    const fadeRange = 32; // px of scroll the fade/dock-in plays out over
    function handleScroll() {
      setHeaderScrollFraction(Math.min(1, Math.max(0, scrollContainer.scrollTop / fadeRange)));
    }
    handleScroll();
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [view]);
  // How much closer to the top the header sits once fully docked, on top of
  // its resting distance (pulled up via `margin-top` in tasklist.css).
  const HEADER_DOCK_PULL_PX = 16;
  const headerDockOffsetPx = headerScrollFraction * HEADER_DOCK_PULL_PX;
  const [editingTaskId, setEditingTaskId] = useState(null);
  // Board view owns its own separate editingTaskId/TaskDetailModal (its cards
  // open it directly too), but the search bar that can trigger it now
  // renders here, in the shared sticky header, not inside BoardView (see
  // .taskpage-sticky-header comment for why) — BoardView writes its setter
  // into this ref on mount so the one shared SearchBar can reach whichever
  // view's modal state is actually active.
  const boardSelectTaskRef = useRef(null);
  // Persisted (device-local view state, not synced/backed up — see CLAUDE.md's
  // Backups section) so the per-view status filter survives a reload. Merged
  // defensively over DEFAULT_FILTER_BY_VIEW rather than trusting the stored
  // shape outright — an older/partial persisted value (missing a view key
  // added since, e.g.) would otherwise leave `filter` undefined below.
  const [filterByView, setFilterByView] = usePersistedState('taskflow_tasks_filter_by_view_v1', DEFAULT_FILTER_BY_VIEW);
  const filter = filterByView[view] ?? DEFAULT_FILTER_BY_VIEW[view]; // active | completed | all | noDueDate
  function setFilter(key) {
    setFilterByView((prev) => ({ ...prev, [view]: key }));
  }
  // Ids of parent tasks whose children are currently hidden — collapsed is
  // opt-in per row, so anything not in this set renders expanded (the
  // default), and it's plain local state rather than persisted.
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');

  // Today's ISO date, used both for the Overdue/Today/Upcoming grouping below
  // and (via isCompletedForCurrentOccurrence) each row's "done for today"
  // display state — computed once per render rather than per row/group.
  const today = toISODate(new Date());
  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || null : null;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  // Per-project id -> "current user is a viewer on this shared project" map,
  // so a row can be gated by *its own* task's project rather than only the
  // page's currently-selected one — "All Tasks" mixes rows from several
  // projects (some viewer-only, some not) into one list, unlike Board which
  // always shows exactly one project at a time (see isSectionsReadOnly there).
  const viewerOnlyProjectIds = useMemo(() => {
    const ids = new Set();
    for (const p of projects) {
      if (p.sharedProjectId && computeEffectiveRole(sharedProjects[p.sharedProjectId], user?.uid) === 'viewer') {
        ids.add(p.id);
      }
    }
    return ids;
  }, [projects, sharedProjects, user?.uid]);
  // Row -> row drag = "make this a sub-task of that" (see SUB-TASK DRAG in the
  // header). Unlike Board there's no competing section/column drop gesture
  // here, so a row is a drop target for its whole body. `isTaskLocked` gates
  // per row rather than for the view as a whole, since "All Tasks" can list a
  // viewer-only shared project's rows next to editable ones.
  const isTaskLocked = useCallback(
    (task) => !!task.projectId && viewerOnlyProjectIds.has(task.projectId),
    [viewerOnlyProjectIds]
  );
  const reparent = useReparentDrag({ tasks, updateTask, isTaskLocked });

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

  // Stable callback refs (useCallback) so TaskRow's React.memo below actually
  // bails on unrelated re-renders instead of seeing a fresh function prop
  // every time this panel re-renders (e.g. while TaskDetailModal's debounced
  // autosave is firing for a task on screen underneath it).
  const toggleCollapsed = useCallback((taskId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);
  const handleUncomplete = useCallback(
    (taskId) => {
      uncompleteTask(taskId);
      playUncomplete();
    },
    [uncompleteTask, playUncomplete]
  );
  const activeProject = activeProjectId === ALL_TASKS_PROJECT_ID ? null : projects.find((p) => p.id === activeProjectId);

  // A viewer-role collaborator can browse a shared project's List view but
  // not add tasks to it — same precedent as BoardView's isSectionsReadOnly.
  // "All Tasks" never counts as viewer-only: the FAB there opens AddTaskModal
  // with no pre-selected project (Inbox), which is never itself a shared
  // project, so there's nothing to gate at this level (AddTaskModal's own
  // dropdown still excludes any viewer-only project the user might pick there).
  const isActiveProjectViewerOnly =
    !!activeProject?.sharedProjectId &&
    computeEffectiveRole(sharedProjects[activeProject.sharedProjectId], user?.uid) === 'viewer';

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
    // A non-empty search query bypasses the active/all/noDueDate filter
    // chip's due-date narrowing — search should surface any matching task
    // from the whole project regardless of due date, not just the subset
    // the current chip already narrowed down to. Completed tasks are the
    // one exception: they only ever show up in search while the
    // "Completed" chip itself is active, matching every other search
    // surface in the app (SearchBar dropdown, Command Palette) where
    // completed tasks stay hidden unless the user has explicitly asked to
    // see completed items.
    if (filter === 'completed') list = filterTasksByStatus(list, 'completed');
    else if (searchQuery) list = list.filter((t) => !t.isCompleted);
    else list = filterTasksByStatus(list, filter);
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

  // Grouped into Overdue/Today/Scheduled/Upcoming sections so what needs
  // attention stands out instead of being buried in one priority-sorted
  // list. Only meaningful for the dated tabs — "Completed" and "No due
  // date" render as a flat list. Overdue is its own bucket (dueDate
  // strictly before today) rather than being silently lumped into
  // "Upcoming" — it's surfaced first since it's the most urgent thing in
  // the list.
  //
  // Uses resolveCurrentOccurrenceDueDate rather than the raw task.dueDate —
  // a recurring task's dueDate is the series' fixed pattern anchor and stays
  // put even when a single occurrence is moved off-pattern (see that
  // function's own doc comment), so grouping on the raw field would leave a
  // rescheduled occurrence sitting in its old Overdue/Today/Upcoming bucket
  // instead of the one it was actually moved to.
  // Ids of tasks with a calendar block placed today — used to peel a
  // "Scheduled" group out of Upcoming/No-due-date below. Overdue and Today
  // (by due date) both stay put regardless of today's blocks: Overdue is
  // already the most urgent bucket, and Today-by-block would just be
  // relabeling a task that's already surfaced in Today-by-due-date.
  const taskIdsScheduledToday = useMemo(() => {
    const ids = new Set();
    for (const block of blocks) {
      if (block.date === today) ids.add(block.taskId);
    }
    return ids;
  }, [blocks, today]);
  const showGroups = filter === 'active' || filter === 'all';
  const taskGroups = useMemo(() => {
    if (!showGroups) return null;
    const overdue = [];
    const todayTasks = [];
    const scheduledToday = [];
    const upcoming = [];
    const undated = [];
    for (const task of visibleTasks) {
      const dueDate = resolveCurrentOccurrenceDueDate(task);
      if (!dueDate) {
        if (taskIdsScheduledToday.has(task.id)) scheduledToday.push(task);
        else undated.push(task);
      } else if (dueDate < today) overdue.push(task);
      else if (dueDate === today) todayTasks.push(task);
      else if (taskIdsScheduledToday.has(task.id)) scheduledToday.push(task);
      else upcoming.push(task);
    }
    return [
      { key: 'overdue', label: 'Overdue', tasks: overdue },
      { key: 'today', label: 'Today', tasks: todayTasks },
      { key: 'scheduledToday', label: 'Scheduled', tasks: scheduledToday },
      { key: 'upcoming', label: 'Upcoming', tasks: upcoming },
      // Only "All" ever surfaces undated tasks here — "Active" already
      // filters them out above, so this group is empty (and hidden) there.
      { key: 'noDueDate', label: 'No due date', tasks: undated },
    ].filter((group) => group.tasks.length > 0);
  }, [visibleTasks, showGroups, today, taskIdsScheduledToday]);

  /**
   * Expands a top-level task into the flat, in-order list of rows it
   * contributes — itself, then (unless collapsed) every descendant
   * depth-first, each tagged with its nesting `depth`. Rows have always been
   * rendered as flat siblings (the indent is a marginLeft, not real DOM
   * nesting), so this is the same output order the old recursive render
   * produced, just as data instead of JSX — which is what lets every row be
   * a direct child of one AnimatePresence (see ROW MOTION above).
   */
  function flattenRows(task, depth = 0, out = []) {
    out.push({ task, depth });
    if (!collapsedIds.has(task.id)) {
      for (const child of childrenByParentId.get(task.id) || []) flattenRows(child, depth + 1, out);
    }
    return out;
  }

  /**
   * Builds the (memo-friendly) props for one task row and hands off to
   * <TaskRow> — see that component's doc comment for why values like
   * `dependenciesMet`/effective hours are resolved here as plain
   * booleans/numbers rather than passed down as the `tasks`/`taskById`
   * they're derived from.
   */
  function renderTaskRow({ task, depth }) {
    const childCount = (childrenByParentId.get(task.id) || []).length;
    const hasChildren = childCount > 0;
    return (
      <TaskRow
        key={task.id}
        task={task}
        depth={depth}
        hasChildren={hasChildren}
        childCount={childCount}
        isCollapsed={collapsedIds.has(task.id)}
        motionEnabled={motionEnabled}
        labelById={labelById}
        dependenciesMet={areDependenciesMet(task, taskById)}
        // List-view-only "done for today" display state — a recurring task
        // never sets isCompleted, so without this a completed-for-today
        // sub-task would render unchecked here even though its occurrence is
        // closed out. See taskHierarchy.js's isCheckedForListDisplay.
        isCheckedForDisplay={isCheckedForListDisplay(task, today)}
        // The CURRENT occurrence's due date, not task.dueDate directly — see
        // resolveCurrentOccurrenceDueDate's doc comment on the taskGroups
        // memo above.
        displayDueDate={resolveCurrentOccurrenceDueDate(task)}
        effectiveRemainingHours={hasChildren ? getEffectiveRemainingHours(task, tasks) : task.remainingHours}
        effectiveEstimatedHours={hasChildren ? getEffectiveEstimatedHours(task, tasks) : task.estimatedHours}
        onToggleCollapse={toggleCollapsed}
        onOpen={setEditingTaskId}
        onComplete={requestComplete}
        onUncomplete={handleUncomplete}
        isReadOnlyViewer={!!task.projectId && viewerOnlyProjectIds.has(task.projectId)}
        isDragging={reparent.draggedId === task.id}
        isReparentTarget={reparent.targetId === task.id}
        reparentHandlers={reparent.handlers}
        onDragEnd={reparent.endDrag}
      />
    );
  }

  // On mobile there isn't room for a title plus two separate menu triggers,
  // so the view/filter picker and the project's Rename/Pin/Delete actions
  // collapse into one combined "⋯" popover (see ViewFilterMenu's
  // `projectActions` prop) instead of the two desktop-only triggers below.
  const projectActionsProps = activeProject
    ? {
      isPinned: !!activeProject.isPinned,
      isShared: !!activeProject.sharedProjectId,
      onRename: startRenameProject,
      onTogglePin: () => togglePinProject(activeProject.id),
      onDelete: handleDeleteProject,
      onShare: () => onShareProject(activeProject.id),
    }
    : undefined;

  return (
    <div className="taskpage">
      <div
        className="taskpage-sticky-header"
        ref={stickyHeaderRef}
        style={{ '--header-blur-opacity': headerScrollFraction, transform: `translateY(-${headerDockOffsetPx}px)` }}
      >
        <div className="taskpage-sticky-header-backdrop" aria-hidden="true" />
        <div className="taskpage-header-row">
          <div className="taskpage-project-header">
            <SelectMenu
              value={activeProjectId}
              options={projectSelectOptions}
              onChange={onChangeActiveProject}
              ariaLabel="Switch project"
              marquee
            />
            {isRenamingProject ? (
              <input
                autoFocus
                className="taskpage-project-title-input"
                aria-label={`Rename project "${activeProject?.name || ''}"`}
                value={projectNameDraft}
                onChange={(e) => setProjectNameDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
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
                <MarqueeText text={activeProject ? activeProject.name : ALL_TASKS_PROJECT_LABEL} />
              </h2>
            )}
            {/* Which of the three sharing states this project is in. Unlike
                the manage-projects action (folded into ProjectActionsMenu/
                ViewFilterMenu, not shown inline), this is shown on mobile too:
                it's STATUS, not an action, and "who else can see this" is
                exactly the thing a user needs to be certain of on whatever
                device they're on — hiding it on mobile would make the
                privacy-relevant state the one thing that disappears on the
                smaller screen. Renders nothing for a personal project. */}
            {activeProject && (
              <SharedProjectBadge
                project={activeProject}
                sharedProject={sharedProjects[activeProject.sharedProjectId]}
                uid={user?.uid}
                variant="detailed"
                ownerDisplayName={sharedProjects[activeProject.sharedProjectId]?.ownerDisplayName}
              />
            )}
          </div>

          <div className="taskpage-view-switch-row">
            <ViewFilterMenu
              view={view}
              onChangeView={onChangeView}
              viewOptions={PAGE_VIEWS.filter((v) => v.key !== 'board' || activeProjectId !== ALL_TASKS_PROJECT_ID)}
              filter={filter}
              onChangeFilter={setFilter}
              projectActions={isMobile ? projectActionsProps : undefined}
              onOpenManageProjects={isMobile ? onOpenManageProjects : undefined}
            />
            {/* Mobile has no top bar (see App.jsx) other than on Dashboard, so this
                doubles as this page's one-tap way to reach account/settings —
                mirrors the old mobile topbar's AccountButton. */}
            {isMobile && <AccountButton compact menuAlign="down" onOpenAccountSettings={onOpenSettings} />}
            {/* Who else is in this shared project right now. Renders nothing
                for a personal project, so it costs no space in the common
                case — see PresenceAvatars. Placed before the actions menu so
                the "⋯" stays where users expect it at the end of the row. */}
            {activeProject?.sharedProjectId && (
              <PresenceAvatars viewers={viewersByProject[activeProject.sharedProjectId]} />
            )}
            {!isMobile && activeProject && (
              <ProjectActionsMenu
                isPinned={!!activeProject.isPinned}
                isShared={!!activeProject.sharedProjectId}
                ariaLabel={`Actions for ${activeProject.name}`}
                onRename={startRenameProject}
                onTogglePin={() => togglePinProject(activeProject.id)}
                onDelete={handleDeleteProject}
                onShare={() => onShareProject(activeProject.id)}
                onOpenManageProjects={onOpenManageProjects}
              />
            )}
            {/* "All Tasks" has no activeProject, so the menu above never
                renders — but manage-projects isn't project-specific, so it
                still needs a trigger here. Reuses the same component with
                only onOpenManageProjects set (Rename/Pin/Delete/Share all
                gate on their own handler being present, see ProjectActionsItems). */}
            {!isMobile && !activeProject && onOpenManageProjects && (
              <ProjectActionsMenu ariaLabel="Manage projects" onOpenManageProjects={onOpenManageProjects} />
            )}
          </div>
        </div>

        {(view === 'list' || view === 'board') && (
          <div className="tasklist-toolbar">
            <SearchBar
              placeholder={view === 'board' ? 'Search board…' : undefined}
              onSelectProject={view === 'list' ? onChangeActiveProject : undefined}
              onSelectTask={view === 'board' ? (id) => boardSelectTaskRef.current?.(id) : setEditingTaskId}
            />
          </div>
        )}
      </div>

      {/* Rendered as a sibling of .taskpage-sticky-header, not inside it —
          that element carries an inline `transform` (the scroll-driven dock
          offset above), and any transform — even translateY(0) at rest —
          makes its subtree a containing block for position:fixed
          descendants, which broke this FAB's "fixed to viewport" corner
          positioning (it would render pinned near the header instead of the
          bottom-right corner, overlapping the view/filter menu). */}
      {view === 'list' && (
        <AddTaskFabGroup
          onAddTask={() => setShowAddModal(true)}
          onAIQuickAdd={() => setShowAIQuickAdd(true)}
          onOpenSearch={isMobile ? onOpenSearch : undefined}
          addTaskDisabled={isActiveProjectViewerOnly}
        />
      )}

      {view === 'board' && (
        <BoardView
          projectId={activeProjectId}
          onProjectChange={onResolveBoardProject}
          filter={filter}
          onOpenSearch={isMobile ? onOpenSearch : undefined}
          openAIQuickAddSignal={openAIQuickAddSignal}
          onSelectTaskRef={boardSelectTaskRef}
        />
      )}
      {view === 'gantt' && <GanttChart activeProjectId={activeProjectId} filter={filter} />}

      {view === 'list' && (
        <>
          <div className="tasklist-rows">
            {visibleTasks.length === 0 && (
              <div className="card" style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                <Inbox size={22} className="empty-state-icon" aria-hidden="true" />
                No tasks {searchQuery ? 'match your search' : 'here yet'}.
              </div>
            )}
            {/* `initial={false}` so the rows already on screen when the list
                first mounts don't all animate in — only rows added later do
                (and even then via the shared `.card` CSS enter animation),
                while removals still get their exit animation. */}
            {taskGroups
              ? taskGroups.map((group) => (
                <div key={group.key} className="tasklist-section">
                  <h3 className={`tasklist-section-header ${group.key === 'overdue' ? 'is-overdue' : ''}`}>
                    {group.label}
                    <span className="tasklist-section-count">{group.tasks.length}</span>
                  </h3>
                  <AnimatePresence initial={false}>
                    {group.tasks.flatMap((task) => flattenRows(task)).map(renderTaskRow)}
                  </AnimatePresence>
                </div>
              ))
              : (
                <AnimatePresence initial={false}>
                  {visibleTasks.flatMap((task) => flattenRows(task)).map(renderTaskRow)}
                </AnimatePresence>
              )}
          </div>

          {showAddModal && (
            <AddTaskModal onClose={() => setShowAddModal(false)} initialProjectId={activeProject ? activeProject.id : ''} />
          )}
          {showAIQuickAdd && <AIQuickAddModal onClose={() => setShowAIQuickAdd(false)} />}
          {editingTask && <TaskDetailModal task={editingTask} onClose={() => setEditingTaskId(null)} />}
        </>
      )}
    </div>
  );
}

/**
 * One task row (see TaskListPanel's ROW MOTION note for the framer-motion
 * `layout="position"` behavior this relies on). Wrapped in React.memo so a
 * row whose own `task` object is unchanged skips both the JSX diff and the
 * layout-measuring `getBoundingClientRect` framer-motion does for
 * `layout="position"` — otherwise every row remeasures on any re-render of
 * the list (e.g. TaskDetailModal's debounced sidebar autosave firing for a
 * task shown underneath it), even though only one row actually changed.
 *
 * For this memo to actually pay off, every prop below is either the `task`
 * object itself (individual task objects keep their identity across an
 * unrelated `updateTask` call — see SchedulerContext's `tasks.map`, which
 * only replaces the one task that changed) or a plain primitive/stable
 * callback resolved by the caller — never the raw `tasks` array or a
 * `taskById`/`childrenByParentId` Map, both of which get a new identity on
 * every task update anywhere and would defeat the memo for every row.
 * `labelById` is the one Map passed through directly since it's keyed off
 * `labels`, which changes far less often than `tasks` does.
 */
const TaskRow = React.memo(function TaskRow({
  task,
  depth,
  hasChildren,
  childCount,
  isCollapsed,
  motionEnabled,
  labelById,
  dependenciesMet,
  isCheckedForDisplay,
  displayDueDate,
  effectiveRemainingHours,
  effectiveEstimatedHours,
  onToggleCollapse,
  onOpen,
  onComplete,
  onUncomplete,
  isReadOnlyViewer,
  isDragging,
  isReparentTarget,
  reparentHandlers,
  onDragEnd,
}) {
  return (
    <motion.div
      layout={motionEnabled ? 'position' : false}
      transition={ROW_TRANSITION}
      exit={motionEnabled ? ROW_EXIT : undefined}
      className={`task-row ${depth === 0 ? 'card' : 'task-row-child'} ${isDragging ? 'is-dragging' : ''} ${
        isReparentTarget ? 'is-reparent-target' : ''
      }`}
      style={depth > 0 ? { marginLeft: `calc(var(--space-5) * ${depth})` } : undefined}
      // Drag a row onto another row to make it that row's sub-task (see
      // SUB-TASK DRAG in TaskListPanel's header). framer-motion only forwards
      // onDragStart/onDragEnd to the DOM when `draggable` is set — which it is
      // here — so native HTML5 DnD works through it; touch gets the
      // long-press path instead, since there's no native touch DnD.
      draggable={!isReadOnlyViewer}
      data-task-id={task.id}
      onDragStart={(e) => reparentHandlers.dragStart(e, task.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => reparentHandlers.dragOver(e, task.id)}
      onDragLeave={() => reparentHandlers.dragLeave(task.id)}
      onDrop={(e) => reparentHandlers.drop(e, task.id)}
      onTouchStart={(e) => reparentHandlers.touchStart(e, task.id)}
      onClick={() => {
        if (reparentHandlers.consumeClick()) return; // trailing click of a long-press drag, not a tap
        onOpen(task.id);
      }}
    >
      {isReparentTarget && <ReparentDropHint parentTitle={task.title} />}
      <button
        className={`task-checkbox ${task.priority} ${isCheckedForDisplay ? 'checked' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (isReadOnlyViewer) return; // Defense in depth — button is already disabled for viewers.
          if (!isCheckedForDisplay) onComplete(task.id);
        }}
        disabled={isCheckedForDisplay || isReadOnlyViewer}
        title={
          isReadOnlyViewer
            ? "Viewers can't complete tasks"
            : isCheckedForDisplay
              ? 'Completed'
              : task.isRecurring
                ? 'Complete (advances to next occurrence)'
                : 'Mark complete'
        }
        aria-label={isCheckedForDisplay ? `${task.title} completed` : `Mark ${task.title} complete`}
      >
        {isCheckedForDisplay && <Check size={12} aria-hidden="true" />}
      </button>
      <div className="task-row-main">
        <div style={{ fontWeight: 600, textDecoration: isCheckedForDisplay ? 'line-through' : 'none', opacity: isCheckedForDisplay ? 0.5 : 1 }}>
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
          {hasChildren && (
            <span
              className="task-row-subtask-count"
              style={{ verticalAlign: -2, marginLeft: 6 }}
              title={`${childCount} sub-task${childCount === 1 ? '' : 's'}`}
            >
              <ListChecks size={12} aria-hidden="true" />
              {childCount}
            </span>
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
            {/* A container (has sub-tasks) shows its rolled-up hours here rather than its own
                frozen/independent number — see utils/taskHierarchy.js. Cheap no-op for a leaf task. */}
            {formatHours(effectiveRemainingHours)} remaining of {formatHours(effectiveEstimatedHours)}
            {displayDueDate ? ` · due ${formatDisplayDate(displayDueDate)}` : ' · no due date'}
            {task.sectionName ? ` · ${task.sectionName}` : ''}
          </span>
          {!isCheckedForDisplay && !dependenciesMet && (
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
      {isCheckedForDisplay && (
        <button
          type="button"
          className="btn btn-icon task-row-restore"
          onClick={(e) => {
            e.stopPropagation();
            onUncomplete(task.id);
          }}
          title="Restore to active"
          aria-label={`Restore ${task.title}`}
        >
          <RotateCcw size={14} />
        </button>
      )}
      {hasChildren && (
        <button
          type="button"
          className="btn btn-icon task-row-collapse"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(task.id);
          }}
          aria-label={isCollapsed ? `Expand ${task.title}` : `Collapse ${task.title}`}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
    </motion.div>
  );
});

/**
 * ============================================================================
 * App
 * ============================================================================
 * Top-level shell: sidebar navigation (Calendar / Tasks / Stats / Settings)
 * and the routed main content area. Global Undo/Redo/New-task now live as
 * keyboard shortcuts (see useKeyboardShortcuts) rather than a topbar — the
 * only header row left is the mobile brand bar (see the `isMobile` block
 * below), desktop just gets a top margin on `.main-content` instead (see
 * global.css). No external router is used (a simple useState
 * tab switch) since this is a single-page dashboard with no deep-linkable
 * sub-routes required by the spec. Board and Gantt aren't separate tabs —
 * they're views within the Tasks page (see TaskListPanel's own
 * List/Board/Gantt switch), tracked here as `taskView` so the guided tour
 * can drive it the same way it drives the top-level `tab`.
 * ============================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import { SchedulerProvider, useScheduler } from './context/SchedulerContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { SoundProvider } from './context/SoundContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TimerProvider } from './context/TimerContext';
import { CompleteTaskProvider } from './context/CompleteTaskContext';
import { ConfirmProvider } from './context/ConfirmContext';
import TimerWidget from './components/Common/TimerWidget';
import CompleteTaskConfirmModal from './components/Common/CompleteTaskConfirmModal';
import ConfirmModal from './components/Common/ConfirmModal';
import CalendarRewriteOverlay from './components/Common/CalendarRewriteOverlay';
import AccountButton from './components/Nav/AccountButton';
import Sidebar from './components/Nav/Sidebar';
import CalendarPage from './components/Calendar/CalendarPage';
import TaskListPanel from './components/TaskListPanel';
import StatsDashboard from './components/Stats/StatsDashboard';
import SettingsPanel from './components/SettingsPanel';
import Toast from './components/Common/Toast';
import ActionToast from './components/Common/ActionToast';
import InstallAppBanner from './components/Common/InstallAppBanner';
import BottomTabBar from './components/Nav/BottomTabBar';
import ManageProjectsModal from './components/Modals/ManageProjectsModal';
import AddProjectModal from './components/Modals/AddProjectModal';
import ChangelogModal from './components/Modals/ChangelogModal';
import JoinProjectModal from './components/Modals/JoinProjectModal';
import ShareProjectModal from './components/Modals/ShareProjectModal';
import TaskDetailModal from './components/Modals/TaskDetailModal';
import SchedulingConflictsModal from './components/Modals/SchedulingConflictsModal';
import CommandPalette from './components/CommandPalette';
import { useIsMobile } from './hooks/useIsMobile';
import { usePersistedState } from './hooks/usePersistedState';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSelectAllOnFocus } from './hooks/useSelectAllOnFocus';
import { useJoinFlow } from './hooks/useJoinFlow';
import { readJoinToken } from './utils/joinFlow';
import GuidedTour from './components/Tutorial/GuidedTour';
import DashboardPage from './components/Dashboard/DashboardPage';
import ProjectsPage from './components/Projects/ProjectsPage';
import { ALL_TASKS_PROJECT_ID, INBOX_PROJECT_ID } from './utils/projectConstants';
import { CURRENT_VERSION } from './changelog';
import {
  LayoutDashboard,
  CalendarDays,
  CheckSquare,
  FolderKanban,
  TrendingUp,
  Settings,
  Search,
  Sparkles,
  StickyNote,
} from 'lucide-react';
import { useAIQuickAddGate } from './hooks/useAIQuickAddGate';
import AIQuickAddModal from './components/Modals/AIQuickAddModal';
import NoteEditorModal from './components/Modals/NoteEditorModal';
import { useNoteMutations } from './hooks/useNoteMutations';

// Board and Gantt used to be their own top-level tabs; they're now views
// within the Tasks page (see TaskListPanel's List/Board/Gantt switch). Six
// tabs is the full set — BottomTabBar's items are flex:1 (see nav.css), so
// they still all show directly in one row on mobile with no "More" overflow
// needed.
const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'stats', label: 'Stats', icon: TrendingUp },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function AppShell() {
  const { user, authError, clearAuthError } = useAuth();
  const [tab, setTab] = useState('dashboard');
  // Device-local UI state (which project/view is selected) — not user data,
  // so deliberately left out of BACKUP_FIELDS.
  const [activeProjectId, setActiveProjectId] = usePersistedState('activeProjectId', ALL_TASKS_PROJECT_ID);
  // Tasks page's own sub-view ('list' | 'board' | 'gantt'), remembered PER
  // PROJECT (keyed by projectId, including the ALL_TASKS_PROJECT_ID pseudo
  // project) rather than as one global choice — switching from Board on
  // Project A to Project B shouldn't drag Board along with it if B was last
  // viewed as List.
  const [taskViewByProject, setTaskViewByProject] = usePersistedState('taskViewByProject', {});
  // Board can't render the All Tasks/Inbox pseudo-projects (see
  // resolveBoardProject below) — if that key was ever persisted as 'board'
  // (e.g. from a session before the Board option was hidden here), clamp it
  // back to 'list' rather than letting BoardView mount, bounce off its
  // invalid-project check, and instantly redirect the user to whatever real
  // project happens to be first — which reads as the pseudo-project being
  // broken.
  const rawTaskView = taskViewByProject[activeProjectId] || 'list';
  const isPseudoProjectActive = activeProjectId === ALL_TASKS_PROJECT_ID || activeProjectId === INBOX_PROJECT_ID;
  const taskView = isPseudoProjectActive && rawTaskView === 'board' ? 'list' : rawTaskView;
  function setTaskView(next) {
    setTaskViewByProject((prev) => {
      const current = prev[activeProjectId] || 'list';
      const resolved = typeof next === 'function' ? next(current) : next;
      return { ...prev, [activeProjectId]: resolved };
    });
  }
  const [showTour, setShowTour] = useState(false);
  const [hasSeenTutorial, setHasSeenTutorial] = usePersistedState('tutorial-seen', false);
  const [showManageProjects, setShowManageProjects] = useState(false);
  // Which project's share dialog is open, by local project id (null = closed).
  // Held here rather than in each list component because three separate
  // surfaces (sidebar, List header, ManageProjectsModal) can open it and only
  // one should ever be on screen.
  const [sharingProjectId, setSharingProjectId] = useState(null);
  const [showChangelog, setShowChangelog] = useState(false);
  const [lastSeenChangelogVersion, setLastSeenChangelogVersion] = usePersistedState('lastSeenChangelogVersion', null);
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);
  // Bumped by the "new task" shortcut below to signal TaskListPanel (which
  // owns "Add task" modal state locally) to open it, even when the shortcut
  // is pressed from a different tab — see the effect on this prop in
  // TaskListPanel.
  const [addTaskSignal, setAddTaskSignal] = useState(0);
  // Same signal pattern as addTaskSignal, for the command palette's "Quick
  // Add with AI" action — TaskListPanel forwards it to whichever sub-view
  // (List or Board) owns the AI Quick Add modal's open state locally.
  const [aiQuickAddSignal, setAiQuickAddSignal] = useState(0);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [paletteTaskId, setPaletteTaskId] = useState(null);
  // Bumped by SchedulingConflictsModal's "jump to day" click — mirrors
  // addTaskSignal/settingsSectionRequest's requestId pattern so CalendarPage
  // can react even when the request repeats the same date.
  const [calendarDayRequest, setCalendarDayRequest] = useState(null);
  // Standalone AI Quick Add modal, opened from the standalone FAB rendered on
  // tabs with no FAB group of their own (Dashboard/Projects/Stats/Settings —
  // see the fixed button below). Tasks/Board and Calendar each open the same
  // modal from their own local state instead (AddTaskFabGroup/CalendarPage),
  // since those already have a FAB group to host the entry point.
  const [showStandaloneAIQuickAdd, setShowStandaloneAIQuickAdd] = useState(false);
  // "Add note" from the command palette opens the note editor right here rather
  // than signalling the Dashboard — the Notes widget can be hidden (see
  // DashboardPage's widget toggles), and the palette shouldn't silently do
  // nothing just because it is.
  const [showStandaloneNoteEditor, setShowStandaloneNoteEditor] = useState(false);
  const { createNote: createNoteFromPalette } = useNoteMutations();
  const isMobile = useIsMobile();
  useSelectAllOnFocus();
  const { toggleTheme } = useTheme();
  const { aiConfigured, requestOpen: requestAIQuickAddOpen } = useAIQuickAddGate();
  const {
    undo,
    redo,
    canUndo,
    canRedo,
    notification,
    setNotification,
    clearNotification,
    requestSettingsSection,
    settingsSectionRequest,
    actionToasts,
    dismissActionToast,
    projects,
    addProject,
    renameProject,
    togglePinProject,
    shareProject,
    deleteProject,
    touchProjectVisited,
    sharedProjects,
    tasks,
    events,
    runRebalance,
    schedulingConflicts,
    schedulingConflictsModalOpen,
    setSchedulingConflictsModalOpen,
  } = useScheduler();

  // Shared by the sidebar, List view, and Board view — selecting a project
  // always jumps to the Tasks tab and stamps it as "recently visited" so the
  // sidebar's unpinned-project ordering (sortProjectsForSidebar) stays fresh.
  // Neither pseudo-project (All Tasks/Inbox) is a real project record, so
  // there's nothing for touchProjectVisited to stamp for either.
  function selectProject(projectId) {
    setActiveProjectId(projectId);
    if (projectId !== ALL_TASKS_PROJECT_ID && projectId !== INBOX_PROJECT_ID) touchProjectVisited(projectId);
    setTab('tasks');
  }

  // "Share project" on a project that isn't shared yet does both halves of
  // the job: makes it collaborative, then opens the share dialog on it. Those
  // used to be separate steps, which left the user looking at a success toast
  // with no link and no obvious way to get one. An already-shared project
  // skips straight to the dialog (the menu labels it "Manage sharing").
  async function handleShareProject(projectId) {
    const project = projects.find((p) => p.id === projectId);
    if (project?.sharedProjectId) {
      setSharingProjectId(projectId);
      return;
    }
    const result = await shareProject(projectId);
    if (result?.ok) setSharingProjectId(projectId);
  }

  // Share-link landing: if this page load carried a `?join=<token>`, resolve
  // it and file the project into this user's own list, then jump straight to
  // it — the point of the flow is that a visitor never has to keep the link
  // around. The token is stripped from the URL before anything else happens
  // (see useJoinFlow's header). Returns IDLE and renders nothing for the
  // overwhelmingly common case of an ordinary page load with no token.
  const joinFlow = useJoinFlow(selectProject);

  // BoardView can't render the "All Tasks" pseudo-project (no single
  // project's Sections to build columns from), so the moment it mounts (or
  // its project gets deleted out from under it) while All Tasks is active,
  // it auto-picks a real project via this callback instead of `selectProject`
  // directly (see BoardView's own resolve effect). That auto-pick is a
  // *consequence* of the user already being on Board, unlike a normal
  // project switch (sidebar/search/project dropdown) — so unlike
  // `selectProject`, this one also seeds the resolved project's remembered
  // view as 'board'. Without that seed, `taskView` (looked up per-project
  // from `taskViewByProject`) falls back to its 'list' default for a project
  // with no stored preference yet, and the very click that just opened
  // Board would silently revert to List a beat later, once this effect
  // commits.
  function resolveBoardProject(projectId) {
    setTaskViewByProject((prev) => ({ ...prev, [projectId]: 'board' }));
    selectProject(projectId);
  }

  // Auto-launch the guided tour for a brand-new visitor, once. Anyone who's
  // already seen it (or dismissed it) only gets it again via the Help icon
  // or Settings' "Replay tour" button (see openTour below).
  //
  // Suppressed when this load carries a share-link token: a first-time
  // visitor arriving via someone's link is here with a specific intent (join
  // that project), and the tour's full-page overlay (z-index 1000, well
  // above every ordinary modal) would sit on top of JoinProjectModal and
  // block it outright — found by an E2E test where "Continue to TaskFlow"
  // was unclickable underneath the tour overlay on a fresh browser profile.
  // `readJoinToken` reads the RAW query string, not useJoinFlow's state
  // (which clears the moment the token is stripped) — this only needs to
  // know whether the page loaded WITH one.
  useEffect(() => {
    if (!hasSeenTutorial && !readJoinToken()) setShowTour(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AuthContext has no UI of its own to surface sign-in failures (e.g. a
  // pop-up blocked by the browser) — bridge it into the app's existing
  // notification toast instead of leaving it as silent, unreachable state.
  useEffect(() => {
    if (!authError) return;
    setNotification({ type: 'error', message: authError });
    clearAuthError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authError]);

  // Auto-pop the "What's new" changelog once per version bump, for
  // returning visitors only — a brand-new visitor already gets the guided
  // tour above, and showing both at once would just be two modals
  // competing for attention. New visitors are silently marked as caught up
  // instead, since a changelog of updates from before their first visit
  // isn't "new" to them.
  useEffect(() => {
    if (!hasSeenTutorial) {
      setLastSeenChangelogVersion(CURRENT_VERSION);
    } else if (lastSeenChangelogVersion !== CURRENT_VERSION) {
      setShowChangelog(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeChangelog() {
    setShowChangelog(false);
    setLastSeenChangelogVersion(CURRENT_VERSION);
  }

  // Mobile has no sidebar to add/browse projects from — the topbar's "⋯"
  // menu and the Tasks page's project SelectMenu both open this same modal
  // (see ManageProjectsModal) onto its plain list+search. "Add project" is a
  // separate dedicated modal (AddProjectModal) opened directly, not a mode
  // of this one — see openAddProject below.
  function openManageProjects() {
    setShowManageProjects(true);
  }

  function openAddProject() {
    setShowAddProjectModal(true);
  }

  function handleDeleteProject(id) {
    deleteProject(id);
    if (activeProjectId === id) setActiveProjectId(ALL_TASKS_PROJECT_ID);
  }

  function openTour() {
    setShowTour(true);
    setHasSeenTutorial(true);
  }

  function closeTour() {
    setShowTour(false);
    setHasSeenTutorial(true);
  }

  // Every shortcut press gets a small confirmation toast (no Undo button —
  // that's ActionToast's job for actual undoable actions) purely so the user
  // knows the keypress registered, e.g. when nothing is visibly different
  // (undo/redo with nothing left to do, or newTask firing from a tab where
  // the resulting dialog isn't immediately visible).
  useKeyboardShortcuts(
    {
      undo: () => canUndo && undo(),
      redo: () => canRedo && redo(),
      newTask: () => {
        setTab('tasks');
        setAddTaskSignal((n) => n + 1);
      },
      commandPalette: () => setShowCommandPalette(true),
    },
    (def) => {
      const messages = {
        undo: canUndo ? 'Undid last action' : 'Nothing to undo',
        redo: canRedo ? 'Redid last action' : 'Nothing to redo',
        newTask: 'Opening new task',
      };
      // Opening the palette is instantly visible on screen, unlike the
      // others above (which may fire from a tab where the result isn't) —
      // no toast needed for it.
      if (def.id === 'commandPalette') return;
      setNotification({ type: 'info', message: messages[def.id] || `${def.label} shortcut used` });
    }
  );

  function openTaskFromPalette(taskId) {
    setPaletteTaskId(taskId);
  }

  // Scheduling conflicts are grouped/explained per-day (see
  // SchedulingConflictsModal) — clicking one should land on that day in the
  // Calendar tab rather than opening the task's edit modal.
  function goToCalendarDay(dateIso) {
    setTab('calendar');
    setCalendarDayRequest((prev) => ({ date: dateIso, requestId: prev ? prev.requestId + 1 : 1 }));
  }

  // Same day-jump mechanism as goToCalendarDay above, but also auto-opens a
  // specific event's detail modal once there (used by SearchBar's Events
  // group) — `eventId` is left undefined for the plain day-jump path above so
  // that existing caller (SchedulingConflictsModal) keeps its current
  // behavior of landing on the day without opening anything. Search only
  // ever matches/passes MASTER events (see SearchBar's doc comment), so
  // `event.id` here is always a real row id, never a virtual per-occurrence
  // one — CalendarPage's selectedEvent derivation already handles that case.
  function goToCalendarEvent(event) {
    setTab('calendar');
    setCalendarDayRequest((prev) => ({ date: event.date, requestId: prev ? prev.requestId + 1 : 1, eventId: event.id }));
  }

  const paletteTask = paletteTaskId ? tasks.find((t) => t.id === paletteTaskId) : null;

  const paletteActions = [
    { id: 'addTask', label: 'Add task', run: () => { setTab('tasks'); setAddTaskSignal((n) => n + 1); } },
    // Gated the same way AddTaskFabGroup's own mini-FAB is (isAIQuickAddConfigured
    // — no worker URL set = feature hidden entirely), rather than always listing it
    // and letting the modal itself reject; both TaskListPanel's List and Board
    // sub-views react to this signal, so it works from either one.
    ...(aiConfigured
      ? [
          {
            id: 'aiQuickAdd',
            label: 'Quick Add with AI',
            icon: Sparkles,
            run: () => {
              // Mirrors AddTaskFabGroup's handleAIQuickAdd key check — the palette
              // entry point must not open the modal when no provider key is saved.
              requestAIQuickAddOpen(() => {
                setTab('tasks');
                setAiQuickAddSignal((n) => n + 1);
              });
            },
          },
        ]
      : []),
    { id: 'addNote', label: 'Add note', icon: StickyNote, run: () => setShowStandaloneNoteEditor(true) },
    { id: 'rebalance', label: 'Re-balance schedule', run: runRebalance },
    { id: 'toggleTheme', label: 'Toggle light/dark theme', run: toggleTheme },
    { id: 'manageProjects', label: 'Manage projects', run: () => openManageProjects() },
  ];

  // Lets components outside SettingsPanel (e.g. an error toast/modal) jump
  // straight to a Settings section via requestSettingsSection — mirrors
  // addTaskSignal above. SettingsPanel itself watches the same prop to scroll.
  useEffect(() => {
    if (settingsSectionRequest?.requestId) setTab('settings');
  }, [settingsSectionRequest?.requestId]);

  return (
    <div className={`app-shell ${isMobile ? 'is-mobile' : ''} ${isMobile && tab !== 'dashboard' ? 'no-topbar' : ''}`}>
      {!isMobile && (
        <Sidebar
          tabs={TABS}
          activeTab={tab}
          onSelectTab={setTab}
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={selectProject}
          onRenameProject={renameProject}
          onTogglePinProject={togglePinProject}
          onShareProject={handleShareProject}
          onDeleteProject={handleDeleteProject}
          footer={
            <>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '0 10px' }}>
                Dynamic task auto-scheduler
              </div>
              <AccountButton menuAlign="up" onOpenAccountSettings={() => setTab('settings')} />
            </>
          }
        />
      )}

      {isMobile && tab === 'dashboard' && (
        <header className="topbar">
          <div className="brand" data-tour="brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="brand-mark" />
            <span className="brand-name">TaskFlow</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <AccountButton compact menuAlign="down" onOpenAccountSettings={() => setTab('settings')} />
          </div>
        </header>
      )}

      <main className="main-content">
        <div
          key={tab}
          className={`tab-panel ${tab === 'calendar' || (tab === 'tasks' && taskView === 'board') ? 'tab-panel-fill' : ''}`}
        >
          {tab === 'dashboard' && <DashboardPage onSelectProject={selectProject} onOpenCalendar={() => setTab('calendar')} />}
          {tab === 'calendar' && (
            <CalendarPage
              dayJumpRequest={calendarDayRequest}
              onOpenSearch={isMobile ? () => setShowCommandPalette(true) : undefined}
              onShareProject={handleShareProject}
              onProjectCreated={selectProject}
            />
          )}
          {tab === 'tasks' && (
            <TaskListPanel
              view={taskView}
              onChangeView={setTaskView}
              activeProjectId={activeProjectId}
              onChangeActiveProject={selectProject}
              onResolveBoardProject={resolveBoardProject}
              onOpenManageProjects={openManageProjects}
              openAddTaskSignal={addTaskSignal}
              openAIQuickAddSignal={aiQuickAddSignal}
              onOpenSettings={() => setTab('settings')}
              onOpenSearch={isMobile ? () => setShowCommandPalette(true) : undefined}
              onShareProject={handleShareProject}
              onProjectCreated={selectProject}
              onSelectEvent={goToCalendarEvent}
            />
          )}
          {tab === 'projects' && (
            <ProjectsPage
              projects={projects}
              tasks={tasks}
              sharedProjects={sharedProjects}
              uid={user?.uid}
              onSelectProject={selectProject}
              onOpenManageProjects={openManageProjects}
              onAddProject={openAddProject}
            />
          )}
          {tab === 'stats' && <StatsDashboard />}
          {tab === 'settings' && <SettingsPanel onOpenTour={openTour} settingsSectionRequest={settingsSectionRequest} />}
        </div>
      </main>

      {isMobile && (tab === 'dashboard' || tab === 'stats' || tab === 'settings' || (tab === 'tasks' && taskView === 'gantt')) && (
        // Mobile has no keyboard for Ctrl+K, so this is its only entry point
        // to the command palette — shown on every tab so it's reachable
        // one-thumb from anywhere. On tabs with their own FAB group (Tasks
        // list/Board, Calendar) it renders as the top-most member of that
        // group instead (see AddTaskFabGroup/CalendarPage's onOpenSearch) so
        // it naturally stacks above — and shifts with — that group's own
        // mini-FABs on expand/collapse; here, with no such group present, it
        // just floats standalone in the same bottom-right corner.
        <button
          className="btn btn-primary fab-round mobile-search-fab mobile-search-fab-standalone"
          onClick={() => setShowCommandPalette(true)}
          aria-label="Open command palette"
          title="Search / commands"
        >
          <Search size={22} />
        </button>
      )}

      {/* Standalone AI Quick Add entry point for the three tabs with no FAB
          group of their own (Dashboard/Stats/Settings — Tasks list/Board and
          Calendar already have one via AddTaskFabGroup/CalendarPage's own AI
          mini-FAB, and Projects now has its own AddTaskFabGroup instance too
          — see ProjectsPage.jsx — since "Add project" is a real main action
          there, unlike these three). Shown on desktop AND mobile (unlike
          mobile-search-fab-standalone above, which is mobile-only) since the
          whole point of this change is making AI Quick Add reachable from
          every screen, not just ones that already had a FAB. Reuses
          .add-task-btn's shell/size for visual consistency with the other
          FABs rather than inventing new styling. */}
      {aiConfigured && (tab === 'dashboard' || tab === 'stats' || tab === 'settings') && (
        <button
          className="btn btn-primary add-task-btn ai-quickadd-standalone-fab"
          onClick={() => requestAIQuickAddOpen(() => setShowStandaloneAIQuickAdd(true))}
          aria-label="AI Quick Add"
          title="AI Quick Add"
        >
          <Sparkles size={14} />
          <span className="add-task-btn-label">AI Quick Add</span>
        </button>
      )}

      {isMobile && <BottomTabBar tabs={TABS} activeTab={tab} onSelectTab={setTab} />}

      <div className="floating-notifications">
        <Toast notification={notification} onDismiss={clearNotification} />
        {actionToasts.map((toast) => (
          <ActionToast
            key={toast.id}
            toast={toast}
            onUndo={() => (toast.undo ? toast.undo() : undo())}
            onDismiss={() => dismissActionToast(toast.id)}
          />
        ))}
        <InstallAppBanner />
      </div>
      {/* Its own independently-positioned, draggable floating window —
          deliberately NOT inside .floating-notifications, so it isn't
          shuffled around by toasts appearing/disappearing (see
          TimerWidget.jsx / useDraggableWindowPosition.js). */}
      <TimerWidget />
      {showManageProjects && (
        <ManageProjectsModal
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={selectProject}
          onAddProject={openAddProject}
          onRenameProject={renameProject}
          onTogglePinProject={togglePinProject}
          onShareProject={handleShareProject}
          onDeleteProject={handleDeleteProject}
          onClose={() => setShowManageProjects(false)}
        />
      )}
      {showAddProjectModal && <AddProjectModal onAddProject={addProject} onClose={() => setShowAddProjectModal(false)} />}
      {showTour && (
        <GuidedTour currentTab={tab} tabs={TABS} onTabChange={setTab} onViewChange={setTaskView} onFinish={closeTour} />
      )}
      {showChangelog && <ChangelogModal onClose={closeChangelog} />}
      {sharingProjectId && projects.some((p) => p.id === sharingProjectId) && (
        <ShareProjectModal
          project={projects.find((p) => p.id === sharingProjectId)}
          onClose={() => setSharingProjectId(null)}
        />
      )}
      {/* Renders nothing unless this page load came from a share link — see
          useJoinFlow, which owns the whole lifecycle and reports IDLE
          otherwise. */}
      <JoinProjectModal
        status={joinFlow.status}
        projectName={joinFlow.projectName}
        error={joinFlow.error}
        onSubmitName={joinFlow.submitName}
        onDismiss={joinFlow.dismiss}
      />
      {showCommandPalette && (
        <CommandPalette
          tabs={TABS}
          activeTab={tab}
          onSelectTab={setTab}
          projects={projects}
          onSelectProject={selectProject}
          tasks={tasks}
          onOpenTask={openTaskFromPalette}
          events={events}
          onOpenEvent={goToCalendarEvent}
          actions={paletteActions}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {paletteTask && <TaskDetailModal task={paletteTask} onClose={() => setPaletteTaskId(null)} />}
      {showStandaloneNoteEditor && (
        <NoteEditorModal
          onCreate={(title, body) => createNoteFromPalette(title, body)}
          onClose={() => setShowStandaloneNoteEditor(false)}
        />
      )}
      {showStandaloneAIQuickAdd && (
        <AIQuickAddModal onClose={() => setShowStandaloneAIQuickAdd(false)} onProjectCreated={selectProject} />
      )}
      {schedulingConflictsModalOpen && (
        <SchedulingConflictsModal
          conflicts={schedulingConflicts}
          tasks={tasks}
          onOpenDay={goToCalendarDay}
          onClose={() => setSchedulingConflictsModalOpen(false)}
        />
      )}
      <CompleteTaskConfirmModal />
      <ConfirmModal />
      <CalendarRewriteOverlay />
    </div>
  );
}

export default function App() {
  return (
    <ConfirmProvider>
      <AuthProvider>
        <ThemeProvider>
          <SchedulerProvider>
            <SoundProvider>
              <TimerProvider>
                <CompleteTaskProvider>
                  <AppShell />
                </CompleteTaskProvider>
              </TimerProvider>
            </SoundProvider>
          </SchedulerProvider>
        </ThemeProvider>
      </AuthProvider>
    </ConfirmProvider>
  );
}

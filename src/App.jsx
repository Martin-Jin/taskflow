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
import { ThemeProvider } from './context/ThemeContext';
import { SoundProvider } from './context/SoundContext';
import { AuthProvider } from './context/AuthContext';
import { TimerProvider } from './context/TimerContext';
import { CompleteTaskProvider } from './context/CompleteTaskContext';
import TimerWidget from './components/Common/TimerWidget';
import CompleteTaskConfirmModal from './components/Common/CompleteTaskConfirmModal';
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
import ChangelogModal from './components/Modals/ChangelogModal';
import { useIsMobile } from './hooks/useIsMobile';
import { usePersistedState } from './hooks/usePersistedState';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import GuidedTour from './components/Tutorial/GuidedTour';
import DashboardPage from './components/Dashboard/DashboardPage';
import { ALL_TASKS_PROJECT_ID } from './utils/projectConstants';
import { CURRENT_VERSION } from './changelog';
import {
  LayoutDashboard,
  CalendarDays,
  CheckSquare,
  TrendingUp,
  Settings,
} from 'lucide-react';

// Board and Gantt used to be their own top-level tabs; they're now views
// within the Tasks page (see TaskListPanel's List/Board/Gantt switch), so
// five tabs is the full set — small enough that BottomTabBar shows all of
// them directly with no "More" overflow needed.
const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'stats', label: 'Stats', icon: TrendingUp },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function AppShell() {
  const [tab, setTab] = useState('dashboard');
  const [activeProjectId, setActiveProjectId] = usePersistedState('activeProjectId', ALL_TASKS_PROJECT_ID);
  // Tasks page's own sub-view ('list' | 'board' | 'gantt'), remembered PER
  // PROJECT (keyed by projectId, including the ALL_TASKS_PROJECT_ID pseudo
  // project) rather than as one global choice — switching from Board on
  // Project A to Project B shouldn't drag Board along with it if B was last
  // viewed as List.
  const [taskViewByProject, setTaskViewByProject] = usePersistedState('taskViewByProject', {});
  // Board can't render the All Tasks pseudo-project (see resolveBoardProject
  // below) — if that key was ever persisted as 'board' (e.g. from a session
  // before the Board option was hidden here), clamp it back to 'list' rather
  // than letting BoardView mount, bounce off its invalid-project check, and
  // instantly redirect the user to whatever real project happens to be
  // first — which reads as "All Tasks" being broken.
  const rawTaskView = taskViewByProject[activeProjectId] || 'list';
  const taskView = activeProjectId === ALL_TASKS_PROJECT_ID && rawTaskView === 'board' ? 'list' : rawTaskView;
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
  const [showChangelog, setShowChangelog] = useState(false);
  const [lastSeenChangelogVersion, setLastSeenChangelogVersion] = usePersistedState('lastSeenChangelogVersion', null);
  const [manageProjectsAutoAdd, setManageProjectsAutoAdd] = useState(false);
  // Bumped by the "new task" shortcut below to signal TaskListPanel (which
  // owns "Add task" modal state locally) to open it, even when the shortcut
  // is pressed from a different tab — see the effect on this prop in
  // TaskListPanel.
  const [addTaskSignal, setAddTaskSignal] = useState(0);
  const isMobile = useIsMobile();
  const {
    undo,
    redo,
    canUndo,
    canRedo,
    notification,
    setNotification,
    clearNotification,
    actionToast,
    dismissActionToast,
    projects,
    addProject,
    renameProject,
    togglePinProject,
    deleteProject,
    touchProjectVisited,
  } = useScheduler();

  // Shared by the sidebar, List view, and Board view — selecting a project
  // always jumps to the Tasks tab and stamps it as "recently visited" so the
  // sidebar's unpinned-project ordering (sortProjectsForSidebar) stays fresh.
  function selectProject(projectId) {
    setActiveProjectId(projectId);
    if (projectId !== ALL_TASKS_PROJECT_ID) touchProjectVisited(projectId);
    setTab('tasks');
  }

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
  useEffect(() => {
    if (!hasSeenTutorial) setShowTour(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // (see ManageProjectsModal), autoAdd just decides whether it lands on the
  // add-project form or the plain list+search.
  function openManageProjects(autoAdd = false) {
    setManageProjectsAutoAdd(autoAdd);
    setShowManageProjects(true);
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
    },
    (def) => {
      const messages = {
        undo: canUndo ? 'Undid last action' : 'Nothing to undo',
        redo: canRedo ? 'Redid last action' : 'Nothing to redo',
        newTask: 'Opening new task',
      };
      setNotification({ type: 'info', message: messages[def.id] || `${def.label} shortcut used` });
    }
  );

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
          onOpenManageProjects={openManageProjects}
          onRenameProject={renameProject}
          onTogglePinProject={togglePinProject}
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
          <AccountButton compact menuAlign="down" onOpenAccountSettings={() => setTab('settings')} />
        </header>
      )}

      <main className="main-content">
        <div
          key={tab}
          className={`tab-panel ${tab === 'calendar' || (tab === 'tasks' && taskView === 'board') ? 'tab-panel-fill' : ''}`}
        >
          {tab === 'dashboard' && <DashboardPage onSelectProject={selectProject} onOpenCalendar={() => setTab('calendar')} />}
          {tab === 'calendar' && <CalendarPage />}
          {tab === 'tasks' && (
            <TaskListPanel
              view={taskView}
              onChangeView={setTaskView}
              activeProjectId={activeProjectId}
              onChangeActiveProject={selectProject}
              onResolveBoardProject={resolveBoardProject}
              onOpenManageProjects={openManageProjects}
              openAddTaskSignal={addTaskSignal}
              onOpenSettings={() => setTab('settings')}
            />
          )}
          {tab === 'stats' && <StatsDashboard />}
          {tab === 'settings' && <SettingsPanel onOpenTour={openTour} />}
        </div>
      </main>

      {isMobile && <BottomTabBar tabs={TABS} activeTab={tab} onSelectTab={setTab} />}

      <div className="floating-notifications">
        <Toast notification={notification} onDismiss={clearNotification} />
        <ActionToast toast={actionToast} onUndo={() => (actionToast?.undo ? actionToast.undo() : undo())} onDismiss={dismissActionToast} />
        <InstallAppBanner />
        <TimerWidget />
      </div>
      {showManageProjects && (
        <ManageProjectsModal
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={selectProject}
          onAddProject={addProject}
          onRenameProject={renameProject}
          onTogglePinProject={togglePinProject}
          onDeleteProject={handleDeleteProject}
          autoShowAdd={manageProjectsAutoAdd}
          onClose={() => setShowManageProjects(false)}
        />
      )}
      {showTour && (
        <GuidedTour currentTab={tab} tabs={TABS} onTabChange={setTab} onViewChange={setTaskView} onFinish={closeTour} />
      )}
      {showChangelog && <ChangelogModal onClose={closeChangelog} />}
      <CompleteTaskConfirmModal />
    </div>
  );
}

export default function App() {
  return (
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
  );
}

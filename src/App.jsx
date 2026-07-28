/**
 * ============================================================================
 * App
 * ============================================================================
 * Top-level shell: sidebar navigation (Calendar / Tasks / Stats / Settings),
 * a topbar with global Undo/Redo controls and loading/sync status, and the
 * routed main content area. No external router is used (a simple useState
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
import { AuthProvider } from './context/AuthContext';
import AccountButton from './components/Nav/AccountButton';
import Sidebar from './components/Nav/Sidebar';
import CalendarPage from './components/Calendar/CalendarPage';
import TaskListPanel from './components/TaskListPanel';
import StatsDashboard from './components/Stats/StatsDashboard';
import SettingsPanel from './components/SettingsPanel';
import Toast from './components/Common/Toast';
import BottomTabBar from './components/Nav/BottomTabBar';
import ManageProjectsModal from './components/Modals/ManageProjectsModal';
import { useIsMobile } from './hooks/useIsMobile';
import { usePersistedState } from './hooks/usePersistedState';
import GuidedTour from './components/Tutorial/GuidedTour';
import DashboardPage from './components/Dashboard/DashboardPage';
import { ALL_TASKS_PROJECT_ID } from './utils/projectConstants';
import {
  LayoutDashboard,
  CalendarDays,
  CheckSquare,
  TrendingUp,
  Settings,
  Undo2,
  Redo2,
  HelpCircle,
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
  const taskView = taskViewByProject[activeProjectId] || 'list';
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
  const [manageProjectsAutoAdd, setManageProjectsAutoAdd] = useState(false);
  const isMobile = useIsMobile();
  const {
    undo,
    redo,
    canUndo,
    canRedo,
    currentActionLabel,
    isLoading,
    notification,
    clearNotification,
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

  // Auto-launch the guided tour for a brand-new visitor, once. Anyone who's
  // already seen it (or dismissed it) only gets it again via the Help icon
  // or Settings' "Replay tour" button (see openTour below).
  useEffect(() => {
    if (!hasSeenTutorial) setShowTour(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className={`app-shell ${isMobile ? 'is-mobile' : ''}`}>
      {!isMobile && (
        <Sidebar
          tabs={TABS}
          activeTab={tab}
          onSelectTab={setTab}
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={selectProject}
          onAddProject={addProject}
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

      <header className="topbar">
        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          {isLoading ? 'Loading…' : currentActionLabel}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-icon help-icon-btn" onClick={openTour} title="Help / guided tour">
            <HelpCircle size={15} />
            {!hasSeenTutorial && <span className="help-icon-unread-dot" />}
          </button>
          <button className="btn btn-icon" onClick={undo} disabled={!canUndo} title="Undo">
            <Undo2 size={15} />
            {!isMobile && 'Undo'}
          </button>
          <button className="btn btn-icon" onClick={redo} disabled={!canRedo} title="Redo">
            <Redo2 size={15} />
            {!isMobile && 'Redo'}
          </button>
          {isMobile && <AccountButton compact menuAlign="down" onOpenAccountSettings={() => setTab('settings')} />}
        </div>
      </header>

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
              onOpenManageProjects={openManageProjects}
              showManageProjectsButton={!isMobile}
            />
          )}
          {tab === 'stats' && <StatsDashboard />}
          {tab === 'settings' && <SettingsPanel onOpenTour={openTour} />}
        </div>
      </main>

      {isMobile && <BottomTabBar tabs={TABS} activeTab={tab} onSelectTab={setTab} />}

      <Toast notification={notification} onDismiss={clearNotification} />
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
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <SchedulerProvider>
          <AppShell />
        </SchedulerProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

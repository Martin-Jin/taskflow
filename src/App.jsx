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

import React, { useEffect, useState } from 'react';
import { SchedulerProvider, useScheduler } from './context/SchedulerContext';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import AccountButton from './components/Nav/AccountButton';
import CalendarPage from './components/Calendar/CalendarPage';
import TaskListPanel from './components/TaskListPanel';
import StatsDashboard from './components/Stats/StatsDashboard';
import SettingsPanel from './components/SettingsPanel';
import Toast from './components/Common/Toast';
import BottomTabBar from './components/Nav/BottomTabBar';
import { useIsMobile } from './hooks/useIsMobile';
import { usePersistedState } from './hooks/usePersistedState';
import GuidedTour from './components/Tutorial/GuidedTour';
import { CalendarDays, CheckSquare, TrendingUp, Settings, Undo2, Redo2, HelpCircle } from 'lucide-react';

// Board and Gantt used to be their own top-level tabs; they're now views
// within the Tasks page (see TaskListPanel's List/Board/Gantt switch), so
// four tabs is the full set — small enough that BottomTabBar shows all of
// them directly with no "More" overflow needed.
const TABS = [
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'stats', label: 'Stats', icon: TrendingUp },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function AppShell() {
  const [tab, setTab] = useState('calendar');
  const [taskView, setTaskView] = useState('list'); // 'list' | 'board' | 'gantt' — the Tasks page's own sub-view
  const [showTour, setShowTour] = useState(false);
  const [hasSeenTutorial, setHasSeenTutorial] = usePersistedState('tutorial-seen', false);
  const isMobile = useIsMobile();
  const { undo, redo, canUndo, canRedo, currentActionLabel, isLoading, notification, clearNotification } = useScheduler();

  // Auto-launch the guided tour for a brand-new visitor, once. Anyone who's
  // already seen it (or dismissed it) only gets it again via the Help icon
  // or Settings' "Replay tour" button (see openTour below).
  useEffect(() => {
    if (!hasSeenTutorial) setShowTour(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <aside className="sidebar">
          <div className="brand" data-tour="brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="brand-mark" />
            TaskFlow
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Workspace</div>
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`nav-item ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
                data-tour={`nav-${t.id}`}
              >
                <t.icon size={16} strokeWidth={2} />
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '0 10px' }}>
              Dynamic task auto-scheduler
            </div>
            <AccountButton menuAlign="up" onOpenAccountSettings={() => setTab('settings')} />
          </div>
        </aside>
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
        <div key={tab} className={`tab-panel ${tab === 'calendar' ? 'tab-panel-fill' : ''}`}>
          {tab === 'calendar' && <CalendarPage />}
          {tab === 'tasks' && <TaskListPanel view={taskView} onChangeView={setTaskView} />}
          {tab === 'stats' && <StatsDashboard />}
          {tab === 'settings' && <SettingsPanel onOpenTour={openTour} />}
        </div>
      </main>

      {isMobile && <BottomTabBar tabs={TABS} activeTab={tab} onSelectTab={setTab} />}

      <Toast notification={notification} onDismiss={clearNotification} />
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

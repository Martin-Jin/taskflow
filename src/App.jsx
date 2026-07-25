/**
 * ============================================================================
 * App
 * ============================================================================
 * Top-level shell: sidebar navigation (Calendar / Tasks / Gantt / Stats /
 * Settings), a topbar with global Undo/Redo controls and loading/sync
 * status, and the routed main content area. No external router is used
 * (a simple useState tab switch) since this is a single-page dashboard
 * with no deep-linkable sub-routes required by the spec.
 * ============================================================================
 */

import React, { useEffect, useState } from 'react';
import { SchedulerProvider, useScheduler } from './context/SchedulerContext';
import CalendarPage from './components/Calendar/CalendarPage';
import TaskListPanel from './components/TaskListPanel';
import BoardView from './components/Board/BoardView';
import GanttChart from './components/Gantt/GanttChart';
import StatsDashboard from './components/Stats/StatsDashboard';
import SettingsPanel from './components/SettingsPanel';
import Toast from './components/Common/Toast';
import BottomTabBar from './components/Nav/BottomTabBar';
import MoreSheet from './components/Nav/MoreSheet';
import { useIsMobile } from './hooks/useIsMobile';
import { usePersistedState } from './hooks/usePersistedState';
import GuidedTour from './components/Tutorial/GuidedTour';
import { CalendarDays, CheckSquare, LayoutGrid, BarChart3, TrendingUp, Settings, Undo2, Redo2, HelpCircle } from 'lucide-react';

const TABS = [
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'gantt', label: 'Gantt', icon: BarChart3 },
  { id: 'stats', label: 'Stats', icon: TrendingUp },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function AppShell() {
  const [tab, setTab] = useState('calendar');
  const [moreOpen, setMoreOpen] = useState(false);
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
            <span className="brand-mark" />
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
          <div style={{ marginTop: 'auto', fontSize: 11, color: 'var(--text-tertiary)', padding: '0 10px' }}>
            Dynamic task auto-scheduler
          </div>
        </aside>
      )}

      <header className="topbar">
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {isLoading ? 'Loading…' : currentActionLabel}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
        </div>
      </header>

      <main className="main-content">
        <div key={tab} className={`tab-panel ${tab === 'calendar' ? 'tab-panel-fill' : ''}`}>
          {tab === 'calendar' && <CalendarPage />}
          {tab === 'tasks' && <TaskListPanel />}
          {tab === 'board' && <BoardView />}
          {tab === 'gantt' && <GanttChart />}
          {tab === 'stats' && <StatsDashboard />}
          {tab === 'settings' && <SettingsPanel onOpenTour={openTour} />}
        </div>
      </main>

      {isMobile && (
        <BottomTabBar tabs={TABS} activeTab={tab} onSelectTab={setTab} onOpenMore={() => setMoreOpen(true)} />
      )}
      {isMobile && moreOpen && (
        <MoreSheet tabs={TABS} activeTab={tab} onSelectTab={setTab} onClose={() => setMoreOpen(false)} />
      )}

      <Toast notification={notification} onDismiss={clearNotification} />
      {showTour && <GuidedTour currentTab={tab} tabs={TABS} onTabChange={setTab} onFinish={closeTour} />}
    </div>
  );
}

export default function App() {
  return (
    <SchedulerProvider>
      <AppShell />
    </SchedulerProvider>
  );
}

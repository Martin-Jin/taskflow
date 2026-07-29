import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { usePersistedState } from '../../hooks/usePersistedState';
import NowNextCard from './NowNextCard';
import TodayAgenda from './TodayAgenda';
import DashboardStats from './DashboardStats';
import PinnedLinks from './PinnedLinks';
import WeeklyProgressRing from './WeeklyProgressRing';
import TodayProgressRing from './TodayProgressRing';
import DashboardCustomizeMenu from './DashboardCustomizeMenu';
import { DEFAULT_DASHBOARD_WIDGETS } from './dashboardWidgets';

function greetingForHour(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage({ onSelectProject, onOpenCalendar }) {
  const { user } = useAuth();
  const [greeting, setGreeting] = useState(() => greetingForHour(new Date().getHours()));

  // Recompute once an hour so a long-open tab doesn't keep saying "Good
  // morning" into the afternoon; no need for the 30s cadence used elsewhere.
  useEffect(() => {
    const id = setInterval(() => setGreeting(greetingForHour(new Date().getHours())), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const firstName = user?.displayName?.split(' ')[0];

  const [widgets, setWidgets] = usePersistedState('dashboardWidgets', DEFAULT_DASHBOARD_WIDGETS);
  function toggleWidget(key) {
    setWidgets((prev) => ({ ...prev, [key]: prev[key] === false }));
  }
  const showMain = widgets.nowNext !== false || widgets.todayAgenda !== false;
  const showSide = widgets.pinnedLinks !== false || widgets.progressRings !== false;

  return (
    <div className="dashboard-page">
      <div className="dashboard-greeting">
        <div>
          <h1>
            {greeting}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p>Here's what's on your plate.</p>
        </div>
        <DashboardCustomizeMenu widgets={widgets} onToggleWidget={toggleWidget} />
      </div>

      {widgets.stats !== false && <DashboardStats onSelectProject={onSelectProject} onOpenCalendar={onOpenCalendar} />}

      {(showMain || showSide) && (
        <div className={`dashboard-grid ${showMain && showSide ? '' : 'dashboard-grid-single'}`}>
          {showMain && (
            <div className="dashboard-grid-main">
              {widgets.nowNext !== false && <NowNextCard />}
              {widgets.todayAgenda !== false && <TodayAgenda />}
            </div>
          )}
          {showSide && (
            <div className="dashboard-grid-side">
              {widgets.pinnedLinks !== false && <PinnedLinks />}
              {widgets.progressRings !== false && (
                <div className="progress-ring-row">
                  <TodayProgressRing />
                  <WeeklyProgressRing />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

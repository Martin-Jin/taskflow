import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { usePersistedState } from '../../hooks/usePersistedState';
import NowNextCard from './NowNextCard';
import TodayAgenda from './TodayAgenda';
import DashboardStats from './DashboardStats';
import WeeklyReviewCard from './WeeklyReviewCard';
import NotesCard from './NotesCard';
import ProgressRings from './ProgressRings';
import DashboardCustomizeMenu from './DashboardCustomizeMenu';
import { DEFAULT_DASHBOARD_WIDGETS } from './dashboardWidgets';

function greetingForHour(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage({ onSelectProject, onOpenCalendar, weeklyReview, onOpenWeeklyReview }) {
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
  const showSide = widgets.notes !== false || widgets.progressRings !== false;

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

      {/* Above the stats strip: it's a prompt to act, and it's only here at
          all when a review is actually due (App.jsx passes null otherwise). */}
      {widgets.weeklyReview !== false && weeklyReview && (
        <WeeklyReviewCard review={weeklyReview} onOpen={onOpenWeeklyReview} />
      )}

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
              {widgets.notes !== false && <NotesCard />}
              {widgets.progressRings !== false && <ProgressRings />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

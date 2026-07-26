import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import NowNextCard from './NowNextCard';
import TodayAgenda from './TodayAgenda';
import DashboardStats from './DashboardStats';
import PinnedLinks from './PinnedLinks';
import WeeklyProgressRing from './WeeklyProgressRing';
import TodayProgressRing from './TodayProgressRing';

function greetingForHour(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage({ onSelectProject }) {
  const { user } = useAuth();
  const [greeting, setGreeting] = useState(() => greetingForHour(new Date().getHours()));

  // Recompute once an hour so a long-open tab doesn't keep saying "Good
  // morning" into the afternoon; no need for the 30s cadence used elsewhere.
  useEffect(() => {
    const id = setInterval(() => setGreeting(greetingForHour(new Date().getHours())), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const firstName = user?.displayName?.split(' ')[0];

  return (
    <div className="dashboard-page">
      <div className="dashboard-greeting">
        <h1>
          {greeting}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p>Here's what's on your plate.</p>
      </div>

      <DashboardStats onSelectProject={onSelectProject} />

      <div className="dashboard-grid">
        <div className="dashboard-grid-main">
          <NowNextCard />
          <TodayAgenda />
        </div>
        <div className="dashboard-grid-side">
          <PinnedLinks />
          <div className="progress-ring-row">
            <TodayProgressRing />
            <WeeklyProgressRing />
          </div>
        </div>
      </div>
    </div>
  );
}

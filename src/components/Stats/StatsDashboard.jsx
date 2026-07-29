/**
 * StatsDashboard — live-computed metrics: total hours left, scheduled today,
 * scheduled this week, free capacity this week, PLUS two charts:
 *   - Hours planned per day, across the current planning horizon.
 *   - Hours spent by project (categorized via each task's project, joined
 *     from the `projects` list in context — task.projectName isn't reliably
 *     populated, so we resolve the name from projectId here instead).
 * Pure derivation from context state, memoized for cheap re-renders on
 * every drag/edit.
 */

import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { computeHorizonCapacity } from '../../algorithms/capacityEngine';
import { addDays, dayOfWeek, toISODate, dateRange, formatDisplayDate } from '../../utils/dateUtils';
import BarChart from './BarChart';
import PieChart from './PieChart';

const CHART_HORIZON_DAYS = 14;

// A small, fixed palette so a given project's color stays stable across
// re-renders regardless of Map/Set iteration order.
const PALETTE = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
];

function StatCard({ label, value, sublabel, accent }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, marginTop: 4, color: accent || 'var(--color-text-primary)' }}>
        {value}
      </div>
      {sublabel && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{sublabel}</div>}
    </div>
  );
}

export default function StatsDashboard() {
  const { tasks, blocks, routines, events, rules, projects } = useScheduler();
  const today = toISODate(new Date());

  const stats = useMemo(() => {
    const activeTasks = tasks.filter((t) => !t.isCompleted);
    const totalHoursLeft = activeTasks.reduce((sum, t) => sum + t.remainingHours, 0);

    // Only set on tasks completed via a tracked Pomodoro timer (see
    // CompleteTaskContext) — most completed tasks have no `actualHours` at
    // all, so this only sums the ones that do rather than assuming 0.
    const totalActualHours = tasks.reduce((sum, t) => sum + (typeof t.actualHours === 'number' ? t.actualHours : 0), 0);

    const weekStart = addDays(today, -dayOfWeek(today));
    const weekEnd = addDays(weekStart, 6);

    const scheduledToday = blocks.filter((b) => b.date === today).reduce((sum, b) => sum + b.durationHours, 0);
    const scheduledThisWeek = blocks
      .filter((b) => b.date >= weekStart && b.date <= weekEnd)
      .reduce((sum, b) => sum + b.durationHours, 0);

    const capacityMap = computeHorizonCapacity(weekStart, 7, { routines, events, blocks, rules });
    const totalWeekCapacity = [...capacityMap.values()].reduce((sum, c) => sum + c.totalAvailableHours, 0);
    const freeCapacityThisWeek = Math.max(0, totalWeekCapacity - scheduledThisWeek);

    const overdueRiskTasks = activeTasks.filter((t) => {
      if (!t.dueDate) return false;
      const effectiveDeadline = addDays(t.dueDate, -rules.bufferDays);
      return effectiveDeadline < today && t.remainingHours > 0;
    });

    return { totalHoursLeft, totalActualHours, scheduledToday, scheduledThisWeek, freeCapacityThisWeek, overdueRiskTasks };
  }, [tasks, blocks, routines, events, rules, today]);

  // ---- Hours planned per day (bar chart) -----------------------------------
  const dailyHoursData = useMemo(() => {
    const days = dateRange(today, CHART_HORIZON_DAYS);
    const hoursByDate = new Map();
    for (const b of blocks) {
      hoursByDate.set(b.date, (hoursByDate.get(b.date) || 0) + b.durationHours);
    }
    return days.map((d) => ({
      label: formatDisplayDate(d).replace(/^[A-Za-z]+,\s/, ''), // "Jul 27" instead of "Mon, Jul 27" to keep bars narrow
      value: hoursByDate.get(d) || 0,
      isToday: d === today,
    }));
  }, [blocks, today]);

  // ---- Hours by project (pie chart) ----------------------------------------
  const projectHoursData = useMemo(() => {
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const hoursByProjectName = new Map();

    for (const b of blocks) {
      const task = taskById.get(b.taskId);
      if (!task) continue;
      const name = task.projectId ? projectNameById.get(task.projectId) || 'Unnamed project' : 'No project';
      hoursByProjectName.set(name, (hoursByProjectName.get(name) || 0) + b.durationHours);
    }

    return [...hoursByProjectName.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length] }));
  }, [blocks, tasks, projects]);

  return (
    <div>
      <div className="stats-cards-row">
        <StatCard label="Total hours left" value={stats.totalHoursLeft.toFixed(1)} sublabel="across all active tasks" />
        <StatCard label="Scheduled today" value={stats.scheduledToday.toFixed(1) + 'h'} />
        <StatCard label="Scheduled this week" value={stats.scheduledThisWeek.toFixed(1) + 'h'} />
        <StatCard
          label="Free capacity (week)"
          value={stats.freeCapacityThisWeek.toFixed(1) + 'h'}
          accent={stats.freeCapacityThisWeek < 2 ? 'var(--color-warning)' : 'var(--color-success)'}
        />
        {stats.totalActualHours > 0 && (
          <StatCard label="Time logged" value={stats.totalActualHours.toFixed(1) + 'h'} sublabel="tracked via timer, on completed tasks" />
        )}
      </div>

      {stats.overdueRiskTasks.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--color-danger)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} />
            {stats.overdueRiskTasks.length} task(s) at risk of missing their buffer deadline
          </strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {stats.overdueRiskTasks.map((t) => (
              <li key={t.id}>
                {t.title} — {t.remainingHours.toFixed(1)}h left, due {t.dueDate}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stats-charts-row">
        <div className="card stats-chart-card" style={{ flex: '2 1 420px' }}>
          <h3 style={{ marginTop: 0, marginBottom: 2, fontFamily: 'var(--font-display)', fontSize: 15 }}>Hours planned per day</h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 14 }}>
            Next {CHART_HORIZON_DAYS} days, from scheduled blocks.
          </p>
          <div className="stats-bar-scroll">
            <BarChart data={dailyHoursData} emptyMessage="No blocks scheduled in this window yet." />
          </div>
        </div>

        <div className="card stats-chart-card" style={{ flex: '1 1 320px' }}>
          <h3 style={{ marginTop: 0, marginBottom: 2, fontFamily: 'var(--font-display)', fontSize: 15 }}>Time by project</h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 14 }}>
            Scheduled hours, grouped by project.
          </p>
          <PieChart data={projectHoursData} emptyMessage="No scheduled blocks to categorize yet." />
        </div>
      </div>
    </div>
  );
}
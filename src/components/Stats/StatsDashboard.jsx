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
import { computeEstimateAccuracy, computeAccuracyByProject, describeAccuracy, accuracyHeadline, MIN_RELIABLE_SAMPLE } from '../../utils/estimateAccuracy';
import { computeHorizonCapacity } from '../../algorithms/capacityEngine';
import { getEffectiveDeadline } from '../../algorithms/allocator';
import { getWeekRange, toISODate, dateRange, formatDisplayDate } from '../../utils/dateUtils';
import { getMissedTaskItems, isBlockTaskCompleted } from '../../utils/missedTasks';
import { getOverdueTasks } from '../../utils/overdueTasks';
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

    // Was open-coded Sunday-start maths; goes through the shared helper now so
    // it honours rules.weekStartsOn like every other week-based view.
    const { weekStart, weekEnd } = getWeekRange(today, rules.weekStartsOn);

    const scheduledToday = blocks.filter((b) => b.date === today).reduce((sum, b) => sum + b.durationHours, 0);
    const scheduledThisWeek = blocks
      .filter((b) => b.date >= weekStart && b.date <= weekEnd)
      .reduce((sum, b) => sum + b.durationHours, 0);

    // nowClamp so today's contribution to the week's free-capacity total
    // doesn't count hours that have already passed — without it, checking
    // this stat at 5pm still counted today as if the full work day were
    // still open, overstating "Free capacity (week)" by however much of
    // today has already elapsed. Mirrors rebalanceEngine.js's own nowClamp
    // construction (the actual scheduler already gets this right; this just
    // brings the stats display in line with it).
    const now = new Date();
    const nowClamp = { date: today, minutes: now.getHours() * 60 + now.getMinutes() };
    const capacityMap = computeHorizonCapacity(weekStart, 7, { routines, events, blocks, rules, nowClamp });
    const totalWeekCapacity = [...capacityMap.values()].reduce((sum, c) => sum + c.totalAvailableHours, 0);
    const freeCapacityThisWeek = Math.max(0, totalWeekCapacity - scheduledThisWeek);

    // Uses the scheduler's own getEffectiveDeadline rather than re-deriving
    // it: a task marked "must be done on due date" (enforceDueDate) has no
    // buffer to miss — its deadline IS its due date — so subtracting
    // bufferDays here flagged it as permanently at-risk while the scheduler
    // considered it perfectly on time. It also resolves an undated sub-task's
    // inherited due date, which the old inline version couldn't see at all.
    // A Map, not a plain object — findAncestorDueDate calls .get() on it.
    const taskByIdForDeadlines = new Map(tasks.map((t) => [t.id, t]));
    const overdueRiskTasks = activeTasks.filter((t) => {
      const effectiveDeadline = getEffectiveDeadline(t, rules.bufferDays, taskByIdForDeadlines);
      return !!effectiveDeadline && effectiveDeadline < today && t.remainingHours > 0;
    });

    // ---- Task-count stats (mirrors DashboardStats' own definitions, so the
    // numbers agree wherever the same concept shows up) --------------------
    const activeTaskCount = activeTasks.length;
    const dueTodayCount = activeTasks.filter((t) => t.dueDate === today).length;
    const overdueAndMissedCount = getOverdueTasks(tasks).length + getMissedTaskItems(tasks, blocks).length;
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const completedTodayCount = blocks.filter((b) => b.date === today && isBlockTaskCompleted(b, taskById.get(b.taskId))).length;
    const totalCompletedCount = tasks.filter((t) => t.isCompleted || (t.isRecurring && t.completedDates?.length > 0)).length;

    return {
      totalHoursLeft,
      totalActualHours,
      scheduledToday,
      scheduledThisWeek,
      freeCapacityThisWeek,
      overdueRiskTasks,
      activeTaskCount,
      dueTodayCount,
      overdueAndMissedCount,
      completedTodayCount,
      totalCompletedCount,
    };
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

  /* Estimate accuracy (see utils/estimateAccuracy.js). Only tasks completed
     with a running timer carry an actual, so this is often empty — the panel
     below says so rather than rendering a zero, and always shows the sample
     size next to any figure. */
  const accuracy = useMemo(() => computeEstimateAccuracy(tasks), [tasks]);
  const accuracyByProject = useMemo(() => computeAccuracyByProject(tasks, projects), [tasks, projects]);

  return (
    <div>
      <h3 className="stats-section-title" style={{ marginTop: 0 }}>Time &amp; hours</h3>
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

      <h3 className="stats-section-title">Task counts</h3>
      <div className="stats-cards-row">
        <StatCard label="Active tasks" value={stats.activeTaskCount} />
        <StatCard label="Due today" value={stats.dueTodayCount} />
        <StatCard
          label="Overdue & missed"
          value={stats.overdueAndMissedCount}
          accent={stats.overdueAndMissedCount > 0 ? 'var(--color-danger)' : undefined}
        />
        <StatCard
          label="Completed today"
          value={stats.completedTodayCount}
          accent={stats.completedTodayCount > 0 ? 'var(--color-success)' : undefined}
        />
        <StatCard label="Total completed" value={stats.totalCompletedCount} sublabel="all-time" />
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

      <h3 className="stats-section-title">Estimate accuracy</h3>
      <div className="card stats-accuracy-card">
        {accuracy.sampleSize === 0 ? (
          <p className="stats-accuracy-empty">
            Nothing to compare yet. Run the timer on a task and log the time when you complete it, and this will start
            showing how your estimates hold up.
          </p>
        ) : (
          <>
            <div className="stats-accuracy-headline">
              <span className="stats-accuracy-verdict">{accuracyHeadline(accuracy.ratio)}</span>
              {/* Sample size is never optional here. A ratio from two tasks
                  looks identical to one from fifty, and acting on the first is
                  how someone stops trusting the panel. */}
              <span className="stats-accuracy-sample">
                from {accuracy.sampleSize} timed task{accuracy.sampleSize === 1 ? '' : 's'}
                {!accuracy.isReliable && ` — too few to read much into yet (${MIN_RELIABLE_SAMPLE}+ gives a clearer picture)`}
              </span>
            </div>
            <p className="stats-accuracy-detail">
              {accuracy.totalEstimated.toFixed(1)}h estimated, {accuracy.totalActual.toFixed(1)}h actually spent.
            </p>

            {accuracyByProject.length > 1 && (
              <div className="table-scroll">
                <table className="stats-accuracy-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Estimated</th>
                      <th>Actual</th>
                      <th>Difference</th>
                      <th>Tasks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accuracyByProject.map((row) => (
                      <tr key={row.projectId || 'none'} className={row.isReliable ? '' : 'is-thin-sample'}>
                        <td>{row.projectName}</td>
                        <td className="num">{row.totalEstimated.toFixed(1)}h</td>
                        <td className="num">{row.totalActual.toFixed(1)}h</td>
                        <td className="num">{describeAccuracy(row.ratio)}</td>
                        <td className="num">{row.sampleSize}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="stats-accuracy-detail">
              Shown for reference only — nothing here changes your estimates or your schedule automatically.
            </p>
          </>
        )}
      </div>

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
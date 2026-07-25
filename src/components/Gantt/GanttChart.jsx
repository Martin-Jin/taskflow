/**
 * ============================================================================
 * GanttChart
 * ============================================================================
 * Renders one row per task, with horizontal bars showing every day that task
 * has scheduled work, spanning from the task's earliest scheduled block to
 * its due date (or last scheduled block if no due date). This gives an
 * at-a-glance "burn-down" view across the full planning horizon, per the
 * requirements.
 *
 * Bar color = priority. A vertical line marks "today". Days with no
 * scheduled hours for a task simply show no fill in that column, so gaps in
 * pacing are visually obvious.
 *
 * DEPENDENCIES: the scheduler (rebalanceEngine) refuses to place any blocks
 * for a task until every task in its `dependsOn` list is complete, so a
 * dependent task's bar naturally starts after its prerequisite's — there's
 * no separate "linking" logic needed here for that part. What DOES need
 * explicit handling is a task that has due date but hasn't been scheduled
 * yet BECAUSE it's blocked — it would otherwise just be silently absent
 * from the chart (the row is normally skipped when there are zero blocks).
 * Those get a hollow "blocked" row instead so it's clear why they're
 * missing a bar, rather than looking like a bug. Tasks whose dependencies
 * are met but simply haven't been through Re-balance yet still don't show
 * (nothing has been decided about them), matching the existing behavior.
 * ============================================================================
 */

import React, { useMemo } from 'react';
import { BarChart3, Wind, Ban, Zap } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { addDays, dateRange, diffDays, toISODate, dayOfWeek } from '../../utils/dateUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { areDependenciesMet } from '../../utils/dependencyUtils';
import { priorityColor } from '../../utils/priorityColor';

const HORIZON_DAYS = 28;
const LABEL_COL_WIDTH_DESKTOP = 220;
const LABEL_COL_WIDTH_MOBILE = 140;

export default function GanttChart() {
  const { tasks, blocks } = useScheduler();
  const isMobile = useIsMobile();
  const labelColWidth = isMobile ? LABEL_COL_WIDTH_MOBILE : LABEL_COL_WIDTH_DESKTOP;
  const today = toISODate(new Date());
  const days = useMemo(() => dateRange(today, HORIZON_DAYS), [today]);

  const activeTasks = useMemo(() => tasks.filter((t) => !t.isCompleted), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Group once instead of re-filtering the full `blocks` array per task
  // (O(tasks x blocks) below otherwise).
  const blocksByTaskId = useMemo(() => {
    const map = new Map();
    for (const b of blocks) {
      const list = map.get(b.taskId);
      if (list) list.push(b);
      else map.set(b.taskId, [b]);
    }
    return map;
  }, [blocks]);

  const rows = useMemo(() => {
    return activeTasks
      .map((task) => {
        const taskBlocks = (blocksByTaskId.get(task.id) || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
        const dependenciesMet = areDependenciesMet(task, taskById);
        const waitingOn = (task.dependsOn || [])
          .map((depId) => taskById.get(depId))
          .filter((dep) => dep && !dep.isCompleted);

        if (taskBlocks.length === 0) {
          // Not scheduled yet. Only worth a row if it's blocked on a
          // dependency — otherwise (no due date, or just not yet
          // rebalanced) it's the existing "no bar" behavior: skip it.
          if (!dependenciesMet) {
            return { task, firstDate: today, lastDate: today, hoursByDate: {}, blocked: true, waitingOn };
          }
          return null;
        }

        const firstDate = taskBlocks[0].date;
        const lastScheduledDate = taskBlocks[taskBlocks.length - 1].date;
        // The bar should never be shorter than the work actually scheduled
        // for it — an overdue task (dueDate before its last block) would
        // otherwise get truncated at dueDate, hiding real scheduled work.
        const lastDate = task.dueDate && task.dueDate > lastScheduledDate ? task.dueDate : lastScheduledDate;
        const hoursByDate = {};
        for (const b of taskBlocks) hoursByDate[b.date] = (hoursByDate[b.date] || 0) + b.durationHours;
        return { task, firstDate, lastDate, hoursByDate, blocked: false, waitingOn };
      })
      .filter(Boolean);
  }, [activeTasks, blocksByTaskId, taskById, today]);

  if (rows.length === 0) {
    return (
      <div className="card gantt-empty-state">
        <div className="gantt-empty-icon">
          <BarChart3 size={32} strokeWidth={1.5} />
        </div>
        <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)' }}>Nothing scheduled yet</h3>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13, maxWidth: 360, margin: '0 auto' }}>
          The Gantt view shows a burn-down bar per task once work is on the calendar. Head to the Calendar tab and
          run{' '}
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Zap size={13} />
            Re-balance schedule
          </strong>{' '}
          to populate it.
        </p>
      </div>
    );
  }

  return (
    <div className="gantt-container">
      <div className="gantt-date-header" style={{ gridTemplateColumns: `${labelColWidth}px 1fr` }}>
        <div />
        <div className="gantt-date-header-track">
          {days.map((d) => (
            <div key={d} className="gantt-date-cell">
              {d.slice(5)}
            </div>
          ))}
        </div>
      </div>

      <div className="gantt-grid">
        {rows.map(({ task, firstDate, lastDate, hoursByDate, blocked, waitingOn }) => {
          const startOffset = Math.max(0, diffDays(today, firstDate));
          const endOffset = Math.min(HORIZON_DAYS - 1, diffDays(today, lastDate));
          const span = Math.max(1, endOffset - startOffset + 1);
          const waitingLabel = waitingOn?.length ? waitingOn.map((d) => d.title).join(', ') : '';

          return (
            <div className="gantt-row" key={task.id} style={{ gridTemplateColumns: `${labelColWidth}px 1fr` }}>
              <div className="gantt-row-header" title={waitingLabel ? `Waiting on: ${waitingLabel}` : undefined}>
                <span className={`priority-dot ${task.priority}`} />
                {task.isPassive && <Wind size={13} style={{ verticalAlign: -2, marginRight: 4 }} title="Can run unattended" />}
                {task.title}
                {blocked && <Ban size={13} style={{ color: 'var(--danger)', verticalAlign: -2, marginLeft: 4 }} />}
              </div>
              <div className="gantt-track">
                <div className="gantt-day-cols">
                  {days.map((d) => (
                    <div key={d} className={`gantt-day-col ${[0, 6].includes(dayOfWeek(d)) ? 'weekend' : ''}`} />
                  ))}
                </div>
                {blocked ? (
                  <div
                    className="gantt-bar gantt-bar-blocked"
                    style={{
                      left: `${(startOffset / HORIZON_DAYS) * 100}%`,
                      width: `${(1 / HORIZON_DAYS) * 100}%`,
                      borderColor: priorityColor(task.priority),
                    }}
                    title={`${task.title}: blocked — waiting on ${waitingLabel}`}
                  />
                ) : (
                  <div
                    className={`gantt-bar ${task.isPassive ? 'gantt-bar-passive' : ''}`}
                    style={{
                      left: `${(startOffset / HORIZON_DAYS) * 100}%`,
                      width: `${(span / HORIZON_DAYS) * 100}%`,
                      background: priorityColor(task.priority),
                    }}
                    title={`${task.title}: ${Object.values(hoursByDate).reduce((a, b) => a + b, 0).toFixed(1)}h scheduled`}
                  />
                )}
              </div>
            </div>
          );
        })}
        <div
          className="gantt-bar-today-line"
          style={{ left: `${labelColWidth}px`, top: 0, bottom: 0 }}
        />
      </div>
    </div>
  );
}
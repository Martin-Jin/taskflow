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
 * Bar color = priority. A vertical line marks "today". Each task renders as
 * one single solid bar spanning its first to last scheduled date — per-day
 * hours (`hoursByDate`) are only summed for the bar's tooltip total, not
 * used to vary the fill within the bar, so a gap-free scheduled range still
 * renders as one uninterrupted block regardless of how the hours land day to
 * day within it.
 *
 * SUB-TASKS: a container (any task with ≥1 sub-task, at any depth) never
 * gets its own row — only leaf tasks do, so a sub-task gets a row just like
 * a normal top-level task (see `hasChildTasks` below). A sub-task's row
 * names its parent as a muted subtitle under the title, mirroring the
 * calendar view's block treatment (see WeekView's `parentTask`), since the
 * title alone wouldn't say which goal it belongs to.
 *
 * DEPENDENCIES: the scheduler (rebalanceEngine + localSearch's dependency-
 * ordering enforcement) places a dependent task's blocks to start no earlier
 * than the end of its dependencies' last block, so a dependent task's bar
 * naturally starts after its prerequisite's — there's no separate "linking"
 * logic needed here for that part, and an incomplete (but schedulable)
 * dependency no longer prevents the dependent from getting a normal bar.
 * What DOES still need explicit handling is a task that has a due date but
 * has zero blocks BECAUSE a dependency of its couldn't be scheduled at all
 * (see rebalanceEngine.js's `dependency_blocked` — a structural, not merely
 * "not yet completed", failure) — it would otherwise just be silently absent
 * from the chart (the row is normally skipped when there are zero blocks).
 * Those get a hollow "blocked" row instead so it's clear why they're
 * missing a bar, rather than looking like a bug. Tasks whose dependencies
 * are met but simply haven't been through Re-balance yet still don't show
 * (nothing has been decided about them), matching the existing behavior.
 *
 * Dependencies are ALSO drawn, as elbow connectors from a prerequisite's bar
 * end to its dependent's bar start — the arrow is what makes a chain visible,
 * and finding the one task holding up five others is the question a Gantt is
 * usually open to answer. The geometry is MEASURED off the rendered bars
 * (see the useEffect below) rather than recomputed from offsets: bars are
 * positioned in percentages of a track whose width depends on the horizontal
 * scroll container, and row heights vary (a sub-task row carries an extra
 * subtitle line), so duplicating that maths here would be a second source of
 * truth that silently drifts. An edge whose prerequisite has no row at all
 * (unscheduled, or outside the 28-day horizon) is simply not drawn.
 * ============================================================================
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Wind, Ban, Zap } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { addDays, dateRange, diffDays, toISODate, dayOfWeek } from '../../utils/dateUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { areDependenciesMet } from '../../utils/dependencyUtils';
import { hasChildTasks } from '../../utils/taskHierarchy';
import { priorityColor } from '../../utils/priorityColor';
import {
  filterTasksByProject,
  filterTasksByStatus,
  NO_SCHEDULE_PROJECT_ID,
  NO_SCHEDULE_PROJECT_LABEL,
} from '../../utils/projectConstants';
import HoverPreviewCard from '../Calendar/HoverPreviewCard';

const HORIZON_DAYS = 28;
// How far a connector runs horizontally out of a bar before turning. Also the
// per-edge stagger when one task has several prerequisites, so their vertical
// segments don't land on top of each other.
const CONNECTOR_ELBOW_PX = 9;
const LABEL_COL_WIDTH_DESKTOP = 220;
const LABEL_COL_WIDTH_MOBILE = 140;

/**
 * Elbow path for one dependency connector, in grid pixel coordinates.
 *
 * The normal case runs right out of the prerequisite, turns once vertically,
 * and arrives at the dependent's left edge. The scheduler orders dependents
 * after their prerequisites, so that's what usually applies — but it isn't
 * guaranteed on screen: a manually-dragged block, or an overdue task whose bar
 * is stretched to its due date, can leave the dependent starting to the LEFT
 * of where its prerequisite ends. A single elbow would then double back
 * through both bars, so that case routes around the outside instead.
 */
function connectorPath({ x1, y1, x2, y2, stagger }) {
  const out = CONNECTOR_ELBOW_PX + stagger;
  if (x2 >= x1 + out * 2) {
    const turn = x1 + out;
    return `M ${x1} ${y1} H ${turn} V ${y2} H ${x2}`;
  }
  // Route around: out of the prerequisite, vertically to halfway between the
  // two rows, back to just before the dependent, then in.
  const midY = (y1 + y2) / 2;
  const back = x2 - out;
  return `M ${x1} ${y1} H ${x1 + out} V ${midY} H ${back} V ${y2} H ${x2}`;
}

export default function GanttChart({ activeProjectId, filter = 'all' }) {
  const { tasks, blocks, projects, runRebalance, isLoading } = useScheduler();
  const isMobile = useIsMobile();
  const labelColWidth = isMobile ? LABEL_COL_WIDTH_MOBILE : LABEL_COL_WIDTH_DESKTOP;
  const today = toISODate(new Date());
  const days = useMemo(() => dateRange(today, HORIZON_DAYS), [today]);
  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  // Desktop-only hover preview (see HoverPreviewCard) for a row's title,
  // which truncates in the fixed-width label column (see .gantt-row-title) —
  // same delayed-show/cancel pattern as WeekView's own hoverPreview state.
  const [hoverPreview, setHoverPreview] = useState(null);
  const hoverTimer = useRef(null);
  // Rendered bar element per task id, and the grid they're measured against —
  // both consumed by the dependency-connector effect further down.
  const barRefs = useRef(new Map());
  const gridRef = useRef(null);
  function scheduleHoverPreview(rect, content) {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverPreview({ rect, ...content }), 350);
  }
  function cancelHoverPreview() {
    clearTimeout(hoverTimer.current);
    setHoverPreview(null);
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // A container (has ≥1 sub-task, at any depth) never gets its own row —
  // only leaf tasks do, so a sub-task gets a row exactly like a normal
  // top-level task (see the file-level SUB-TASKS note above). Checked
  // against the full `tasks` list, not the project/status-filtered one,
  // since a task's children determine whether it's a container regardless
  // of what's currently filtered out.
  // `filter` defaults to "all" (every non-completed task, dated or not),
  // matching Gantt's original behavior — see filterTasksByStatus.
  const activeTasks = useMemo(
    () =>
      filterTasksByStatus(
        filterTasksByProject(tasks, activeProjectId).filter((t) => !hasChildTasks(t.id, tasks)),
        filter
      ),
    [tasks, activeProjectId, filter]
  );
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
        const taskBlocks = (blocksByTaskId.get(task.id) || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
        // Stale scheduled blocks that were never cleaned up (or an overdue
        // task not yet rebalanced) can leave every block in the past —
        // skip the row rather than rendering a misleading 1-day bar at
        // "today" for work that isn't actually happening now.
        if (lastDate < today) return null;
        const hoursByDate = {};
        for (const b of taskBlocks) hoursByDate[b.date] = (hoursByDate[b.date] || 0) + b.durationHours;
        return { task, firstDate, lastDate, hoursByDate, blocked: false, waitingOn };
      })
      .filter(Boolean);
  }, [activeTasks, blocksByTaskId, taskById, today]);

  /* Dependency connectors. `barRefs` collects the rendered bar element per
     task id (populated by the ref callbacks below); this then measures them
     relative to the grid, so the paths come from real layout rather than a
     re-derivation of the percentage positioning. Re-measured on any resize of
     the grid, which covers window resize, the label column changing width at
     the mobile breakpoint, and rows appearing/disappearing. */
  const [connectors, setConnectors] = useState([]);

  /* Stable-per-render ref callback keyed by task id. Deletes on unmount so a
     task that stops having a row can't leave a detached node behind for the
     measurement pass to read stale geometry from. */
  function registerBar(taskId) {
    return (el) => {
      if (el) barRefs.current.set(taskId, el);
      else barRefs.current.delete(taskId);
    };
  }

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return undefined;

    function measure() {
      const gridRect = grid.getBoundingClientRect();
      const next = [];
      for (const { task } of rows) {
        const toEl = barRefs.current.get(task.id);
        if (!toEl) continue;
        const deps = task.dependsOn || [];
        deps.forEach((depId, i) => {
          const fromEl = barRefs.current.get(depId);
          // No row for the prerequisite (unscheduled, completed-and-skipped,
          // or off-horizon) means there is nothing to draw from.
          if (!fromEl) return;
          const from = fromEl.getBoundingClientRect();
          const to = toEl.getBoundingClientRect();
          next.push({
            id: `${depId}->${task.id}`,
            x1: from.right - gridRect.left,
            y1: from.top + from.height / 2 - gridRect.top,
            x2: to.left - gridRect.left,
            y2: to.top + to.height / 2 - gridRect.top,
            // Stagger only matters when a task has more than one prerequisite.
            stagger: deps.length > 1 ? i * 4 : 0,
          });
        });
      }
      setConnectors(next);
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [rows, labelColWidth]);

  if (rows.length === 0) {
    return (
      <div className="card gantt-empty-state">
        <div className="gantt-empty-icon">
          <BarChart3 size={32} strokeWidth={1.5} />
        </div>
        <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)' }}>Nothing scheduled yet</h3>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, maxWidth: 360, margin: '0 auto' }}>
          The Gantt view shows a burn-down bar per task once work is on the calendar. Re-balance your schedule to
          populate it.
        </p>
        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={runRebalance} disabled={isLoading}>
          <Zap size={14} />
          Re-balance schedule
        </button>
      </div>
    );
  }

  return (
    // tab-panel (global.css): same content-swap fade-in as switching main
    // nav tabs — see W7's "Project/view switch: short content cross-fade".
    <div className="gantt-container tab-panel">
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

      <div className="gantt-grid" ref={gridRef}>
        {rows.map(({ task, firstDate, lastDate, hoursByDate, blocked, waitingOn }) => {
          const startOffset = Math.max(0, diffDays(today, firstDate));
          const endOffset = Math.min(HORIZON_DAYS - 1, diffDays(today, lastDate));
          const span = Math.max(1, endOffset - startOffset + 1);
          const waitingLabel = waitingOn?.length ? waitingOn.map((d) => d.title).join(', ') : '';
          const parentTask = task.parentId ? taskById.get(task.parentId) : null;
          const headerTitle = parentTask
            ? `${task.title} (sub-task of ${parentTask.title})`
            : undefined;

          return (
            <div className="gantt-row" key={task.id} style={{ gridTemplateColumns: `${labelColWidth}px 1fr` }}>
              <div
                className="gantt-row-header"
                // Desktop gets the richer HoverPreviewCard instead (see
                // below) — mobile has no hover, so it keeps the native
                // tooltip fallback.
                title={isMobile ? (waitingLabel ? `Waiting on: ${waitingLabel}` : headerTitle) : undefined}
                onMouseEnter={
                  isMobile
                    ? undefined
                    : (e) =>
                        scheduleHoverPreview(e.currentTarget.getBoundingClientRect(), {
                          title: task.title,
                          priority: task.priority,
                          projectName:
                            task.projectId === NO_SCHEDULE_PROJECT_ID
                              ? NO_SCHEDULE_PROJECT_LABEL
                              : projectById[task.projectId]?.name,
                          parentTitle: parentTask?.title,
                          isPassive: task.isPassive,
                          timeText: waitingLabel ? `Waiting on: ${waitingLabel}` : undefined,
                        })
                }
                onMouseLeave={isMobile ? undefined : cancelHoverPreview}
              >
                <div className="gantt-row-title">
                  <span className={`priority-dot ${task.priority}`} />
                  {task.isPassive && <Wind size={13} style={{ verticalAlign: -2, marginRight: 4 }} title="Can run unattended" />}
                  {task.title}
                  {blocked && <Ban size={13} style={{ color: 'var(--color-danger)', verticalAlign: -2, marginLeft: 4 }} />}
                </div>
                {parentTask && <div className="gantt-row-parent">{parentTask.title}</div>}
              </div>
              <div className="gantt-track">
                <div className="gantt-day-cols">
                  {days.map((d) => (
                    <div key={d} className={`gantt-day-col ${[0, 6].includes(dayOfWeek(d)) ? 'weekend' : ''}`} />
                  ))}
                </div>
                {blocked ? (
                  <div
                    ref={registerBar(task.id)}
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
                    ref={registerBar(task.id)}
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
        {connectors.length > 0 && (
          <svg className="gantt-connectors" aria-hidden="true">
            <defs>
              {/* One shared arrowhead; `context-stroke` keeps it the same
                  colour as the path without hardcoding a token here. */}
              <marker
                id="gantt-dep-arrow"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L6,3 L0,6 z" fill="context-stroke" />
              </marker>
            </defs>
            {connectors.map((c) => (
              <path key={c.id} d={connectorPath(c)} markerEnd="url(#gantt-dep-arrow)" />
            ))}
          </svg>
        )}
        <div
          className="gantt-bar-today-line"
          style={{ left: `${labelColWidth}px`, top: 0, bottom: 0 }}
        />
      </div>

      {hoverPreview && <HoverPreviewCard {...hoverPreview} />}
    </div>
  );
}
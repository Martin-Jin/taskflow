/**
 * Read-only stats/sorting helpers for the Projects directory page (distinct
 * from the per-project Board/List views) — a sibling to projectConstants.js's
 * sidebar-ordering helpers, split into its own file since these are about
 * summarizing a project's contents rather than filtering/ordering tasks.
 * Nothing here is persisted state; every value is derived on demand from the
 * live `projects`/`tasks` arrays.
 */

import { filterTasksByProject } from './projectConstants';
import { getEffectiveEstimatedHours } from './taskHierarchy';

/**
 * Number of tasks in a project, subtasks included — a plain flat count of
 * every Task whose `projectId` matches. Unlike total-hours below, a task
 * count has no double-counting risk (a parent and its subtasks are each one
 * task, however you're planning to display them), so "size" here means
 * "everything that belongs to this project," matching how `filterTasksByProject`
 * is used elsewhere (List/Board view show every task, subtasks included).
 */
export function getProjectTaskCount(projectId, tasks) {
  return filterTasksByProject(tasks, projectId).length;
}

/**
 * Sum of effective estimated hours across a project's TOP-LEVEL tasks only
 * (no `parentId`, or a `parentId` pointing outside this project) — each
 * top-level task's effective hours already rolls up its own subtasks (see
 * taskHierarchy.js's getEffectiveEstimatedHours), so summing over every task
 * in the project flatly would double-count a parent's hours on top of its
 * children's. A subtask whose parent lives in a DIFFERENT project (not
 * possible today via the UI, but not structurally prevented) is treated as
 * its own top-level entry here rather than silently dropped.
 */
export function getProjectTotalHours(projectId, tasks) {
  const projectTasks = filterTasksByProject(tasks, projectId);
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));
  const topLevel = projectTasks.filter((t) => !t.parentId || !projectTaskIds.has(t.parentId));
  return topLevel.reduce((sum, t) => sum + getEffectiveEstimatedHours(t, tasks), 0);
}

/** Sort keys accepted by `sortProjectsBy`. */
export const PROJECT_SORT_KEYS = ['size', 'duration', 'created'];

/**
 * New, sorted copy of `projects` (never mutates the input) for the Projects
 * directory's "Size / Duration / Creation date" sort menu.
 *  - 'size'     -> task count (getProjectTaskCount)
 *  - 'duration' -> total top-level effective hours (getProjectTotalHours)
 *  - 'created'  -> creation order. Project has no `createdAt`; `order` is
 *                  stamped once at creation as `prev.length + 1` (see
 *                  SchedulerContext's addProject) and never changed
 *                  afterward, so it's a monotonically increasing proxy for
 *                  "older projects have a lower order" — higher `order` is
 *                  newer.
 * Descending by default (biggest/newest first), since that's the more
 * useful default for a directory view; pass `ascending: true` to flip it.
 */
export function sortProjectsBy(projects, tasks, sortKey, { ascending = false } = {}) {
  const valueFor = {
    size: (p) => getProjectTaskCount(p.id, tasks),
    duration: (p) => getProjectTotalHours(p.id, tasks),
    created: (p) => p.order || 0,
  }[sortKey];
  if (!valueFor) return [...projects];

  const sorted = [...projects].sort((a, b) => valueFor(a) - valueFor(b));
  return ascending ? sorted : sorted.reverse();
}

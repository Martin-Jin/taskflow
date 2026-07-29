/**
 * Shared constants/helpers for the "All Tasks" pseudo-project and sidebar
 * project ordering. "All Tasks" is a virtual filter (not a real Project
 * record) — it always shows every task and can't be renamed/deleted/pinned,
 * so it's represented purely by this sentinel id rather than living in the
 * `projects` array.
 */

export const ALL_TASKS_PROJECT_ID = '__all__';
export const ALL_TASKS_PROJECT_LABEL = 'All Tasks';

/**
 * Tasks belonging to `projectId`, treating ALL_TASKS_PROJECT_ID as "every
 * task" — the one place this sentinel check lives, instead of each of
 * List/Board view re-deriving it inline.
 */
export function filterTasksByProject(tasks, projectId) {
  if (projectId === ALL_TASKS_PROJECT_ID) return tasks;
  return tasks.filter((t) => t.projectId === projectId);
}

/**
 * Status filter shared by List/Board/Gantt's view-filter menu — "Active"
 * means scheduled: not completed and has a due date (the scheduler only
 * ever places blocks for tasks with a due date). "All" is everything *not
 * completed*, dated or not. "No due date" is just a quick filter onto a
 * subset of what "All" already contains, not a disjoint bucket.
 */
export const TASK_STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Scheduled' },
  { key: 'noDueDate', label: 'No due date' },
  { key: 'completed', label: 'Completed' },
];

export function filterTasksByStatus(tasks, filter) {
  if (filter === 'completed') return tasks.filter((t) => t.isCompleted);
  let list = tasks.filter((t) => !t.isCompleted);
  if (filter === 'active') list = list.filter((t) => !!t.dueDate);
  if (filter === 'noDueDate') list = list.filter((t) => !t.dueDate);
  return list;
}

/**
 * Sidebar project ordering: pinned projects first (alphabetical), then
 * unpinned projects by most-recently-visited (undefined `lastVisitedAt`
 * sorts last) — mirrors the "Jump back in" recency pattern already used for
 * Pinned Links (see pinnedLinksModel.js).
 */
export function sortProjectsForSidebar(projects) {
  const pinned = projects.filter((p) => p.isPinned).sort((a, b) => a.name.localeCompare(b.name));
  const unpinned = projects
    .filter((p) => !p.isPinned)
    .sort((a, b) => {
      const aTime = a.lastVisitedAt ? new Date(a.lastVisitedAt).getTime() : 0;
      const bTime = b.lastVisitedAt ? new Date(b.lastVisitedAt).getTime() : 0;
      return bTime - aTime;
    });
  return [...pinned, ...unpinned];
}

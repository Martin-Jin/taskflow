/**
 * Shared constants/helpers for the "All Tasks" and "Inbox" pseudo-projects,
 * plus sidebar project ordering. Both are virtual filters, not real Project
 * records — "All Tasks" always shows every task, "Inbox" shows tasks with no
 * project assigned (`task.projectId` falsy). Neither can be renamed/deleted/
 * pinned/shared, so each is represented purely by its sentinel id rather than
 * living in the `projects` array — this also means deleting a project (which
 * sets its tasks' `projectId` to null) automatically "moves" those tasks into
 * Inbox for free, with no extra bookkeeping.
 */

export const ALL_TASKS_PROJECT_ID = '__all__';
export const ALL_TASKS_PROJECT_LABEL = 'All Tasks';

export const INBOX_PROJECT_ID = '__inbox__';
export const INBOX_PROJECT_LABEL = 'Inbox';

/**
 * Tasks belonging to `projectId`, treating ALL_TASKS_PROJECT_ID as "every
 * task" and INBOX_PROJECT_ID as "no project assigned" — the one place these
 * sentinel checks live, instead of each of List/Board view re-deriving them
 * inline.
 */
export function filterTasksByProject(tasks, projectId) {
  if (projectId === ALL_TASKS_PROJECT_ID) return tasks;
  if (projectId === INBOX_PROJECT_ID) return tasks.filter((t) => !t.projectId);
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
 * sorts last) — mirrors the recency pattern already used for Notes'
 * "Recently edited" strip (see notesModel.js).
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

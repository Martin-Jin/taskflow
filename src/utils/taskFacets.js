/**
 * ============================================================================
 * TASK FACETS
 * ============================================================================
 * Small pure helpers for deriving the distinct "facets" (projects, tags)
 * present in a task list — used to populate Todoist-style filter controls
 * (project switcher, tag chips) without hardcoding a project/tag list
 * anywhere in state.
 * ============================================================================
 */

const UNASSIGNED_PROJECT = { id: '__unassigned__', name: 'No project' };

/**
 * Derive the distinct list of projects present across `tasks`, sorted
 * alphabetically, with a synthetic "No project" entry appended if any task
 * lacks a project. Each entry is `{ id, name }`, where `id` is the task's
 * `projectId` (or the sentinel above) — safe to use as a React key and as
 * the value compared against in filtering.
 */
export function getDistinctProjects(tasks) {
  const byId = new Map();
  let hasUnassigned = false;

  for (const t of tasks) {
    if (t.projectId) {
      if (!byId.has(t.projectId)) {
        byId.set(t.projectId, { id: t.projectId, name: t.projectName || t.projectId });
      }
    } else {
      hasUnassigned = true;
    }
  }

  const projects = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (hasUnassigned) projects.push(UNASSIGNED_PROJECT);
  return projects;
}

/** Derive the distinct, alphabetically-sorted list of tags present across `tasks`. */
export function getDistinctTags(tasks) {
  const tagSet = new Set();
  for (const t of tasks) {
    for (const tag of t.tags ?? []) tagSet.add(tag);
  }
  return [...tagSet].sort((a, b) => a.localeCompare(b));
}

export { UNASSIGNED_PROJECT };

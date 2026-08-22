/**
 * ============================================================================
 * CALENDAR FILTER
 * ============================================================================
 * Pure predicate logic backing CalendarFilterMenu — extracted out of
 * CalendarPage so it's unit-testable and so WeekView/MonthView stay simple
 * (they just receive already-filtered arrays, see CalendarPage's
 * filteredBlocks/filteredEvents).
 *
 * Filter shape: `{ showMode: 'both'|'tasks'|'events', projectIds: null|string[],
 * labelIds: null|string[] }`. `null` for projectIds/labelIds means "no filter
 * applied" (matches everything) rather than an explicit list of every current
 * id — that way a project/label created AFTER the filter was last touched is
 * included by default instead of silently excluded by a now-stale snapshot.
 * ============================================================================
 */

/** Default filter — nothing excluded. */
export const DEFAULT_CALENDAR_FILTER = { showMode: 'both', projectIds: null, labelIds: null };

/**
 * Merges a possibly-partial/stale persisted value over the defaults so an
 * older or hand-edited localStorage shape can't produce `undefined` fields
 * (which would silently break the `null`-means-"all" checks below).
 */
export function normalizeCalendarFilter(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CALENDAR_FILTER };
  const showMode = ['both', 'tasks', 'events'].includes(raw.showMode) ? raw.showMode : DEFAULT_CALENDAR_FILTER.showMode;
  const projectIds = Array.isArray(raw.projectIds) ? raw.projectIds : null;
  const labelIds = Array.isArray(raw.labelIds) ? raw.labelIds : null;
  return { showMode, projectIds, labelIds };
}

/** True if `filter` differs from the all-inclusive default — drives the trigger's active-indicator dot. */
export function isCalendarFilterActive(filter) {
  return filter.showMode !== 'both' || filter.projectIds !== null || filter.labelIds !== null;
}

/**
 * A task's effective project/label set for filtering purposes. A sub-task is
 * created with its own `projectId`/`labelIds` (defaulting to a copy of its
 * parent's at creation time — see TaskDetailModal's handleAddSubtask), so in
 * the common case a sub-task already carries its own values and no fallback
 * is needed. But older data or a task edited to explicitly clear its project
 * can leave a sub-task with no `projectId` of its own — in that case fall
 * back to the nearest ancestor's, so "filter by project" still matches sub-
 * tasks a user would naturally consider part of that project. Labels are
 * unioned with the ancestor's rather than replaced, since multiple tags can
 * meaningfully apply at different levels.
 */
function effectiveTaskProjectId(task, taskById) {
  if (task.projectId) return task.projectId;
  let current = task;
  const visited = new Set([task.id]);
  while (current.parentId) {
    const parent = taskById.get ? taskById.get(current.parentId) : taskById[current.parentId];
    if (!parent || visited.has(parent.id)) return null;
    if (parent.projectId) return parent.projectId;
    visited.add(parent.id);
    current = parent;
  }
  return null;
}

function effectiveTaskLabelIds(task, taskById) {
  const own = new Set(task.labelIds || []);
  if (own.size > 0) return own;
  let current = task;
  const visited = new Set([task.id]);
  while (current.parentId) {
    const parent = taskById.get ? taskById.get(current.parentId) : taskById[current.parentId];
    if (!parent || visited.has(parent.id)) break;
    if (parent.labelIds?.length) return new Set(parent.labelIds);
    visited.add(parent.id);
    current = parent;
  }
  return own; // empty
}

/** Sentinel id for "tasks with no project" in the Projects filter group. */
export const UNASSIGNED_PROJECT_ID = '__unassigned__';

/**
 * Does `block` (a ScheduledBlock) pass the project/label portion of `filter`?
 * A block whose task can't be resolved (orphaned — its task was deleted but
 * the block lingered) never matches a project/label filter, since it can't be
 * said to belong to any project/tag — but it's unaffected by showMode, same
 * as any other block.
 */
function blockMatchesProjectAndLabel(block, filter, taskById) {
  const task = taskById.get ? taskById.get(block.taskId) : taskById[block.taskId];
  if (filter.projectIds !== null) {
    const projectId = task ? effectiveTaskProjectId(task, taskById) : null;
    // No-project tasks (and orphaned blocks) form an implicit "Unassigned"
    // bucket, selected via the literal id below (see CalendarFilterMenu).
    const bucketId = projectId || UNASSIGNED_PROJECT_ID;
    if (!filter.projectIds.includes(bucketId)) return false;
  }
  if (filter.labelIds !== null) {
    if (!task) return false;
    const effectiveLabels = effectiveTaskLabelIds(task, taskById);
    if (!filter.labelIds.some((id) => effectiveLabels.has(id))) return false;
  }
  return true;
}

/**
 * Filters `blocks` and `events` per `filter`. `taskById` may be a Map or a
 * plain object keyed by task id (both are supported, matching the two
 * conventions already used across the codebase — see effectiveTaskProjectId).
 */
export function filterCalendarItems(blocks, events, filter, taskById) {
  const filteredBlocks =
    filter.showMode === 'events'
      ? []
      : blocks.filter((b) => blockMatchesProjectAndLabel(b, filter, taskById));
  const filteredEvents = filter.showMode === 'tasks' ? [] : events;
  return { filteredBlocks, filteredEvents };
}

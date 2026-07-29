/**
 * ============================================================================
 * TODOIST SERVICE
 * ============================================================================
 * Thin wrapper around the unified Todoist API v1 (api.todoist.com/api/v1).
 * The old REST API v2 (api.todoist.com/rest/v2) was sunset in 2026 — this
 * service targets the current endpoint, which supports CORS from any origin
 * for authenticated requests (no proxy needed).
 *
 * READ ONLY: `fetchProjects()`, `fetchSections()`, `fetchTasks()` return our
 * internal Project[] / Section[] / Task[] shapes, so the rest of the app
 * never has to know about Todoist's field names. This is a ONE-TIME IMPORT,
 * not a two-way sync — SchedulerContext.importFromTodoist calls these three
 * exactly once per user-triggered "Import from Todoist" click, and nothing
 * in this app ever writes back to Todoist. Fields with no Todoist
 * equivalent (isLocked, minChunkHours, maxChunkHours, remainingHours, and
 * everything about ScheduledBlocks) are simply app-only.
 *
 * AUTH: Personal API token (Settings -> Integrations -> Developer in the
 * Todoist web app), passed as a Bearer token.
 *
 * DURATION RESOLUTION ORDER, per task (READ):
 *   1. Todoist's structured `duration` field, if set (most authoritative —
 *      the user explicitly set this in Todoist).
 *   2. A duration mentioned in free text in the task's description, then
 *      its title, parsed by `durationParser` (handles "2 hours", "~1.5hrs",
 *      "45 min", "1h 30m", "half an hour", etc. — see that module for the
 *      full list of supported phrasings).
 *   3. A short flat default (see DEFAULT_DURATION_HOURS below) — deliberately
 *      small so an un-estimated task doesn't eat a large, wrong chunk of
 *      calendar capacity; the user can always lengthen it after import.
 *
 * SUBTASKS: Todoist tasks with a `parent_id` become standalone Tasks here,
 * just like any top-level task, linked back to their parent via `parentId`
 * (see types/index.js). They're only schedulable once they carry their own
 * `dueDate` — see allocator.js's prioritizeTasks — so an undated sub-task
 * shows up in the Tasks/Board UI (nested under its parent) without ever
 * being allocated calendar time. Todoist allows nesting subtasks arbitrarily
 * deep; anything below the first level is flattened onto the nearest
 * top-level ancestor's `parentId` rather than preserving the intermediate
 * grouping (see `fetchTasks`'s `resolveTopAncestorId`).
 *
 * TASKS WITH NO DUE DATE: previously excluded entirely on import, since the
 * allocator can't compute a planning window for them. They are now KEPT —
 * Tasks list and Board view should mirror Todoist 1:1 regardless of
 * schedulability, and an undated task simply never gets scheduled onto the
 * calendar (the allocator/rebalance engine already skip tasks with no
 * `dueDate` — see allocator.js's `getTaskWindow`, which only special-cases
 * a due date if one is present, and rebalanceEngine, which only allocates
 * `remainingHours > 0` work within a computed window). No due date just
 * means "shows up everywhere except the calendar."
 *
 * RECURRING TASKS: Todoist tasks can carry a recurrence rule on `due`
 * (`due.is_recurring` + a natural-language `due.string`, e.g. "every day",
 * "every 2 weeks"). That metadata is captured on our Task as `isRecurring`
 * / `recurrenceString` purely for display + local completion handling (see
 * SchedulerContext.completeTask + utils/recurrence.js) — Todoist itself
 * remains the authority on the *exact* next occurrence once the task is
 * actually closed there.
 *
 * Recurrence DETECTION uses `isRecurringDue()` from utils/recurrence.js
 * rather than trusting `due.is_recurring` in isolation — that flag is
 * normally authoritative, but as a defensive fallback we also treat a task
 * as recurring if `due.string` itself is a parseable recurrence phrase (see
 * that module's doc comment for why: some tasks — particularly ones created
 * via quick-add natural-language parsing — have come back from the API
 * with the flag unset despite clearly repeating text).
 *
 * If no token is configured, every read function transparently falls back
 * to mock data, so the app is fully explorable and editable without any setup.
 * ============================================================================
 */

import { getMockTasks, getMockSections, getMockProjects } from './mockData';
import { extractDurationHours } from '../utils/durationParser';
import { isRecurringDue } from '../utils/recurrence';

const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

// Deliberately short: an un-estimated imported task should default to a
// small, easy-to-schedule sliver rather than silently eating an hour of
// calendar capacity. Users can lengthen it in-app once they know better.
const DEFAULT_DURATION_HOURS = 5 / 60; // 5 minutes

/** Map Todoist's 1-4 priority (4=urgent in Todoist's UI) to our Priority enum. */
function mapTodoistPriority(todoistPriority) {
  // Todoist: p1 (urgent, UI) = API value 4; p4 (lowest) = API value 1.
  switch (todoistPriority) {
    case 4:
      return 'urgent';
    case 3:
      return 'high';
    case 2:
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Resolve a task's estimated duration in hours, per the READ resolution
 * order documented above. Checks the structured field first, then
 * description, then title, then falls back to a short default.
 */
function resolveDurationHours(raw) {
  if (raw.duration) {
    // Todoist's `duration.unit` is only ever 'minute' or 'day' — there's no 'hour' unit.
    return raw.duration.unit === 'minute' ? raw.duration.amount / 60 : raw.duration.amount * 24;
  }

  const parsedFromDescription = extractDurationHours(raw.description);
  if (parsedFromDescription !== null) return parsedFromDescription;

  const parsedFromTitle = extractDurationHours(raw.content);
  if (parsedFromTitle !== null) return parsedFromTitle;

  return DEFAULT_DURATION_HOURS;
}

/**
 * Normalize a raw Todoist v1 task object into our internal Task shape.
 * @param {Object} raw - Raw task object from the Todoist v1 API.
 * @param {Map<string,string>} sectionsById - Resolved section id -> name lookup.
 * @param {string} [parentId] - This task's resolved top-level-ancestor TaskFlow id, if it's a Todoist sub-item.
 */
function normalizeTodoistTask(raw, sectionsById, parentId) {
  const durationHours = resolveDurationHours(raw);
  // See module doc comment: don't trust due.is_recurring in isolation.
  const isRecurring = isRecurringDue(raw.due);

  return {
    id: `todoist_${raw.id}`,
    todoistId: String(raw.id),
    title: raw.content,
    notes: raw.description || '',
    estimatedHours: durationHours,
    remainingHours: durationHours,
    priority: mapTodoistPriority(raw.priority),
    dueDate: raw.due?.date ?? null,
    isRecurring,
    // Natural-language recurrence phrasing straight from Todoist (e.g.
    // "every day", "every 2 weeks") — used to advance the due date locally
    // on completion (utils/recurrence.js) and to show a repeat icon in the
    // UI. Null for non-recurring tasks.
    recurrenceString: isRecurring ? raw.due?.string ?? null : null,
    projectId: raw.project_id != null ? String(raw.project_id) : null,
    // Stringified to match fetchSections()'s String(s.id) keys below — the
    // API doesn't consistently return section_id as the same type (string vs
    // number) across endpoints, and a type mismatch here silently breaks
    // section-name lookup and Board view's column grouping.
    sectionId: raw.section_id != null ? String(raw.section_id) : null,
    sectionName: raw.section_id != null ? sectionsById?.get(String(raw.section_id)) ?? null : null,
    // Raw Todoist label NAME strings (Todoist's `labels` field is an array
    // of names, not ids — there's no shared id space between a Todoist
    // account's labels and TaskFlow's local Label records). Resolving these
    // to real local `labelIds` (creating any that don't exist yet) happens
    // in SchedulerContext.importFromTodoist, which has access to the local
    // labels list this module intentionally doesn't know about.
    labelNames: Array.isArray(raw.labels) ? raw.labels : [],
    source: 'todoist',
    isLocked: false,
    isCompleted: false,
    minChunkHours: 0.5,
    maxChunkHours: Math.min(4, durationHours),
    createdAt: raw.added_at || raw.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parentId,
  };
}

/** Fetch all pages of a v1 cursor-paginated list endpoint. */
async function fetchAllPages(path, apiToken, params) {
  const results = [];
  let cursor = null;

  do {
    const url = new URL(`${TODOIST_API_BASE}${path}`);
    if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!res.ok) {
      throw new Error(`Todoist API error (${res.status}): ${res.statusText}`);
    }

    const page = await res.json();
    results.push(...(page.results ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor);

  return results;
}

// ============================================================================
// READ
// ============================================================================

/**
 * Fetch every Project in the user's Todoist account — used to populate the
 * Board view's project filter. Returns mock projects if no token is
 * configured, and [] on any request failure (a filter that can't populate
 * just falls back to "All projects").
 * @param {string|null} apiToken
 * @returns {Promise<import('../types').Project[]>}
 */
export async function fetchProjects(apiToken) {
  if (!apiToken) return getMockProjects();
  try {
    const raw = await fetchAllPages('/projects', apiToken);
    return raw.map((p) => ({ id: String(p.id), name: p.name, color: p.color, order: p.child_order ?? p.order ?? 0 }));
  } catch (err) {
    console.warn('[todoistService] Failed to fetch projects, project filter will be unavailable.', err);
    return [];
  }
}

/**
 * Fetch every Section across the user's Todoist account (used to label
 * Board view columns). Returns mock sections if no token is configured,
 * and [] on any request failure rather than throwing — sections are a
 * display nicety, not critical path.
 * @param {string|null} apiToken
 * @returns {Promise<import('../types').Section[]>}
 */
export async function fetchSections(apiToken) {
  if (!apiToken) return getMockSections();
  try {
    const rawSections = await fetchAllPages('/sections', apiToken);
    return rawSections.map((s) => ({ id: String(s.id), name: s.name, projectId: String(s.project_id), order: s.section_order ?? s.order ?? 0 }));
  } catch (err) {
    console.warn('[todoistService] Failed to fetch sections, board view will show "No Section" only.', err);
    return [];
  }
}

/**
 * Fetch active (incomplete) tasks from Todoist as one flat array — Todoist
 * sub-items (tasks with a `parent_id`) are returned as their own standalone
 * Task entries, linked back to their top-level ancestor via `parentId`,
 * rather than nested/grouped under their parent (see module doc comment).
 *
 * Tasks with NO due date are now included (previously excluded — see the
 * module doc comment above for why). They show up normally in the Tasks
 * list and Board view; the scheduling engine simply never places them on
 * the calendar, since it has no planning window to work with (and a
 * sub-task specifically needs its own due date to be schedulable at all —
 * see allocator.js's prioritizeTasks).
 *
 * @param {string|null} apiToken - Personal API token. If null/empty, mock data is used.
 * @param {Map<string,string>} [sectionsById] - Pre-fetched section id -> name map.
 * @returns {Promise<import('../types').Task[]>}
 */
export async function fetchTasks(apiToken, sectionsById) {
  if (!apiToken) {
    console.info('[todoistService] No API token configured — using mock data. See README for setup.');
    return getMockTasks();
  }

  const rawTasks = await fetchAllPages('/tasks', apiToken);
  const sectionMap = sectionsById || new Map();
  const byId = new Map(rawTasks.map((t) => [t.id, t]));

  // A child's parent_id may itself point at another child (a sub-subtask,
  // or deeper) rather than a top-level task. Walk up the chain to find the
  // nearest top-level ancestor so nothing gets silently dropped — Todoist
  // only surfaces one level of nesting here (see module doc comment), so
  // deeper nesting is flattened onto that top-level ancestor's `parentId`
  // rather than preserving the intermediate grouping.
  function resolveTopAncestorId(task) {
    const visited = new Set();
    let current = task;
    while (current.parent_id && byId.has(current.parent_id) && !visited.has(current.id)) {
      visited.add(current.id);
      current = byId.get(current.parent_id);
    }
    return current.id;
  }

  return rawTasks.map((raw) => {
    const parentId = raw.parent_id ? `todoist_${resolveTopAncestorId(raw)}` : undefined;
    return normalizeTodoistTask(raw, sectionMap, parentId);
  });
}

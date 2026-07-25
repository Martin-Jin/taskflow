/**
 * ============================================================================
 * TODOIST SERVICE
 * ============================================================================
 * Thin wrapper around the unified Todoist API v1 (api.todoist.com/api/v1).
 * The old REST API v2 (api.todoist.com/rest/v2) was sunset in 2026 — this
 * service targets the current endpoint, which supports CORS from any origin
 * for authenticated requests (no proxy needed).
 *
 * READ: `fetchProjects()`, `fetchSections()`, `fetchTasks()` return our
 * internal Project[] / Section[] / Task[] shapes, so the rest of the app
 * never has to know about Todoist's field names.
 *
 * WRITE (two-way sync): every task/subtask/section field that's editable in
 * this app and has a Todoist equivalent is pushed back via the functions
 * below (`createTask`, `updateTask`, `moveTask`, `deleteTask`,
 * `setTaskCompleted`, `createSubtask`, `setSubtaskCompleted`, `deleteSubtask`,
 * `createSection`, `renameSection`, `reorderSections`, `deleteSection`).
 * Fields with no Todoist equivalent (isLocked, minChunkHours, maxChunkHours,
 * remainingHours, and everything about ScheduledBlocks) are app-only and are
 * never sent to Todoist.
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
 * On WRITE, `estimatedHours` is always pushed back as Todoist's structured
 * `duration` field (in minutes) — this is the one authoritative, round-trip
 * safe field, so edits made in this app don't get silently re-parsed from
 * text and drift on the next sync.
 *
 * SUBTASKS: Todoist tasks with a `parent_id` are grouped under their parent
 * as `subtasks` (a simple checklist) rather than surfaced as independent,
 * schedulable Tasks — matching Todoist's own grouping and keeping the
 * scheduling engine from ever allocating time to a subtask on its own.
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
 * to mock data, and every write function no-ops (returns `{ mocked: true }`)
 * so the app is fully explorable and editable without any setup.
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

/** Inverse of mapTodoistPriority — our Priority enum -> Todoist's 1-4 scale. */
function priorityToTodoist(priority) {
  switch (priority) {
    case 'urgent':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

/**
 * Resolve a task's estimated duration in hours, per the READ resolution
 * order documented above. Checks the structured field first, then
 * description, then title, then falls back to a short default.
 */
function resolveDurationHours(raw) {
  if (raw.duration) {
    return raw.duration.unit === 'minute' ? raw.duration.amount / 60 : raw.duration.amount;
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
 * @param {Array<{id:string,title:string,isCompleted:boolean}>} [subtasks] - Pre-grouped child items.
 */
function normalizeTodoistTask(raw, sectionsById, subtasks) {
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
    source: 'todoist',
    isLocked: false,
    isCompleted: false,
    minChunkHours: 0.5,
    maxChunkHours: Math.min(4, durationHours),
    createdAt: raw.added_at || raw.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subtasks: subtasks || [],
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

/** Shared POST/DELETE helper for write endpoints. Returns parsed JSON, or null for 204/empty responses. */
async function request(method, path, apiToken, body) {
  const res = await fetch(`${TODOIST_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = await res.json();
      detail = errBody?.error || errBody?.error_tag || detail;
    } catch {
      /* response wasn't JSON — keep statusText */
    }
    throw new Error(`Todoist API error (${res.status}): ${detail}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
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
 * Create a new Project ("board") in Todoist.
 *
 * Free Todoist accounts are capped at 5 active projects; Pro/Business have
 * higher (but still finite) caps. When that cap is hit, Todoist responds
 * with a 403 and an error tag like "LIMITS_REACHED" (or similar wording,
 * which can vary — we match loosely on status 403 + a "limit" keyword
 * rather than relying on parsing the exact tag). We wrap that case as
 * `err.isLimitReached = true` so the caller (SchedulerContext.addProject)
 * can fall back to a local-only project and tell the user why, instead of
 * just surfacing a generic sync-failure toast.
 *
 * @param {string|null} apiToken
 * @param {string} name
 * @returns {Promise<Object>} the raw created Todoist project
 */
export async function createProject(apiToken, name) {
  if (!apiToken) return { mocked: true };
  try {
    return await request('POST', '/projects', apiToken, { name });
  } catch (err) {
    const message = String(err.message || '').toLowerCase();
    if (message.includes('403') || message.includes('limit')) {
      err.isLimitReached = true;
    }
    throw err;
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
 * Fetch active (incomplete) tasks from Todoist, grouping any sub-items
 * (tasks with a `parent_id`) under their parent as `subtasks` rather than
 * returning them as their own top-level Task.
 *
 * Tasks with NO due date are now included (previously excluded — see the
 * module doc comment above for why). They show up normally in the Tasks
 * list and Board view; the scheduling engine simply never places them on
 * the calendar, since it has no planning window to work with.
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

  const parents = rawTasks.filter((t) => !t.parent_id);
  const children = rawTasks.filter((t) => t.parent_id);

  const subtasksByParent = new Map();
  for (const child of children) {
    const list = subtasksByParent.get(child.parent_id) || [];
    list.push({
      id: `todoist_${child.id}`,
      todoistId: String(child.id),
      title: child.content,
      isCompleted: !!child.checked || !!child.is_completed,
    });
    subtasksByParent.set(child.parent_id, list);
  }

  return parents.map((t) => normalizeTodoistTask(t, sectionMap, subtasksByParent.get(t.id)));
}

// ============================================================================
// WRITE — Tasks
// ============================================================================

/** Build the Todoist v1 task payload fields shared by create/update. */
function buildTaskPayload(fields) {
  const payload = {};
  if (fields.title !== undefined) payload.content = fields.title;
  if (fields.notes !== undefined) payload.description = fields.notes;
  if (fields.priority !== undefined) payload.priority = priorityToTodoist(fields.priority);
  if (fields.estimatedHours !== undefined && fields.estimatedHours != null) {
    payload.duration = Math.max(1, Math.round(fields.estimatedHours * 60));
    payload.duration_unit = 'minute';
  }
  // Recurrence: Todoist's natural-language due-date parser is the only way
  // to set a recurrence rule via `due_string` (there's no separate
  // structured recurrence field). Sending both due_date and a recurring
  // due_string in the same call is contradictory to Todoist's API, so
  // due_string wins whenever recurrence is present — the due_string phrase
  // ("every day", "every 2 weeks") already encodes the date.
  if (fields.recurrenceString !== undefined && fields.recurrenceString) {
    payload.due_string = fields.recurrenceString;
  } else if (fields.dueDate !== undefined) {
    payload.due_date = fields.dueDate || null;
  }
  return payload;
}

/**
 * Create a new task directly in Todoist (used when a task added in-app
 * should be a "real" Todoist task rather than a local-only one — e.g. the
 * "Sync new tasks to Todoist" preference in Settings). Returns the raw
 * created task so the caller can normalize it and get a Todoist id.
 */
export async function createTask(apiToken, fields) {
  if (!apiToken) return { mocked: true };
  const payload = {
    ...buildTaskPayload(fields),
    project_id: fields.projectId ?? undefined,
    section_id: fields.sectionId ?? undefined,
  };
  return request('POST', '/tasks', apiToken, payload);
}

/**
 * Push edits to an existing Todoist task's content/description/priority/
 * due date/duration/recurrence. No-ops (mocked) if no token configured or
 * the task isn't Todoist-sourced.
 */
export async function updateTask(apiToken, todoistTaskId, fields) {
  if (!apiToken || !todoistTaskId) return { mocked: true };
  const payload = buildTaskPayload(fields);
  if (Object.keys(payload).length === 0) return { noop: true };
  return request('POST', `/tasks/${todoistTaskId}`, apiToken, payload);
}

/**
 * Move a task to a different Section and/or Project in Todoist — this is
 * what a Board-view drag/edit (changing which column a task lives in)
 * needs, since section/project moves are a separate endpoint from field
 * updates in the Todoist API.
 */
export async function moveTask(apiToken, todoistTaskId, { projectId, sectionId } = {}) {
  if (!apiToken || !todoistTaskId) return { mocked: true };
  const payload = {};
  if (sectionId !== undefined) payload.section_id = sectionId || null;
  if (projectId !== undefined) payload.project_id = projectId;
  if (Object.keys(payload).length === 0) return { noop: true };
  return request('POST', `/tasks/${todoistTaskId}/move`, apiToken, payload);
}

/** Delete a task in Todoist. */
export async function deleteTask(apiToken, todoistTaskId) {
  if (!apiToken || !todoistTaskId) return { mocked: true };
  return request('DELETE', `/tasks/${todoistTaskId}`, apiToken);
}

/**
 * Mark a task complete/incomplete back in Todoist (two-way sync when the
 * user completes a task, or a scheduled block, in-app).
 *
 * IMPORTANT for recurring tasks: calling `close` on a recurring Todoist
 * task does NOT delete/complete it server-side — Todoist advances its due
 * date to the next occurrence and leaves it active, exactly like clicking
 * the checkbox in the Todoist UI. This function still just calls
 * close/reopen either way; it's SchedulerContext's job to mirror that
 * "stays active, due date advances" behavior in local state immediately
 * (see completeTask in SchedulerContext.jsx + utils/recurrence.js) rather
 * than optimistically marking the task `isCompleted` the way a one-off
 * task would be.
 */
export async function setTaskCompleted(apiToken, todoistTaskId, isCompleted) {
  if (!apiToken || !todoistTaskId) return { mocked: true };
  const action = isCompleted ? 'close' : 'reopen';
  return request('POST', `/tasks/${todoistTaskId}/${action}`, apiToken);
}

// ============================================================================
// WRITE — Subtasks (Todoist child tasks)
// ============================================================================

/**
 * Create a subtask (a Todoist task with `parent_id` set) under a parent
 * task. Returns the raw created item so the caller can get its Todoist id.
 */
export async function createSubtask(apiToken, parentTodoistId, title) {
  if (!apiToken || !parentTodoistId) return { mocked: true };
  return request('POST', '/tasks', apiToken, { content: title, parent_id: parentTodoistId });
}

/** Toggle a subtask's completion state in Todoist. */
export async function setSubtaskCompleted(apiToken, subtaskTodoistId, isCompleted) {
  return setTaskCompleted(apiToken, subtaskTodoistId, isCompleted);
}

/** Delete a subtask in Todoist. */
export async function deleteSubtask(apiToken, subtaskTodoistId) {
  return deleteTask(apiToken, subtaskTodoistId);
}

/** Rename a subtask in Todoist. */
export async function renameSubtask(apiToken, subtaskTodoistId, title) {
  if (!apiToken || !subtaskTodoistId) return { mocked: true };
  return request('POST', `/tasks/${subtaskTodoistId}`, apiToken, { content: title });
}

// ============================================================================
// WRITE — Sections (Board view columns)
// ============================================================================

/** Create a new Section (Board column) under a project. */
export async function createSection(apiToken, projectId, name) {
  if (!apiToken || !projectId) return { mocked: true };
  return request('POST', '/sections', apiToken, { project_id: projectId, name });
}

/** Rename a Section. */
export async function renameSection(apiToken, sectionId, name) {
  if (!apiToken || !sectionId) return { mocked: true };
  return request('POST', `/sections/${sectionId}`, apiToken, { name });
}

/** Reorder Sections (Todoist expects the full new order list — see call sites). */
export async function reorderSections(apiToken, sectionOrders) {
  // sectionOrders: [{ id, section_order }]
  if (!apiToken || !sectionOrders?.length) return { mocked: true };
  return request('POST', '/sections/reorder', apiToken, { sections: sectionOrders });
}

/** Delete a Section. Tasks in it fall back to "No Section" in Todoist, matching our own "No Section" column. */
export async function deleteSection(apiToken, sectionId) {
  if (!apiToken || !sectionId) return { mocked: true };
  return request('DELETE', `/sections/${sectionId}`, apiToken);
}

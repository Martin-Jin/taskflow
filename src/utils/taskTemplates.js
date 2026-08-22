/**
 * ============================================================================
 * TASK TEMPLATES
 * ============================================================================
 * A template is a saved SHAPE OF WORK: a task and its sub-tasks, with their
 * estimates, dependencies and — the part that makes it useful — their due dates
 * stored as day OFFSETS rather than absolute dates. Instantiating one asks for
 * a single anchor date and rebuilds the whole shape around it.
 *
 * Recurrence already covers "this task, again". Nothing covered "this whole
 * process, again", so a repeating piece of work (an onboarding, a release, a
 * grant application) had to be rebuilt by hand every time, dependencies and
 * all.
 *
 * THE CENTRAL DESIGN DECISION: offsets are DERIVED FROM THE REAL DATES at save
 * time, not authored. `buildTemplateFromTasks` takes a subtree that already
 * exists, finds its earliest due date, and stores every task's offset as days
 * from that. Two things follow, and both are why it's done this way:
 *
 *   1. There is no offset-authoring UI to build or learn. You lay the work out
 *      once as ordinary tasks — which the app is already good at — and save the
 *      result. A template is therefore always a snapshot of a shape that
 *      actually worked, rather than a guess typed into a form.
 *   2. "Kickoff, then +3d, then +1w" needs no chain model. Chained offsets
 *      would need a topological pass and have no answer for a task with two
 *      predecessors or none; flattening to "days from the anchor" at save time
 *      preserves exactly the same shape with none of that.
 *
 * The anchor is the EARLIEST due date in the subtree, so every offset is >= 0
 * and the anchor date the user picks is when the first thing is due. Undated
 * tasks keep a null offset and come back undated — an undated task in the
 * original shape was deliberate.
 *
 * WHAT IS DELIBERATELY NOT CAPTURED:
 *   - **Project and section.** Chosen at instantiation instead, so one template
 *     works across projects. That's the whole point of having a template rather
 *     than duplicating a subtree.
 *   - **Recurrence.** A template of recurring tasks is two answers to the same
 *     question, and recurrence carries invariants (a parent and its sub-tasks
 *     must agree, plus an anchor/skip watermark — see utils/recurrenceState.js)
 *     that a rebuilt copy would have to reconstruct correctly. Instantiated
 *     tasks are plain one-offs; make one recurring afterwards if you want that.
 *   - **Comments, scheduled blocks, completion state, and the postponement
 *     counter.** All facts about one past instance, not about the shape.
 *   - **Dependencies pointing outside the subtree.** They'd reference a task
 *     that has nothing to do with the new instance. Dropped at save time.
 *
 * RETENTION: bounded twice over, per CLAUDE.md's rule that anything persisted
 * to Firestore needs a documented bound — MAX_TEMPLATES templates, each with at
 * most MAX_TEMPLATE_TASKS tasks. Both are far above real use; they exist so a
 * bug or a stuck retry can't grow the synced document without limit. No
 * time-based prune, because a named template is something the user expects to
 * keep until they delete it.
 * ============================================================================
 */

import { addDays, diffDays } from './dateUtils';

/** Upper bound on stored templates. A real user has a handful. */
export const MAX_TEMPLATES = 30;

/** Upper bound on tasks captured in one template. */
export const MAX_TEMPLATE_TASKS = 100;

export const MAX_TEMPLATE_NAME_LENGTH = 60;

/**
 * The task fields a template carries. Everything absent from this list is
 * either instance history (completion, comments, blocks, postponeCount),
 * chosen at instantiation (project, section), or deliberately excluded
 * (recurrence) — see the header.
 *
 * `dueDate` is NOT here: it becomes `dueDayOffset`. `parentId`/`dependsOn` are
 * NOT here either: they become template-local references.
 */
export const TEMPLATE_TASK_FIELDS = [
  'title',
  'notes',
  'estimatedHours',
  'priority',
  'isPassive',
  'enforceDueDate',
  'excludeFromAutoSchedule',
  'fixedTime',
  'preferredTimeOfDay',
  'earliestDate',
  'maxChunkHours',
  'labelIds',
];

/**
 * Orders a subtree parent-before-child, so instantiation can wire each task's
 * parent in a single forward pass.
 *
 * Depth is computed by walking up `parentId` within the given set rather than
 * assuming the input order — callers pass whatever `getAllDescendants` gave
 * them, and relying on its ordering would silently break if that changed.
 */
function orderParentsFirst(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depthOf = (task) => {
    let depth = 0;
    let cursor = task;
    // Bounded by the set size, so a corrupt parent cycle can't spin forever.
    while (cursor?.parentId && byId.has(cursor.parentId) && depth <= tasks.length) {
      cursor = byId.get(cursor.parentId);
      depth += 1;
    }
    return depth;
  };
  return [...tasks].sort((a, b) => depthOf(a) - depthOf(b));
}

/**
 * Captures a task subtree as a reusable template.
 *
 * @param {{name: string, tasks: import('../types').Task[]}} input - `tasks` is
 *   the root plus every descendant, in any order.
 * @param {object[]} existingTemplates - for name-collision and cap checks
 * @param {() => string} makeId - id factory, injected so this stays pure/testable
 * @returns {{ok: true, template: object} | {ok: false, error: string}}
 */
export function buildTemplateFromTasks({ name, tasks }, existingTemplates = [], makeId = () => crypto.randomUUID()) {
  const trimmedName = (name || '').trim();
  const source = (tasks || []).filter(Boolean);

  if (!trimmedName) return { ok: false, error: 'Give the template a name.' };
  if (trimmedName.length > MAX_TEMPLATE_NAME_LENGTH) {
    return { ok: false, error: `Keep the name under ${MAX_TEMPLATE_NAME_LENGTH} characters.` };
  }
  if (source.length === 0) return { ok: false, error: 'Nothing to save as a template.' };
  if (source.length > MAX_TEMPLATE_TASKS) {
    return { ok: false, error: `A template can hold up to ${MAX_TEMPLATE_TASKS} tasks — this one has ${source.length}.` };
  }
  if (existingTemplates.some((t) => t.name.toLowerCase() === trimmedName.toLowerCase())) {
    return { ok: false, error: 'A template with that name already exists.' };
  }
  if (existingTemplates.length >= MAX_TEMPLATES) {
    return { ok: false, error: `You can keep up to ${MAX_TEMPLATES} templates — delete one to add another.` };
  }

  const ordered = orderParentsFirst(source);
  // Real task id -> template-local id, so parent and dependency references
  // survive as internal pointers instead of ids that mean nothing once the
  // original tasks are gone.
  const localIdByTaskId = new Map(ordered.map((t) => [t.id, makeId()]));

  // The anchor: earliest due date in the shape, so every offset is >= 0 and the
  // date the user picks at instantiation is when the first thing comes due.
  const dueDates = ordered.map((t) => t.dueDate).filter(Boolean).sort();
  const anchor = dueDates[0] || null;

  const templateTasks = ordered.map((t) => {
    const entry = { localId: localIdByTaskId.get(t.id) };
    for (const field of TEMPLATE_TASK_FIELDS) {
      if (t[field] !== undefined && t[field] !== null) entry[field] = t[field];
    }
    entry.parentLocalId = t.parentId && localIdByTaskId.has(t.parentId) ? localIdByTaskId.get(t.parentId) : null;
    entry.dueDayOffset = anchor && t.dueDate ? diffDays(anchor, t.dueDate) : null;
    // Only dependencies inside the captured subtree survive — see the header.
    entry.dependsOnLocalIds = (t.dependsOn || [])
      .filter((id) => localIdByTaskId.has(id))
      .map((id) => localIdByTaskId.get(id));
    return entry;
  });

  return {
    ok: true,
    template: {
      id: makeId(),
      name: trimmedName,
      createdAt: Date.now(),
      tasks: templateTasks,
    },
  };
}

/**
 * Plans the tasks to create from a template, with every reference resolved to
 * real ids.
 *
 * Returns task inputs rather than creating anything, so the caller can commit
 * all of them in ONE transaction — a template instantiation should be a single
 * undo step, not one per task.
 *
 * @param {object} template
 * @param {{anchorDate: string, projectId?: string|null, sectionId?: string|null, validLabelIds?: Set<string>}} options
 * @param {() => string} makeId - id factory for the new tasks
 * @returns {{id: string}[]} task objects, parents before children
 */
export function planTemplateInstantiation(template, options, makeId) {
  const { anchorDate, projectId = null, sectionId = null, validLabelIds = null } = options || {};
  const source = template?.tasks || [];
  const realIdByLocalId = new Map(source.map((t) => [t.localId, makeId()]));

  return source.map((entry) => {
    const task = { id: realIdByLocalId.get(entry.localId) };
    for (const field of TEMPLATE_TASK_FIELDS) {
      if (entry[field] !== undefined) task[field] = entry[field];
    }
    // A label deleted since the template was saved would otherwise leave a
    // dangling id on every task this creates, forever.
    if (validLabelIds && task.labelIds) {
      task.labelIds = task.labelIds.filter((id) => validLabelIds.has(id));
    }
    task.projectId = projectId;
    task.sectionId = sectionId;
    task.parentId = entry.parentLocalId ? realIdByLocalId.get(entry.parentLocalId) : undefined;
    task.dueDate = entry.dueDayOffset === null || entry.dueDayOffset === undefined || !anchorDate
      ? null
      : addDays(anchorDate, entry.dueDayOffset);
    task.dependsOn = (entry.dependsOnLocalIds || []).map((id) => realIdByLocalId.get(id)).filter(Boolean);
    return task;
  });
}

/**
 * Templates in display order: alphabetical by name, for the same reason saved
 * views are (see utils/savedViews.js) — a list you go looking for by name
 * shouldn't rearrange itself as you use it.
 */
export function sortTemplates(templates) {
  return [...(templates || [])].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One-line summary for a template row: how many tasks, and how long the shape
 * spans. The span is what tells you whether this is a same-day checklist or a
 * three-week process, which the task count alone doesn't.
 */
export function describeTemplate(template) {
  const tasks = template?.tasks || [];
  const count = tasks.length;
  const taskPart = `${count} task${count === 1 ? '' : 's'}`;
  const offsets = tasks.map((t) => t.dueDayOffset).filter((o) => typeof o === 'number');
  if (offsets.length === 0) return `${taskPart}, no due dates`;
  const span = Math.max(...offsets);
  if (span === 0) return `${taskPart}, all due on the anchor date`;
  return `${taskPart} over ${span + 1} days`;
}

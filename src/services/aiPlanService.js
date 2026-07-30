/**
 * ============================================================================
 * AI ASSISTANT PLAN RESOLUTION & VALIDATION
 * ============================================================================
 * Turns the worker's raw `operations[]` (see cloudflare-worker/src/index.js,
 * Stage B) into a validated, confirm-screen-ready plan (TODO.md's "AI
 * Assistant upgrade", Stage C): resolves `new:<n>` local ids declared by
 * create_* operations, validates every reference an operation makes against
 * either the real workspace (`context`) or another operation's declared
 * local id, detects dependency/parent cycles across the MERGED graph
 * (existing tasks + this plan's creates/updates), and computes a safe apply
 * order (creates before anything that references them).
 *
 * Nothing here talks to Firestore or SchedulerContext — this is pure
 * validation/derivation over plain data, so it's trivially testable and so
 * Stage D (the confirm screen) only has to render what this produces rather
 * than re-deriving any of it.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Per-operation shape: which entity kind it creates (if any), which field
// holds the id of the existing entity it targets (for update/delete), and
// which fields are references that must resolve to a real or local id of a
// given kind. Mirrors the OPERATIONS table in cloudflare-worker/src/index.js
// — kept here as data, not re-derived from the worker file, since the client
// and worker are deployed independently (see cloudflare-worker/README.md).
// ---------------------------------------------------------------------------
const OP_SHAPES = {
  create_task: { creates: 'task', refFields: [{ field: 'projectId', kind: 'project' }, { field: 'sectionId', kind: 'section' }, { field: 'parentId', kind: 'task' }, { field: 'dependsOn', kind: 'task', multi: true }, { field: 'labelIds', kind: 'label', multi: true }] },
  update_task: { target: { field: 'taskId', kind: 'task' }, refFields: [{ field: 'projectId', kind: 'project' }, { field: 'sectionId', kind: 'section' }, { field: 'parentId', kind: 'task' }, { field: 'dependsOn', kind: 'task', multi: true }, { field: 'labelIds', kind: 'label', multi: true }] },
  delete_task: { target: { field: 'taskId', kind: 'task' }, refFields: [] },
  create_event: { creates: 'event', refFields: [] },
  update_event: { target: { field: 'eventId', kind: 'event' }, refFields: [] },
  delete_event: { target: { field: 'eventId', kind: 'event' }, refFields: [] },
  create_project: { creates: 'project', refFields: [] },
  rename_project: { target: { field: 'projectId', kind: 'project' }, refFields: [] },
  delete_project: { target: { field: 'projectId', kind: 'project' }, refFields: [] },
  create_section: { creates: 'section', refFields: [{ field: 'projectId', kind: 'project' }] },
  rename_section: { target: { field: 'sectionId', kind: 'section' }, refFields: [] },
  delete_section: { target: { field: 'sectionId', kind: 'section' }, refFields: [] },
  create_label: { creates: 'label', refFields: [] },
};

const KIND_TO_CONTEXT_KEY = { project: 'projects', section: 'sections', label: 'labels', task: 'tasks', event: 'events' };
const KIND_DISPLAY_FIELD = { project: 'name', section: 'name', label: 'name', task: 'title', event: 'title' };

function isLocalId(id) {
  return typeof id === 'string' && /^new:\d+$/.test(id);
}

function buildRealIdRegistry(context) {
  const registry = {};
  for (const kind of Object.keys(KIND_TO_CONTEXT_KEY)) {
    const entities = context[KIND_TO_CONTEXT_KEY[kind]] || [];
    registry[kind] = new Map(entities.map((e) => [e.id, e]));
  }
  return registry;
}

/**
 * @param {Array<Object>} operations - raw operations from the worker (each has `op` plus its fields).
 * @param {{ projects: Array, sections: Array, labels: Array, tasks: Array, events: Array }} context - current workspace state (same shape as aiContextService's input).
 * @returns {{ entries: Array, applyOrder: number[] }}
 *   entries[i] = { index, operation, valid, errors: string[], creates: {kind, localId}|null, humanDescription, changedFields: string[] }
 *   applyOrder = indices into `entries`, in a safe apply sequence (creates before their dependents); only includes entries that end up valid.
 */
export function resolvePlan(operations, context) {
  const realIds = buildRealIdRegistry(context);

  // Pass 1: collect local id declarations (kind + declaring operation index), catch duplicates.
  const localIdOwner = new Map(); // localId -> { kind, index }
  const duplicateLocalIdErrors = new Map(); // index -> error string
  operations.forEach((operation, index) => {
    const shape = OP_SHAPES[operation.op];
    if (!shape || !shape.creates || !operation.localId) return;
    if (localIdOwner.has(operation.localId)) {
      duplicateLocalIdErrors.set(index, `Duplicate localId "${operation.localId}" — already declared by another operation in this plan.`);
    } else {
      localIdOwner.set(operation.localId, { kind: shape.creates, index });
    }
  });

  // Deleted-in-this-plan ids, per kind — referencing one of these is always an error.
  const deletedIds = { project: new Set(), section: new Set(), label: new Set(), task: new Set(), event: new Set() };
  operations.forEach((operation) => {
    const shape = OP_SHAPES[operation.op];
    if (shape && shape.target && operation.op.startsWith('delete_')) {
      deletedIds[shape.target.kind].add(operation[shape.target.field]);
    }
  });

  function idIsKnown(kind, id) {
    if (isLocalId(id)) return localIdOwner.get(id)?.kind === kind;
    return realIds[kind].has(id);
  }

  // Pass 2: per-operation structural validation (unknown op, unknown target, unknown/wrong-kind references, deleted-in-plan references).
  const entries = operations.map((operation, index) => {
    const errors = [];
    const shape = OP_SHAPES[operation.op];
    if (!shape) {
      errors.push(`Unknown operation "${operation.op}".`);
      return { index, operation, valid: false, errors, creates: null };
    }
    if (duplicateLocalIdErrors.has(index)) errors.push(duplicateLocalIdErrors.get(index));

    if (shape.target) {
      const id = operation[shape.target.field];
      if (!idIsKnown(shape.target.kind, id)) {
        errors.push(`${shape.target.field} "${id}" does not match any existing ${shape.target.kind} in this workspace.`);
      } else if (deletedIds[shape.target.kind].has(id) && !operation.op.startsWith('delete_')) {
        errors.push(`${shape.target.field} "${id}" is also being deleted by another operation in this plan.`);
      }
    }

    for (const ref of shape.refFields) {
      const raw = operation[ref.field];
      if (raw === undefined) continue;
      const ids = ref.multi ? raw : [raw];
      for (const id of ids) {
        if (!idIsKnown(ref.kind, id)) {
          errors.push(`${ref.field} references unknown ${ref.kind} "${id}".`);
        } else if (deletedIds[ref.kind].has(id)) {
          errors.push(`${ref.field} references ${ref.kind} "${id}", which is also being deleted by another operation in this plan.`);
        }
      }
    }

    return {
      index,
      operation,
      valid: errors.length === 0,
      errors,
      creates: shape.creates ? { kind: shape.creates, localId: operation.localId } : null,
    };
  });

  // Pass 3: cascading invalidation — an operation referencing a local id whose
  // declaring create-operation is itself invalid can never actually apply.
  // Fixed-point loop since invalidity can cascade transitively (a chain of
  // dependent creates).
  let changed = true;
  let iterations = 0;
  while (changed && iterations < operations.length + 1) {
    changed = false;
    iterations += 1;
    for (const entry of entries) {
      if (!entry.valid) continue;
      const shape = OP_SHAPES[entry.operation.op];
      const refIds = [];
      if (shape.target && isLocalId(entry.operation[shape.target.field])) refIds.push(entry.operation[shape.target.field]);
      for (const ref of shape.refFields) {
        const raw = entry.operation[ref.field];
        if (raw === undefined) continue;
        for (const id of ref.multi ? raw : [raw]) if (isLocalId(id)) refIds.push(id);
      }
      for (const id of refIds) {
        const owner = localIdOwner.get(id);
        if (owner && !entries[owner.index].valid) {
          entry.valid = false;
          entry.errors.push(`Depends on "${id}", which failed validation and will not be created.`);
          changed = true;
        }
      }
    }
  }

  // Pass 4: dependency/parent cycle detection over the MERGED graph — existing
  // tasks overlaid with this plan's create_task/update_task changes. Only
  // considers currently-valid operations; a cycle here invalidates every
  // operation that contributes an edge to it (not just one arbitrary side).
  const dependsEdges = new Map(); // id -> [ids]
  const parentEdges = new Map();
  const edgeSource = new Map(); // "dependsOn:childId->depId" or "parent:childId->parentId" -> operation index, for attributing cycle errors

  for (const t of context.tasks || []) {
    dependsEdges.set(t.id, [...(t.dependsOn || [])]);
    if (t.parentId) parentEdges.set(t.id, t.parentId);
  }
  for (const entry of entries) {
    if (!entry.valid) continue;
    const op = entry.operation;
    if (op.op === 'create_task' || op.op === 'update_task') {
      const nodeId = op.op === 'create_task' ? op.localId : op.taskId;
      if (op.dependsOn !== undefined) {
        dependsEdges.set(nodeId, op.dependsOn);
        op.dependsOn.forEach((depId) => edgeSource.set(`depends:${nodeId}->${depId}`, entry.index));
      }
      if (op.parentId !== undefined) {
        if (op.parentId) {
          parentEdges.set(nodeId, op.parentId);
          edgeSource.set(`parent:${nodeId}->${op.parentId}`, entry.index);
        } else {
          parentEdges.delete(nodeId);
        }
      }
    }
  }

  function findCycleNodes(edges) {
    const UNVISITED = 0, VISITING = 1, DONE = 2;
    const state = new Map();
    const cyclic = new Set();
    const stack = [];
    function visit(node) {
      state.set(node, VISITING);
      stack.push(node);
      const neighbors = edges.get(node);
      const list = Array.isArray(neighbors) ? neighbors : neighbors ? [neighbors] : [];
      for (const next of list) {
        const s = state.get(next);
        if (s === VISITING) {
          const startIdx = stack.indexOf(next);
          for (let i = startIdx; i < stack.length; i++) cyclic.add(stack[i]);
        } else if (s === undefined || s === UNVISITED) {
          visit(next);
        }
      }
      stack.pop();
      state.set(node, DONE);
    }
    for (const node of edges.keys()) {
      if (!state.has(node)) visit(node);
    }
    return cyclic;
  }

  const dependsCycleNodes = findCycleNodes(dependsEdges);
  const parentCycleNodes = findCycleNodes(parentEdges);

  if (dependsCycleNodes.size > 0 || parentCycleNodes.size > 0) {
    for (const entry of entries) {
      if (!entry.valid) continue;
      const op = entry.operation;
      const nodeId = op.op === 'create_task' ? op.localId : op.taskId;
      if (!nodeId) continue;
      if (dependsCycleNodes.has(nodeId)) {
        entry.valid = false;
        entry.errors.push('Part of a dependency cycle (dependsOn) — tasks cannot wait on each other in a loop.');
      }
      if (parentCycleNodes.has(nodeId)) {
        entry.valid = false;
        entry.errors.push('Part of a subtask/parent cycle — a task cannot be its own ancestor.');
      }
    }
  }

  // Pass 5: human-readable description + changed-field list, using real
  // workspace names and this plan's own declared names for local ids.
  const realNames = {};
  for (const kind of Object.keys(KIND_TO_CONTEXT_KEY)) {
    realNames[kind] = new Map((context[KIND_TO_CONTEXT_KEY[kind]] || []).map((e) => [e.id, e[KIND_DISPLAY_FIELD[kind]]]));
  }
  const localNames = { project: new Map(), section: new Map(), label: new Map(), task: new Map(), event: new Map() };
  for (const entry of entries) {
    const shape = OP_SHAPES[entry.operation.op];
    if (shape?.creates && entry.operation.localId) {
      const display = entry.operation.name || entry.operation.title || entry.operation.localId;
      localNames[shape.creates].set(entry.operation.localId, display);
    }
  }
  function nameFor(kind, id) {
    if (id === undefined || id === null || id === '') return null;
    if (isLocalId(id)) return localNames[kind].get(id) || `new ${kind} (${id})`;
    return realNames[kind].get(id) || `unknown ${kind} (${id})`;
  }

  for (const entry of entries) {
    entry.humanDescription = describeOperation(entry.operation, context, nameFor);
    entry.changedFields = OP_SHAPES[entry.operation.op]?.creates
      ? Object.keys(entry.operation).filter((k) => k !== 'op' && k !== 'localId')
      : Object.keys(entry.operation).filter((k) => k !== 'op' && !k.endsWith('Id'));
  }

  // Pass 6: apply order — topological sort so a create is always ordered
  // before any (valid) operation referencing its localId. Delete operations
  // are pushed after everything else, since Pass 2 already rejects any
  // reference to a deleted-in-plan id, so deletes never need to precede
  // anything valid.
  const validIndices = entries.filter((e) => e.valid).map((e) => e.index);
  const dependsOnOp = new Map(validIndices.map((i) => [i, new Set()])); // opIndex -> set of opIndex it must follow
  for (const i of validIndices) {
    const op = operations[i];
    const shape = OP_SHAPES[op.op];
    const refIds = [];
    if (shape.target && isLocalId(op[shape.target.field])) refIds.push(op[shape.target.field]);
    for (const ref of shape.refFields) {
      const raw = op[ref.field];
      if (raw === undefined) continue;
      for (const id of ref.multi ? raw : [raw]) if (isLocalId(id)) refIds.push(id);
    }
    for (const id of refIds) {
      const owner = localIdOwner.get(id);
      if (owner && owner.index !== i) dependsOnOp.get(i).add(owner.index);
    }
  }
  const applyOrder = [];
  const placed = new Set();
  function place(i) {
    if (placed.has(i)) return;
    placed.add(i); // mark in-progress to guard against any residual cycle
    for (const dep of dependsOnOp.get(i)) place(dep);
    applyOrder.push(i);
  }
  // Non-delete first (in original order), then deletes, both respecting the dependency ordering above.
  for (const i of validIndices) if (!operations[i].op.startsWith('delete_')) place(i);
  for (const i of validIndices) if (operations[i].op.startsWith('delete_')) place(i);

  return { entries, applyOrder };
}

function describeOperation(op, context, nameFor) {
  switch (op.op) {
    case 'create_task':
      return `Create task "${op.title}"${describeTaskPlacement(op, nameFor)}`;
    case 'update_task':
      return `Update task "${nameFor('task', op.taskId)}"${describeTaskPlacement(op, nameFor)}`;
    case 'delete_task':
      return `Delete task "${nameFor('task', op.taskId)}"`;
    case 'create_event':
      return `Create event "${op.title}" on ${op.date} ${op.startTime}–${op.endTime}`;
    case 'update_event':
      return `Update event "${nameFor('event', op.eventId)}"`;
    case 'delete_event':
      return `Delete event "${nameFor('event', op.eventId)}"`;
    case 'create_project':
      return `Create project "${op.name}"`;
    case 'rename_project':
      return `Rename project "${nameFor('project', op.projectId)}" to "${op.name}"`;
    case 'delete_project':
      return `Delete project "${nameFor('project', op.projectId)}"`;
    case 'create_section':
      return `Create section "${op.name}" in project "${nameFor('project', op.projectId)}"`;
    case 'rename_section':
      return `Rename section "${nameFor('section', op.sectionId)}" to "${op.name}"`;
    case 'delete_section':
      return `Delete section "${nameFor('section', op.sectionId)}"`;
    case 'create_label':
      return `Create label "${op.name}"`;
    default:
      return op.op;
  }
}

function describeTaskPlacement(op, nameFor) {
  const bits = [];
  if (op.projectId !== undefined) bits.push(`project: ${nameFor('project', op.projectId) || 'none'}`);
  if (op.sectionId !== undefined) bits.push(`section: ${nameFor('section', op.sectionId) || 'none'}`);
  if (op.parentId !== undefined) bits.push(`subtask of: ${nameFor('task', op.parentId) || 'none'}`);
  if (op.dependsOn !== undefined) {
    bits.push(op.dependsOn.length ? `depends on: ${op.dependsOn.map((id) => nameFor('task', id)).join(', ')}` : 'depends on: none');
  }
  if (op.dueDate !== undefined) bits.push(`due: ${op.dueDate || 'none'}`);
  return bits.length ? ` (${bits.join('; ')})` : '';
}

// ---------------------------------------------------------------------------
// Stage D: applying the confirmed subset of a plan against SchedulerContext's
// real mutation functions.
// ---------------------------------------------------------------------------

// Same fallback AIQuickAddModal/AddTaskModal use for a task with no stated
// duration — keeps create_task behavior consistent across both entry points.
const DEFAULT_ESTIMATED_HOURS = 5 / 60;

// Reference-id fields where an explicit "" from the AI means "clear this
// field" (see the update_task/update_event tool descriptions in
// cloudflare-worker/src/index.js) — normalized to `null` to match this app's
// own null-means-unset convention, rather than leaving a stray empty string.
const NULLABLE_ON_EMPTY = new Set(['projectId', 'sectionId', 'parentId', 'dueDate', 'fixedTime', 'recurrenceString']);

/** Replaces every new:<n> reference in `op`'s fields with its resolved real id, via `idMap`. Throws if a referenced local id was never resolved (should not happen given a correct applyOrder). */
function resolveRefs(op, idMap) {
  const shape = OP_SHAPES[op.op];
  const resolved = { ...op };
  function resolveOne(id) {
    if (!isLocalId(id)) return id;
    if (!idMap.has(id)) throw new Error(`Internal error: "${id}" was referenced before it was created.`);
    return idMap.get(id);
  }
  if (shape.target && isLocalId(resolved[shape.target.field])) {
    resolved[shape.target.field] = resolveOne(resolved[shape.target.field]);
  }
  for (const ref of shape.refFields) {
    if (resolved[ref.field] === undefined) continue;
    resolved[ref.field] = ref.multi ? resolved[ref.field].map(resolveOne) : resolveOne(resolved[ref.field]);
  }
  return resolved;
}

/** Extracts just the content fields (no `op`/localId/target-id) from a resolved operation, normalizing "clear" sentinels to null. */
function contentFields(op, excludeKeys) {
  const out = {};
  for (const [key, value] of Object.entries(op)) {
    if (excludeKeys.has(key)) continue;
    out[key] = value === '' && NULLABLE_ON_EMPTY.has(key) ? null : value;
  }
  return out;
}

/**
 * Applies the checked, valid subset of a resolved plan (see resolvePlan)
 * against the live SchedulerContext, in `applyOrder` so every create runs
 * before anything referencing its localId. Label creations are batched into
 * one getOrCreateLabelIds call up front (that helper already dedupes/creates
 * many at once) rather than one call per label, since separate back-to-back
 * calls would each read the same stale `labels` closure and could hand out
 * duplicate ids — see SchedulerContext.jsx's getOrCreateLabelIds.
 *
 * @param {{ entries: Array, applyOrder: number[] }} plan - resolvePlan's output.
 * @param {Set<number>} checkedIndices - entry indices the user left checked on the confirm screen.
 * @param {Object} mutators - { addTask, updateTask, deleteTask, addManualEvent, updateEvent, deleteEvent, addProject, renameProject, deleteProject, addSection, renameSection, deleteSection, getOrCreateLabelIds } from useScheduler().
 * @returns {Array<{ index: number, ok: boolean, error?: string }>}
 */
export function applyPlan({ entries, applyOrder }, checkedIndices, mutators) {
  const idMap = new Map();
  const results = [];

  const labelCreateIndices = applyOrder.filter((i) => checkedIndices.has(i) && entries[i].operation.op === 'create_label');
  if (labelCreateIndices.length > 0) {
    const names = labelCreateIndices.map((i) => entries[i].operation.name);
    const ids = mutators.getOrCreateLabelIds(names);
    labelCreateIndices.forEach((i, position) => idMap.set(entries[i].operation.localId, ids[position]));
  }

  for (const i of applyOrder) {
    if (!checkedIndices.has(i)) continue;
    const entry = entries[i];
    if (entry.operation.op === 'create_label') {
      results.push({ index: i, ok: true });
      continue;
    }
    try {
      const resolved = resolveRefs(entry.operation, idMap);
      switch (resolved.op) {
        case 'create_task': {
          const fields = contentFields(resolved, new Set(['op', 'localId']));
          if (fields.estimatedHours === undefined) fields.estimatedHours = DEFAULT_ESTIMATED_HOURS;
          const created = mutators.addTask(fields);
          idMap.set(resolved.localId, created.id);
          break;
        }
        case 'update_task':
          mutators.updateTask(resolved.taskId, contentFields(resolved, new Set(['op', 'taskId'])));
          break;
        case 'delete_task':
          mutators.deleteTask(resolved.taskId);
          break;
        case 'create_event': {
          const created = mutators.addManualEvent(contentFields(resolved, new Set(['op', 'localId'])));
          idMap.set(resolved.localId, created.id);
          break;
        }
        case 'update_event':
          mutators.updateEvent(resolved.eventId, contentFields(resolved, new Set(['op', 'eventId'])));
          break;
        case 'delete_event':
          mutators.deleteEvent(resolved.eventId);
          break;
        case 'create_project': {
          const created = mutators.addProject(resolved.name);
          idMap.set(resolved.localId, created.id);
          break;
        }
        case 'rename_project':
          mutators.renameProject(resolved.projectId, resolved.name);
          break;
        case 'delete_project':
          mutators.deleteProject(resolved.projectId);
          break;
        case 'create_section': {
          const created = mutators.addSection(resolved.projectId, resolved.name);
          idMap.set(resolved.localId, created.id);
          break;
        }
        case 'rename_section':
          mutators.renameSection(resolved.sectionId, resolved.name);
          break;
        case 'delete_section':
          mutators.deleteSection(resolved.sectionId);
          break;
        default:
          throw new Error(`Unhandled operation "${resolved.op}".`);
      }
      results.push({ index: i, ok: true });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message });
    }
  }

  return results;
}

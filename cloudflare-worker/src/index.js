/**
 * ============================================================================
 * TASKFLOW AI ASSISTANT — Cloudflare Worker proxy
 * ============================================================================
 * Stateless proxy that turns a free-form request (+ optional screenshot) and
 * a full snapshot of the user's workspace (`contextMarkdown`, built by
 * src/services/aiContextService.js's buildAIContext) into a PROPOSED PLAN —
 * a list of create/update/delete operations across tasks, events, projects,
 * sections, and labels — via Claude or Gemini's tool/function-calling. This
 * worker never applies anything itself; it only collects every tool call the
 * model makes into a flat `operations[]` array and returns it. The client
 * (see src/services/aiPlanService.js, Stage C) is responsible for resolving
 * local ids, validating every reference, and driving the confirm-screen/
 * apply flow (Stage D) — none of that id-existence validation happens here,
 * since this worker has no access to Firestore and only ever sees whatever
 * `contextMarkdown` the client sent for this one request.
 *
 * This is bring-your-own-key (BYOK): the worker holds no secrets of its own.
 * Each request carries the caller's own Anthropic/Gemini API key (`apiKey` in
 * the POST body, see below), which this worker forwards straight through to
 * the relevant provider and never logs or persists. The client is
 * responsible for sourcing that key from the visitor's own Settings — this
 * worker exists purely to solve CORS (browsers can't call Anthropic/Gemini
 * directly). See README.md in this directory for deployment steps.
 *
 * No persistence, no rate-limiting store (KV/Durable Object) — this is a
 * personal-scale app; the size/shape guards below are the only abuse guard.
 * ============================================================================
 */

import { handleExchangeCode, handleRefreshToken, handleDisconnect } from './googleCalendarAuthRoutes.js';

const CALENDAR_ROUTES = {
  '/calendar/exchange-code': handleExchangeCode,
  '/calendar/refresh-token': handleRefreshToken,
  '/calendar/disconnect': handleDisconnect,
};

const MAX_TEXT_CHARS = 4000;
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024; // ~5MB of base64 text
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Sanity ceiling on contextMarkdown, NOT a feature-level truncation — the
// design intent (see TODO.md) is to always send the user's full active
// workspace with no capping. This only guards against a client-side bug
// accidentally sending something pathological (e.g. duplicated data).
const MAX_CONTEXT_CHARS = 400_000;

// Curated per-provider model allowlist — NOT free text, so a typo'd model id
// can't silently 400 the request; the client's own copy of this same catalog
// lives in src/services/aiModels.js (a separate deployable project, so it
// can't literally import this file — keep both in sync by hand). Every
// id/claim below confirmed directly against each provider's own docs as of
// 2026-07-30:
// Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models/overview
//   (claude-sonnet-5 is a pinned snapshot for this model generation, not a
//   floating alias, per Anthropic's dateless-id versioning note there.)
//   claude-sonnet-5 has ADAPTIVE thinking on by default (no request field
//   needed) and remains compatible with forced tool_choice. Claude Haiku
//   4.5 supports only MANUAL extended thinking (thinking.type:"enabled"),
//   which per https://platform.claude.com/docs/en/build-with-claude/thinking
//   ("Tool choice limitation (manual mode)") is INCOMPATIBLE with a forced
//   tool_choice ("any"/named tool) — using both together errors. So Haiku
//   requests use thinking + tool_choice:"auto" instead of the "any" every
//   other model uses; see callAnthropic below. That trades away the
//   guaranteed-at-least-one-tool-call property for this one model/config —
//   an occasional "the AI proposed no changes" response is an accepted
//   cost of getting reasoning out of the cheapest tier.
// Gemini: https://ai.google.dev/gemini-api/docs/models,
//   https://ai.google.dev/gemini-api/docs/thinking
//   (a floating "gemini-flash-latest" alias also exists, but Google's own
//   docs recommend pinning to a specific stable string in production
//   instead, since the alias silently hot-swaps to whatever's newest.)
//   Both Gemini models below have thinking ON BY DEFAULT with no request
//   field needed, and Google's docs don't document any forced-function-
//   calling incompatibility the way Anthropic's manual mode has, so no
//   special-casing is needed on the Gemini side.
const MODEL_CATALOG = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', requiresManualThinking: true },
    { id: 'claude-sonnet-5' },
  ],
  gemini: [{ id: 'gemini-3.5-flash-lite' }, { id: 'gemini-3.6-flash' }],
};
const DEFAULT_MODEL = { anthropic: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.5-flash-lite' };

function resolveModel(provider, requestedModel) {
  const catalog = MODEL_CATALOG[provider];
  if (!requestedModel) return catalog.find((m) => m.id === DEFAULT_MODEL[provider]);
  const match = catalog.find((m) => m.id === requestedModel);
  if (!match) throw new Error(`"${requestedModel}" is not a supported ${provider} model.`);
  return match;
}

// Manual thinking's budget must be >=1024 and comfortably under max_tokens,
// leaving room for the actual tool-call response after reasoning.
const ANTHROPIC_THINKING_BUDGET_TOKENS = 4096;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 8192; // a full reorganize plan can carry many operations
const GEMINI_MAX_OUTPUT_TOKENS = 8192;

// ----------------------------------------------------------------------------
// Shared field descriptors per operation ("tool"), so the Anthropic (JSON
// Schema, lowercase types) and Gemini (OpenAPI-ish schema, UPPERCASE types)
// versions of every schema can't drift apart from being hand-written twice,
// and so normalization (see normalizeOperationInput) is driven by the same
// declarations rather than duplicated per operation.
//
// Field-reference convention shared with src/services/aiContextService.js:
// any field that points at a project/section/task/label accepts EITHER a
// real existing id from context.md OR a `new:<n>` local id declared by an
// earlier create_* operation in the same plan. This worker does not resolve
// or validate those references — it only checks basic type/shape — the
// client (Stage C) does the actual id-existence/cycle validation.
// ----------------------------------------------------------------------------

const LOCAL_ID_FIELD = {
  name: 'localId',
  type: 'string',
  required: true,
  description:
    'A local id for this newly created item, of the exact form "new:<n>" (n a small integer unique within this response, e.g. "new:1", "new:2"). Any other operation in this same plan that needs to reference this item (e.g. a subtask\'s parentId, a task\'s projectId) must use this exact string.',
};

const TASK_CONTENT_FIELDS = [
  { name: 'title', type: 'string', description: 'Short task title.' },
  { name: 'notes', type: 'string', description: 'Free-text notes/description, if extra detail was given beyond the title.' },
  {
    name: 'estimatedHours',
    type: 'number',
    description: 'Estimated hours to complete the task (e.g. "30 min" -> 0.5, "2 hours" -> 2). Only if a duration was stated or clearly implied.',
  },
  {
    name: 'priority',
    type: 'string',
    enum: ['low', 'medium', 'high', 'urgent'],
    description: 'Only set if urgency/importance was explicitly stated (e.g. "urgent", "low priority").',
  },
  {
    name: 'dueDate',
    type: 'string',
    description: 'ISO date (YYYY-MM-DD) the task is due, resolved relative to the reference date in context.md.',
  },
  { name: 'isRecurring', type: 'boolean', description: 'True only if the task explicitly repeats (e.g. "every day", "weekly").' },
  {
    name: 'recurrenceString',
    type: 'string',
    description: 'The recurrence phrased in natural language exactly as implied, e.g. "every day", "every 2 weeks". Only set when isRecurring is true.',
  },
  {
    name: 'fixedTime',
    type: 'string',
    description: '"HH:MM" 24-hour time, only if a specific time of day was mentioned for doing the task itself (not a due date/deadline).',
  },
  {
    name: 'projectId',
    type: 'string',
    description: 'The project this task belongs to — an existing project id from context.md, or a new:<n> localId from a create_project operation in this plan. Omit for no project.',
  },
  {
    name: 'sectionId',
    type: 'string',
    description: 'The section (board column) this task belongs to — an existing section id from context.md, or a new:<n> localId from a create_section operation in this plan. Omit for no section.',
  },
  {
    name: 'parentId',
    type: 'string',
    description: 'This task\'s parent task, if it is a subtask — an existing task id, or a new:<n> localId from a create_task operation in this plan. Omit for a top-level task.',
  },
  {
    name: 'dependsOn',
    type: 'array',
    items: 'string',
    description: 'Ids of other tasks that must be completed before this one is eligible to be scheduled — existing task ids and/or new:<n> localIds declared in this plan. Omit if none.',
  },
  {
    name: 'labelIds',
    type: 'array',
    items: 'string',
    description: 'Ids of labels attached to this task — existing label ids and/or new:<n> localIds from create_label operations in this plan. Omit if none.',
  },
];

const EVENT_CONTENT_FIELDS = [
  { name: 'title', type: 'string', description: 'Short event title.' },
  { name: 'date', type: 'string', description: 'ISO date (YYYY-MM-DD) the event occurs on, resolved relative to the reference date in context.md.' },
  { name: 'startTime', type: 'string', description: '"HH:MM" 24-hour start time.' },
  { name: 'endTime', type: 'string', description: '"HH:MM" 24-hour end time. If no duration is given, default to 1 hour after startTime.' },
  { name: 'description', type: 'string', description: 'Optional extra detail.' },
  { name: 'location', type: 'string', description: 'Optional location, if mentioned.' },
];

function withRequired(fields, names) {
  const set = new Set(names);
  return fields.map((f) => (set.has(f.name) ? { ...f, required: true } : f));
}

function targetIdField(name, description) {
  return { name, type: 'string', required: true, description };
}

// The full operation set. `apply: 'create'|'update'|'delete'` is metadata for
// this worker's own bookkeeping only (not sent to the provider) — it's not
// used to change normalization behavior beyond which id field is required.
const OPERATIONS = [
  {
    name: 'create_task',
    apply: 'create',
    description:
      'Create a new task/to-do — something to be DONE/worked on. This is the DEFAULT for almost everything the user describes, including things with a deadline or a preferred day/time to work on them (use dueDate/fixedTime for that) — the app\'s own scheduler decides exactly when to actually work the task, so do not reach for create_event just because a date or time was mentioned. Only use create_event instead if the request is clearly about a fixed real-world occurrence (see create_event\'s description) or explicitly asks to add something to the calendar/schedule an event.',
    fields: [LOCAL_ID_FIELD, ...withRequired(TASK_CONTENT_FIELDS, ['title'])],
  },
  {
    name: 'update_task',
    apply: 'update',
    description:
      'Change fields on an existing task. Only include the fields that should change — omitted fields are left as-is. To CLEAR an optional field (e.g. remove a due date), explicitly pass an empty string ("") or empty array ([]) for it rather than omitting it.',
    fields: [targetIdField('taskId', 'The existing task to update — an exact id from the "Existing tasks" list in context.md.'), ...TASK_CONTENT_FIELDS],
  },
  {
    name: 'delete_task',
    apply: 'delete',
    description: 'Delete an existing task.',
    fields: [targetIdField('taskId', 'The existing task to delete — an exact id from the "Existing tasks" list in context.md.')],
  },
  {
    name: 'create_event',
    apply: 'create',
    description:
      'Create a calendar event — NOT the default, use this only for something that must happen at that exact real-world date/time regardless of anyone\'s workload, i.e. an actual appointment/meeting/flight/class the user (or someone else) is expected to physically or virtually attend at that moment (e.g. "dentist at 2pm Tuesday", "team standup every weekday 9am", "flight to Auckland Friday 6am"). Do NOT use this to plan/block out time to WORK ON something — that is what create_task\'s dueDate/fixedTime/estimatedHours are for, since the app\'s own scheduler (not this tool) decides when task work actually gets slotted in. If in doubt whether something is a task or an event, prefer create_task.',
    fields: [LOCAL_ID_FIELD, ...withRequired(EVENT_CONTENT_FIELDS, ['title', 'date', 'startTime', 'endTime'])],
  },
  {
    name: 'update_event',
    apply: 'update',
    description: 'Change fields on an existing event. Only include the fields that should change — omitted fields are left as-is.',
    fields: [targetIdField('eventId', 'The existing event to update — an exact id from the "Existing calendar events" list in context.md.'), ...EVENT_CONTENT_FIELDS],
  },
  {
    name: 'delete_event',
    apply: 'delete',
    description: 'Delete an existing event.',
    fields: [targetIdField('eventId', 'The existing event to delete — an exact id from the "Existing calendar events" list in context.md.')],
  },
  {
    name: 'create_project',
    apply: 'create',
    description: 'Create a new project.',
    fields: [LOCAL_ID_FIELD, { name: 'name', type: 'string', required: true, description: 'Project name, worded as close to what the user said as sensible.' }],
  },
  {
    name: 'rename_project',
    apply: 'update',
    description: 'Rename an existing project.',
    fields: [
      targetIdField('projectId', 'The existing project to rename — an exact id from the "Existing projects" list in context.md.'),
      { name: 'name', type: 'string', required: true, description: 'The new project name.' },
    ],
  },
  {
    name: 'delete_project',
    apply: 'delete',
    description: 'Delete an existing project. Tasks in it are NOT deleted — they become unassigned (this mirrors the app\'s own delete-project behavior).',
    fields: [targetIdField('projectId', 'The existing project to delete — an exact id from the "Existing projects" list in context.md.')],
  },
  {
    name: 'create_section',
    apply: 'create',
    description: 'Create a new section (board-view column) inside a project.',
    fields: [
      LOCAL_ID_FIELD,
      { name: 'name', type: 'string', required: true, description: 'Section name.' },
      {
        name: 'projectId',
        type: 'string',
        required: true,
        description: 'The project this section belongs to — an existing project id, or a new:<n> localId from a create_project operation in this plan.',
      },
    ],
  },
  {
    name: 'rename_section',
    apply: 'update',
    description: 'Rename an existing section.',
    fields: [
      targetIdField('sectionId', 'The existing section to rename — an exact id from the "Existing sections" list in context.md.'),
      { name: 'name', type: 'string', required: true, description: 'The new section name.' },
    ],
  },
  {
    name: 'delete_section',
    apply: 'delete',
    description: 'Delete an existing section. Tasks in it are NOT deleted — they fall back to "No Section" (this mirrors the app\'s own delete-section behavior).',
    fields: [targetIdField('sectionId', 'The existing section to delete — an exact id from the "Existing sections" list in context.md.')],
  },
  {
    name: 'create_label',
    apply: 'create',
    description:
      'Create a new label/tag. Only call this if nothing in the "Existing labels" list in context.md reasonably matches — prefer reusing an existing label id over creating a near-duplicate.',
    fields: [LOCAL_ID_FIELD, { name: 'name', type: 'string', required: true, description: 'Label name, worded as close to what the user said as sensible.' }],
  },
];

const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

function fieldsToAnthropicSchema(fields) {
  const properties = {};
  const required = [];
  for (const f of fields) {
    properties[f.name] =
      f.type === 'array'
        ? { type: 'array', items: { type: f.items }, description: f.description }
        : { type: f.type, description: f.description, ...(f.enum ? { enum: f.enum } : {}) };
    if (f.required) required.push(f.name);
  }
  return { type: 'object', properties, required };
}

const GEMINI_TYPE_MAP = { string: 'STRING', number: 'NUMBER', boolean: 'BOOLEAN' };

function fieldsToGeminiSchema(fields) {
  const properties = {};
  const required = [];
  for (const f of fields) {
    properties[f.name] =
      f.type === 'array'
        ? { type: 'ARRAY', items: { type: GEMINI_TYPE_MAP[f.items] }, description: f.description }
        : { type: GEMINI_TYPE_MAP[f.type], description: f.description, ...(f.enum ? { enum: f.enum } : {}) };
    if (f.required) required.push(f.name);
  }
  return { type: 'OBJECT', properties, required };
}

function buildSystemPrompt(contextMarkdown) {
  return [
    'You are an assistant that plans changes to a personal task/project manager on the user\'s behalf.',
    'You act ONLY by calling the provided tools — each tool call becomes one proposed operation that the user will review and individually approve/reject before anything is applied. You never apply anything directly.',
    'Call as many tools as the request genuinely needs — a single request may reasonably produce many operations (e.g. "plan out this project" creating a parent task, several subtasks with dependencies, and moving them into a project/section).',
    'Only call a tool when the user\'s request actually implies that action — do not reorganize or touch anything the user did not ask about.',
    'Tasks vs events — this app has a scheduler that decides WHEN task work actually happens (via dueDate/fixedTime/priority/estimatedHours on create_task/update_task); it is not this tool\'s job to plan or block out working time. Default to create_task for anything the user describes needing to be done, even if it has a deadline or a preferred day. Only use create_event/update_event when the request is unmistakably about a fixed real-world occurrence that must happen at that exact time regardless of workload (an appointment, meeting, flight, class, etc.) or explicitly asks to add/schedule a calendar event — never as a way to "schedule" or "block time for" a task.',
    '',
    contextMarkdown,
  ].join('\n');
}

/**
 * Generic normalization for one tool call's raw input, driven by the same
 * field declarations used to build the provider schemas. Only checks
 * type/shape and required-field presence — id existence, local-id
 * resolution, and dependency-cycle checks are the client's job (Stage C).
 * Returns { ok: true, data } or { ok: false, error }.
 */
function normalizeOperationInput(opDef, input) {
  input = input || {};
  const data = {};
  for (const f of opDef.fields) {
    const raw = input[f.name];
    if (raw === undefined || raw === null) continue;
    if (f.type === 'array') {
      if (!Array.isArray(raw)) continue;
      data[f.name] = raw.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    } else if (f.type === 'number') {
      if (typeof raw === 'number' && Number.isFinite(raw)) data[f.name] = raw;
    } else if (f.type === 'boolean') {
      if (typeof raw === 'boolean') data[f.name] = raw;
    } else if (typeof raw === 'string') {
      if (f.enum && raw && !f.enum.includes(raw)) continue;
      data[f.name] = raw.trim();
    }
  }
  for (const f of opDef.fields) {
    if (f.required && (data[f.name] === undefined || data[f.name] === '')) {
      return { ok: false, error: `${opDef.name}: missing required field "${f.name}".` };
    }
  }
  if (data.localId !== undefined && !/^new:\d+$/.test(data.localId)) {
    return { ok: false, error: `${opDef.name}: localId must be of the form "new:<n>", got "${data.localId}".` };
  }
  return { ok: true, data };
}

/** Converts one raw provider tool call into a normalized plan operation, or null if unrecognized/invalid. */
function toolCallToOperation(name, input) {
  const opDef = OPERATIONS_BY_NAME.get(name);
  if (!opDef) return { ok: false, error: `Unknown tool "${name}".` };
  const normalized = normalizeOperationInput(opDef, input);
  if (!normalized.ok) return normalized;
  return { ok: true, operation: { op: name, ...normalized.data } };
}

async function safeReadError(res) {
  try {
    return (await res.text()).slice(0, 1000);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Classifies an upstream provider failure into a stable `kind` the client
 * can branch on for a specific, actionable message (see aiQuickAddService.js
 * / the AI Assistant UI, Stage E) instead of always showing one generic
 * string. Best-effort text sniffing — providers don't give us a clean
 * machine-readable error taxonomy over these endpoints.
 */
function classifyProviderError(status, bodyText, headers) {
  const text = (bodyText || '').toLowerCase();
  const retryAfterHeader = headers && headers.get && headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;

  if (status === 401 || status === 403) {
    return { kind: 'invalid_api_key', message: 'The API key was rejected — check it in Settings.' };
  }
  if (status === 429) {
    const isQuota = text.includes('quota') || text.includes('resource_exhausted') || text.includes('exceeded your current quota');
    return {
      kind: isQuota ? 'quota_exhausted' : 'rate_limit',
      message: isQuota
        ? 'The provider says your quota/usage limit is exhausted for now — try again later or switch provider in Settings.'
        : 'The provider rate-limited this request — wait a moment and try again.',
      retryAfterSeconds,
    };
  }
  // Gemini reports a bad API key as HTTP 400 (not 401/403 like Anthropic), so
  // that case has to be caught by message text here too.
  if (status === 400 && (text.includes('api key not valid') || text.includes('api_key_invalid'))) {
    return { kind: 'invalid_api_key', message: 'The API key was rejected — check it in Settings.' };
  }
  if (status === 400 && (text.includes('too long') || text.includes('too large') || text.includes('exceeds') || text.includes('maximum context') || text.includes('maximum number of tokens'))) {
    return {
      kind: 'context_too_large',
      message: 'This request is too large for the model — this usually means your workspace (tasks/events) has gotten very big. Try archiving/completing old tasks, or use a model with a larger context window.',
    };
  }
  return { kind: 'upstream_error', message: `Upstream AI request failed (HTTP ${status}): ${bodyText.slice(0, 300)}` };
}

class ProviderError extends Error {
  constructor(classification) {
    super(classification.message);
    this.classification = classification;
  }
}

async function callAnthropic({ apiKey, text, image, contextMarkdown, model }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
  if (content.length === 0) content.push({ type: 'text', text: '(no input provided)' });

  // Manual extended thinking (Haiku 4.5's only thinking mode) is incompatible
  // with a forced tool_choice — see MODEL_CATALOG's comment above. Every
  // other model here gets adaptive thinking on by default with no request
  // field needed, and keeps the forced "any" that guarantees at least one
  // tool call back.
  const body = {
    model: model.id,
    max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(contextMarkdown),
    tools: OPERATIONS.map((op) => ({ name: op.name, description: op.description, input_schema: fieldsToAnthropicSchema(op.fields) })),
    tool_choice: model.requiresManualThinking ? { type: 'auto' } : { type: 'any' },
    messages: [{ role: 'user', content }],
  };
  if (model.requiresManualThinking) {
    body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new ProviderError(classifyProviderError(res.status, await safeReadError(res), res.headers));
  const data = await res.json();
  return (data.content || []).filter((block) => block.type === 'tool_use').map((block) => toolCallToOperation(block.name, block.input));
}

async function callGemini({ apiKey, text, image, contextMarkdown, model }) {
  const parts = [];
  if (text) parts.push({ text });
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  if (parts.length === 0) parts.push({ text: '(no input provided)' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: buildSystemPrompt(contextMarkdown) }] },
      generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
      tools: [
        {
          functionDeclarations: OPERATIONS.map((op) => ({ name: op.name, description: op.description, parameters: fieldsToGeminiSchema(op.fields) })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: OPERATIONS.map((op) => op.name) } },
    }),
  });

  if (!res.ok) throw new ProviderError(classifyProviderError(res.status, await safeReadError(res), res.headers));
  const data = await res.json();
  const responseParts = data.candidates?.[0]?.content?.parts || [];
  return responseParts.filter((p) => p.functionCall).map((p) => toolCallToOperation(p.functionCall.name, p.functionCall.args || {}));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env.ALLOWED_ORIGIN || '*');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed — POST only.' }, 405, headers);

    // Google Calendar persistent-auth routes (see googleCalendarAuthRoutes.js)
    // — dispatched by path ahead of the AI quick-add logic below, which has
    // no path of its own and handles every other POST.
    const { pathname } = new URL(request.url);
    const calendarHandler = CALENDAR_ROUTES[pathname];
    if (calendarHandler) {
      try {
        return await calendarHandler(request, env, headers);
      } catch (err) {
        // Without this, an uncaught error here returns a bare Cloudflare
        // error page with no CORS headers — the browser reports that as an
        // opaque "CORS request did not succeed" rather than the real cause.
        console.error(`${pathname} threw`, err);
        return jsonResponse({ error: `Internal error: ${err?.message || String(err)}` }, 500, headers);
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400, headers);
    }

    const { provider, text, image, contextMarkdown, apiKey, model: requestedModel } = body || {};
    if (provider !== 'anthropic' && provider !== 'gemini') {
      return jsonResponse({ error: "`provider` must be 'anthropic' or 'gemini'." }, 400, headers);
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return jsonResponse({ error: 'Add your Anthropic/Gemini API key in Settings first.' }, 400, headers);
    }
    let model;
    try {
      model = resolveModel(provider, requestedModel);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400, headers);
    }

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    if (!trimmedText && !image) {
      return jsonResponse({ error: 'Provide text and/or an image.' }, 400, headers);
    }
    if (trimmedText.length > MAX_TEXT_CHARS) {
      return jsonResponse({ error: `Text is too long (max ${MAX_TEXT_CHARS} characters).` }, 400, headers);
    }
    if (typeof contextMarkdown !== 'string' || !contextMarkdown.trim()) {
      return jsonResponse({ error: 'Missing `contextMarkdown` — see aiContextService.buildAIContext.' }, 400, headers);
    }
    if (contextMarkdown.length > MAX_CONTEXT_CHARS) {
      return jsonResponse({ error: `Workspace context is unexpectedly large (max ${MAX_CONTEXT_CHARS} characters) — this looks like a bug rather than a real workspace size.` }, 413, headers);
    }
    if (image) {
      if (typeof image !== 'object' || typeof image.data !== 'string' || typeof image.mimeType !== 'string') {
        return jsonResponse({ error: 'Malformed `image` field — expected { data, mimeType }.' }, 400, headers);
      }
      if (!ALLOWED_IMAGE_TYPES.has(image.mimeType)) {
        return jsonResponse({ error: 'Unsupported image type — use PNG, JPEG, WEBP, or GIF.' }, 400, headers);
      }
      if (image.data.length > MAX_IMAGE_BASE64_CHARS) {
        return jsonResponse({ error: 'Image is too large (max ~5MB).' }, 413, headers);
      }
    }

    let rawResults;
    try {
      rawResults =
        provider === 'anthropic'
          ? await callAnthropic({ apiKey: apiKey.trim(), text: trimmedText, image, contextMarkdown, model })
          : await callGemini({ apiKey: apiKey.trim(), text: trimmedText, image, contextMarkdown, model });
    } catch (err) {
      if (err instanceof ProviderError) {
        return jsonResponse({ error: err.message, errorKind: err.classification.kind, retryAfterSeconds: err.classification.retryAfterSeconds }, 502, headers);
      }
      return jsonResponse({ error: err.message || 'Upstream AI request failed.', errorKind: 'upstream_error' }, 502, headers);
    }

    if (rawResults.length === 0) {
      return jsonResponse({ error: 'The AI proposed no changes for that request — try adding more detail.', errorKind: 'no_operations' }, 422, headers);
    }

    const operations = [];
    const rejected = [];
    for (const r of rawResults) {
      if (r.ok) operations.push(r.operation);
      else rejected.push(r.error);
    }

    if (operations.length === 0) {
      return jsonResponse({ error: `The AI's proposed changes were all malformed: ${rejected.join(' ')}`, errorKind: 'malformed_operations' }, 422, headers);
    }

    return jsonResponse({ operations, rejected: rejected.length ? rejected : undefined }, 200, headers);
  },
};

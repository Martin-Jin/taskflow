/**
 * ============================================================================
 * TASKFLOW AI QUICK ADD — Cloudflare Worker proxy
 * ============================================================================
 * Stateless proxy that turns free-form text (+ optional screenshot) into a
 * single structured Task or CalendarEvent via Claude or Gemini's tool/
 * function-calling, using a fixed two-tool schema (create_task /
 * create_event) so the model always returns something the client can hand
 * straight to SchedulerContext's addTask/addManualEvent.
 *
 * This exists purely to keep the Anthropic/Gemini API keys off the client —
 * they're read from Worker secrets (`wrangler secret put ANTHROPIC_API_KEY` /
 * `GEMINI_API_KEY`), never from `.env` or any bundled code. See README.md in
 * this directory for deployment steps.
 *
 * No persistence, no rate-limiting store (KV/Durable Object) — this is a
 * personal-scale app; the size/shape guards below are the only abuse guard.
 * ============================================================================
 */

const MAX_TEXT_CHARS = 4000;
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024; // ~5MB of base64 text
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Update these to whichever model ids are current at deploy time.
// Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
// Gemini: https://ai.google.dev/gemini-api/docs/models
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const GEMINI_MODEL = 'gemini-2.5-flash';

// Shared field descriptors for the two tools, so the Anthropic (JSON Schema,
// lowercase types) and Gemini (OpenAPI-ish schema, UPPERCASE types) versions
// of each schema can't drift apart from being hand-written twice.
const TASK_FIELDS = [
  { name: 'title', type: 'string', required: true, description: 'Short task title.' },
  {
    name: 'notes',
    type: 'string',
    description: 'Optional free-text notes/description, if extra detail was given beyond the title.',
  },
  {
    name: 'estimatedHours',
    type: 'number',
    description:
      'Estimated hours to complete the task, only if a duration was stated or clearly implied (e.g. "30 min" -> 0.5, "2 hours" -> 2). Omit entirely if not mentioned.',
  },
  {
    name: 'priority',
    type: 'string',
    enum: ['low', 'medium', 'high', 'urgent'],
    description: 'Only set if urgency/importance was explicitly stated (e.g. "urgent", "low priority"). Omit otherwise.',
  },
  {
    name: 'dueDate',
    type: 'string',
    description:
      'ISO date (YYYY-MM-DD) the task is due, resolved relative to the reference date given in the system prompt. Omit if no date/deadline was mentioned.',
  },
  { name: 'isRecurring', type: 'boolean', description: 'True only if the task explicitly repeats (e.g. "every day", "weekly").' },
  {
    name: 'recurrenceString',
    type: 'string',
    description:
      'The recurrence phrased in natural language exactly as implied, e.g. "every day", "every 2 weeks". Only set when isRecurring is true.',
  },
  {
    name: 'fixedTime',
    type: 'string',
    description:
      '"HH:MM" 24-hour time, only if a specific time of day was mentioned for doing the task itself (not a due date/deadline).',
  },
  {
    name: 'projectName',
    type: 'string',
    description:
      'The name of an existing project this task belongs to — ONLY use one of the exact names listed as "Existing projects" in the system prompt. Omit if none clearly matches.',
  },
  {
    name: 'labelNames',
    type: 'array',
    items: 'string',
    description:
      'Any tag/label names mentioned. Prefer reusing one of the "Existing labels" listed in the system prompt if it matches; a new short label name is fine otherwise.',
  },
];

const EVENT_FIELDS = [
  { name: 'title', type: 'string', required: true, description: 'Short event title.' },
  {
    name: 'date',
    type: 'string',
    required: true,
    description: 'ISO date (YYYY-MM-DD) the event occurs on, resolved relative to the reference date given in the system prompt.',
  },
  { name: 'startTime', type: 'string', required: true, description: '"HH:MM" 24-hour start time.' },
  {
    name: 'endTime',
    type: 'string',
    required: true,
    description: '"HH:MM" 24-hour end time. If no duration is given, default to 1 hour after startTime.',
  },
  { name: 'description', type: 'string', description: 'Optional extra detail.' },
  { name: 'location', type: 'string', description: 'Optional location, if mentioned.' },
];

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

function buildSystemPrompt(context) {
  const today = (context && context.today) || new Date().toISOString().slice(0, 10);
  const projectNames = (context && Array.isArray(context.projectNames) && context.projectNames) || [];
  const labelNames = (context && Array.isArray(context.labelNames) && context.labelNames) || [];
  return [
    'You turn a short piece of free-form text (and optionally a screenshot) into exactly one new Task or one new Calendar Event for a personal task manager.',
    `Today's date is ${today} — resolve any relative date/time mention ("tomorrow", "next Friday", "in 2 weeks") against this reference date.`,
    'Call create_task for something to be DONE/worked on with no fixed start/end time (most to-dos, chores, assignments, reminders). Call create_event for something that occupies a specific block of time on a specific day (a meeting, appointment, flight, class). Call exactly one of the two tools, whichever fits better — never both, never neither.',
    'Only populate a field if it is actually expressed (or a screenshot clearly shows it) in the input — leave optional fields out entirely rather than guessing a value.',
    projectNames.length ? `Existing projects: ${projectNames.join(', ')}.` : 'There are no existing projects to match against.',
    labelNames.length ? `Existing labels: ${labelNames.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeTaskData(input) {
  input = input || {};
  const data = {};
  if (typeof input.title === 'string' && input.title.trim()) data.title = input.title.trim();
  if (typeof input.notes === 'string' && input.notes.trim()) data.notes = input.notes.trim();
  if (typeof input.estimatedHours === 'number' && input.estimatedHours > 0) data.estimatedHours = input.estimatedHours;
  if (['low', 'medium', 'high', 'urgent'].includes(input.priority)) data.priority = input.priority;
  if (typeof input.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) data.dueDate = input.dueDate;
  if (input.isRecurring === true && typeof input.recurrenceString === 'string' && input.recurrenceString.trim()) {
    data.isRecurring = true;
    data.recurrenceString = input.recurrenceString.trim();
  }
  if (typeof input.fixedTime === 'string' && /^\d{2}:\d{2}$/.test(input.fixedTime)) data.fixedTime = input.fixedTime;
  if (typeof input.projectName === 'string' && input.projectName.trim()) data.projectName = input.projectName.trim();
  if (Array.isArray(input.labelNames)) {
    data.labelNames = input.labelNames.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
  }
  return data;
}

function normalizeEventData(input) {
  input = input || {};
  const data = {};
  if (typeof input.title === 'string' && input.title.trim()) data.title = input.title.trim();
  if (typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) data.date = input.date;
  if (typeof input.startTime === 'string' && /^\d{2}:\d{2}$/.test(input.startTime)) data.startTime = input.startTime;
  if (typeof input.endTime === 'string' && /^\d{2}:\d{2}$/.test(input.endTime)) data.endTime = input.endTime;
  if (typeof input.description === 'string' && input.description.trim()) data.description = input.description.trim();
  if (typeof input.location === 'string' && input.location.trim()) data.location = input.location.trim();
  return data;
}

function toolCallToResult(name, input) {
  if (name === 'create_task') return { type: 'task', data: normalizeTaskData(input) };
  if (name === 'create_event') return { type: 'event', data: normalizeEventData(input) };
  return null;
}

async function safeReadError(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function callAnthropic({ apiKey, text, image, context }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
  if (content.length === 0) content.push({ type: 'text', text: '(no input provided)' });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(context),
      tools: [
        { name: 'create_task', description: 'Create a new task/to-do.', input_schema: fieldsToAnthropicSchema(TASK_FIELDS) },
        {
          name: 'create_event',
          description: 'Create a new calendar event with a fixed start/end time.',
          input_schema: fieldsToAnthropicSchema(EVENT_FIELDS),
        },
      ],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await safeReadError(res)}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((block) => block.type === 'tool_use');
  return toolUse ? toolCallToResult(toolUse.name, toolUse.input) : null;
}

async function callGemini({ apiKey, text, image, context }) {
  const parts = [];
  if (text) parts.push({ text });
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  if (parts.length === 0) parts.push({ text: '(no input provided)' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: buildSystemPrompt(context) }] },
      tools: [
        {
          functionDeclarations: [
            { name: 'create_task', description: 'Create a new task/to-do.', parameters: fieldsToGeminiSchema(TASK_FIELDS) },
            {
              name: 'create_event',
              description: 'Create a new calendar event with a fixed start/end time.',
              parameters: fieldsToGeminiSchema(EVENT_FIELDS),
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['create_task', 'create_event'] } },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${await safeReadError(res)}`);
  const data = await res.json();
  const responseParts = data.candidates?.[0]?.content?.parts || [];
  const call = responseParts.find((p) => p.functionCall)?.functionCall;
  return call ? toolCallToResult(call.name, call.args || {}) : null;
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

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400, headers);
    }

    const { provider, text, image, context } = body || {};
    if (provider !== 'anthropic' && provider !== 'gemini') {
      return jsonResponse({ error: "`provider` must be 'anthropic' or 'gemini'." }, 400, headers);
    }

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    if (!trimmedText && !image) {
      return jsonResponse({ error: 'Provide text and/or an image.' }, 400, headers);
    }
    if (trimmedText.length > MAX_TEXT_CHARS) {
      return jsonResponse({ error: `Text is too long (max ${MAX_TEXT_CHARS} characters).` }, 400, headers);
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

    const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: `${provider} is not configured on this worker (missing API key secret).` }, 500, headers);
    }

    let result;
    try {
      result =
        provider === 'anthropic'
          ? await callAnthropic({ apiKey, text: trimmedText, image, context })
          : await callGemini({ apiKey, text: trimmedText, image, context });
    } catch (err) {
      return jsonResponse({ error: err.message || 'Upstream AI request failed.' }, 502, headers);
    }

    if (!result) {
      return jsonResponse({ error: 'The AI could not extract a task or event from that input — try adding more detail.' }, 422, headers);
    }
    if (result.type === 'task' && !result.data.title) {
      return jsonResponse({ error: 'Could not determine a task title from that input.' }, 422, headers);
    }
    if (result.type === 'event' && (!result.data.title || !result.data.date || !result.data.startTime || !result.data.endTime)) {
      return jsonResponse({ error: 'Could not determine enough event details (title, date, start/end time) from that input.' }, 422, headers);
    }

    return jsonResponse(result, 200, headers);
  },
};

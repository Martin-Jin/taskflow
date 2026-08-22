/**
 * ============================================================================
 * AI ASSISTANT SERVICE
 * ============================================================================
 * Client-side wrapper around the companion Cloudflare Worker (see
 * cloudflare-worker/) that turns a free-form request plus optional
 * screenshots/PDFs and a full
 * workspace snapshot (`contextMarkdown`, see services/aiContextService.js)
 * into a PROPOSED PLAN — see services/aiPlanService.js for how that plan is
 * validated/resolved and services/AIPlanConfirmModal.jsx (via
 * AIQuickAddModal) for how it's confirmed and applied. This service itself
 * only does the network call — it never applies anything.
 *
 * Bring-your-own-key (BYOK): each user pastes their own Anthropic/Gemini API
 * key into Settings (mirrors the Todoist token pattern — see
 * SettingsPanel.jsx and utils/persistence.js), persisted only in that
 * browser's localStorage. This service reads it here at request time and
 * sends it to the Worker as `apiKey`; the Worker itself holds no secrets and
 * just forwards whatever key it's given straight to the provider. See
 * cloudflare-worker/README.md for the full rationale.
 *
 * `VITE_ANTHROPIC_API_KEY` / `VITE_GEMINI_API_KEY` are read first purely for
 * local `npm run dev` convenience (same reasoning as
 * `VITE_TODOIST_API_TOKEN` in SchedulerContext) — never present in the
 * public GitHub Pages build, since there's no `.env` at build time there.
 * ============================================================================
 */

import { loadPersisted } from '../utils/persistence';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB, matches the Worker's per-attachment base64 size cap
const MAX_ATTACHMENTS = 5; // matches the Worker's MAX_ATTACHMENTS
export const ALLOWED_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

// localStorage keys the AI Quick Add Settings section saves to (see SettingsPanel.jsx).
const AI_KEY_STORAGE = { anthropic: 'aiAnthropicApiKey', gemini: 'aiGeminiApiKey' };
const PROVIDER_LABEL = { anthropic: 'Anthropic', gemini: 'Gemini' };

/** Reads the user's own API key for `provider` — local-dev `.env` fallback, then localStorage. */
export function getStoredApiKey(provider) {
  const envKey = provider === 'anthropic' ? import.meta.env.VITE_ANTHROPIC_API_KEY : import.meta.env.VITE_GEMINI_API_KEY;
  return envKey || loadPersisted(AI_KEY_STORAGE[provider], null);
}

/** Whether the AI Quick Add entry point should be shown at all. */
export function isAIQuickAddConfigured() {
  return !!import.meta.env.VITE_AI_QUICKADD_WORKER_URL;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:<mime>;base64,<data>" — strip the prefix.
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

/** Thrown by requestAIPlan on any failure. `kind` mirrors the worker's errorKind (see cloudflare-worker/src/index.js's classifyProviderError) so callers can branch on it — e.g. offering a "switch provider" shortcut for quota_exhausted. */
export class AIRequestError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind || 'unknown';
  }
}

function messageForFailure(body, status) {
  const base = body?.error || `AI Assistant request failed (HTTP ${status}).`;
  if (body?.errorKind === 'rate_limit' && body?.retryAfterSeconds) {
    return `${base} (retry in about ${body.retryAfterSeconds}s)`;
  }
  return base;
}

/**
 * Sends a free-form request/image and the current workspace context to the
 * Worker and returns the proposed plan's raw operations. Throws AIRequestError
 * with a user-facing message on any failure — network error, worker not
 * configured, or an error surfaced from the worker's own `error` field.
 *
 * @param {{
 *   provider: 'anthropic'|'gemini',
 *   text: string,
 *   attachmentFiles?: File[],
 *   contextMarkdown: string,
 *   model?: string,
 * }} params
 * @returns {Promise<{ operations: Array<Object>, rejected?: string[] }>}
 */
export async function requestAIPlan({ provider, text, attachmentFiles, contextMarkdown, model }) {
  const workerUrl = import.meta.env.VITE_AI_QUICKADD_WORKER_URL;
  if (!workerUrl) {
    throw new AIRequestError('AI Quick Add is not configured — no worker URL set.', 'not_configured');
  }

  const apiKey = getStoredApiKey(provider);
  if (!apiKey) {
    throw new AIRequestError(`Add your ${PROVIDER_LABEL[provider]} API key in Settings first.`, 'no_api_key');
  }

  const files = attachmentFiles || [];
  if (files.length > MAX_ATTACHMENTS) {
    throw new AIRequestError(`Too many attachments — please use ${MAX_ATTACHMENTS} or fewer.`, 'too_many_attachments');
  }
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new AIRequestError(`"${file.name}" is too large — please use files under 5MB.`, 'image_too_large');
    }
  }
  const attachments = await Promise.all(
    files.map(async (file) => ({ data: await fileToBase64(file), mimeType: file.type || 'application/octet-stream' }))
  );

  let res;
  try {
    res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey, text: text || '', attachments, contextMarkdown, model }),
    });
  } catch {
    throw new AIRequestError(
      'Could not reach the AI Assistant worker — check your connection and the configured worker URL.',
      'network_error'
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new AIRequestError('The AI Assistant worker returned an unexpected response.', 'bad_response');
  }

  if (!res.ok || body.error) {
    throw new AIRequestError(messageForFailure(body, res.status), body.errorKind || 'upstream_error');
  }
  return body;
}

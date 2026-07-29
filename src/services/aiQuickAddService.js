/**
 * ============================================================================
 * AI QUICK ADD SERVICE
 * ============================================================================
 * Client-side wrapper around the companion Cloudflare Worker (see
 * cloudflare-worker/) that turns free-form text/screenshot into a structured
 * Task or CalendarEvent via Claude or Gemini. The actual Anthropic/Gemini API
 * keys never touch the browser — this only ever talks to the Worker URL,
 * configured via VITE_AI_QUICKADD_WORKER_URL (see .env.example).
 *
 * The Worker is stateless and has no knowledge of the user's existing
 * projects/labels or today's date, so callers pass those as `context` —
 * without a reference date the model can't resolve "tomorrow"/"next Friday"
 * mentions, and without existing project/label names it can only guess at
 * `projectName`/`labelNames` rather than matching real ones (see
 * `resolveProjectAndLabels` below, used by AIQuickAddModal).
 * ============================================================================
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, matches the Worker's base64 size cap

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
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Sends free-form text/image to the Worker and returns the parsed result.
 * Throws with a user-facing message on any failure — network error, worker
 * not configured, or an error surfaced from the worker's own `error` field
 * (bad input, upstream AI error, missing API key secret).
 *
 * @param {{
 *   provider: 'anthropic'|'gemini',
 *   text: string,
 *   imageFile?: File|null,
 *   context?: { today?: string, projectNames?: string[], labelNames?: string[] },
 * }} params
 * @returns {Promise<{type: 'task'|'event', data: object}>}
 */
export async function parseWithAI({ provider, text, imageFile, context }) {
  const workerUrl = import.meta.env.VITE_AI_QUICKADD_WORKER_URL;
  if (!workerUrl) {
    throw new Error('AI Quick Add is not configured — no worker URL set.');
  }

  let image;
  if (imageFile) {
    if (imageFile.size > MAX_IMAGE_BYTES) {
      throw new Error('Image is too large — please use one under 5MB.');
    }
    image = { data: await fileToBase64(imageFile), mimeType: imageFile.type || 'image/png' };
  }

  let res;
  try {
    res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, text: text || '', image, context }),
    });
  } catch {
    throw new Error('Could not reach the AI Quick Add worker — check your connection and the configured worker URL.');
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('The AI Quick Add worker returned an unexpected response.');
  }

  if (!res.ok || body.error) {
    throw new Error(body.error || `AI Quick Add failed (HTTP ${res.status}).`);
  }
  return body;
}

/**
 * Resolves the AI's freeform `projectName`/`labelNames` hints (see
 * cloudflare-worker/src/index.js's TASK_FIELDS) against the user's actual
 * Projects/Labels — the worker has no access to Firestore, so it can only
 * echo back a name, never a real id. Matching is deliberately simple
 * (case-insensitive exact match, falling back to a unique substring match)
 * rather than reusing utils/smartParse.js's own matcher, which is private to
 * that unrelated feature.
 */
export function resolveProjectId(projectName, projects) {
  if (!projectName) return null;
  const name = projectName.trim().toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === name);
  if (exact) return exact.id;
  const partial = projects.filter((p) => p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase()));
  return partial.length === 1 ? partial[0].id : null;
}

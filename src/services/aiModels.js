/**
 * ============================================================================
 * AI MODEL CATALOG (client side)
 * ============================================================================
 * Curated, non-free-text model choices per provider — deliberately NOT an
 * open text field, so a typo'd model id can't silently 400 the request (see
 * TODO.md's AI Assistant upgrade, Stage A.6). The Cloudflare Worker
 * (cloudflare-worker/src/index.js) keeps its OWN copy of this same catalog
 * and validates the incoming `model` against it — the two can't literally
 * share one file (this is Vite/React, the worker is a separate deployable
 * project with its own build), so keep them in sync by hand; each file
 * cross-references the other in a comment for exactly this reason.
 *
 * Every model listed here is confirmed against the relevant provider's own
 * docs as of 2026-07-30 (see cloudflare-worker/src/index.js's comment for
 * the exact doc URLs/citations) — re-verify before trusting this file if a
 * lot of time has passed, since provider lineups move fast (this app already
 * hit a 404 once from a retired Gemini model id).
 * ============================================================================
 */

export const MODEL_CATALOG = {
  anthropic: [
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      hint: 'Fast & cheap, reasoning enabled',
      isDefault: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      hint: 'Smarter, for harder requests',
    },
  ],
  gemini: [
    {
      id: 'gemini-3.5-flash-lite',
      label: 'Gemini 3.5 Flash-Lite',
      hint: 'Fast & cheap, reasoning enabled',
      isDefault: true,
    },
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      hint: 'Smarter, for harder requests',
    },
  ],
};

export function getDefaultModelId(provider) {
  return MODEL_CATALOG[provider]?.find((m) => m.isDefault)?.id || MODEL_CATALOG[provider]?.[0]?.id || null;
}

/** True if `modelId` is one of the curated options for `provider` — guards against a stale localStorage value after the catalog changes. */
export function isValidModelId(provider, modelId) {
  return !!MODEL_CATALOG[provider]?.some((m) => m.id === modelId);
}

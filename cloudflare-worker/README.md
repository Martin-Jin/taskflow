# TaskFlow AI Quick Add — Cloudflare Worker

A small, stateless Cloudflare Worker that proxies "AI Quick Add" requests from
the TaskFlow app to Claude (Anthropic) or Gemini (Google). This is a
bring-your-own-key (BYOK) worker: it holds no API keys of its own — each
request carries the caller's own Anthropic/Gemini API key (pasted into
Settings in the app, stored only in that visitor's browser), and the worker
just forwards it straight to the relevant provider. It exists purely to solve
CORS (browsers can't call Anthropic/Gemini directly from the page). See
`src/index.js` for the request/response contract and model-selection logic.

This is a free-tier Cloudflare Worker — no paid plan or billing required for
personal-scale usage.

## Prerequisites

- A Cloudflare account (free tier is enough).
- [Node.js](https://nodejs.org/) and `npx` available locally.
- `npx wrangler login` once, to authenticate the CLI against your account.
- That's it — you don't need an Anthropic or Gemini API key yourself; each
  visitor brings their own.

## Deploy

From this `cloudflare-worker/` directory:

```bash
npm install          # installs the wrangler CLI as a dev dependency
npx wrangler login    # one-time browser auth, skip if already logged in
npx wrangler deploy
```

`wrangler deploy` prints the deployed Worker's URL, e.g.
`https://taskflow-ai-quickadd.<your-subdomain>.workers.dev`.

## Wire it into the main app

Copy that URL into the main repo's `.env` (not this directory's):

```
VITE_AI_QUICKADD_WORKER_URL=https://taskflow-ai-quickadd.<your-subdomain>.workers.dev
```

Restart `npm run dev` (or rebuild for a deployed site). If this is left
unset, the "AI Quick Add" entry point simply doesn't appear in the app —
see `src/services/aiQuickAddService.js`'s `isAIQuickAddConfigured()`.

## Locking down CORS

`wrangler.toml` sets `ALLOWED_ORIGIN = "*"` by default, which is fine for
local development (any origin can call the worker) but means anyone who
discovers the Worker URL could use it as a generic CORS-bypassing relay to
Anthropic/Gemini from any other site — not a direct cost to you (each caller
supplies their own key), but still worth locking down for hygiene. For a
production deployment, restrict this to your actual app origin:

```bash
npx wrangler deploy --var ALLOWED_ORIGIN:https://yourname.github.io
```

or edit the `[vars]` section of `wrangler.toml` directly and redeploy.

## Updating the model ids

`src/index.js` hardcodes `ANTHROPIC_MODEL` and `GEMINI_MODEL` constants near
the top of the file — check the linked docs in that file's comments and bump
them to whatever the current model ids are before/after deploying, since
model ids get retired over time.

## Notes on the abuse guard

This worker holds no secrets, so there's nothing here for an attacker to
steal or spend on your behalf — each caller only ever spends their own API
credits, using their own key. The remaining reason to lock things down is
hygiene: without a restricted `ALLOWED_ORIGIN`, any other site could point at
your Worker and use it as a free CORS-bypassing relay to Anthropic/Gemini.
There's no rate-limiting store (no KV/Durable Object) either — that's
deliberately out of scope for a personal-scale app. It only rejects
obviously-oversized or malformed requests (text over 4000 characters, images
over ~5MB of base64, missing/invalid fields, and now a missing `apiKey`).

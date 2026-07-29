# TaskFlow AI Quick Add — Cloudflare Worker

A small, stateless Cloudflare Worker that proxies "AI Quick Add" requests from
the TaskFlow app to Claude (Anthropic) or Gemini (Google), so the actual API
keys never reach the browser. See `src/index.js` for the request/response
contract and model-selection logic.

This is a free-tier Cloudflare Worker — no paid plan or billing required for
personal-scale usage.

## Prerequisites

- A Cloudflare account (free tier is enough).
- [Node.js](https://nodejs.org/) and `npx` available locally.
- `npx wrangler login` once, to authenticate the CLI against your account.
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com/))
  and/or a Gemini API key ([aistudio.google.com](https://aistudio.google.com/app/apikey))
  — you only need whichever provider(s) you actually want to offer; the app
  lets the user pick per-request.

## Deploy

From this `cloudflare-worker/` directory:

```bash
npm install          # installs the wrangler CLI as a dev dependency
npx wrangler login    # one-time browser auth, skip if already logged in

# Set whichever secrets you have a key for (prompts for the value, doesn't
# echo it, and never gets written to any file in this repo):
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY

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
discovers the Worker URL could also call it and spend your API credits.
For a production deployment, lock this down to your actual app origin:

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

This worker has no rate-limiting store (no KV/Durable Object) — that's
deliberately out of scope for a personal-scale app. It only rejects
obviously-oversized or malformed requests (text over 4000 characters, images
over ~5MB of base64, missing/invalid fields). If you deploy this publicly,
restricting `ALLOWED_ORIGIN` (above) is your main protection against abuse.

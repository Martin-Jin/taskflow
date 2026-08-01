# TaskFlow Cloudflare Worker

A small Cloudflare Worker that backs two independent features of the TaskFlow
app:

- **AI Quick Add** — proxies requests to Claude (Anthropic) or Gemini
  (Google). This is bring-your-own-key (BYOK): it holds no API keys of its
  own — each request carries the caller's own Anthropic/Gemini API key
  (pasted into Settings in the app, stored only in that visitor's browser),
  and the worker just forwards it straight to the relevant provider. It
  exists purely to solve CORS (browsers can't call Anthropic/Gemini directly
  from the page). See `src/index.js` for the request/response contract and
  model-selection logic.
- **Google Calendar persistent auth** — redeems/refreshes a Google Calendar
  refresh token server-side, so the app never needs a login popup after the
  first connection (see "Google Calendar persistent auth" section below).
  Unlike AI Quick Add, this one DOES need secrets configured (see that
  section) — it's not BYOK.

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

## Google Calendar persistent auth

The `/calendar/exchange-code` and `/calendar/refresh-token` routes (see
`src/googleCalendarAuthRoutes.js`) let the app get a Google Calendar
connection that survives page refreshes without repeated login popups: the
one-time consent grant's authorization code is redeemed here for a Google
**refresh token**, stored in Firestore, and used to mint fresh access tokens
on demand — the client never holds the refresh token or the OAuth client
secret.

Unlike AI Quick Add, this needs the following configured **once**, by you
(the deployer), not per-visitor:

### 1. Public vars (`wrangler.toml`)

Already set in the committed `wrangler.toml`:
- `FIREBASE_PROJECT_ID` — this app's Firebase project id (not a secret).
- `GOOGLE_CLIENT_ID` — the same OAuth Client ID as the app's own
  `VITE_GOOGLE_CLIENT_ID` (not a secret — it identifies the OAuth client, not
  authorize access). Fill it in in `wrangler.toml` (or override at deploy
  time with `--var GOOGLE_CLIENT_ID:<your-client-id>`) before deploying.

### 2. Secrets (`wrangler secret put` — never commit these)

**`GOOGLE_CLIENT_SECRET`** — from the same Google Cloud Console OAuth Client
ID used for `VITE_GOOGLE_CLIENT_ID` (Credentials page → your Web application
client → "Client secret"):

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**A Firestore-scoped Google Cloud service account**, used only to
read/write the `users/{uid}/googleCalendarAuth/token` doc via the Firestore
REST API (see `src/firestoreClient.js`) — deliberately a *separate*,
least-privilege account, not your personal Google credentials:

1. In Google Cloud Console (same project as your Firebase project), go to
   **IAM & Admin → Service Accounts → Create Service Account**.
2. Grant it only the **`roles/datastore.user`** role (read/write access to
   Firestore in Datastore mode/Native mode — nothing else; do NOT grant
   Editor/Owner).
3. Open the new service account → **Keys → Add Key → Create new key → JSON**,
   and download it.
4. From that downloaded JSON, set two secrets:

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
# paste the JSON's "client_email" field when prompted

# The JSON's "private_key" field is a multi-line PEM. Save it to a temporary
# file (with real newlines, not "\n" escapes) and pipe it in rather than
# pasting into the interactive prompt, e.g.:
node -e "console.log(JSON.parse(require('fs').readFileSync('service-account.json')).private_key)" > /tmp/sa-key.pem
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY < /tmp/sa-key.pem
rm /tmp/sa-key.pem service-account.json   # don't leave these lying around
```

### 3. Deploy and wire it into the main app

```bash
npx wrangler deploy
```

Copy the printed Worker URL into the main repo's `.env`:

```
VITE_CALENDAR_AUTH_WORKER_URL=https://taskflow-ai-quickadd.<your-subdomain>.workers.dev
```

Restart `npm run dev` (or rebuild for a deployed site).

### 4. Deploy the matching Firestore rule

The main repo's `firestore.rules` denies all client-side access to
`users/{uid}/googleCalendarAuth/**` (the service account above bypasses this
via IAM, not these rules) — deploy it from the main repo root:

```bash
firebase deploy --only firestore:rules
```

## Notes on the abuse guard

The AI quick-add routes hold no secrets, so there's nothing here for an
attacker to steal or spend on your behalf — each caller only ever spends
their own API credits, using their own key. The remaining reason to lock
things down is hygiene: without a restricted `ALLOWED_ORIGIN`, any other
site could point at your Worker and use it as a free CORS-bypassing relay to
Anthropic/Gemini. There's no rate-limiting store (no KV/Durable Object)
either — that's deliberately out of scope for a personal-scale app. It only
rejects obviously-oversized or malformed requests (text over 4000
characters, images over ~5MB of base64, missing/invalid fields, and now a
missing `apiKey`).

The `/calendar/*` routes are different: they DO hold real secrets
(`GOOGLE_CLIENT_SECRET`, the service account's private key) and every
request is authenticated by a verified Firebase ID token (see
`src/googleAuth.js`) rather than being open to any caller — an attacker
without a valid ID token for a real Taskflow user can't reach the
Firestore-backed refresh-token logic at all.

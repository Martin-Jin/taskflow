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

### Troubleshooting: if Calendar connect/sign-in ever breaks again

This flow touches an unusually large number of independently-configured
pieces (OAuth client, consent screen, Firebase, Firestore rules, a service
account, three separate "authorized domain" lists, and two separately-baked
env-var sets for local vs. published builds). Getting it wrong the first
time cost an entire debugging session — this section exists so the next
time is faster. Check these roughly in order of how often each one was the
actual cause:

1. **Client-side and server-side must use the literal same OAuth Client ID.**
   By far the most likely cause of `unauthorized_client` at the token-
   exchange step. The client-side authorization request (`VITE_GOOGLE_CLIENT_ID`)
   and the Worker's token exchange (`GOOGLE_CLIENT_ID` in `wrangler.toml`)
   must be the exact same client — if the OAuth client ever gets deleted and
   recreated, **every place that ID is configured needs updating together**:
   - `.env` locally (`VITE_GOOGLE_CLIENT_ID`)
   - the **GitHub Actions repo secret** `VITE_GOOGLE_CLIENT_ID` — easy to
     forget, since it's invisible from the working tree and only affects the
     *published* build, never local dev. Update it with
     `echo "<new-id>" | gh secret set VITE_GOOGLE_CLIENT_ID`, then trigger a
     rebuild (`gh workflow run deploy.yml`) — a stale secret here will pass
     `npm run build` and look completely fine locally.
   - `cloudflare-worker/wrangler.toml`'s `GOOGLE_CLIENT_ID`, then
     `npx wrangler deploy`.
   - To directly verify what's actually live on the published site (rather
     than trusting that a secret got updated), fetch the deployed bundle and
     grep it for `.apps.googleusercontent.com` — it'll show you the literal
     client ID baked into what's actually being served.

2. **`redirect_uri` for GIS's `initCodeClient` in `ux_mode: 'popup'` must be
   the calling page's own origin** (e.g. `https://example.github.io`, no
   path) — per
   [Google's docs](https://developers.google.com/identity/oauth2/web/guides/use-code-model).
   It is **not** `"postmessage"` (that's the older `gapi.auth2.grantOfflineAccess()`
   convention) and not an empty string — both produce `unauthorized_client`.
   `googleCalendarAuthRoutes.js` derives this from the request's `Origin`
   header rather than hardcoding it, so it's automatically correct for both
   `localhost` and the deployed origin. This origin must *also* be listed
   under the OAuth client's **Authorized redirect URIs** (not just
   Authorized JavaScript origins) for the exchange to succeed.

3. **`gapi.client` needs the fetched access token explicitly.**
   `gapi.client.calendar.*` calls read their auth from `gapi.client`'s own
   internal state via `gapi.client.setToken(...)` — they do **not**
   automatically know about a token this module fetched through the
   Worker's refresh-token/exchange-code routes. `requestAccessToken()` in
   `googleCalendarService.js` calls `setToken` on every path (cached, Worker-
   refreshed, or freshly exchanged) specifically so this doesn't regress
   again — if Calendar connects successfully but every subsequent event
   fetch immediately throws "authorization expired", this wiring is the
   first thing to check.

4. **Three separate "authorized domain" lists exist and are easy to
   conflate** — a change to one does not affect the others:
   - The OAuth **client's** own Authorized JavaScript origins / Authorized
     redirect URIs (Google Cloud Console → Credentials → your client).
   - The **OAuth consent screen's** Authorized domains (Data Access/Audience
     tabs) — requires **Google Search Console domain-ownership
     verification** for any domain you don't already own outright (like a
     `github.io` subdomain), *if* the consent screen is in **Production**
     status. Switching the consent screen to **Testing** + adding your own
     account as a **test user** sidesteps this entirely for a personal-scale
     app, and also avoids Google's formal app-verification requirement for
     sensitive scopes (Calendar's scopes are sensitive).
   - **Firebase's own** Authorized domains list (Firebase Console →
     Authentication → Settings) — separate from both of the above, defaults
     to `localhost` + `*.firebaseapp.com`/`*.web.app` only; a custom domain
     (like your GitHub Pages origin) needs adding here too, independently.

5. **The Google Calendar API itself must be enabled** for the GCP project
   (APIs & Services → Library → "Google Calendar API" → Enable) — separate
   from every OAuth/consent-screen setting above. If it's ever disabled
   (including by accident), the failure mode looks identical to an OAuth
   config problem.

6. **If the OAuth client is ever deleted and Firebase's Google sign-in
   breaks too** (`auth/requests-from-referer-...-are-blocked` or "The
   requested action is invalid" on the `<project>.firebaseapp.com/__/auth/handler`
   page): Firebase's Google provider depends on its own auto-managed OAuth
   client, which does not always get automatically recreated by toggling the
   provider off/on in Firebase Console. If Google Cloud Console's Credentials
   page shows no OAuth client after doing that, manually wire Firebase to an
   OAuth client you do control (e.g. the Calendar one above) via
   **Firebase Console → Authentication → Sign-in method → Google → Web SDK
   configuration**, pasting in that client's ID and secret — and make sure
   that client's Authorized redirect URIs includes
   `https://<project>.firebaseapp.com/__/auth/handler`.

7. **A GCP service account key downloaded while the console's project
   selector was pointed at the wrong project still "works"** (Google will
   happily mint it an access token — the key is real, just for the wrong
   account/project) but then fails on the actual Firestore call with a
   permissions or signature error. Before trusting a downloaded service-
   account JSON, check its own `client_email`/`project_id` fields match what
   you expect.

8. **Never paste a client secret or service-account private key into an AI
   chat, ticket, or log** — if one ever does leak this way, rotate it
   immediately (Google Cloud Console lets you add a new client secret /
   service-account key without downtime, then delete the old one). When
   setting `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, always pipe it directly
   from the downloaded JSON (see the `node -e ... | wrangler secret put ...`
   command above) rather than copy-pasting through a clipboard/editor, which
   silently mangles the PEM's newlines.

9. **`wrangler secret put <NAME>`** — the argument is the secret's *name*;
   it then prompts interactively for the *value*. Passing the value as the
   argument instead creates a secret with that value as its name (visible via
   `npx wrangler secret list`, which lists names only — it can't show you a
   secret's current value, so when in doubt about whether a secret is
   correct, just overwrite it rather than trying to inspect it).

10. **Cloudflare Worker deploys/secrets are entirely independent of git.**
    `wrangler deploy` and `wrangler secret put` push directly to Cloudflare
    regardless of what's committed or pushed — uncommitted local changes are
    still live once deployed, and a `git push` alone does *not* redeploy the
    Worker (only the GitHub Pages *frontend* build is git-triggered, via
    `.github/workflows/deploy.yml`).

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

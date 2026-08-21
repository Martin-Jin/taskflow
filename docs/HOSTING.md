# Hosting TaskFlow

TaskFlow is a client-only SPA — no backend, no database — so anything that
serves static files can host it.

- [A public copy on GitHub Pages](#hosting-a-public-copy-on-github-pages)
- [Beyond localhost, on a private network](#hosting-it-beyond-localhost-private-network)

## Hosting a public copy on GitHub Pages

GitHub Pages is a free static host that serves whatever `npm run build`
produces. `.github/workflows/deploy.yml` builds and deploys automatically on
every push to `main`.

**One-time setup:**

1. **Repo settings → Pages → Build and deployment → Source: "GitHub
   Actions"** (not "Deploy from a branch"). This lets the included workflow
   publish directly, without needing a separate `gh-pages` branch.
2. If you want Google Calendar sync to work for visitors, add three **Repo
   settings → Secrets and variables → Actions → Repository secrets**:
   `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, and
   `VITE_CALENDAR_AUTH_WORKER_URL` (same values as your local `.env` — see
   [Google Calendar](INTEGRATIONS.md#google-calendar) above; the last one requires
   deploying the Cloudflare Worker's Calendar routes, see
   [`cloudflare-worker/README.md`](../cloudflare-worker/README.md#google-calendar-persistent-auth)).
   Then, in Google Cloud Console, add `https://<your-username>.github.io`
   to that OAuth client's **Authorized JavaScript origins AND Authorized
   redirect URIs** (both lists — the persistent-auth token exchange
   validates against the redirect URIs list specifically) so the deployed
   site is allowed to use it. If this OAuth client is ever deleted and
   recreated, every one of these three places needs updating together —
   see the troubleshooting section in `cloudflare-worker/README.md` for the
   full list of what breaks if you miss one.
   - **Do not** add a `VITE_TODOIST_API_TOKEN` secret here. That would bake
     *your* personal Todoist token into a build every visitor downloads —
     see the [Todoist](INTEGRATIONS.md#todoist) section above for why each visitor instead
     connects their own account from Settings.
   - If you want **AI Quick Add** to work for visitors too, add
     `VITE_AI_QUICKADD_WORKER_URL` as a repo secret as well (see [AI Quick
     Add](INTEGRATIONS.md#ai-quick-add) above). This is just a Worker URL, not a credential
     — each visitor brings their own Anthropic/Gemini API key from Settings,
     so nothing here costs you anything. Still worth locking the Worker's
     `ALLOWED_ORIGIN` down to your Pages origin (see
     `cloudflare-worker/README.md`) so random other sites can't piggyback on
     it as a generic CORS relay.
3. Push to `main`. Check the **Actions** tab for the workflow run, then visit
   `https://<your-username>.github.io/taskflow/`.

**What visitors get, with zero setup on your end:**

- The app works immediately on sample data, same as local dev.
- **Settings → Integrations → Connect Todoist**: each visitor pastes their
  own personal API token (with instructions and a direct link right there in
  Settings, and again in the in-app tutorial — **Settings → Help → Show
  tutorial**). It's saved to their browser only.
- **Settings → Connect Google Calendar**: one click, standard Google consent
  screen, no password ever seen by TaskFlow — works for every visitor
  against the one OAuth client you configured in step 2, exactly like any
  other multi-user web app's "Sign in with Google" button.
- **AI Quick Add** (if you deployed the Worker): each visitor pastes their
  own Anthropic and/or Gemini API key in **Settings → Integrations → AI
  Quick Add**, same BYOK pattern as Todoist above.
- Everything (tasks, routines, scheduling rules, the Todoist token, AI Quick
  Add keys) is saved to that visitor's own browser via `localStorage` —
  nothing is shared between visitors, and nothing is stored on any server,
  since there isn't one.

If the Google Cloud project is still in **Testing** publishing status (the
default for a new project), only accounts you've explicitly added as test
users can complete the OAuth flow — fine for sharing with a few people, but
move it to **Production** (Cloud Console → OAuth consent screen) if you want
it open to anyone. Google Calendar sync is optional either way; the app is
fully usable without it.

## Hosting it beyond localhost (private network)

Everything above covers `npm run dev`/`npm run preview` on `localhost`. To
reach TaskFlow from your phone or another device without deploying it
publicly, put your devices on the same private network and point Google
Cloud's OAuth settings at whatever hostname that gives you.

**Tailscale** is a reasonable default: a mesh VPN giving every device a
stable private IP and a `.ts.net` DNS name (which, unlike a bare IP,
Google's OAuth origin rules accept), free for personal use, no
port-forwarding required. Other options depending on what you're
optimizing for: a self-hosted WireGuard setup, a Cloudflare Tunnel, a small
VPS deployment, or your router's own VPN server.

Whichever you pick, two things need to know about the new hostname: Vite's
dev/preview server (`allowedHosts` in `vite.config.js`, if not on
`localhost`) and Google Cloud Console's OAuth client + API key
restrictions, if using Google Calendar sync from that hostname.


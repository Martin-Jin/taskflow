# Integrations

TaskFlow is fully usable without any of these — each one is opt-in, and
anything left unconfigured just keeps using local sample data for that piece.
Copy the env template and fill in whatever you have:

```bash
cp .env.example .env
```

- [Todoist](#todoist) — one-time import of your existing tasks
- [Google Calendar](#google-calendar) — two-way event sync
- [AI Quick Add](#ai-quick-add) — natural-language and screenshot input, bring your own API key
- [Notifications](#notifications) — in-app popups, plus optional self-hosted email


## Todoist

**For local development**, the fastest path is an env var:

1. Todoist → Settings → Integrations → Developer → copy your API token.
2. Paste it into `.env` as `VITE_TODOIST_API_TOKEN` and restart `npm run dev`.

**For the deployed public site** (see [Hosting a public copy on GitHub
Pages](HOSTING.md) below), there is no `.env` — each
visitor instead pastes their own token into **Settings → Integrations →
Connect Todoist**, straight from the browser. It's saved to that browser's
`localStorage` only and used to call `api.todoist.com` directly; it's never
sent to any server the app doesn't already talk to directly, and a token
entered this way is never baked into the build (unlike the `.env` value,
which stays in the dev build on your machine — see the Pages workflow for
why the two are kept separate). This is also how `.env` itself is
Todoist-agnostic: whichever one is present at runtime wins, checked in this
order — the browser's saved token, then `VITE_TODOIST_API_TOKEN` if built in.

**This is a one-time import, not a live sync.** Nothing is ever fetched
from Todoist automatically — click **Settings → Import from Todoist** to
pull in your Projects, Sections, and Tasks. Nothing you edit in TaskFlow
afterward is ever pushed back to your Todoist account; it's exactly as
locally-editable as a task you created directly in TaskFlow. A few things
worth knowing:

- **This targets Todoist API v1** (`api.todoist.com/api/v1`), not the
  retired REST v2. If you're merging in older code that still points at
  `rest/v2`, update it — see `src/services/todoistService.js`.
- **Re-running the import upserts, never duplicates.** Projects/Sections/
  Tasks already imported (matched by id) get their Todoist-sourced fields
  (title, notes, estimated hours, priority, due date, recurrence,
  project/section, labels, parent task) refreshed from the latest fetch, while
  app-only fields you've since set locally (lock state, completion,
  min/max chunk hours, dependencies, passive flag, earliest date, enforce
  due date, link, scheduling progress) are left alone; anything new is
  added. Tasks/boards/sections you created directly in TaskFlow are never
  touched by an import, and a previously-imported item that's since been
  deleted in Todoist isn't removed here either — it just stops being
  updated by future imports.
- **Tasks with no due date are imported but never scheduled.** They show up
  in Tasks/Board like any other task (mirroring Todoist 1:1), but the
  scheduler needs a due date to compute a planning window, so an undated
  task simply never gets a calendar block (the in-app **Add task** dialog
  still requires a due date for new tasks, since those are scheduled from
  the moment they're created).
- **Estimated hours** come from Todoist's native `duration` field if set,
  otherwise from a duration mentioned in the title/description (`"~2
  hours"`, `"45 min"`, `"1h 30m"`, `"half an hour"` — see
  `src/utils/durationParser.js`), otherwise default to a deliberately short
  5 minutes, so an un-estimated task doesn't silently eat a large chunk of
  calendar capacity before you get a chance to correct it.
- **Labels** are resolved by name onto TaskFlow's own Label records,
  creating any that don't already exist — a label attached to several
  imported tasks is only created once.
- **Sub-tasks** (Todoist items with a parent) come in as standalone tasks
  linked via `parentId`, listed under their parent in the task detail modal
  and nested under it in the Tasks list — they're schedulable with their own
  due date, or one inherited from their nearest dated ancestor, same as a
  locally-created sub-task (see "How the scheduler works" below). Todoist
  allows nesting subtasks arbitrarily deep; anything below the first level is
  flattened onto the top-level task's `parentId` rather than preserving the
  intermediate grouping (which also means an imported sub-task is never more
  than 1 level deep, well under the app's own 2-level nesting cap for
  locally-created sub-tasks).

## Google Calendar

1. [Google Cloud Console](https://console.cloud.google.com/) → create or
   select a project.
2. **APIs & Services → Library** → enable the Google Calendar API.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   (type: Web application). Add `http://localhost:5173` as an authorized
   JavaScript origin, plus your production domain when you deploy — and add
   that same origin (bare, no path) under **Authorized redirect URIs** too
   (see the persistent-auth note below for why both lists matter).
4. **APIs & Services → Credentials → Create Credentials → API key**.
5. Add both to `.env`:
   ```
   VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=xxxxxxxx
   ```
6. Deploy the Cloudflare Worker's Calendar auth routes and add
   `VITE_CALENDAR_AUTH_WORKER_URL` to `.env` too — see
   [`cloudflare-worker/README.md`](../cloudflare-worker/README.md#google-calendar-persistent-auth)
   for the full setup (a client secret and a Firestore-scoped service
   account, both server-side only). This is what makes the connection
   persist across refreshes instead of needing periodic re-login.
7. Restart the dev server, then **Settings → Connect Google Calendar** and
   approve the OAuth prompt. This enables two-way sync of calendar events:
   your Google events populate the calendar grid, and creating, editing,
   moving, resizing, or deleting an event in TaskFlow now pushes that
   change to your primary Google Calendar too. Pulls happen on sign-in/
   connect, on a background poll roughly every minute while connected, on
   returning to the tab/window (if at least 20s have passed since the last
   pull), and on manual **Sync now** — it isn't a true real-time push (that
   would need a webhook server Google notifies on change, not just a
   client-side poll), so a change made directly in Google Calendar can take
   up to about a minute to show up here rather than being instant. If the
   same event changed on both sides since the last sync, **Google
   Calendar's version always wins**. This two-way sync covers calendar
   *events* only. Separately, **today's scheduled task blocks are also
   pushed to Google Calendar, one-way** (TaskFlow → Google only — Google is
   never the source of truth for these, and nothing is ever read back from
   them): as your schedule changes throughout the day, TaskFlow keeps a
   mirror of today's still-active task blocks on your Google Calendar,
   completely automatically, with no button to click. Completing a task
   removes its entry; a rebalance, edit, or drag-drop updates it. Only
   *today's* blocks are ever kept in sync this way — a task block for any
   other day is TaskFlow-only, same as before.

While the project is in Testing publishing status (the default), only
accounts you've explicitly added as test users can complete the OAuth flow:
Cloud Console → **APIs & Services → OAuth consent screen → Audience/Test
users → Add users**. Testing status also sidesteps Google's formal
app-verification requirement for Calendar's scopes (which are "sensitive"),
so it's the right choice for personal/small-scale use — only move to
Production if you actually need the app open to arbitrary Google accounts.

You only need to click "Connect" once, ever (not once per browser profile) —
the one-time consent grant gets exchanged server-side for a Google refresh
token (stored in Firestore, never sent back to the client — see
[`cloudflare-worker/README.md`](../cloudflare-worker/README.md#google-calendar-persistent-auth)),
so every subsequent access token is minted silently on demand, with no
dependency on a cached token's ~1 hour lifetime or the browser holding onto
any Google session state. Reconnecting is only ever needed if you actually
revoke TaskFlow's access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
— Settings flags that case distinctly as "Google Calendar disconnected —
reconnect" (rather than looking identical to never having connected) and a
toast fires the moment it's detected.

Settings → Integrations also has a **Pull from Google Calendar** button
(shown once connected), for forcing an on-demand resync instead of waiting
for the next automatic poll or accepting local drift — it re-fetches your
Google events and overwrites any local changes to synced events with
whatever Google currently has, same as any other pull.

**Subscribed calendars not showing up?** Check that you reconnected *after*
subscribing (TaskFlow lists your subscribed calendars at connect-time),
that the calendar isn't unchecked in Google Calendar's own sidebar
(TaskFlow mirrors the "selected calendars" list), and that it was shared at
"See all event details" rather than "See only free/busy" — a specific
calendar that fails to load names itself in a toast so you know which one
to check.

## AI Quick Add

The **AI Quick Add** button (a sparkle icon) lets you type a free-form
description — or attach up to 5 screenshots and/or PDFs — and have an AI
propose a set of changes across your workspace, instead of filling in forms
field by field or one item at a time. It's reachable from every tab: it's
one of the mini-FABs next to "Add task" in Tasks list/Board view and next to
"New event" in Calendar, and a standalone floating button in the same corner
on Dashboard, Projects, Stats, and Settings (which have no FAB of their own).
It can create tasks and events, break a task into subtasks, set up
dependencies ("do X after Y"), move tasks between projects/sections,
create/rename/delete projects, sections, and labels, and write dashboard
notes (Markdown, so it can produce a formatted checklist or summary) —
essentially anything you could do by hand. Nothing is applied automatically: every request opens
a review screen listing each proposed change individually, so you can
uncheck anything you don't want before applying. Tasks are the default for
anything that needs doing (even with a deadline) — events are reserved for
things that must happen at a fixed real-world time regardless of workload,
like an appointment or meeting. You choose the provider (Claude/Anthropic or
Gemini/Google) and a specific model per request; your last choice is
remembered on that device, and picking a provider you haven't added an API
key for yet is disabled.

Each request sends a snapshot of your workspace so the AI knows what already
exists — a **context scope** picker lets you control how much: **Full
context** (the default) sends everything; **No context** sends none of it
(the AI can still create new tasks/events/projects, it just can't reference
anything existing by id); **Custom** lets you independently restrict to one
project and/or narrow the calendar events sent to a date range, useful for
keeping a request smaller/cheaper or more focused. Your last scope choice is
remembered on that device, same as the provider/model choice.

Your **notes are a separate, opt-in part of that snapshot** — off by default
in every scope, since a note body is unbounded freeform text that can dwarf
the rest of the request. Tick **Include my notes** if you want the AI to be
able to read, edit, or delete the notes you already have; leave it off and it
can still write new ones, it just can't see the existing ones.

This is **bring-your-own-key (BYOK)**, the same model as the Todoist
integration above: each person using the app pastes their own Anthropic
and/or Gemini API key into **Settings → Integrations → AI Quick Add**. That
key is saved only in that browser's `localStorage` and sent straight through
to the provider — never to the app owner, and never baked into any build.

**Getting the button to appear at all requires deploying a small companion
Cloudflare Worker once** — browsers can't call Anthropic/Gemini directly
(CORS), so requests go through a Worker you deploy yourself (free tier, no
billing required). The worker holds no secrets of its own — it's a stateless
relay that forwards whatever key your browser sends it. See
[`cloudflare-worker/README.md`](../cloudflare-worker/README.md) for setup steps.
Once deployed, point the app at it via `.env`:

```
VITE_AI_QUICKADD_WORKER_URL=https://taskflow-ai-quickadd.<your-subdomain>.workers.dev
```

Like the other integrations above, this is entirely optional — leave the env
var unset and the AI Quick Add button simply doesn't appear. Even once it's
configured, each visitor still needs to add their own API key in Settings
before they can actually use it.

For local `npm run dev` convenience, you can also set `VITE_ANTHROPIC_API_KEY`
and/or `VITE_GEMINI_API_KEY` in `.env` — these are read before falling back to
the Settings-saved key, so you don't need to paste a key into the UI on every
fresh checkout. They're never present in the public GitHub Pages build, since
there's no `.env` at build time there.

In-app help is built in too: the guided tour (Settings → Help → Show
tutorial) has a step pointing at the sparkle button, and the button "?" in
the top-right of the AI Quick Add panel itself opens a fuller guide covering
where to get a key and how to use the feature — no need to come back to this
README for either.


## Notifications

**Settings → Notifications** picks which task events can notify you — a task
**starting soon** (with your own minutes-ahead threshold), a task becoming
**overdue**, and a task being **due today** — and over which of two channels.

**In-app notifications** need no setup and work signed out. They fire while
TaskFlow is open, as your browser's native notification popup where that's
permitted, falling back to an in-app toast where it isn't. Ticking the toggle
is what triggers the browser's permission prompt, so it never appears out of
nowhere on some later page load. These are transient alerts, not a persisted
inbox — nothing accumulates in a list to be read later.

**Email notifications** are a separate, self-hosted piece: a plain Node script
(`notify-worker/`) run on a schedule by GitHub Actions, sending through
[Resend](https://resend.com). It can reach you when TaskFlow isn't open at all,
which the in-app channel can't. Two things to know before turning it on:

- **It does nothing until you set it up yourself** — see
  [`notify-worker/README.md`](../notify-worker/README.md) for the workflow, the
  secrets, and the per-trigger rules (due-today arrives as one consolidated
  morning digest rather than an email per task, and there's a "missed" trigger
  distinct from overdue).
- **It is single-recipient by design.** Every email goes to one fixed address
  configured in the workflow's own secrets, not to each account's sign-in
  address — that's what keeps it free of a domain purchase. The toggle is
  therefore restricted to the deployment owner's account, so nobody else can
  switch on something that would quietly mail a stranger's inbox instead of
  their own.

# TaskFlow

TaskFlow is a standalone task manager and time-blocking calendar — add tasks
and fixed routines/meetings directly in the app, and it automatically carves
out when each task actually gets worked on, balancing deadlines against real
free time instead of just sorting a to-do list. It runs completely out of
the box on local sample data, so you can try every view and every feature
(drag-and-drop scheduling, re-balancing, dependencies, undo/redo,
Board/Gantt/Stats views) without connecting anything.

If you already keep tasks in Todoist, you can optionally connect your
account to import them in one click instead of typing them into TaskFlow
(a one-time pull, not an ongoing sync — see below), and optionally sync
your calendar events two-way with Google Calendar (Google's version
always wins if the same event changes on both sides). Both integrations
are entirely opt-in — see [Connecting real data](#connecting-real-data).

Signing in with Google (optional — see [Account & cross-device
sync](#account--cross-device-sync)) syncs your tasks, boards, and settings
to every device you use TaskFlow on, instead of each device keeping its own
separate local copy.

Fully responsive down to phone width, with a bottom tab bar replacing the
sidebar on small screens, and a guided tour that walks new visitors through
every view on first launch (replay it anytime from Settings → Help).

## Contents

- [Quick start](#quick-start)
- [Account & cross-device sync](#account--cross-device-sync)
- [Connecting real data](#connecting-real-data)
- [AI Quick Add](#ai-quick-add)
- [Using the app](#using-the-app)
- [Hosting a public copy on GitHub Pages](#hosting-a-public-copy-on-github-pages)
- [Hosting it beyond localhost (private network)](#hosting-it-beyond-localhost-private-network)
- [Known limitations](#known-limitations)

Working on TaskFlow itself (not just using it)? See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the scheduler internals,
data model, project layout, persistence, contribution conventions, tech
stack, and testing.

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. The app boots with local sample tasks and
calendar events, so Re-balance, drag-and-drop, Undo/Redo, Board,
Month/Week/Day calendar views, Gantt, and Stats all work immediately with no
setup. A guided tour walks you through the main views on first load.

To build for production:

```bash
npm run build   # outputs to dist/
npm run preview # serve the production build locally
```

## Account & cross-device sync

TaskFlow works fully standalone with no sign-in, saving only to the current
browser's `localStorage` exactly as described in
[Persistence](docs/DEVELOPMENT.md#persistence).
Signing in with Google (the account button in the sidebar on desktop, or the
topbar on mobile, and also available from **Settings → Account & sync**) is
entirely optional and adds cross-device sync on top of that local storage,
backed by [Firebase](https://firebase.google.com/) (Auth + Firestore).

**How it works:**

- On first sign-in on a device, if nothing has been synced yet, that
  device's current local data is uploaded to become the cloud copy.
- On every subsequent sign-in (e.g. opening TaskFlow on a second device and
  signing in with the same Google account), the cloud copy is pulled down
  and **overwrites** whatever was local on that device — this is what makes
  a phone and a computer converge onto the same data instead of keeping two
  separate copies.
- From then on, local changes are pushed to the cloud automatically a
  moment after you make them (a short debounce so a burst of edits doesn't
  fire a write per keystroke).
- Sync is **live** while signed in: a background Firestore listener picks up
  a change pushed from another signed-in device and applies it here too,
  usually within a few seconds — no reload needed. **Settings → Account &
  sync → Sync now** is still there as a manual fallback (and it's what
  refreshes Google Calendar events, which don't push live — see [Google
  Calendar](#google-calendar)).
- Signing out just signs out of the account — no local data is deleted.

**Setup, for anyone running their own copy of this app** (not needed if
you're just using someone else's deployment — sign-in works out of the box
there):

1. [Firebase console](https://console.firebase.google.com/) → create a
   project.
2. **Build → Authentication → Get started → Sign-in method → Google** →
   enable it.
3. **Build → Firestore Database → Create database** → start in **production
   mode**.
4. Deploy the rules in [`firestore.rules`](firestore.rules), which restrict
   each user's synced data to that user only — either:
   - CLI: `firebase use --add` (pick your project), then
     `firebase deploy --only firestore:rules`, or
   - Console: **Firestore Database → Rules** (not Realtime Database → Rules —
     a different product with its own JSON-based rules editor, listed
     separately in the sidebar) → paste in the contents of
     [`firestore.rules`](firestore.rules) → **Publish**.
5. Deploy the Firestore **indexes**: `firebase deploy --only firestore:indexes`.
   Cloud backups need a composite index to enforce their retention limits —
   without it, every "Back up now" reports a failure even though the backup
   itself saved fine.
6. Project settings (gear icon) → scroll to "Your apps" → add a Web app →
   copy the `firebaseConfig` object it gives you into `src/firebase.js`,
   replacing the values already there.
7. Sign-in itself uses Google Identity Services (GIS) rather than Firebase's
   own popup/redirect (see `AuthContext.jsx` for why), so it needs the same
   `VITE_GOOGLE_CLIENT_ID` OAuth Client ID used for [Google
   Calendar](#google-calendar) below — set that up too (steps 1-5 there),
   even if you don't care about Calendar sync itself.
8. **Only if you want shared projects** (see [Sharing a project](#sharing-a-project)):
   **Build → Authentication → Sign-in method → Anonymous** → enable it. This
   is what lets someone open a share link and participate without making an
   account — the rules need *some* stable identity to authorize their writes
   against. Leave it off and everything else still works; share links just
   won't be usable by signed-out visitors.

The `firebaseConfig` values (API key, project id, etc.) are not secrets —
they identify the project, they don't authorize access to it — so it's
normal for them to live directly in client-side code rather than `.env`,
unlike the Todoist/Google Calendar credentials below. Access control is
enforced entirely by the Firestore rules from step 4.

### Backups

Independent of cross-device sync, **Settings → Backups** lets you download a
full snapshot of your tasks, boards, and settings as a `.json` file, or
restore one back in — both work whether or not you're signed in, since the
file path never touches Firestore.

If you're signed in, TaskFlow also keeps point-in-time snapshots in your
account: a "Back up now" button for an on-demand snapshot, and an automatic
one taken once a day while you're signed in with cloud sync active. These
live separately from the live sync doc described above (`users/{uid}`, which
is just "current state" and gets overwritten on every change) in their own
`users/{uid}/backups/{backupId}` subcollection, so they're a genuine
rollback point even if a bad sync or an accidental bulk-delete already
propagated to the live doc. **View backups** in Settings lists your recent
snapshots (newest first, tagged "Automatic" or "Manual") to restore or delete.

Both automatic and "Back up now" snapshots keep a rolling 2-week window
each, but as two **independent** pools of 14, not one shared pool: the 14
most recent automatic snapshots are kept (older ones pruned right after each
new one is created), and separately, the 14 most recent manual snapshots are
kept too (older ones pruned right after you create a new one, or on the
next daily automatic-backup check). So up to 14 automatic + 14 manual can
exist side by side.

Restoring — from a file or from a cloud snapshot — replaces your current
tasks, boards, and settings on this device, and asks for confirmation
first, same as **Clear all data** below. Already-completed one-off tasks
aren't included in any backup (there's nothing to restore them to);
recurring tasks always are, since completing one occurrence doesn't mark
the task itself as done.

**Calendar events are included in backups, but still excluded from live
cross-device cloud sync.** Google Calendar remains the single source of
truth for synced events day-to-day — TaskFlow mirrors whatever Google
currently has via polling/pulling (see [Google Calendar](#google-calendar)
below), and any purely local "blocked time" entry (never pushed to Google)
is device-local by design. Live-syncing events across devices too would let
a stale, continuously-reconciled snapshot silently resurrect an event you'd
already deleted (in TaskFlow or directly in Google Calendar) — exactly the
kind of duplicate/reappearing-event bug that exclusion exists to prevent.
A one-off backup restore doesn't share that risk (it's an explicit,
user-initiated, one-directional action rather than an automatic background
sync), so backups do capture your events as a point-in-time safety net —
restoring an old backup will bring back whatever events it had, which may
since have changed or been deleted in Google Calendar.

**Restoring a backup only ever changes local TaskFlow data — it never
touches your actual Google Calendar.** Since Google Calendar remains the
source of truth for the live sync (above), the very next periodic pull
would otherwise silently re-overwrite whatever calendar-related data a
restore brought back. If you want your Google Calendar itself to reflect
what you just restored (or generally want to fix a Google Calendar that's
drifted out of sync with TaskFlow), use **Settings → Integrations →
"Rewrite Google Calendar to match TaskFlow"** — a separate, explicit,
opt-in action (never run automatically by restore itself) that flips the
normal sync direction: TaskFlow's current data becomes authoritative, and
Google is updated to match, deleting any conflicting events. It's scoped
tightly for safety — it only ever touches your own **primary** Google
Calendar (never a calendar you've merely subscribed to or been shared,
like a shared team calendar or a university timetable) and only within the
date range your own tasks/events actually span. It asks for a clear
confirmation first, since — unlike everything else in this section — it
can delete real events on an external service that TaskFlow can't undo.

### Sharing a project

A project can be turned into a **shared project** that other people work in
with you, live. Open a project's "⋯" menu → **Share project**. From the share
dialog you can generate two independent links:

- a **view link** — recipients can read the project but not change anything;
- an **edit link** — recipients can add, edit, and complete tasks.

Each link can be **rotated** (issues a new URL and kills the old one),
**revoked** (turned off but kept, so you can re-enable it), **deleted**
outright, or given an **expiry date**. The same dialog lists everyone who has
joined, lets you change someone between viewer and editor, remove them, or
hand ownership of the project to another collaborator.

**Anyone opening a link joins without needing an account** — they're asked
once for a display name so their changes are attributable, and the project is
filed into their own project list so they never need the link again. That name
is remembered for this browser (rename it anytime from Settings), so joining a
second share link later — or just using TaskFlow signed out in general — never
asks again. Signing in with Google instead gets you the same project across
your own devices. (Guest participation requires Anonymous sign-in to be
enabled on the Firebase project — step 8 of
[Account & cross-device sync](#account--cross-device-sync).)

Every project row shows which of three states it's in: nothing at all for a
private project, **shared by you** (with who's in it) for one you own and have
shared, and **shared with you** (with the owner's name and your role) for one
you joined. The direction matters — "other people can see this" is worth being
certain about.

A few deliberate limits worth knowing:

- **Tasks, Board columns (sections), and per-task comments all sync live.**
  A viewer-role collaborator can look at a shared project's board but can't
  add, rename, or delete its columns.
- **Scheduled time blocks are never shared.** Dragging a shared task onto your
  calendar schedules it for *you* only, and by default shared tasks are left
  out of the automatic scheduler, since capacity is a per-person thing. The
  one exception: a task's "⋯" menu lets an editor **assign it to a specific
  collaborator** via a type-to-search box (including guests, not just
  signed-in accounts) or unassign it, and a task assigned to *you* is
  scheduled by Re-balance schedule against your own capacity like any other
  task — an unassigned task, or one assigned to someone else, still stays out
  of it. Typing "assign to Alex" or "for Alex" into a shared task's title
  smart-parses the assignment too, same as `#project` or `after <task>`.
- **If two people edit the same task at once, the last write wins** — there's no
  field-by-field merge. Editing different tasks never conflicts. The one
  exception is recurring-task completion, which merges properly rather than
  overwriting.
- Sharing requires a real account; a guest can join a shared project but can't
  create one.

Share links need the Cloudflare Worker deployed (see
[`cloudflare-worker/README.md`](cloudflare-worker/README.md)) — the link tokens
are secrets that no browser is ever allowed to read, so generating and
redeeming them happens server-side.

## Connecting real data

TaskFlow is fully usable without either of these — everything below is an
optional integration, not a requirement. Copy the env template and fill in
whatever you have; anything left blank keeps using local sample data for
that piece.

```bash
cp .env.example .env
```

### Todoist

**For local development**, the fastest path is an env var:

1. Todoist → Settings → Integrations → Developer → copy your API token.
2. Paste it into `.env` as `VITE_TODOIST_API_TOKEN` and restart `npm run dev`.

**For the deployed public site** (see [Hosting a public copy on GitHub
Pages](#hosting-a-public-copy-on-github-pages) below), there is no `.env` — each
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

### Google Calendar

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
   [`cloudflare-worker/README.md`](cloudflare-worker/README.md#google-calendar-persistent-auth)
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
[`cloudflare-worker/README.md`](cloudflare-worker/README.md#google-calendar-persistent-auth)),
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
dependencies ("do X after Y"), move tasks between projects/sections, and
create/rename/delete projects, sections, and labels — essentially anything
you could do by hand. Nothing is applied automatically: every request opens
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
[`cloudflare-worker/README.md`](cloudflare-worker/README.md) for setup steps.
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

## Using the app

On phone-width screens (<640px) the sidebar is replaced by a fixed bottom
tab bar (Dashboard / Calendar / Tasks / Projects / Stats / Settings). Tablet widths
keep the full sidebar. Every view is fully usable at any width — nothing is
hidden, only reorganized.

TaskFlow is installable as a PWA — adding it to your phone's home screen
(iOS: Safari's Share sheet → "Add to Home Screen"; Android: Chrome's
"Install app"/"Add to Home screen") launches it full-screen, without the
browser's address bar. Mobile visitors see a one-time dismissible banner
with the exact steps for their platform; it's also always available from
**Settings → Install app** afterwards. See `index.html`/`public/manifest.json`
for the underlying setup and `src/utils/installPrompt.js` for how the
Android/Chrome native install prompt is captured and re-triggered.

This is a manifest-only PWA — there is deliberately **no service worker**
(nothing under `navigator.serviceWorker`, no Workbox/`vite-plugin-pwa`).
Installing just gives a chrome-less launch icon; there's no offline caching
layer, so a stale-looking page after a deploy is ordinary browser/CDN HTTP
caching (hard-refresh fixes it), never a service worker serving an old
cached copy.

- **Dashboard** — the default landing tab: a stats strip (due today,
  overdue, hours scheduled this week), **Right now** (the block currently
  in progress, or what's next, with a live countdown), **Today's agenda**,
  a **this week's progress** ring, and **Notes** — folder-organized sticky
  notes (a title plus a freeform text body) for jotting anything down; a note
  that's just a pasted link auto-formats and stays clickable, and a
  "Recently edited" row surfaces whichever notes you touched last regardless
  of folder. Bookmark files exported from a browser can still be imported,
  one note per bookmark.
- **Calendar** — Month / Week / 3 Day / Day views, picked from the hamburger
  menu next to the date title (tap the date itself to drop down a
  Google-Calendar-style month-strip date picker and jump to any day). A
  **Filter** button in the toolbar narrows what the grid shows: tasks and
  events, tasks only, or events only, plus multi-select by project and by
  tag (both only apply to task blocks — events have neither). Once you have
  more than a handful of projects, the Projects list gets a search box —
  type to narrow it down (typo-tolerant, prefix/substring matches ranked
  first), with Up/Down/Enter to jump straight to and toggle the top match.
  Projects and tags you add later are included automatically unless you've
  explicitly narrowed the list, the trigger shows a dot whenever a filter is
  active, and if a filter hides everything in the visible range the grid
  says so with a one-tap **Clear filters** instead of just looking empty.
  The filter is remembered per device, not synced across them.
  Clicking a day-of-week header in Week/3 Day view jumps straight into Day
  view for that date, same as clicking a day number in Month view. Both
  scheduled task blocks and calendar events (Google-sourced or created in
  TaskFlow via the floating **+** button) support drag-to-move and
  drag-edge-to-resize, on desktop with the mouse and on mobile via
  long-press-then-drag/resize by touch — any event you create counts as
  busy time the scheduler avoids, there's no separate "blocked time" concept
  anymore. Every event/block gets its own proportionally-sized column on the
  continuous time axis by default — overlapping items render side-by-side,
  each sized to its true duration (no artificial minimum height), matching
  how Google Calendar's own web UI lays out a busy day. Only once a group of
  overlapping or back-to-back items becomes too small to render legibly
  individually does it collapse into a single tappable chip instead (click
  to expand) — that chip's label lists the actual event/task titles it
  contains (truncated with "…" once space runs out), not a generic "N
  events" summary. This packs every block/chip with a guaranteed
  non-overlapping layout, so a densely scheduled day always stays legible no
  matter how many short tasks land close together. Hold Ctrl and scroll (or
  pinch on a trackpad) over the grid to zoom the time axis in/out — more room
  at a higher zoom means less clustering, never more. Month view shows a
  density overview (chips per day, clustering short tasks, "+N more" on busy
  days) and clicking a day drills into Day view for the full time grid,
  matching how most calendar apps handle month → day navigation. Tap the
  lock icon on a block to protect it from future rebalances. **Re-balance
  schedule** re-runs the engine while preserving locked blocks.
- **Tasks** — one page, three views via its own List/Board/Gantt switch, all
  scoped to one project at a time (or "All Tasks", or "Inbox" for tasks with
  no project assigned). Switch projects from the sidebar, the Projects page,
  the project picker shown above List/Board, or the search bar; pin, rename,
  or delete a project from its "⋯" menu (sidebar row or the page header) —
  pinned projects sort first, unpinned ones by most recently visited. Like
  "All Tasks", Inbox is a permanent, undeletable pseudo-project, not a real
  project you create.
- **Projects** — a directory of every project: a fuzzy search box, and
  Recent / Shared / My Projects columns (the last sortable by size, total
  estimated hours, or creation date). The sidebar itself only shows your 5
  most recently visited projects plus a link into this page, so it stays
  short even with a large project list.
  - **List** — searchable/filterable; add/edit/complete/delete/lock tasks
    (adding requires a due date); open a task to edit every field, manage
    subtasks, set dependencies, mark it as able to run unattended, force
    it to be scheduled entirely on its due date ("Enforce due date"), or
    exclude it from Re-balance schedule entirely (from the task's "⋯" menu,
    or when adding it) so it's only ever scheduled by dragging it onto the
    calendar yourself. Making
    a task recurring automatically makes its parent (or sub-tasks) recurring
    too, since they represent the steps toward the same repeating goal — no
    need to set it on both sides yourself.
    Every task also has a Todoist-style **comment thread** (up to 200
    comments per task) — post text, a file (image, PDF, or common office
    doc, 10MB max), or both; image attachments show as a clickable
    thumbnail (opens full-size), other files as a name/size chip linking
    to the file. Attachments upload to Firebase Storage (requires being
    signed in — see [Account & cross-device sync](#account--cross-device-sync))
    and sync/back up alongside the rest of the task, same as every other
    field. Once a task hits the 200-comment cap, posting is blocked with a
    clear message until you delete an older comment to make room. File
    attachments aren't available on shared projects' tasks yet — text
    comments still work there as usual.
  - **Board** — Todoist-style Kanban board, one column per Section plus a
    leading "No Section" column (or a flat list if the project has no
    Sections yet). Rename/delete columns, add sections, drag cards between
    them on desktop/tablet (on mobile, open a card and change its Section
    field instead, since there's no drag gesture to hook into). Columns
    themselves can be dragged into a different order by the grip handle in
    their header — that order is remembered per project on this device only
    (it isn't pushed to Todoist or synced across devices), and the leading
    "No Section" column always stays first.
  - **Gantt** — multi-week burn-down: one row per leaf task (a task with
    sub-tasks gets no row of its own — each sub-task gets its own row
    instead, with the parent named as a subtitle), bar spans from first
    scheduled block to due date, colored by priority; blocked tasks get a
    hollow dashed marker, passive tasks get a striped overlay.
- **Bulk select** — a **Select** button in List, Board, Calendar's toolbar,
  and a task's own sub-task list (in its "⋯"-adjacent header) lets you tap/
  click several tasks, cards, or calendar blocks/events at once (checkboxes
  replace the normal open/drag/complete action while it's on) and edit
  whatever field they share — due date, project, tags, priority, complete/
  incomplete, or delete — from one docked bar at the bottom of the screen.
  Editing skips (and reports) any item a field genuinely can't apply to
  (e.g. a due date past a sub-task's own ancestor deadline) rather than
  failing the whole batch. Selecting a mix of scheduled tasks and standalone
  calendar events only offers fields valid for both (a standalone event has
  no project/tags/priority/completion of its own). On mobile, long-pressing a
  chip/day-cell item in Calendar's Month view also enters selection mode and
  selects that item; everywhere else (List, Board, Calendar's Week/Day/3-Day
  view) long-press keeps its existing drag-to-reparent/drag-to-reschedule
  meaning, so Select is reachable via the toolbar button instead. Deleting a
  selection always asks for confirmation first.
- **Stats** — live Total Hours Left, Scheduled Today/This Week, Free
  Capacity This Week, and an at-risk-of-missing-buffer callout.
- **Settings** — connect integrations, tune scheduling rules (buffer days,
  work-day window, max daily hours, horizon, front-loading), edit fixed
  routines on a drag-based 24-hour timeline (drag empty space to add one,
  drag a block to move it, drag its edge to resize, click to rename/pause/
  delete), mark calendar events as "Free Time" individually or in bulk, view
  a searchable **What's new** changelog (**Settings → Versions**, also
  auto-shown once whenever a new version ships), view and rebind every
  keyboard shortcut (**Settings → Keyboard shortcuts**), replay the guided
  tour (**Settings → Help**), and reset local data to wipe TaskFlow's local
  cache without touching your actual Todoist/Google Calendar accounts.
- **Undo / Redo** — every task/block mutation and every rebalance is one
  atomic, undoable action, triggered via keyboard shortcut (`Ctrl+Z` /
  `Ctrl+Shift+Z` by default, rebindable from Settings) rather than a topbar
  button — see `useKeyboardShortcuts.js`.
- **Command palette** — `Ctrl+K` (rebindable from Settings) opens a Linear/
  Todoist-style "jump to anything" search across Views, Projects, Tasks,
  Calendar events, and quick actions (like Re-balance schedule or toggling
  the theme); Arrow keys + Enter pick a result without touching the mouse.

### Smart task titles

Typing naturally into the Title field — e.g. *"Call dentist tomorrow p2
every month after Book appointment"* — auto-detects a due date, Todoist's
`p1`–`p4` priority shorthand, a recurrence rule, an estimated duration
(`"~2 hours"`, `"45 min"`), whether it "can run unattended", an earliest
schedulable date (`"not before Friday"`, `"don't start until tomorrow"`,
`"can't start before March 3"`), `!noauto` / `!manual` to exclude the task
from Re-balance schedule, a plain URL, a dependency, a `sub of`/`subtask of`
mention that makes the task a sub-task of another, an `assign to <name>` /
`for <name>` mention that assigns a shared task to a collaborator (including
guests), a `#project` mention, a standalone `%section` shorthand, and one or
more `@label` mentions,
surfacing each as a dismissible chip rather than applying anything
silently. Dismissing a chip blocks that exact phrase from re-triggering
until you edit it. A chip that matched more than one thing ambiguously
(e.g. `%section` matching sections in several different projects) is
clickable instead, opening a small list to pick which one you meant. See
`src/utils/smartParse.js` and `src/hooks/useSmartTaskTitle.js`.

**Recurrence** covers the phrasings Todoist's own natural-language quick-add
produces: `"every day"` / `"daily"`, `"every 2 weeks"` / `"fortnightly"`,
weekday lists (`"every mon, wed, fri"`, `"every sat and sun"`, `"every
saturday and every sunday"`), ordinal weekdays (`"every 2nd sunday"`,
`"every second monday"`, `"every other monday"`), `"every weekday"`
(Mon–Fri), and `"every other <unit>"` (`"every other week"` = every 2
weeks) — see `src/utils/recurrence.js`.

**Projects and sections**: `#Tasks` matches an existing Project by name;
`#Tasks/Scholarships` or `#Tasks / scholarships` (spaces around the slash
are fine) additionally matches a Section within that project, the same
`#Project/Section` shorthand Todoist itself uses. `%Scholarships` is a
shorter alternative when you don't need to spell out the project — it
searches every project's sections at once, so if more than one project has
a matching section the chip lists them for you to pick from instead of
guessing. Typing `@` or `#` also opens a live autocomplete dropdown
filtered as you type — arrow keys to move the highlight, Tab to cycle
through the options, Enter to pick the highlighted one, Escape to dismiss —
rather than only showing a result after the fact as a chip; see
`src/hooks/useMentionAutocomplete.js`.

**Sub-tasks**: besides adding a new one under a task, an existing task can
be reparented — made a sub-task of another task, or turned back into a
standalone task — four ways: the task's "..." menu ("Remove from parent
task"), the "move to" picker next to its breadcrumb (searches every task by
title), dragging its card/row onto another one in Board or List view (works
with touch on mobile via a long-press), or typing `sub of <task title>` /
`subtask of <task title>` into its title. See `src/hooks/useReparentDrag.js`
and `src/utils/taskHierarchy.js`.

**Links**: a plain URL (`https://…`, `www.…`, or a bare `domain.tld/path`)
becomes the task's `link` field — the URL itself is stripped out of the
title (shown as a highlighted, removable chip while editing, matching how
`@`/`#` mentions are hidden from the title text too), and everywhere that
task's title is shown (List, Board, both Dashboard widgets, the detail
modal) it becomes a click-through with a small link icon so it's obvious
at a glance which tasks have one attached.

Any http(s)/`www.` URL typed into a task's notes (not just the title) also
renders as a clickable link automatically — see `src/utils/linkify.js`.

## Hosting a public copy on GitHub Pages

TaskFlow is a client-only SPA (no backend, no database), so it's a good fit
for GitHub Pages — a free static host that serves whatever `npm run build`
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
   [Google Calendar](#google-calendar) above; the last one requires
   deploying the Cloudflare Worker's Calendar routes, see
   [`cloudflare-worker/README.md`](cloudflare-worker/README.md#google-calendar-persistent-auth)).
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
     see the [Todoist](#todoist) section above for why each visitor instead
     connects their own account from Settings.
   - If you want **AI Quick Add** to work for visitors too, add
     `VITE_AI_QUICKADD_WORKER_URL` as a repo secret as well (see [AI Quick
     Add](#ai-quick-add) above). This is just a Worker URL, not a credential
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

## Known limitations

- Cross-device sync (see [Account & cross-device
  sync](#account--cross-device-sync)) is live for tasks/blocks/boards/
  settings — a change on device A shows up on an already-open device B
  within moments via a background Firestore listener, no reload needed.
  Calendar events are excluded from this sync entirely (Google Calendar is
  their one source of truth — see Backups above) and Google Calendar sync
  itself is the exception: it stays poll-based (see the next bullet), so a
  change made directly in Google Calendar can still take up to about a
  minute to appear.
- Google Calendar sync is two-way but poll-based, not truly real-time —
  pulls happen on sign-in/connect, a ~1-minute background poll while
  connected, on returning to the tab/window, and manual **Sync now**, not
  via a live webhook (no backend exists for that in this client-only SPA),
  so a change made directly in Google Calendar can take up to about a
  minute to appear in TaskFlow rather than being instant. On conflict (the
  same event changed in both places since the last sync), **Google
  Calendar's version always wins** — a local edit that hasn't been pushed
  yet can be silently overwritten by the next pull.
- All-day Google Calendar events are not imported or synced — only timed
  events are.
- Google Calendar sync keeps a modest rolling window (30 days back, 30 days
  forward, centered on today) fresh automatically in the background — pulls
  don't cover the account's entire calendar every time, since that would
  mean a much larger fetch on every ~1-minute poll for a range most sessions
  never even look at. Scrolling the calendar view (Week/Month/etc.) to a date
  outside that window fetches the additional range on demand instead, and
  once fetched it stays synced for the rest of the session — navigating back
  to "today" afterward doesn't drop it again. Retention is capped at a
  rolling 1 year regardless: a non-recurring event older than that (whether
  never synced at all, or on-demand fetched from further back than a year)
  is actively removed from TaskFlow's local mirror on the next sync (it
  stays on Google Calendar itself, only the local mirror is pruned); a
  recurring event's own occurrences roll in and out of view as the window
  advances day by day.
- Today's scheduled task blocks are pushed to Google Calendar one-way only
  (TaskFlow → Google) and only for *today* — a task block for any other day
  is TaskFlow-only. Google is never a source of truth for these entries and
  TaskFlow never reads them back, so editing or deleting one directly in
  Google Calendar has no effect in TaskFlow; the next automatic sync simply
  overwrites it back to match TaskFlow's current schedule.
- Todoist is a one-time import, not a sync — completing, editing, or
  deleting a Todoist-imported task in TaskFlow never writes back to
  Todoist. Re-importing later pulls in anything new/changed on Todoist's
  side, but won't reflect changes made here.
- Reconnecting Google Calendar is only ever needed if you actually revoke
  TaskFlow's access at Google's end (myaccount.google.com/permissions) —
  the server-side refresh-token flow (see [Google
  Calendar](#google-calendar) above) means an ordinary page refresh or
  closed tab never triggers it. When a revoke does happen, Settings
  surfaces a distinct "reconnect" prompt rather than failing silently.
- Undo/Redo (`useHistoryState`) only covers `tasks` and `blocks`. Calendar
  events get the same Undo-toast affordance through a parallel mechanism
  (editing, dragging, or resizing one — including reverting the matching
  Google Calendar push — can be undone), but they're not part of the same
  transactional stack as tasks/blocks. Board sections, Todoist projects, and
  labels live in their own `useState` and are not undoable at all —
  renaming/deleting a Board column or clearing all data cannot currently be
  undone, only the task-side effects of those actions can. Tasks in shared
  projects are deliberately excluded from undo/redo too — undoing only
  affects your own data, since restoring an old snapshot could otherwise
  revert a collaborator's concurrent edits.
</content>

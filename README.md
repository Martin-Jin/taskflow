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
- [How the scheduler works](#how-the-scheduler-works)
- [Data model](#data-model)
- [Project layout](#project-layout)
- [Using the app](#using-the-app)
- [Persistence](#persistence)
- [Contributing / working in this codebase](#contributing--working-in-this-codebase)
- [Tech stack](#tech-stack)
- [Testing](#testing)
- [Hosting a public copy on GitHub Pages](#hosting-a-public-copy-on-github-pages)
- [Hosting it beyond localhost (private network)](#hosting-it-beyond-localhost-private-network)
- [Known limitations](#known-limitations)

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
browser's `localStorage` exactly as described in [Persistence](#persistence).
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
5. Project settings (gear icon) → scroll to "Your apps" → add a Web app →
   copy the `firebaseConfig` object it gives you into `src/firebase.js`,
   replacing the values already there.

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

The automatic backups keep a rolling 2-week window: only the 14 most recent
automatic snapshots are kept, and older ones are pruned right after each new
one is created. Anything you create yourself via "Back up now" is tagged
separately and is **never** pruned by this rotation, no matter how old it
gets or how many automatic backups accumulate — you're the only one who
deletes a manual backup.

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
  and nested under it in the Tasks list — they're schedulable with or
  without their own due date, same as a locally-created sub-task (see "How
  the scheduler works" below). Todoist allows nesting subtasks arbitrarily
  deep; anything below the first level is flattened onto the top-level
  task's `parentId` rather than preserving the intermediate grouping (which
  also means an imported sub-task is never more than 1 level deep, well
  under the app's own 2-level nesting cap for locally-created sub-tasks).

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
   Calendar's version always wins**.

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

The **AI Quick Add** button (a sparkle icon next to "Add task" in Tasks list
and Board view) lets you type a free-form description — or attach a
screenshot — and have an AI propose a set of changes across your whole
workspace, instead of filling in forms field by field or one item at a time.
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

## How the scheduler works

The engine lives in `src/algorithms/` as three layers of plain
JavaScript — no React, no DOM, fully unit-testable in isolation.

### 1. Capacity (`capacityEngine.js`)

For every day in the planning horizon, start with the configured work-day
window (e.g. 07:00–23:00) and subtract active fixed routines for that
day-of-week (sleep, meals, commute), calendar events not marked "Free
Time", and locked scheduled blocks already committed. What's left is that
day's free capacity, as a sorted list of open time intervals.

### 2. Allocation (`allocator.js`)

For each task, a **score** combines priority and urgency into one number:

$$\text{score} = \text{priorityWeight} \times \left(1 + \frac{10}{\max(1,\ \text{daysUntilEffectiveDeadline})}\right)$$

where `priorityWeight` is `urgent=4, high=3, medium=2, low=1` and
`effectiveDeadline = dueDate − bufferDays`. Tasks are processed in
descending score order, so a task due tomorrow at medium priority still
outranks a task due in six weeks at high priority. Equal scores (e.g. two
default-priority, undated sibling sub-tasks) tiebreak on creation order —
whichever sub-task was added first schedules first.

A sub-task with no due date of its own borrows its nearest ancestor's due
date for this calculation instead of falling back to the baseline "no
deadline" urgency — the parent goal's deadline pressures its steps even
when they aren't individually dated (see `resolveDueDate`). A **container**
task (any task with ≥1 sub-task of its own) is never scored or scheduled
directly at all, regardless of whether it has a due date — see "Sub-tasks
and containers" below.

A task's `effectiveDeadline` also absorbs pressure from anything that
`dependsOn` it: if B depends on A and B is due soon, A is scored as if it
had B's (tighter) deadline too — a blocker being late makes everything
waiting on it late, so it's treated with the same urgency, using its own
priority weight rather than borrowing B's. This propagates transitively
through chains of any length (A→B→C) and is defensive against a corrupted
dependency cycle (it can't hang a rebalance even on bad data), though the
Edit modal already stops a cycle from being created in the first place.

Beyond scoring, a **blocker task** (anything with at least one other,
still-incomplete task depending on it) also gets placed differently: instead
of pacing its hours evenly across its window like everything else, it
greedily consumes as much of each day's free capacity as it can, so it
clears out of the way — and unblocks whatever's waiting on it — as fast as
possible, rather than splitting the day evenly with unrelated equal-priority
work. This still isn't full job-shop-style makespan minimization (there's no
global reordering of the whole schedule to minimize total completion time);
it's a targeted rule for this one case.

The **planning window** is `[today, dueDate − bufferDays]` — the buffer
targets finishing a day early by default, but it's a soft preference: if
the buffer-shrunk window can't fit a task's remaining hours, the engine
spills the leftover into the days between the buffer target and the real
due date before ever calling a task unschedulable.

A task can opt out of both the buffer and pacing with **"Enforce due
date"**: the window collapses to just `[dueDate, dueDate]`, so every
remaining hour lands on the due date itself instead of being spread out
ahead of it.

**Pacing** distributes hours across the window: even pacing (default) gives
every day an equal share; front-loaded pacing (for urgent/high-priority
tasks, when enabled) ramps effort up as the deadline approaches.

**Placement** is greedy and runs in three passes — an ideal-day pass
clamped to `[minChunkHours, maxChunkHours]` and available capacity, a sweep
pass that mops up hours that didn't fit their ideal day into any other open
capacity in the window, and a final spill pass into the buffer-to-due-date
range. Only after all three passes still have leftover hours does a task
show up in the "couldn't be fully scheduled" overflow.

### 3. Rebalancing (`rebalanceEngine.js`)

Backs the **Re-balance schedule** button: partitions existing blocks into
historical (before today, untouched), locked (protected, untouched), and
unlocked-future (cleared and re-planned); recomputes each task's
`remainingHours`; runs capacity + allocation over just the unlocked
remainder; merges everything back together. Locked blocks are never
destroyed by a rebalance.

**Plan today** (same file, `planToday()`) is a lighter sibling: it only
clears and re-plans *today's* unlocked blocks — every other day, past or
future, is left untouched. It can't just reuse `allocateTasks`'s normal
multi-day pacing against a one-day capacity map (that would dilute today's
placement based on due-date runway it can no longer see, and misreport
plenty-of-time tasks as overflow) — instead it calls `allocateTasks` with
`{ dayScoped: true }`, which greedily targets each task's full remaining
hours against today alone (the same fast-path the allocator already used
for "blocker" tasks — see above). Future blocks aren't touched, so their
hours still count as already-spent when recomputing `remainingHours`, or a
task with work already booked tomorrow would get double-scheduled.

### Sub-tasks and containers

A sub-task (`parentId` set) is scheduled exactly like a top-level task —
same scoring, same pacing, same placement passes — with one twist: if it
has no due date of its own, it borrows its nearest ancestor's due date as
urgency pressure instead of the flat "no deadline" baseline (see
`resolveDueDate` above). Nesting is capped at 2 levels (task → sub-task →
sub-task of that sub-task), enforced going forward only.

The moment a task has ≥1 sub-task, it becomes a **container**: it never
gets its own calendar block again, no matter its own due date or hours —
only its leaf sub-tasks (or deeper leaves, if nested) do. Its
`estimatedHours`/`remainingHours` become a live rollup of its children's
own effective hours instead of an independently-editable number (see
`utils/taskHierarchy.js`), and its own due date becomes purely an input
into its children's urgency rather than something scheduled directly.
Everything else on it (priority, lock state, min/max chunk hours, labels)
stays independently editable, same as before.

### Dependencies and passive tasks

A task can list other tasks it `dependsOn`. `rebalanceEngine` excludes a task
from allocation until every dependency is complete — a blocked task just has
zero eligible hours. Beyond that gate, a dependency also feeds backward into
scoring: a blocker's effective urgency rises to match whatever depends on it
(see "Allocation" above), so a blocker due soon *because* something urgent is
waiting on it gets scheduled earlier, not just eventually. The Edit modal
blocks picking a dependency that would create a cycle.

A task marked **"can run unattended"** (`isPassive` — laundry, something
baking) gets its own capacity track: it's placed against a fresh copy of
each day's free time rather than the pool other tasks carve into, so any
number of passive tasks can share a time slot with other work. Calendar
views render genuinely overlapping blocks side-by-side, with passive blocks
getting a dashed border and stripe fill.

## Data model

See `src/types/index.js` for full JSDoc typedefs.

| Type | Purpose |
|---|---|
| `Task` | Hours, priority, due date, lock/complete state, optional section, optional `parentId` (sub-task of another Task, capped at 2 levels deep — see "Sub-tasks and containers"), optional `dependsOn` and `isPassive`, optional `comments` (text + optional file attachment, Firebase Storage-backed). |
| `Section` | A Todoist Section — Board view column |
| `Project` | A Todoist Project, or a local-only one created from the sidebar's "+" — the top-level grouping switched between from the sidebar, List/Board's project header, or the search bar |
| `ScheduledBlock` | A concrete dated/timed slice of a `Task` on the calendar |
| `FixedRoutine` | Recurring non-negotiable time (sleep, meals, commute) |
| `CalendarEvent` | External (Google) or manual event; `isFreeTime` enables the "ignore" override |
| `SchedulingRules` | Global config: buffer days, work-day window, pacing, horizon |
| `DayCapacity` | Derived per-day free-time snapshot the allocator consumes |
| `HistoryEntry` | One Undo/Redo snapshot (full tasks+blocks state) |

## Project layout

```
src/
├── algorithms/               # Pure scheduling logic, framework-agnostic
│   ├── capacityEngine.js     # Day-by-day free-time computation
│   ├── allocator.js          # Priority/deadline-aware hour distribution
│   └── rebalanceEngine.js    # Orchestrates capacity+allocator, preserves locks
├── components/
│   ├── Dashboard/              # DashboardPage (default landing tab) — DashboardStats, NowNextCard, TodayAgenda, WeeklyProgressRing, NotesCard (+ notesModel.js)
│   ├── Calendar/              # WeekView (day/week time-grid, drag/resize), MonthView (density overview), CalendarPage
│   ├── Board/                 # BoardView — Kanban-style Section columns, or a flat list for a project with no Sections yet
│   ├── Gantt/                 # GanttChart burn-down view
│   ├── Stats/                 # StatsDashboard + BarChart/PieChart
│   ├── Modals/                # AddTaskModal (Todoist-style quick-add), TaskDetailModal (sub-tasks open a nested instance of itself), BlockDetailModal, EventDetailModal, ShortcutsModal (Settings → Keyboard shortcuts)
│   ├── Nav/                   # Sidebar — desktop/tablet nav + project list (pin/rename/delete via ProjectActionsMenu); BottomTabBar — mobile-only nav; AccountButton — sign-in/account menu (sidebar + mobile topbar)
│   ├── Tutorial/               # GuidedTour + its step content (guidedTourSteps.js)
│   ├── Common/                 # SearchBar (also searches/switches projects), ProjectActionsMenu, Linkified (renders URLs in notes as links), Toast, SmartChips, SmartTitleInput, SmartDurationInput, SmartRecurrenceInput, DependencyPicker, LabelPicker, DetailField, CompleteTaskConfirmModal (log actual time spent on completion)
│   ├── Settings/                # RoutineTimeline — drag-to-edit 24h fixed-routines timeline
│   ├── TaskListPanel.jsx
│   └── SettingsPanel.jsx
├── context/
│   ├── SchedulerContext.jsx  # Global state: tasks/blocks/routines/rules/sections + actions (+ cloud sync, see AuthContext)
│   ├── ThemeContext.jsx      # Light/dark theme (+ cloud sync)
│   ├── CompleteTaskContext.jsx # Intercepts task completion to stop/log a running Pomodoro timer (see TimerContext) before delegating to SchedulerContext.completeTask
│   └── AuthContext.jsx       # Firebase Auth (Google sign-in) — see "Account & cross-device sync"
├── firebase.js                # Firebase app/Auth/Firestore init — see "Account & cross-device sync"
├── hooks/
│   ├── useHistoryState.js         # Generic Undo/Redo transactional stack
│   ├── useIsMobile.js             # matchMedia-backed layout branching
│   ├── usePersistedState.js       # localStorage-backed useState
│   ├── useAnimatedUnmount.js      # Plays a CSS exit transition before unmount
│   ├── useAutosizeTextarea.js     # Grows a textarea to fit its content, no scrollbar
│   ├── useComboboxMultiSelect.js  # Shared open/close/query state for DependencyPicker + LabelPicker
│   ├── useSmartTaskTitle.js       # Shared smart-parse wiring for the title field
│   └── useKeyboardShortcuts.js    # Global rebindable shortcuts (undo/redo/new task) — bindings in localStorage, editable from Settings → Keyboard shortcuts
├── migrations/
│   ├── migrateBlockedTimeToEvents.js  # One-time data-shape migration backfilling new event fields (description/location) onto pre-existing manual events — see file-level comments for removal timing
│   └── migrateSubtasksToTasks.js      # One-time migration converting the old embedded Task.subtasks array into standalone parentId-linked Tasks — see file-level comments for removal timing
├── services/
│   ├── todoistService.js         # Todoist API v1 wrapper + normalization
│   ├── googleCalendarService.js  # Google Calendar OAuth + two-way event sync (push/pull)
│   ├── eventSyncService.js       # Google-wins merge/reconcile logic for pulled events
│   ├── firestoreSync.js          # Pull/push/live-subscribe to a signed-in user's synced data
│   └── mockData.js               # Zero-config sample data
├── utils/
│   ├── dateUtils.js          # ISO date / "HH:MM" arithmetic
│   ├── intervalUtils.js      # Interval merge/subtract math
│   ├── durationParser.js     # Free-text duration extraction
│   ├── dateParse.js          # Free-text due-date phrase detection
│   ├── recurrence.js         # Free-text recurrence phrase detection (task due-date recurrence, e.g. "every monday")
│   ├── recurrenceExpansion.js # RRULE parsing + display-time expansion of recurring calendar events into visual instances
│   ├── smartParse.js         # Composes the above + priority/dependency detection
│   ├── dependencyUtils.js    # Cycle detection for dependsOn graphs
│   ├── taskFacets.js         # Derived task facets (blocked/overdue/etc.)
│   ├── linkify.js            # Turns http(s)/www URLs in free text into clickable segments
│   └── projectConstants.js   # "All Tasks" pseudo-project sentinel + sidebar project ordering
├── types/
│   └── index.js               # JSDoc typedefs for the whole domain model
├── styles/                    # global.css (tokens/breakpoints), calendar.css, gantt.css, board.css, nav.css, tasklist.css, stats.css, forms.css, tutorial.css
├── App.jsx                    # Shell: sidebar (desktop/tablet) or bottom tab bar (mobile) + tabs; mobile-only brand topbar; global keyboard shortcuts (see useKeyboardShortcuts.js)
└── main.jsx                   # React root
```

`algorithms/` never imports React or touches the DOM. `services/` never
imports React either — it only knows how to talk to external APIs and
normalize responses into our internal types. `context/` is the only place
that wires algorithms + services into React state; components only ever
read from `useScheduler()` and call its actions, never mutating tasks/blocks
directly, which is what keeps Undo/Redo reliable everywhere.

## Using the app

On phone-width screens (<640px) the sidebar is replaced by a fixed bottom
tab bar (Dashboard / Calendar / Tasks / Stats / Settings). Tablet widths
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
  Google-Calendar-style month-strip date picker and jump to any day).
  Clicking a day-of-week header in Week/3 Day view jumps straight into Day
  view for that date, same as clicking a day number in Month view. Both
  scheduled task blocks and calendar events (Google-sourced or created in
  TaskFlow via the floating **+** button) support drag-to-move and
  drag-edge-to-resize, on desktop with the mouse and on mobile via
  long-press-then-drag/resize by touch — any event you create counts as
  busy time the scheduler avoids, there's no separate "blocked time" concept
  anymore. Any task with unplaced hours shows up as a draggable chip in the
  "Unscheduled" tray above the grid — drag (or long-press-drag on touch) one
  straight onto a day to place a block manually, sized to the task's own
  chunk-size rules, without waiting for Re-balance/Plan today. Overlapping
  events/blocks render side-by-side in columns on
  desktop; on mobile, where there's no room for columns, they collapse into
  a single tappable "N events" chip instead. Week/3 Day/Day view clusters
  runs of short back-to-back tasks into a single "N short tasks" chip (click
  to expand) and packs every block/chip with a guaranteed non-overlapping
  layout, so a densely scheduled day always stays legible no matter how many
  short tasks land close together. Hold Ctrl and scroll (or pinch on a
  trackpad) over the grid to zoom the time axis in/out. Month view shows a
  density overview (chips per day, clustering short tasks, "+N more" on busy
  days) and clicking a day drills into Day view for the full time grid,
  matching how most calendar apps handle month → day navigation. Tap the
  lock icon on a block to protect it from future rebalances. **Re-balance
  schedule** re-runs the engine while preserving locked blocks. **Plan
  today**, next to it, only clears and re-plans today's unlocked blocks,
  leaving every other day exactly as it was — useful when you just want to
  fill in today's gaps without disturbing the rest of the week.
- **Tasks** — one page, three views via its own List/Board/Gantt switch, all
  scoped to one project at a time (or "All Tasks"). Switch projects from the
  sidebar, the project picker shown above List/Board, or the search bar;
  pin, rename, or delete a project from its "⋯" menu (sidebar row or the
  page header) — pinned projects sort first, unpinned ones by most recently
  visited.
  - **List** — searchable/filterable; add/edit/complete/delete/lock tasks
    (adding requires a due date); open a task to edit every field, manage
    subtasks, set dependencies, mark it as able to run unattended, or force
    it to be scheduled entirely on its due date ("Enforce due date").
    Every task also has a Todoist-style **comment thread** — post text,
    a file (image, PDF, or common office doc, 10MB max), or both; image
    attachments show as a clickable thumbnail (opens full-size), other
    files as a name/size chip linking to the file. Attachments upload to
    Firebase Storage (requires being signed in — see [Account &
    cross-device sync](#account--cross-device-sync)) and sync/back up
    alongside the rest of the task, same as every other field.
  - **Board** — Todoist-style Kanban board, one column per Section plus a
    leading "No Section" column (or a flat list if the project has no
    Sections yet). Rename/delete columns, add sections, drag cards between
    them on desktop/tablet (on mobile, open a card and change its Section
    field instead, since there's no drag gesture to hook into).
  - **Gantt** — multi-week burn-down: one row per leaf task (a task with
    sub-tasks gets no row of its own — each sub-task gets its own row
    instead, with the parent named as a subtitle), bar spans from first
    scheduled block to due date, colored by priority; blocked tasks get a
    hollow dashed marker, passive tasks get a striped overlay.
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

### Smart task titles

Typing naturally into the Title field — e.g. *"Call dentist tomorrow p2
every month after Book appointment"* — auto-detects a due date, Todoist's
`p1`–`p4` priority shorthand, a recurrence rule, an estimated duration
(`"~2 hours"`, `"45 min"`), whether it "can run unattended", a plain URL, a
dependency, a `#project` mention, and one or more `@label` mentions,
surfacing each as a dismissible chip rather than applying anything
silently. Dismissing a chip blocks that exact phrase from re-triggering
until you edit it. See `src/utils/smartParse.js` and
`src/hooks/useSmartTaskTitle.js`.

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
`#Project/Section` shorthand Todoist itself uses. Typing `@` or `#` also
opens a live autocomplete dropdown filtered as you type — arrow keys +
Enter to pick a project/section/label, Escape to dismiss — rather than
only showing a result after the fact as a chip; see
`src/hooks/useMentionAutocomplete.js`.

**Links**: a plain URL (`https://…`, `www.…`, or a bare `domain.tld/path`)
becomes the task's `link` field — the URL itself is stripped out of the
title (shown as a highlighted, removable chip while editing, matching how
`@`/`#` mentions are hidden from the title text too), and everywhere that
task's title is shown (List, Board, both Dashboard widgets, the detail
modal) it becomes a click-through with a small link icon so it's obvious
at a glance which tasks have one attached.

Any http(s)/`www.` URL typed into a task's notes (not just the title) also
renders as a clickable link automatically — see `src/utils/linkify.js`.

## Persistence

Everything persists to `localStorage` (see `src/utils/persistence.js`):
tasks, scheduled blocks, sections, projects, calendar events, scheduling
rules, fixed routines, when the last Todoist import ran, and a "connected
to Google Calendar" flag plus a short-lived cached access token (the Google
refresh token itself is never persisted client-side at all — it lives only
in Firestore, written by the Cloudflare Worker; see
[Google Calendar](#google-calendar) above). A recurring calendar
event is stored once with its RRULE recurrence rule, not as one record
per occurrence — occurrences are expanded for display only.

In practice: nothing is ever re-fetched from Todoist automatically — your
local tasks are always the source of truth, and a Todoist import only ever
happens when you click **Settings → Import from Todoist**. Use
**Settings → Reset local data** to wipe everything and start fresh from
mock data.

If signed in (see [Account & cross-device sync](#account--cross-device-sync)),
the same data also syncs to Firestore — `localStorage` on the current device
stays the always-on, works-offline source of truth, and the cloud copy is
what a second device pulls down.

## Contributing / working in this codebase

**Data flows one way, through one place.** `SchedulerContext.jsx` holds all
state and is the only thing that talks to `algorithms/` and `services/`.
Components call an action from `useScheduler()` (e.g. `updateTask`,
`rebalance`) and re-render off the context — never mutate state directly.
That's the reason Undo/Redo works for free on `tasks`/`blocks`: every action
touching them goes through `useHistoryState`, which snapshots before/after
into a transactional stack. Sections/projects/labels are plain `useState`
and are not part of that stack — see Known limitations.

**The scheduling engine is plain JS, not React.** Everything under
`algorithms/` takes plain objects in, returns plain objects out. Deliberate:
it's the part of the app worth unit-testing in isolation, and staying
framework-agnostic means it could move into a backend service later without
a rewrite.

**`services/` only knows how to talk outward.** `todoistService.js` and
`googleCalendarService.js` each wrap one external API and normalize its
responses into `src/types/index.js`'s internal types — they're the only
files that should change if an external API's shape changes.

**Smart-parse is composed, not monolithic.** Free-text detection for the
task title is split into small single-purpose detectors
(`dateParse.js`, `recurrence.js`, plus inline priority/dependency detectors)
that `smartParse.js` runs in sequence, stripping each match before the next
detector runs. `useSmartTaskTitle.js` wires that logic into both the Add and
Edit modals identically so they can't drift apart.

**Animation follows one pattern.** React unmounts a component the instant
its parent stops rendering it, cutting off any CSS exit transition. Every
modal uses `useAnimatedUnmount.js` instead of calling `onClose` directly: it
flips an `is-closing` class, waits out the transition, then unmounts.

**Mobile is a layout branch, not a separate app.** Every view renders the
same data at every width. Most adaptation is pure CSS media queries; the
few places that need to branch in JS go through `useIsMobile()`/
`useIsTablet()` (`src/hooks/useIsMobile.js`) rather than duplicating
components.

Read [How the scheduler works](#how-the-scheduler-works),
[Data model](#data-model), and [Project layout](#project-layout) before
making structural changes — they cover what the app does architecturally;
this section covers how the pieces talk to each other.

## Tech stack

- **React 18**, function components + hooks only.
- **Vite** for dev/build tooling.
- No external state library — `useHistoryState` + React Context is enough
  at this scope and keeps the undo/redo model transparent and debuggable.
- No CSS framework — hand-authored CSS custom properties (design tokens) in
  `styles/global.css`.
- Responsive via plain CSS media queries plus a small `useIsMobile()`/
  `useIsTablet()` hook for the few places layout must branch in JS.
- JSDoc typedefs (`src/types/index.js`) give editor-level type safety
  without a TypeScript build step — add `// @ts-check` to any file to get
  live type checking in VS Code today.

## Testing

`npm run build` is the main correctness check for everything in this repo
(catches type/import/build errors).

Two additional suites cover more than the build check can:

```bash
npm run test:unit                              # Vitest, ~3s, no setup needed
npm run test:e2e -- tests/e2e/full-suite       # Playwright, boots its own dev server
```

`npm run test:unit` runs [Vitest](https://vitest.dev) over `tests/unit/` —
pure-logic coverage (date/recurrence math, natural-language parsing,
backup/restore, dependency-cycle detection, cloud-sync merge/race-guard
logic). Output (pass/fail counts per file) prints straight to the terminal
when it finishes.

`npm run test:e2e -- tests/e2e/full-suite` runs the tracked
[Playwright](https://playwright.dev) suite covering user-facing behavior
(tasks, views, dashboard, settings/backups, search/shortcuts/undo, timer).
It works headless against seeded `localStorage` mock data, no login
required; `playwright.config.js`'s `webServer` block starts the dev server
automatically (or reuses one already on port 5183). Pass/fail results print
to the terminal; on failure, Playwright also writes an HTML report you can
open with `npx playwright show-report`.

`npm run test:e2e` (no path) runs everything under `tests/e2e/`, including
`tests/e2e/todoist-parity.spec.js`, which checks TaskFlow's smart-parse
(`utils/smartParse.js`) against real Todoist's own quick-add parsing for a
table of representative phrases. It needs a logged-in Todoist session,
since quick-add's natural-language parsing only runs for a signed-in
account:

```bash
npx playwright open --save-storage=todoist-storage-state.json https://todoist.com/app
# log in manually in the window that opens, then close it
TODOIST_STORAGE_STATE=todoist-storage-state.json npm run test:e2e
```

Without `TODOIST_STORAGE_STATE` set (or if the file doesn't exist), the
suite skips with a clear message rather than failing — there's no
expectation that a Todoist test account is available in every environment
this runs in. Never commit the storage-state file (it's a real logged-in
session) — it's already gitignored.

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
  to "today" afterward doesn't drop it again. A non-recurring event that's
  never been synced (neither by the routine window nor an on-demand fetch
  this session) is actively removed from TaskFlow's local mirror once it ages
  past the oldest edge ever synced (it stays on Google Calendar itself, only
  the local mirror is pruned); a recurring event's own occurrences roll in
  and out of view as the window advances day by day.
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
  undone, only the task-side effects of those actions can.
</content>

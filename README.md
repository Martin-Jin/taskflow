# TaskFlow

TaskFlow turns a Todoist task list into a fully time-blocked calendar. Point
it at your tasks, tell it your fixed routines and existing meetings, and it
automatically carves out when each task actually gets worked on — balancing
deadlines against real free time, not just sorting a to-do list. Push the
result straight to Google Calendar when you're happy with it.

It runs completely out of the box on mock data, so you can try every view
and every feature (drag-and-drop scheduling, re-balancing, dependencies,
undo/redo, Board/Gantt/Stats views) without an API key in sight. Fully
responsive down to phone width, with a bottom tab bar replacing the sidebar
on small screens.

## Contents

- [Quick start](#quick-start)
- [Connecting real data](#connecting-real-data)
- [How the scheduler works](#how-the-scheduler-works)
- [Data model](#data-model)
- [Project layout](#project-layout)
- [Using the app](#using-the-app)
- [Persistence](#persistence)
- [Contributing / working in this codebase](#contributing--working-in-this-codebase)
- [Tech stack](#tech-stack)
- [Hosting a public copy on GitHub Pages](#hosting-a-public-copy-on-github-pages)
- [Hosting it beyond localhost (private network)](#hosting-it-beyond-localhost-private-network)
- [Known limitations](#known-limitations)

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. The app boots with sample Todoist tasks and
sample calendar events, so Re-balance, drag-and-drop, Undo/Redo, Board,
Month/Week/Day calendar views, Gantt, and Stats all work immediately with no
setup.

To build for production:

```bash
npm run build   # outputs to dist/
npm run preview # serve the production build locally
```

## Connecting real data

Everything below is optional — TaskFlow works fine without it. Copy the env
template and fill in whatever you have; anything left blank keeps using mock
data for that piece.

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

Tasks (and Sections, for Board view) now come from your live Todoist
account. A few things worth knowing:

- **This targets Todoist API v1** (`api.todoist.com/api/v1`), not the
  retired REST v2. If you're merging in older code that still points at
  `rest/v2`, update it — see `src/services/todoistService.js`.
- **Tasks with no due date are never imported.** The scheduler needs a due
  date to compute a planning window, so an undated task has nowhere to go
  on the calendar and is filtered out of the sync entirely (the in-app
  **Add task** dialog enforces the same rule).
- **Estimated hours** come from Todoist's native `duration` field if set,
  otherwise from a duration mentioned in the title/description (`"~2
  hours"`, `"45 min"`, `"1h 30m"`, `"half an hour"` — see
  `src/utils/durationParser.js`), otherwise default to 1 hour.
- **Subtasks** (Todoist items with a parent) are grouped under their parent
  as a checklist in the task detail modal — never scheduled as independent
  blocks.

**Two-way sync.** Once a token is configured, editing a Todoist-sourced task
(or its subtasks, or a Board Section) in TaskFlow pushes the change back to
Todoist immediately in the background. The local edit applies instantly
regardless of whether the network call has finished, and Undo/Redo keeps
working normally; a failed sync call (offline, revoked token) keeps the
local edit and toasts what didn't sync.

| Editable in TaskFlow | Syncs to Todoist? |
|---|---|
| Title, description, priority, due date, estimated hours | Yes — hours sync as Todoist's `duration` field |
| Task's project/section (moving it on the Board) | Yes |
| Marking a task complete | Yes |
| Deleting a task | Yes |
| Subtask add/rename/check off/delete | Yes |
| Section create/rename/delete | Yes |
| New task created in-app | Local-only unless you check "Also create in Todoist" (requires picking a project) |
| Lock state, min/max chunk hours, `remainingHours` | No — app-only, no Todoist equivalent |
| Scheduled block placement/timing | No — that's what Google Calendar push is for |

Manually-created tasks that were never synced to Todoist stay local-only,
since there's no Todoist item to update. Flip **"Keep syncing task changes
to Todoist"** off in Settings to freeze your current tasks as the local
source of truth and stop all Todoist reads/writes; turning it back on
resumes syncing on the next load.

### Google Calendar

1. [Google Cloud Console](https://console.cloud.google.com/) → create or
   select a project.
2. **APIs & Services → Library** → enable the Google Calendar API.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   (type: Web application). Add `http://localhost:5173` as an authorized
   JavaScript origin, plus your production domain when you deploy.
4. **APIs & Services → Credentials → Create Credentials → API key**.
5. Add both to `.env`:
   ```
   VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=xxxxxxxx
   ```
6. Restart the dev server, then **Settings → Connect Google Calendar** and
   approve the OAuth prompt. Your real events populate the calendar grid,
   and **Push scheduled blocks to Google Calendar** creates real events on
   your primary calendar.

While the project is in Testing publishing status (the default), only
accounts you've explicitly added as test users can complete the OAuth flow:
Cloud Console → **APIs & Services → OAuth consent screen → Audience/Test
users → Add users**.

You only need to click "Connect" once per browser profile — TaskFlow then
silently refreshes the access token on future loads (no popup) as long as
the underlying Google grant is still valid. If you revoke access from your
Google Account settings, the silent refresh fails quietly and Settings just
shows "Connect Google Calendar" again.

> The app uses Google Identity Services' token client (implicit OAuth2
> flow), which is appropriate for a client-only SPA. For a multi-tenant
> production deployment behind a backend, swap this for a server-side
> OAuth2 flow with refresh tokens — `src/services/googleCalendarService.js`
> is the one file that would need to change.

**Subscribed calendars not showing up?** Check that you reconnected *after*
subscribing (TaskFlow lists your subscribed calendars at connect-time),
that the calendar isn't unchecked in Google Calendar's own sidebar
(TaskFlow mirrors the "selected calendars" list), and that it was shared at
"See all event details" rather than "See only free/busy" — a specific
calendar that fails to load names itself in a toast so you know which one
to check.

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
outranks a task due in six weeks at high priority.

The **planning window** is `[today, dueDate − bufferDays]` — the buffer
targets finishing a day early by default, but it's a soft preference: if
the buffer-shrunk window can't fit a task's remaining hours, the engine
spills the leftover into the days between the buffer target and the real
due date before ever calling a task unschedulable.

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

### Dependencies and passive tasks

A task can list other tasks it `dependsOn`. `rebalanceEngine` simply excludes
a task from allocation until every dependency is complete — there's no
separate "must start after" logic, a blocked task just has zero eligible
hours. The Edit modal blocks picking a dependency that would create a cycle.

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
| `Task` | Hours, priority, due date, lock/complete state, optional section + subtasks, optional `dependsOn` and `isPassive`. Always has a `dueDate`. |
| `Subtask` | A Todoist child item, grouped under its parent `Task` |
| `Section` | A Todoist Section — Board view column |
| `Project` | A Todoist Project — Board view's project filter |
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
│   ├── Calendar/              # WeekView (day/week time-grid, drag/resize), MonthView (density overview), CalendarPage
│   ├── Board/                 # BoardView — Kanban-style Section columns
│   ├── Gantt/                 # GanttChart burn-down view
│   ├── Stats/                 # StatsDashboard + BarChart/PieChart
│   ├── Modals/                # AddTaskModal (Todoist-style quick-add), TaskDetailModal, BlockDetailModal, EventDetailModal, SubtaskDetailModal
│   ├── Nav/                   # BottomTabBar, MoreSheet — mobile-only nav
│   ├── Tutorial/               # TutorialModal + its step content
│   ├── Common/                 # SearchBar, Toast, SmartChips, SmartTitleInput, DependencyPicker, LabelPicker, DetailField
│   ├── Settings/                # RoutineTimeline — drag-to-edit 24h fixed-routines timeline
│   ├── TaskCard.jsx
│   ├── TaskListPanel.jsx
│   └── SettingsPanel.jsx
├── context/
│   └── SchedulerContext.jsx  # Global state: tasks/blocks/routines/rules/sections + actions
├── hooks/
│   ├── useHistoryState.js         # Generic Undo/Redo transactional stack
│   ├── useIsMobile.js             # matchMedia-backed layout branching
│   ├── usePersistedState.js       # localStorage-backed useState
│   ├── useAnimatedUnmount.js      # Plays a CSS exit transition before unmount
│   ├── useAutosizeTextarea.js     # Grows a textarea to fit its content, no scrollbar
│   ├── useComboboxMultiSelect.js  # Shared open/close/query state for DependencyPicker + LabelPicker
│   └── useSmartTaskTitle.js       # Shared smart-parse wiring for the title field
├── services/
│   ├── todoistService.js         # Todoist API v1 wrapper + normalization
│   ├── googleCalendarService.js  # Google Calendar OAuth + events + push
│   └── mockData.js               # Zero-config sample data
├── utils/
│   ├── dateUtils.js          # ISO date / "HH:MM" arithmetic
│   ├── intervalUtils.js      # Interval merge/subtract math
│   ├── durationParser.js     # Free-text duration extraction
│   ├── dateParse.js          # Free-text due-date phrase detection
│   ├── recurrence.js         # Free-text recurrence phrase detection
│   ├── smartParse.js         # Composes the above + priority/dependency detection
│   ├── dependencyUtils.js    # Cycle detection for dependsOn graphs
│   └── taskFacets.js         # Derived task facets (blocked/overdue/etc.)
├── types/
│   └── index.js               # JSDoc typedefs for the whole domain model
├── styles/                    # global.css (tokens/breakpoints), calendar.css, gantt.css, board.css, nav.css, tasklist.css, stats.css, forms.css, tutorial.css
├── App.jsx                    # Shell: sidebar (desktop/tablet) or bottom tab bar (mobile) + topbar + tabs
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
tab bar (Calendar / Tasks / Board / Gantt / More), with **More** opening a
sheet for Stats and Settings. Tablet widths keep the full sidebar. Every
view is fully usable at any width — nothing is hidden, only reorganized.

- **Calendar** — Month / Week / Day views. On desktop/tablet, drag a block
  to a new day/time or drag its edge to resize; on mobile, tap a block to
  edit its date/time/lock state instead, since native drag-and-drop doesn't
  work on touch. Week/Day view clusters runs of short back-to-back tasks
  into a single "N short tasks" chip (click to expand) and packs every
  block/chip with a guaranteed non-overlapping layout, so a densely
  scheduled day always stays legible no matter how many short tasks land
  close together. Hold Ctrl and scroll (or pinch on a trackpad) over the
  grid to zoom the time axis in/out. Month view shows a density overview
  (chips per day, clustering short tasks, "+N more" on busy days) and
  clicking a day drills into Day view for the full time grid, matching how
  most calendar apps handle month → day navigation. Tap the lock icon on a
  block to protect it from future rebalances. **Re-balance schedule**
  re-runs the engine while preserving locked blocks.
- **Tasks** — searchable/filterable list; add/edit/complete/delete/lock
  tasks (adding requires a due date); open a task to edit every field, manage
  subtasks, set dependencies, and mark it as able to run unattended.
- **Board** — Todoist-style Kanban board, one project at a time via a
  project filter, one column per Section plus a leading "No Section"
  column. Rename/delete columns, add sections, drag cards between them.
- **Gantt** — multi-week burn-down: one row per task, bar spans from first
  scheduled block to due date, colored by priority; blocked tasks get a
  hollow dashed marker, passive tasks get a striped overlay.
- **Stats** — live Total Hours Left, Scheduled Today/This Week, Free
  Capacity This Week, and an at-risk-of-missing-buffer callout.
- **Settings** — connect integrations, tune scheduling rules (buffer days,
  work-day window, max daily hours, horizon, front-loading), edit fixed
  routines on a drag-based 24-hour timeline (drag empty space to add one,
  drag a block to move it, drag its edge to resize, click to rename/pause/
  delete), mark calendar events as "Free Time" individually or in bulk, and
  reset local data to wipe TaskFlow's local cache without touching your
  actual Todoist/Google Calendar accounts.
- **Undo / Redo** — every task/block mutation and every rebalance is one
  atomic, undoable action.

### Smart task titles

Typing naturally into the Title field — e.g. *"Call dentist tomorrow p2
every month after Book appointment"* — auto-detects a due date, Todoist's
`p1`–`p4` priority shorthand, a recurrence rule, and a dependency, surfacing
each as a dismissible chip rather than applying anything silently.
Dismissing a chip blocks that exact phrase from re-triggering until you
edit it. See `src/utils/smartParse.js` and `src/hooks/useSmartTaskTitle.js`.

## Persistence

Everything persists to `localStorage` (see `src/utils/persistence.js`):
tasks, scheduled blocks, sections, projects, calendar events, scheduling
rules, fixed routines, the Todoist-sync toggle, and a "connected to Google
Calendar" flag (the OAuth token itself is not persisted — a silent,
popup-free refresh runs on load instead).

In practice: with Todoist sync on, TaskFlow re-fetches current tasks on
every load but always preserves your local calendar (`blocks`); with sync
off, nothing is re-fetched and your local tasks are the source of truth.
Use **Settings → Reset local data** to wipe everything and start fresh from
mock data.

## Contributing / working in this codebase

**Data flows one way, through one place.** `SchedulerContext.jsx` holds all
state and is the only thing that talks to `algorithms/` and `services/`.
Components call an action from `useScheduler()` (e.g. `updateTask`,
`rebalance`) and re-render off the context — never mutate state directly.
That's the entire reason Undo/Redo works everywhere for free: every action
goes through `useHistoryState`, which snapshots before/after into a
transactional stack.

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

## Hosting a public copy on GitHub Pages

TaskFlow is a client-only SPA (no backend, no database), so it's a good fit
for GitHub Pages — a free static host that serves whatever `npm run build`
produces. `.github/workflows/deploy.yml` builds and deploys automatically on
every push to `main`.

**One-time setup:**

1. **Repo settings → Pages → Build and deployment → Source: "GitHub
   Actions"** (not "Deploy from a branch"). This lets the included workflow
   publish directly, without needing a separate `gh-pages` branch.
2. If you want Google Calendar sync to work for visitors, add two **Repo
   settings → Secrets and variables → Actions → Repository secrets**:
   `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_API_KEY` (same values as your
   local `.env` — see [Google Calendar](#google-calendar) above). Then, in
   Google Cloud Console, add `https://<your-username>.github.io` to that
   OAuth client's **Authorized JavaScript origins** so the deployed site is
   allowed to use it.
   - **Do not** add a `VITE_TODOIST_API_TOKEN` secret here. That would bake
     *your* personal Todoist token into a build every visitor downloads —
     see the [Todoist](#todoist) section above for why each visitor instead
     connects their own account from Settings.
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
- Everything (tasks, routines, scheduling rules, the Todoist token) is saved
  to that visitor's own browser via `localStorage` — nothing is shared
  between visitors, and nothing is stored on any server, since there isn't
  one.

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

- Google Calendar sync is one-directional push (app → Calendar) plus a
  read-only pull of existing events; true two-way sync would need a
  webhook/polling layer and a backend, out of scope for a client-only SPA.
- Todoist sync is pull-only for tasks; completing a task in-app doesn't yet
  call `todoistService.completeTask` from the UI (the function exists and
  is ready to wire up).
- Silent Google token refresh depends on the underlying OAuth grant still
  being valid; Google may occasionally require interactive re-consent
  (e.g. after long inactivity or a security-related grant reset) that a
  backend-less SPA can't fully suppress. A server-side OAuth flow with
  refresh tokens (see the Google Calendar setup note above) removes this
  edge case if it becomes a problem in practice.
</content>

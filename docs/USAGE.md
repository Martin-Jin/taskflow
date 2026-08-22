# Using the app

- [Layout and mobile](#layout-and-mobile)
- [Dashboard](#dashboard)
- [Calendar](#calendar)
- [Tasks](#tasks) — [List](#list) · [Board](#board) · [Gantt](#gantt)
- [Projects](#projects)
- [Bulk select](#bulk-select)
- [Stats](#stats)
- [Settings](#settings)
- [Undo / redo and the command palette](#undo--redo-and-the-command-palette)
- [Searching and filtering](#searching-and-filtering)
- [Smart task titles](#smart-task-titles)

## Layout and mobile


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

Installing also wires up two shortcuts into the app from outside it:

- **Share to TaskFlow.** TaskFlow appears in your phone's share sheet, so a
  link, a selection of text, or a page you're reading can be sent straight
  into a new task. The shared text goes through the same natural-language
  parsing as typing it yourself (see [Smart task titles](#smart-task-titles)),
  so sharing "call the dentist tomorrow p2" arrives with its due date and
  priority already detected, and a shared URL becomes the task's link. A long
  block of shared text lands in the notes field instead of becoming an unwieldy
  title.
- **Home-screen shortcuts.** Long-pressing the installed icon offers
  **Add task** and **Add note** directly, skipping the trip through the app's
  own navigation.

This is a manifest-only PWA — there is deliberately **no service worker**
(nothing under `navigator.serviceWorker`, no Workbox/`vite-plugin-pwa`).
Installing just gives a chrome-less launch icon; there's no offline caching
layer, so a stale-looking page after a deploy is ordinary browser/CDN HTTP
caching (hard-refresh fixes it), never a service worker serving an old
cached copy.

## Dashboard

The default landing tab: a stats strip (due today,
overdue, hours scheduled this week), **Right now** (the block currently
in progress, or what's next, with a live countdown), **Today's agenda**,
a pair of **progress rings** (today and this week), and **Notes** —
folder-organized sticky notes (a title plus a markdown body) for jotting
anything down. Clicking a note (or "Add note") opens a mini WYSIWYG
markdown editor — a toolbar for bold/italic/strikethrough, headings,
bullet/numbered/checklist lists, links, and inline/block code — with
changes to an existing note saved automatically as you type. Its "⋯" menu
holds **Export as Markdown** (saves the note as a `.md` file) and
**Delete**. A note that's just a pasted link auto-formats and stays
clickable, and a "Recently edited" row surfaces whichever notes you
touched last regardless of folder. Notes are also searchable (typo-tolerant,
like every other search box), reachable from the command palette's "Add
note" action from any tab, and writable by AI Quick Add.

## Calendar

**Month / Week / 3 Day / Day** views, picked from the hamburger
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
at a higher zoom means less clustering, never more. The grid spans the whole
day, 00:00 to 24:00, so nothing can ever sit above the top of it; it just opens
scrolled to the morning so the overnight hours aren't taking up the viewport.
All-day events (holidays, leave, travel, a conference) get their own row
pinned under the day headers rather than a block in the grid — one that tall
would bury every real appointment on that day. A multi-day one appears on
each day it covers. Month view shows a
density overview (chips per day, clustering short tasks, "+N more" on busy
days) and clicking a day drills into Day view for the full time grid,
matching how most calendar apps handle month → day navigation. Tap the
lock icon on a block to protect it from future rebalances. **Re-balance
schedule** re-runs the engine while preserving locked blocks.

## Tasks

One page, three views via its own List/Board/Gantt switch, all
scoped to one project at a time (or "All Tasks", or "Inbox" for tasks with
no project assigned). Switch projects from the sidebar, the Projects page,
the search bar, or the collapsible "all projects" panel toggled from the
icon next to the page title (a persistent column on desktop, an overlay
drawer that closes itself after you pick on mobile); pin, rename, or delete
a project from its "⋯" menu (sidebar row or the page header) — pinned
projects sort first, unpinned ones by most recently visited. Like "All
Tasks", Inbox is a permanent, undeletable pseudo-project, not a real
project you create.

### List

A flat, sortable, searchable/filterable list — add, edit, complete, delete, and lock tasks
(adding requires a due date); open a task to edit every field, manage
subtasks, set dependencies, mark it as able to run unattended, say which part
of the day it should prefer, force
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
signed in — see [Account & cross-device sync](SYNC-AND-SHARING.md#account--cross-device-sync))
and sync/back up alongside the rest of the task, same as every other
field. Once a task hits the 200-comment cap, posting is blocked with a
clear message until you delete an older comment to make room. File
attachments aren't available on shared projects' tasks yet — text
comments still work there as usual.

### Board

A Todoist-style Kanban board — one column per Section plus a
leading "No Section" column (or a flat list if the project has no
Sections yet). Rename/delete columns, add sections, drag cards between
them on desktop/tablet (on mobile, open a card and change its Section
field instead, since there's no drag gesture to hook into). Columns
Cards can also be
reordered *within* a column by dragging one into the gap between two others —
dropping onto a card itself is the separate "make this a sub-task" gesture.
That hand-ranked order is saved with the task, so it follows you across devices
and is shared with collaborators on a shared board. Columns
themselves can be dragged into a different order by the grip handle in
their header — that order is remembered per project on this device only
(it isn't pushed to Todoist or synced across devices), and the leading
"No Section" column always stays first.

### Gantt

A multi-week burn-down: one row per leaf task (a task with
sub-tasks gets no row of its own — each sub-task gets its own row
instead, with the parent named as a subtitle), bar spans from first
scheduled block to due date, colored by priority; blocked tasks get a
hollow dashed marker, passive tasks get a striped overlay.

Dependencies are drawn as arrows from a prerequisite's bar to the bar of
whatever is waiting on it, so a chain — and the one task holding up several
others — reads at a glance. A prerequisite that has no bar of its own (not
scheduled, or outside the 4-week horizon) simply has no arrow to draw.

## Projects

A directory of every project: a fuzzy search box, and
Recent / Shared / My Projects columns (the last sortable by size, total
estimated hours, or creation date). The sidebar itself only shows your 5
most recently visited projects plus a link into this page, so it stays
short even with a large project list.

## Bulk select

A **Select** button in List, Board, Calendar's toolbar,
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

## Stats

Live Total Hours Left, Scheduled Today/This Week, Free
Capacity This Week, and an at-risk-of-missing-buffer callout.

## Settings

One page of cards, each covering one area:

- **Account & sync** — sign in, sync now, see sync status. See
  [Sync, backups, and sharing](SYNC-AND-SHARING.md).
- **Integrations** — connect Todoist, Google Calendar, and your AI Quick Add
  API key. See [Integrations](INTEGRATIONS.md).
- **Scheduling rules** — buffer days, work hours, max daily hours, planning
  horizon, and front-loading. Work hours are the same every day by default;
  tick **Different hours on different days** to give each weekday its own, or
  to mark a day as not working (weekends start off when you switch it on). The
  scheduler plans nothing at all on a day marked not working.
- **Routines** — fixed recurring commitments, edited on a drag-based 24-hour
  timeline: drag empty space to add one, drag a block to move it, drag its edge
  to resize, click to rename, pause, or delete it. You can also mark calendar
  events as "Free Time" here, individually or in bulk.
- **Notifications** — which task events notify you, and over which channel.
  See [Notifications](INTEGRATIONS.md#notifications).
- **Tags** — every tag in use across all tasks, with how many tasks carry each.
- **Backups** — export, import, and cloud snapshots. See
  [Backups](SYNC-AND-SHARING.md#backups).
- **Appearance** — the light/dark theme switch.
- **Keyboard shortcuts** — view and rebind every shortcut.
- **Install app** — the PWA install steps for your platform.
- **Versions** — a searchable **What's new** changelog, also auto-shown once
  whenever a new version ships.
- **Help** — replay the guided tour.
- **Danger zone** — clear the sample data, or reset TaskFlow's local cache
  entirely. Neither touches your actual Todoist or Google Calendar account.

## Undo / redo and the command palette

**Undo / Redo** — every task/block mutation and every rebalance is one
atomic, undoable action, triggered via keyboard shortcut (`Ctrl+Z` /
`Ctrl+Shift+Z` by default, rebindable from Settings) rather than a topbar
button — see `useKeyboardShortcuts.js`.

**Command palette** — `Ctrl+K` (rebindable from Settings) opens a Linear/
Todoist-style "jump to anything" search across Views, Projects, Tasks,
Calendar events, and quick actions (Add task, Add note, Quick Add with AI,
Re-balance schedule, Toggle light/dark theme, Manage projects); Arrow keys
+ Enter pick a result without touching the mouse.

## Searching and filtering

The search box above the task list matches plain text against a task's title,
notes, and section — type part of what you remember and it narrows as you go.

It also understands **filters**, for asking a structured question rather than
recalling a name:

| Filter | Finds |
|---|---|
| `p1` `p2` `p3` `p4` | tasks at that priority (several means "any of these") |
| `@tag` | tasks carrying that tag (several means "all of these") |
| `#project` | tasks in that project (several means "any of these") |
| `due:today` | tasks due on a date — also `due:tomorrow`, `due:friday`, `due:2026-09-01`, `due:end of month` |
| `is:overdue` | past their due date and not done |
| `is:done` / `is:open` | finished, or not |
| `no:date` `no:project` `no:label` `no:section` | tasks missing that field |

Filters combine, and combine with plain text: `p1 #work deck` means "urgent,
in Work, mentioning deck". Anything the box doesn't recognise as a filter is
searched for literally, so a task actually called "Overdue invoices" is still
findable by typing exactly that — every filter carries a `:` or a leading
sigil precisely so it can never swallow an ordinary word.

Date values use the same natural-language parser as the title field (see
[Smart task titles](#smart-task-titles)), so anything that works there works
after `due:`.

## Smart task titles

Typing naturally into the Title field — e.g. *"Call dentist tomorrow p2
every month after Book appointment"* — auto-detects a due date, Todoist's
`p1`–`p4` priority shorthand, a recurrence rule, an estimated duration
(`"~2 hours"`, `"45 min"`), whether it "can run unattended", a preferred time
of day (`"in the morning"`, `"this afternoon"`, `"evenings"`), an earliest
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

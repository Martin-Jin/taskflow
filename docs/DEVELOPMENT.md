# Developing TaskFlow

Internals for anyone working in this codebase — how the scheduler works, the
data model, project layout, persistence, contribution conventions, tech
stack, and testing. For what the app does and how to set it up as a user,
see the main [README](../README.md).

## Contents

- [How the scheduler works](#how-the-scheduler-works)
- [Data model](#data-model)
- [Project layout](#project-layout)
- [Persistence](#persistence)
- [Contributing / working in this codebase](#contributing--working-in-this-codebase)
  - [Versioning and the changelog](#versioning-and-the-changelog)
- [Tech stack](#tech-stack)
- [Testing](#testing)
- [Local dev tips](#local-dev-tips)

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
date for this calculation (see `resolveDueDate`) — the parent goal's
deadline pressures its steps even when they aren't individually dated. A
sub-task needs a resolvable due date (its own, or an ancestor's) to reach
the allocator at all, exactly like a top-level task needs its own — one
with no due date anywhere in its ancestor chain is a checklist item, not
schedulable work (see rebalanceEngine.js's `schedulable` filter). A
**container** task (any task with ≥1 sub-task of its own) is never scored or
scheduled directly at all, regardless of whether it has a due date — see
"Sub-tasks and containers" below.

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

**Placement** is greedy and runs in five passes — a weighted-share pass
targeting each day's ideal slice (clamped to `maxChunkHours`, available
capacity, and a same-day whole-block lookahead that prefers a later
full-fit day over fragmenting a task's last permitted chunk on a sliver),
a sweep pass that mops up hours that didn't fit their ideal day into any
other open capacity in the window, a buffer-overflow spill pass into the
buffer-to-due-date range, a last-resort split pass into any remaining
opening in the window, and — only for tasks without "Enforce due date" —
a horizon-spill pass past the due date into the rest of the planning
horizon. Only after all five passes still have leftover hours does a task
show up in the "couldn't be fully scheduled" overflow. Fixed-time tasks
(`task.fixedTime`) are placed in their own pre-pass before any of this,
pinned to their exact time of day regardless of score.

A task's total remaining hours may only be split into as many pieces as
`round(durationHours * 60 / 30)` allows (`maxChunksFor` in `allocator.js`)
— a chunk-COUNT cap, not a per-chunk minimum-size floor. The only hard
floor on an individual chunk's size is a flat 5 minutes
(`MIN_CHUNK_HOURS`), and even that's waived for a task whose entire
remaining time is already at or under 5 minutes, so it can still place as
one small block instead of being skipped. The per-task `minChunkHours`
field still exists on `Task` but is no longer read by the allocator (see
`types/index.js`).

### 3. Cost-minimizing refinement (`placementCost.js` + `localSearch.js`)

The greedy allocator above always produces a valid schedule, but "first
slot that fits" isn't the same as "best" schedule — it has no way to
weigh a task fragmented across five days against one placed as a single
block, or to reward finishing early versus just-in-time. After allocation,
`rebalanceEngine.js` runs a second, optional refinement layer that treats
the greedy result as a starting point (a "seed") and searches for a
lower-cost rearrangement of it.

**`placementCost.js`** is a pure function that scores a candidate
placement — lower is better. Two terms, both scaled by a per-priority
multiplier (`PRIORITY_MULTIPLIER`: `urgent 1.4, high 1.2, medium 1.0, low
0.8` — fractional, not the allocator's integer scoring weights, since this
is a gentler nudge rather than a strict ordering rule):

- **Fragmentation** — `(daysUsed − 1) × FRAG_DAY_PENALTY` for spreading a
  task's hours across extra days, plus `SMALL_CHUNK_PENALTY` for every
  individual chunk under `SMALL_CHUNK_THRESHOLD_MINS` (15 min). Both apply
  together, so a task split into several tiny same-day slivers still costs
  more than one continuous block even though it didn't use an extra day.
- **Due date** — a small linear reward per day of slack finished ahead of
  the due date, or a penalty that grows quadratically (not flatly) with
  days late if a task's last chunk lands after its due date, so being a
  little late costs much less than being very late.

There's deliberately no separate "unplaced" cost term — an unplaced task
already surfaces through the allocator's own `overflow` reporting, and
priority only ever multiplies the two terms above, never stands alone.

**`localSearch.js`** takes the greedy seed and runs a time-boxed
simulated-annealing search (default ~100ms wall-clock or 2000 iterations,
whichever comes first) over single-chunk relocate moves, trying to reduce
total cost. Locked, fixed-time, and passive blocks are never candidates
for a move — they're treated as fixed busy time. Every candidate move is
checked against capacity, `minGapBetweenBlocksMins`, the daily deep-work
budget, and dependency ordering (see below) *before* it's accepted, never
merely penalized after the fact, so the search can never wander into an
invalid state. The search tracks the best placement seen and always
returns that — if it never finds an improvement (or times out
immediately), the original greedy seed comes back unchanged. This is a
hard guarantee, not a tuning goal: the returned placement's cost is never
worse than the seed's.

Because the greedy allocator has no dependency awareness of its own (it
places purely by priority/urgency score), a high-priority dependent can
occasionally land earlier than a lower-priority task it depends on in the
seed itself. `localSearch.js` repairs any such violation topologically
before search begins, so this guarantee — every chunk of a dependent task
starts at or after the last chunk of all its (transitive) dependencies —
holds unconditionally, not just because `rebalanceEngine.js`'s own
upstream filter happens to exclude incomplete dependencies from a given
run.

### 4. Rebalancing (`rebalanceEngine.js`)

Backs the **Re-balance schedule** button: partitions existing blocks into
historical (before today, untouched), locked (protected, untouched), and
unlocked-future (cleared and re-planned); recomputes each task's
`remainingHours`; runs capacity + allocation, then the cost-minimizing
refinement above, over just the unlocked remainder; merges everything back
together. Locked blocks are never destroyed by a rebalance.

### Sub-tasks and containers

A sub-task (`parentId` set) is a normal, independently-schedulable Task in
every respect (priority, dependencies, search, completion) — scheduled
exactly like a top-level task, same scoring, same pacing, same placement
passes — with the same one requirement: a resolvable due date. If it has no
due date of its own, it borrows its nearest ancestor's due date, both as
urgency pressure (see `resolveDueDate` above) and as the LATEST day its
window can extend to (`getTaskWindow`) — a container's due date (enforced
or not) is a soft "must finish every step by this day" deadline for its
undated sub-tasks, never a hard "every step happens on this exact day"
constraint (only a sub-task's own `enforceDueDate` collapses its own
window). A sub-task with no due date anywhere in its ancestor chain is
never scheduled, exactly like an undated top-level task (see
rebalanceEngine.js's `schedulable` filter). A sub-task's own due date can
never be set later than its nearest dated ancestor's — enforced in the UI
(TaskDetailModal's save gate, WeekView's drag-to-reschedule guard) rather
than silently clamped, since a step scheduled past its own goal's deadline
could never actually finish that goal on time. Nesting is capped at 2
levels (task → sub-task → sub-task of that sub-task), enforced going
forward only.

The moment a task has ≥1 sub-task, it becomes a **container**: it never
gets its own calendar block again, no matter its own due date or hours —
only its leaf sub-tasks (or deeper leaves, if nested) do. Its
`estimatedHours`/`remainingHours` become a live rollup of its children's
own effective hours instead of an independently-editable number (see
`utils/taskHierarchy.js`), and its own due date becomes purely an input
into its children's urgency/deadline rather than something scheduled
directly. Everything else on it (priority, lock state, min/max chunk hours,
labels) stays independently editable, same as before. TaskDetailModal offers
an "Apply to all sub-tasks" action on a container (priority, due
date/enforcement, project/section, labels, passive flag) that cascades onto
every descendant, direct and nested (see `utils/taskHierarchy.js`'s
`getAllDescendants`) — shown only while the task actually has sub-tasks.

`isRecurring`/`recurrenceString` are deliberately excluded from that manual
action: a parent's sub-tasks represent steps toward its recurring goal, so
parent/sub-task recurrence is kept consistent automatically instead —
`utils/recurrence.js`'s `computeRecurrenceSyncUpdates` walks a task's full
ancestor/descendant chain (up to the 2-level nesting cap) and is run by
SchedulerContext's `addTask`/`updateTask` on every write, propagating a
recurring task's cadence — and `dueDate` — onto any non-recurring relative
in its chain (nearest recurring ancestor wins over a recurring descendant
when both exist). The propagated `dueDate` is snapped forward to the first
date that actually satisfies the inherited rule via
`computeFirstMatchingDueDate` (a no-op for plain interval rules, but
necessary for a weekday-specific rule like "every Wed, Sun" since the
recurring relative's own `dueDate` may not itself fall on one of those
days). The one-time `migrateRecurrenceConsistency` migration applied this
once to any pre-existing inconsistent data — see its file-level comment for
removal timing.

**"Done for today" vs. `isCompleted`:** a recurring task never sets
`isCompleted: true` on a normal completion (its due date just advances — see
"Completion" below), so the Tasks list derives a separate, display-only
"completed for the current occurrence" state (`utils/taskHierarchy.js`'s
`isCompletedForCurrentOccurrence` — `completedDates` includes today for a
recurring task, plain `isCompleted` otherwise) to decide a row's checked/
strikethrough state, restore button, etc. (`TaskListPanel.jsx`'s
`isCheckedForDisplay`). This is purely a list-view concern — TaskDetailModal
still shows a recurring task as ongoing, never permanently done. Once every
one of a parent's direct sub-tasks is "done for today" this way, the parent
itself auto-completes too (recursing up the chain for nested sub-tasks) —
see `SchedulerContext.completeTask`'s `applyUpwardCompletionCascade`, folded
into the same commit as the leaf completion so the whole cascade is one
undoable action. Restoring a completed task from the list undoes this
symmetrically (`uncompleteTask`): for a recurring task/sub-task that means
dropping today back out of `completedDates` (not just flipping `isCompleted`,
which a recurring completion never set), and un-completing any ancestor whose
auto-completion depended on the just-restored task, walking up while doing so
is still warranted.

Editing a recurring task's due date (`SchedulerContext.updateTask`) runs it
through `computeRecurringRescheduleUpdate` (`utils/recurrence.js`), which
drops any `completedDates` entries on/after the new date — otherwise moving
the due date back onto (or before) an occurrence already recorded as done
would leave it showing completed forever, since a recurring task's
`isCompleted` never flips true for the guard above (the `isCompleted`-reset
one) to catch. The same function also refuses to let `dueDate` end up empty
on a recurring task, falling back to its current due date instead — a
recurring task needs a due date to advance from each occurrence, so clearing
it isn't a valid edit. `TaskDetailModal` blocks this at the form level too
(`dueDateRequiredError`, gating Save/autosave the same way `dueDateError`
does), but `updateTask`'s guard covers any other caller (AI plan assistant,
Todoist import).

**Moving one occurrence off its repeat pattern:** if the new due date doesn't
match the recurrence rule (e.g. moving one occurrence of an "every week on
Mon/Wed/Fri" task onto a Thursday), `computeRecurringRescheduleUpdate` does
NOT re-anchor the series onto that date — `generateTaskOccurrences` filters
every future date by the same weekday rule, so an off-pattern anchor would
make the series generate nothing near it, silently dropping the occurrence
from the scheduler and its remaining hours. Instead it records a one-
occurrence entry in `task.overrides` (keyed by the pattern's own occurrence
date, same `{date, deleted}` shape as `CalendarEvent.overrides` — see
`types/index.js`) and leaves `dueDate` where it was. `utils/recurrence.js`'s
`expandTaskOccurrences` (used by `rebalanceEngine.js`'s
`expandRecurringTasks` instead of the plain pattern-only
`generateTaskOccurrences`) layers `overrides` on top the same way
`recurrenceExpansion.js`'s `expandRecurringEvent` already does for Calendar
Events, so the moved occurrence is scheduled on its actual (moved-to) date
while every other occurrence keeps landing on its normal pattern day.
Completing the moved occurrence (`completeTask`) advances `dueDate` from the
untouched pattern anchor as normal and prunes that occurrence's now-closed-
out override entry.

**A task newly becoming recurring starts a fresh occurrence, not a resumed
one:** `computeRecurrenceSyncUpdates` (parent/sub-task recurrence sync, see
above) resets `remainingHours` to `estimatedHours` and clears `isCompleted`
whenever it flips a task's `isRecurring` to `true` and that task was already
`isCompleted` or sitting at `remainingHours <= 0`. Without this, a task that
was completed (or migrated in already-completed — see
`migrateSubtasksToTasks.js`'s `sub.isCompleted ? 0 : 0.5`) BEFORE it or its
parent became recurring stayed permanently stuck showing 0 remaining, since
becoming recurring isn't `completeTask`'s occurrence-advance (the only other
place that reset happens). `migrateStaleRecurringRemainingHours.js` is the
matching one-time backfill for tasks that were already stuck like this
before the live sync above existed to catch it going forward.

### Dependencies and passive tasks

A task can list other tasks it `dependsOn`. `rebalanceEngine` excludes a task
from allocation until every dependency is complete — a blocked task just has
zero eligible hours. Beyond that gate, a dependency also feeds backward into
scoring: a blocker's effective urgency rises to match whatever depends on it
(see "Allocation" above), so a blocker due soon *because* something urgent is
waiting on it gets scheduled earlier, not just eventually. The Edit modal
blocks picking a dependency that would create a cycle.

The cost-minimizing refinement pass (see above) additionally enforces
dependency ordering as a real, jointly-checked constraint on the whole
transitive chain — every chunk of a dependent task must start at or after
the last chunk of every task it depends on — rather than relying solely on
the upstream "exclude if incomplete" filter.

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
| `Project` | A Todoist Project, or a local-only one created from the sidebar's "+" — the top-level grouping switched between from the sidebar, List/Board's project header, or the search bar. Optional `ownerId`/`sharedProjectId` mark it as a collaborative project (see "Shared projects" below); a personal project has neither |
| `SharedProject` | A project shared with other users, living in its own top-level `sharedProjects/{projectId}` Firestore doc rather than inside `users/{uid}` — holds `ownerId` and a `collaborators` map. Deliberately does NOT hold the view/edit share links/tokens — see "Shared projects" below |
| `Collaborator` | One entry in `SharedProject.collaborators`: role (`viewer`/`editor`), display name, photo, joined-at. The owner is deliberately NOT in this map — they're identified by `ownerId` |
| `ScheduledBlock` | A concrete dated/timed slice of a `Task` on the calendar |
| `FixedRoutine` | Recurring non-negotiable time (sleep, meals, commute) |
| `CalendarEvent` | External (Google) or manual event; `isFreeTime` enables the "ignore" override |
| `SchedulingRules` | Global config: buffer days, work-day window, pacing, horizon |
| `DayCapacity` | Derived per-day free-time snapshot the allocator consumes |
| `HistoryEntry` | One Undo/Redo snapshot (full tasks+blocks state) |

### Shared projects (collaboration)

Personal projects live entirely inside the owner's `users/{uid}` doc, as they
always have. Sharing is **opt-in per project**: only a project explicitly
turned into a shared one moves into its own top-level
`sharedProjects/{projectId}` doc (with its `tasks`/`sections`/`comments` as
subcollections), and gains `ownerId` + `sharedProjectId` on the local
`Project` record so app code knows which store to read/write. Nothing is
migrated retroactively.

Access rules (`firestore.rules`) — the app's first cross-user data path, so
the constraints are deliberate and worth understanding before touching them:

- **`list` is never granted on `sharedProjects`.** A project is only fetchable
  by exact document ID, and only for its owner or a uid present in its
  `collaborators` map. Omitting `list` is load-bearing, not an oversight: it's
  what makes projects non-discoverable. Never replace the `allow get` with a
  bare `allow read` (which would grant `list` too).
- **Share tokens don't live on the project document at all — they're in a
  separate, client-unreadable doc.** This wasn't the original design. Tokens
  used to sit directly on `sharedProjects/{projectId}` as a `links` map, and
  that turned out to be a CRITICAL privilege-escalation bug caught in
  security review: a `get` returns the WHOLE document, and every collaborator
  (including view-only ones) must be able to `get` this doc just to use the
  project — so any viewer could read `links.edit.token` straight out of it,
  re-join presenting that token, and escalate themselves to editor. Proven
  end-to-end against the emulator: read the token, re-join as editor, write
  tasks. Firestore has no field-level read rules — the smallest unit of a
  read is one whole document — so a secret can never safely share a document
  with a broader read audience than the secret's own. The fix: tokens now
  live at `sharedProjects/{projectId}/private/links`, locked with
  `allow read, write: if false` — **no client can read or write it, not even
  the project's own owner.** Rules still evaluate a presented token by
  reading that private doc with `get()` (a rules-internal read, not a client
  one). The token a joining visitor presents never travels as a document
  field either (an earlier version did that too, which persisted it into the
  project doc on the join write and leaked it to every later reader — same
  class of bug); instead it arrives as a custom auth claim
  (`request.auth.token.joinToken`), minted server-side by the join endpoint
  only after that endpoint has validated the token against `private/links`
  itself. One consequence worth calling out: because owner-facing "show me my
  share link" can no longer be a client read of anything, it has to be served
  by that same server-side join endpoint too — generating, rotating,
  revoking, and displaying links are all now endpoint operations, not
  Firestore reads/writes a client performs directly.
- **Editors can't touch access control.** `ownerId` and `collaborators` are
  off-limits to non-owners, or "editor" would silently mean "can promote
  themselves to owner". Non-owners also can't smuggle a `links` field back
  onto the project document — it must never exist there at all, per above.
- **Ownership transfer is narrow**: owner-only, the recipient must already be
  a collaborator (a project can't be pushed onto a stranger), anonymous users
  can never become owners, and the outgoing owner is retained as an editor.
  The anonymous check works via an `isAnonymous` flag stamped onto each
  collaborator entry at join time from the joiner's own verified
  `sign_in_provider` claim — rules can only inspect the *requester's* provider,
  never a third party's, so the fact has to be recorded when they join to be
  checkable when someone later tries to hand them the project. Transferring to
  an anonymous identity would leave the project effectively unowned once that
  visitor cleared their storage: nobody able to delete it, rotate its links, or
  manage its collaborators.
- **Every write is shape- and size-validated**, which is less incidental than
  it sounds. `diff().affectedKeys()` reports only that a *top-level* field
  changed, never what's inside it — so without an explicit per-entry check, a
  joiner could stuff arbitrary keys (`adminOverride: true`) or hundreds of KB
  of junk inside their own `collaborators` entry, on a document every member
  downloads on every read. The same reasoning caps `presence` and
  `anonProfiles` docs and restricts the project document to a known key set.
  A new project must also start with an *empty* `collaborators` map, so that
  map only ever grows through a token-verified join — the whole access model
  rests on it. Note rules can bound these values but can't sanitize them:
  `displayName`/`photoURL` are user-supplied and must still be treated as
  untrusted when rendered.
- **Anonymous participants** go through Firebase Anonymous Auth so rules have
  a stable uid to authorize against; their chosen display name lives in
  `anonProfiles/{uid}`, which holds a name and nothing else — keep it that way.
- **Link expiry** (`private/links.{view,edit}.expiresAt`) is stored as a
  Firestore **timestamp**, not this app's usual ISO string: rules have no
  ISO-8601 parser, so a string would make expiry unenforceable server-side.
  It's compared against `request.time`, never a client-supplied clock. Expiry
  gates *joining* only — it never retroactively evicts an existing
  collaborator.

The pure decision logic (token→role resolution, effective-role precedence,
join and ownership-transfer planning) is extracted into
`src/utils/sharedProjectAccess.js` with no Firebase imports, so it's
unit-testable in isolation (`tests/unit/sharedProjectAccess.test.js`) — same
precedent as `computeFingerprint` in `useCloudSync.js`. The rules themselves
are tested against the Firestore emulator (see [Testing](#testing)); the
client-side logic mirrors them for fast, specific failure messages, but the
rules remain the only real enforcement boundary.

## Project layout

```
src/
├── algorithms/               # Pure scheduling logic, framework-agnostic
│   ├── capacityEngine.js     # Day-by-day free-time computation
│   ├── allocator.js          # Priority/deadline-aware hour distribution (greedy seed)
│   ├── placementCost.js      # Cost function (fragmentation + due-date terms) scoring a placement
│   ├── localSearch.js        # Time-boxed search that refines the greedy seed to lower cost
│   └── rebalanceEngine.js    # Orchestrates capacity+allocator+search, preserves locks
├── components/
│   ├── Dashboard/              # DashboardPage (default landing tab) — DashboardStats, NowNextCard, TodayAgenda, WeeklyProgressRing, NotesCard (+ notesModel.js)
│   ├── Calendar/              # WeekView (day/week time-grid, drag/resize), MonthView (density overview), CalendarPage, CalendarFilterMenu (show-type/project/tag filter — predicate lives in utils/calendarFilter.js)
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
│   └── AuthContext.jsx       # Firebase Auth (Google sign-in) — see "Account & cross-device sync" in the README
├── firebase.js                # Firebase app/Auth/Firestore init — see "Account & cross-device sync" in the README
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
│   ├── migrateSubtasksToTasks.js      # One-time migration converting the old embedded Task.subtasks array into standalone parentId-linked Tasks — see file-level comments for removal timing
│   ├── migrateRecurrenceConsistency.js # One-time migration syncing recurrence across mismatched parent/sub-task chains — see file-level comments for removal timing
│   └── migrateStaleRecurringRemainingHours.js # One-time migration repairing a recurring task stuck at remainingHours 0 from before it became recurring — see file-level comments for removal timing
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
│   ├── dependencyUtils.js    # Cycle detection + transitive dependency/dependent traversal for dependsOn graphs
│   ├── taskFacets.js         # Derived task facets (blocked/overdue/etc.)
│   ├── linkify.js            # Turns http(s)/www URLs in free text into clickable segments
│   ├── boardColumnOrder.js   # Board's device-local, per-project column order layered over synced Section.order
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

## Persistence

Everything persists to `localStorage` (see `src/utils/persistence.js`):
tasks, scheduled blocks, sections, projects, calendar events, scheduling
rules, fixed routines, when the last Todoist import ran, and a "connected
to Google Calendar" flag plus a short-lived cached access token (the Google
refresh token itself is never persisted client-side at all — it lives only
in Firestore, written by the Cloudflare Worker; see
[Google Calendar](../README.md#google-calendar) in the README). A recurring
calendar event is stored once with its RRULE recurrence rule, not as one
record per occurrence — occurrences are expanded for display only.

Some state is deliberately device-local and stays out of both backups and
cross-device sync — view/filter selections, dashboard widget visibility, and
Board's drag-chosen column order (`src/utils/boardColumnOrder.js`). The
column order is a per-project list of section ids layered over the synced
`Section.order` at render time rather than written back onto the Sections
themselves: sections come from Todoist, so persisting a local arrangement
into `order` would be clobbered by the next import, and pushing it upstream
would reorder the user's sections inside Todoist as a side effect of a view
preference. Because it's a sparse id list, sections added/removed/synced
later don't invalidate it — unknown ids are ignored and unlisted sections
fall back to their natural order, so no migration is needed when the section
set drifts.

In practice: nothing is ever re-fetched from Todoist automatically — your
local tasks are always the source of truth, and a Todoist import only ever
happens when you click **Settings → Import from Todoist**. Use
**Settings → Reset local data** to wipe everything and start fresh from
mock data.

Some persisted state is deliberately **device-local** — it lives in
`localStorage` (usually via `usePersistedState`) but is deliberately kept
out of `BACKUP_FIELDS` and cloud sync, because it's a per-device view
preference rather than data a user would be sad to lose on a device switch:
dashboard widget visibility, calendar zoom level, the Tasks page's
per-view status filter (`taskflow_tasks_filter_by_view_v1`), and the
Calendar's filter menu (`taskflow_calendar_filter_v1`). Use a versioned key
for these so a shape change can't strand users on a stale persisted value,
and merge the loaded value over the defaults defensively rather than
trusting it.

If signed in (see [Account & cross-device sync](../README.md#account--cross-device-sync)
in the README), the same data also syncs to Firestore — `localStorage` on
the current device stays the always-on, works-offline source of truth, and
the cloud copy is what a second device pulls down.

**Shared projects invert that model**, and it's the one place in the app where
Firestore — not `localStorage` — is the source of truth: a project several
people edit concurrently can't have a per-device local authority. Two
consequences for persistence:

- `sharedProjectIds` (which shared projects you're a member of) IS persisted,
  synced, and backed up. It's a short list of ids — unambiguously your own
  data, and losing it would lose your way back into boards you'd joined.
  Restoring it re-lists those projects but grants nothing: membership is
  enforced by the `collaborators` map in Firestore rules, not by this array.
- A shared project's **content** (its tasks/sections/comments) is deliberately
  excluded from every backup payload. It isn't solely yours to snapshot or roll
  back — restoring a months-old backup must not resurrect tasks a collaborator
  deliberately deleted, or re-create content from a project you've since been
  removed from. See the doc comment above `FIELD_TYPES` in
  `src/services/backupService.js` for the full rationale.

## Contributing / working in this codebase

**Data flows one way, through one place.** `SchedulerContext.jsx` holds all
state and is the only thing that talks to `algorithms/` and `services/`.
Components call an action from `useScheduler()` (e.g. `updateTask`,
`rebalance`) and re-render off the context — never mutate state directly.
That's the reason Undo/Redo works for free on `tasks`/`blocks`: every action
touching them goes through `useHistoryState`, which snapshots before/after
into a transactional stack. Sections/projects/labels are plain `useState`
and are not part of that stack — see the README's Known limitations.

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

### Versioning and the changelog

Every push shipping a user-visible change adds an entry (newest-first) to
`src/changelog.js` and bumps the version. There is **one** version number
in three places that must always agree: the first `CHANGELOG` entry's
`version`, `CURRENT_VERSION` (derived from it automatically), and
`package.json`'s `version`.

Versions are **standard semver — `MAJOR.MINOR.PATCH`, each part an integer
that rolls over at 9, never a multi-digit "1.100.0"**:

- **Patch** (`2.1.0` → `2.1.1`) — a bug fix or small correction to
  something already shipped, with no new capability.
- **Minor** (`2.1.3` → `2.2.0`) — a new user-visible feature or a
  meaningful change to an existing one. This is the common case.
- **Major** (`2.9.0` → `3.0.0`) — reserved for the minor rolling past 9,
  or a genuine overhaul of how the app works. **`x.9.0` is followed by
  `(x+1).0.0`** — not `x.10.0`. Resetting the lower parts to zero on a
  roll-over is what keeps this readable.

This was wrong once already (`1.99.0` was followed by `1.100.0`/`1.101.0`,
since renumbered to `2.0.0`/`2.1.0`) — that's the exact mistake this rule
exists to prevent, so check the previous entry's numbers rather than
blindly incrementing the last component.

Renumbering an already-shipped entry is safe but not free: `App.jsx`
compares `lastSeenChangelogVersion` to `CURRENT_VERSION` with `!==`, not
ordered semver, so a rename just re-pops the "What's New" modal once for
users who'd already seen it. Prefer getting it right the first time.

Write entries in plain English for end users, not a commit log — group
same-day/same-branch commits into one entry and skip anything with no
user-visible effect (internal refactors, migration code).

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

Three additional suites cover more than the build check can:

```bash
npm run test:unit                              # Vitest, ~3s, no setup needed
npm run test:rules                             # Firestore security rules, needs Java (emulator)
npm run test:e2e -- tests/e2e/full-suite       # Playwright, boots its own dev server
```

`npm run test:unit` runs [Vitest](https://vitest.dev) over `tests/unit/` —
pure-logic coverage (date/recurrence math, natural-language parsing,
backup/restore, dependency-cycle detection, cloud-sync merge/race-guard
logic). Output (pass/fail counts per file) prints straight to the terminal
when it finishes.

`npm run test:rules` runs the Firestore **security rules** suite
(`tests/rules/`) against the local Firestore emulator, using
`@firebase/rules-unit-testing`. It's kept out of `npm run test:unit`
deliberately — it has its own config (`vitest.rules.config.js`) because it
needs a running emulator (and therefore a Java runtime), whereas the unit
suite must stay fast and dependency-free. `firebase emulators:exec` starts and
tears the emulator down for you on port 8571 (`firebase.json`); no manual
setup, and it never touches a real Firebase project.

The suite is adversarial by design — most of it asserts what *must fail*:
that a stranger can't read or enumerate someone else's shared project, that an
editor can't escalate to owner or rotate share tokens, that a joiner can't add
anyone but themselves or claim a role stronger than their link grants, that
expired and disabled links are rejected outright, and that ownership can't be
transferred to a non-collaborator. **Run it after any change to
`firestore.rules`** — the rules are the only real boundary protecting
cross-user data, and a mistake there is not visible in the UI.

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

## Local dev tips

A few things worth knowing when working on this repo day to day. Anything
machine-specific to your own setup (account IDs, your own OAuth client's
exact origins, your own deployment domain) belongs in a local, gitignored
notes file instead of here — this section only covers what's true for
anyone working on the project.

**Local hosting is just `npm run dev`.** If you've previously set this repo
up as a persistent LAN-reachable service (e.g. a background `vite preview`
process, a Startup-folder shortcut, scoped firewall rules so another device
on your network can reach it), remember to tear all of that down again if
you stop using it — a stale shortcut/firewall rule pointed at a dev server
that's no longer running is easy to forget about.

**A public-network firewall rule that opens a Node.js process to any
device** is a general security footgun worth knowing about independent of
this repo: Windows can have a pre-existing rule (commonly named "Node.js
JavaScript Runtime") that allows any device, on any port, to reach
`node.exe` whenever the active network is categorized "Public." This isn't
specific to TaskFlow — it affects any Node process (dev servers, scripts)
— but it's worth checking for and disabling if you don't specifically need
inbound access to a local Node process from other devices:

```powershell
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Disable-NetFirewallRule
```

**Google Calendar OAuth troubleshooting**: if Google Calendar connect ever
fails with an origin/referrer error after changing how or where you run
this locally, double check the OAuth client's **Authorized JavaScript
origins** (Google Cloud Console) include whatever origin you're actually
loading the app from (e.g. `http://localhost:5173` for a default Vite dev
server — exempt from Google's HTTPS requirement) — and that the API key's
own "Website restrictions" have the same origin added too, since that's a
separate setting from the OAuth client's origins and easy to miss.

### AI Quick Add — local Worker dev loop (test worker changes before deploying)

Two separate dev servers, two separate terminals — Wrangler (the Worker) and
Vite (the main app) know nothing about each other directly; they only
connect because the app's `.env` points at whatever URL the Worker is
running on.

**Terminal 1 — run the Worker locally:**
```powershell
cd cloudflare-worker
npx wrangler dev
```
Leave this running. It prints `Ready on http://127.0.0.1:8787`. A bare
`GET /` in a browser correctly 405s — the worker only accepts `POST` — that's
not a bug, it's confirmation the server is up.

**Terminal 2 (repo root) — point the app at that local Worker:**
Add/edit this line in the repo root's `.env` (create the file if it doesn't
exist yet):
```
VITE_AI_QUICKADD_WORKER_URL=http://127.0.0.1:8787
```
Then:
```powershell
npm run dev
```
Open the app, add a real Anthropic/Gemini API key under Settings →
Integrations → AI Quick Add (only needs doing once — it's saved in
`localStorage`), and use AI Quick Add normally. Every request now hits your
local Worker instead of the deployed one, so edits to
`cloudflare-worker/src/index.js` take effect on the next request — no
restart needed, Wrangler hot-reloads it.

**Quick manual test of just the Worker** (no app/browser needed, checks
request validation without spending real API credits — swap in a real key to
test the full provider round trip):
```powershell
$body = @{
  provider = "anthropic"
  apiKey = "fake-key-just-checking-validation"
  text = "Buy groceries tomorrow"
  contextMarkdown = "# test`n## Existing projects (0 total)`n[]"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8787" -Method Post -Body $body -ContentType "application/json"
```

**Switching back to the deployed Worker** once done testing locally: change
`.env`'s `VITE_AI_QUICKADD_WORKER_URL` back to the `*.workers.dev` URL (see
[README's AI Quick Add section](../README.md#ai-quick-add) for the deploy
steps) and restart `npm run dev`. Stop the `wrangler dev` terminal with
Ctrl+C whenever — it's not needed unless actively iterating on the Worker.

When locking down the deployed Worker's CORS (`ALLOWED_ORIGIN`, see
`cloudflare-worker/README.md`), point it at your own actual deployment
domain — this is a per-deployer value, not something to hardcode here.

**No service worker — ruled out as a caching suspect, if it comes up
again.** TaskFlow is installable (manifest.json + iOS meta tags, see
[README's "Using the app"](../README.md#using-the-app)) but has **no
service worker** — confirmed by grepping the whole repo for
`navigator.serviceWorker`/`sw.js`/`workbox`/`vite-plugin-pwa` and finding
nothing. If the app ever "still looks stale after deploy," that's ordinary
browser/CDN HTTP caching (a hard refresh fixes it), not a service worker
deciding on its own when to fetch a new version — there isn't one to
suspect.

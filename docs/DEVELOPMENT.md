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

For every day in the planning horizon, start with that day's work-hours
window and subtract active fixed routines for that day-of-week (sleep, meals,
commute), calendar events not marked "Free Time", and locked scheduled blocks
already committed. What's left is that day's free capacity, as a sorted list of
open time intervals.

The window comes from `utils/workHours.js`'s `resolveWorkWindow`, never from
`rules.workDayStart`/`workDayEnd` directly: those two are the baseline, and
`rules.workHoursByDay` optionally overrides them per weekday. The map is absent
on any rules object saved before per-day hours existed, which resolves to the
baseline for all seven days — that's why the feature needed no migration. A day
marked `enabled: false` resolves to a zero-length window, so "day off" costs the
engine no special case; it falls out of the interval subtraction as zero
capacity. The scalars are deliberately kept rather than replaced, because
`notify-worker` reads `rules.workDayStart` to time its due-today digest and
deploys independently of the app.

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
placement — lower is better. Three terms, all scaled by a per-priority
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
- **Time of day** — `TIME_OF_DAY_PENALTY_PER_HOUR` for each hour of a task's
  work placed outside its `preferredTimeOfDay` window (see
  `utils/timeOfDay.js`), and zero for the common case of no preference set.
  Charged on real overlap rather than "does the block start in the window",
  which is what gives the search a gradient to follow — without it a 3-hour
  morning task starting at 11:00 scores the same as one starting at 20:00 and
  no move looks like an improvement. Deliberately weaker than one day of
  fragmentation for a typical 1–2 hour block, so a preference decides a close
  call but never justifies shredding a task across days to chase a nicer hour.
  The preference is soft by design and never reaches the allocator: a hard
  constraint would produce unschedulable tasks with no visible reason.

There's deliberately no separate "unplaced" cost term — an unplaced task
already surfaces through the allocator's own `overflow` reporting, and
priority only ever multiplies the two terms above, never stands alone.

**`localSearch.js`** takes the greedy seed and runs a simulated-annealing
search over single-chunk relocate moves, trying to reduce total cost. It is
bounded primarily by a fixed `MAX_ITERATIONS` (2000) with a fixed RNG seed,
which makes it **deterministic: identical inputs always produce identical
placements**. That's load-bearing beyond scheduling quality — a block's id is
derived from its placement (`blk_${taskId}_${date}_${startTime}`), so a
placement that drifted by a minute between two otherwise-identical runs would
mint a new id and look like a brand-new block, detaching whatever per-block
state (locks, completion, UI selection) was keyed to it. `SEARCH_TIME_BUDGET_MS` (1000ms) is a
pathological-case safety valve only, deliberately set well above real cost (a
realistic workload finishes all 2000 iterations in well under 100ms, and
converges to stable placements after ~100) so it effectively never fires —
any run it truncated would be machine-speed-dependent and therefore
non-reproducible. Locked, fixed-time, and passive blocks are never candidates
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
easily land earlier than a lower-priority task it depends on in the seed
itself — an expected, routine case, since `rebalanceEngine.js` hands a
dependency and its (possibly incomplete) dependent to the allocator
together rather than excluding the dependent until the dependency is done.
`localSearch.js` repairs any such violation topologically before search
begins, so the guarantee — every chunk of a dependent task starts at or
after the last chunk of all its (transitive) dependencies — is actually
established here, not merely preserved from an already-valid seed.

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

`parentId` can also be changed after creation — via TaskDetailModal's "..."
menu ("Remove from parent task"), its breadcrumb "move to" picker, dragging
one task's card/row onto another in Board/List (`hooks/useReparentDrag.js`,
shared by both views), or smart-parse's "sub of <task>" title trigger. Every
one of these funnels through the same `getIneligibleParentIds`/
`isAtMaxSubtaskDepth` pair in `utils/taskHierarchy.js` to reject an invalid
target (the task itself, one of its own descendants, or a task already at
the 2-level cap) so the depth/cycle rule can't drift between entry points.

The inverse — clearing `parentId` — has its own drag gesture and smart-parse
trigger too, mirroring the ones above: dragging a nested List row onto the
list's own empty background (not onto another row) clears its parent (see
`useReparentDrag.js`'s UNPARENT section — the sentinel `targetId`
`UNPARENT_TARGET_ID` and its `dragOverRoot`/`dropRoot` handlers), and typing
the bare word "unsubtask" into a title is smart-parse's inverse of "sub of
<task>" (`smartParse.js`'s `findUnsubtaskPhrase`; no task name needed since
there's nothing to match against for a removal). Board has no equivalent
drag-out gesture — a sub-task never gets its own card there in the first
place (see BoardView's SUB-TASKS note), so there's nothing to drag out.

Inside TaskDetailModal specifically, `parentId` is tracked as its own local
state (like every other sidebar field), not read live off the `task` prop at
commit time. The modal's sidebar fields auto-save via a 500ms debounced
`commitChanges()` call — if that read `task.parentId` directly, a direct
reparent action (the menu/picker above) landing while an earlier edit's
timer was still pending would get silently undone moments later by that
timer firing with a stale closure. Tracking `parentId` as local state that
both direct-reparent call sites update synchronously (alongside the
snapshot) closes that gap — see `commitChanges`' and `handleMoveToParent`'s
doc comments. The same debounce effect also guards against a related
self-re-arming loop: `updateTask`'s own cascade helpers
(`computeRecurringRescheduleUpdate`, `computeEnforceDueDateSyncUpdates`) can
settle a field on a slightly different value than what `commitChanges` just
requested, which the modal's separate "pull in external change" effect
can't tell apart from a genuinely external edit — pushing either into local
state would otherwise re-arm the same debounce timer for another commit,
repeating until the cascade stabilizes. `isReconcilingOwnCommitRef`/
`suppressNextAutoSaveRef` (declared above `commitChanges`) suppress exactly
that one re-arm without blocking a timer armed by fresh user input or a
genuinely independent external change.

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
Completing the moved occurrence must NOT advance from the untouched pattern
anchor, though — that would ignore the move entirely and roll forward from
the stale pre-move date, landing a full cycle later than the day the user
actually moved it to. So `completeTask` (and the analogous descendant/cascade
completion paths — `computeRecurringDescendantState`,
`applyUpwardCompletionCascade`) first resolves the occurrence's real current
date via `resolveCurrentOccurrenceDueDate`, and if it differs from the stored
`dueDate`, re-anchors the series onto it with `planSeriesReanchor` (same
re-anchor `updateTask` already applies to a plain manual due-date edit)
before rolling forward — then prunes that occurrence's now-closed-out
override entry as before.

Because `dueDate` deliberately stays on the pattern anchor for an off-pattern
move, every plain `task.dueDate` reader needs to resolve the override to show
the occurrence's real date — `utils/recurrence.js`'s
`resolveCurrentOccurrenceDueDate(task)` does this (returns the override's
`date` when one exists for the task's current `dueDate` and isn't `deleted`,
else `dueDate` unchanged). `TaskDetailModal` uses it to seed/sync its due-date
field and to pick which date's blocks its "Scheduled" list shows, so both
agree with where the scheduler actually placed the occurrence instead of
displaying the stale pre-move anchor.

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

A task can list other tasks it `dependsOn`. An incomplete dependency does
**not** exclude the dependent task from scheduling — both are handed to the
allocator together, and the cost-minimizing refinement pass (`localSearch.js`,
see above) enforces dependency ordering as a real, jointly-checked constraint
on the whole transitive chain: every chunk of a dependent task must start at
or after the last chunk of every task it depends on. If a dependency itself
comes out of allocation with unplaced hours (e.g. it structurally doesn't fit
its own window's capacity), there's no placed block left to order the
dependent against — `rebalanceEngine.js` reports that dependent as
`dependency_blocked` overflow, distinct from (and much rarer than) an
ordinary `no_capacity` overflow, since it's the dependency chain — not the
dependent's own hours — that's the actual problem. Manually marking a task
complete is a separate, unrelated gate: `SchedulerContext.completeTask`
still refuses to complete a task while any of its dependencies remain
incomplete (`dependencyUtils.areDependenciesMet`), independent of whatever
the scheduler decided to do with its blocks.

A dependency also feeds backward into scoring: a blocker's effective urgency
rises to match whatever depends on it (see "Allocation" above), so a blocker
due soon *because* something urgent is waiting on it gets scheduled earlier,
not just eventually. The Edit modal blocks picking a dependency that would
create a cycle.

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
| `Task` | Hours, priority, due date, lock/complete state, optional section, optional `parentId` (sub-task of another Task, capped at 2 levels deep — see "Sub-tasks and containers"), optional `dependsOn` and `isPassive`, optional `comments` (text + optional file attachment, Firebase Storage-backed; capped at `MAX_COMMENTS_PER_TASK` (200) per task — see `SchedulerContext.addComment`/`deleteComment`). Always the embedded `Task.comments` array, even for a shared task's task — there is no separate comments subcollection (see "Shared projects" below). On a shared task's comment only, `authorUid`/`authorDisplayName`/`authorPhotoURL`/`mentions` are additionally populated (denormalized at post time) so the thread can attribute and @-mention collaborators — see `utils/commentMentions.js`. |
| `Section` | A Todoist Section — Board view column |
| `Project` | A Todoist Project, or a local-only one created from the sidebar's "+" — the top-level grouping switched between from the sidebar, List/Board's project header, or the search bar. Optional `ownerId`/`sharedProjectId` mark it as a collaborative project (see "Shared projects" below); a personal project has neither |
| `SharedProject` | A project shared with other users, living in its own top-level `sharedProjects/{projectId}` Firestore doc rather than inside `users/{uid}` — holds `ownerId`, a `collaborators` map, and denormalized `ownerDisplayName`/`ownerPhotoURL` (set at creation and kept current across an ownership transfer, so the owner's name/photo is readable even while they're offline — see `utils/sharedProjectAccess.js`'s `resolveOwnerProfile`). Deliberately does NOT hold the view/edit share links/tokens — see "Shared projects" below |
| `Collaborator` | One entry in `SharedProject.collaborators`: role (`viewer`/`editor`), display name, photo, joined-at. The owner is deliberately NOT in this map — they're identified by `ownerId` |
| `ScheduledBlock` | A concrete dated/timed slice of a `Task` on the calendar |
| `FixedRoutine` | Recurring non-negotiable time (sleep, meals, commute) |
| `CalendarEvent` | External (Google) or manual event; `isFreeTime` enables the "ignore" override |
| `SchedulingRules` | Global config: buffer days, work hours (per-weekday via `workHoursByDay`), pacing, horizon |
| `SavedView` | A named search query (`{id, name, query, createdAt}`) — synced and backed up, capped at `MAX_SAVED_VIEWS` |
| `DayCapacity` | Derived per-day free-time snapshot the allocator consumes |
| `HistoryEntry` | One Undo/Redo snapshot (full tasks+blocks state) |

### Shared projects (collaboration)

Personal projects live entirely inside the owner's `users/{uid}` doc, as they
always have. Sharing is **opt-in per project**: only a project explicitly
turned into a shared one moves into its own top-level
`sharedProjects/{projectId}` doc (with its `tasks`/`sections` as
subcollections), and gains `ownerId` + `sharedProjectId` on the local
`Project` record so app code knows which store to read/write. Nothing is
migrated retroactively. Comments are NOT a separate subcollection despite an
earlier draft of `firestore.rules` having one (that block is still present in
the rules file but explicitly commented as abandoned/unused) — they're just
the existing embedded `Task.comments` array, so they sync for free through
the same per-task diff as every other task field (see
`utils/sharedTaskSync.js`). One consequence: a comment write is really a
write to the whole task document, so `firestore.rules`' `tasks/{taskId}`
rule (`parentOwner() || parentEditor()`, no viewer carve-out) applies to it
too — a viewer-role collaborator cannot post or delete a comment. Rather than
widening that rule (which would let a viewer edit every other task field,
not just comments), `TaskDetailModal` renders the comment thread read-only
for viewers.

**Comment file attachments are disabled on shared-project tasks** (text
comments are unaffected). Personal (non-shared) task attachments upload to
`users/{uid}/attachments/{taskId}/...`, whose `storage.rules` are deployed
and working. Shared-task attachments were designed to use a second path,
`sharedProjects/{sharedProjectId}/attachments/{taskId}/...` (see
`attachmentService.js`'s `buildAttachmentPath`), with its own rules block
already written in `storage.rules` — but Firebase Storage has never been
provisioned for this project, and provisioning it likely requires switching
to the paid Blaze plan, which hasn't been adopted. An undeployed/unprovisioned
Storage bucket denies every request, so every shared-task upload would fail
at runtime if the UI still offered it. The affordance is disabled in three
places, all reversible: `TaskDetailModal` hides the attach-file button for a
task with a `sharedProjectId` (showing a short note instead) and shows a note
explaining why; `SchedulerContext`'s `addComment` refuses a `file` for a
shared task via `attachmentService.js`'s `checkAttachmentAllowed`, as
defense in depth against a stale client or a future call site; and
`storage.rules` carries a header note that its shared-project block is
written and reviewed but not deployed. Also note `storage.rules` has no
automated test coverage — `npm run test:rules` (see
[Testing](#testing)) only exercises `firestore.rules` against the Firestore
emulator, there's no equivalent Storage-rules emulator test in this repo. To
re-enable: provision Firebase Storage for the project, run `firebase deploy
--only storage`, then remove the three guards above (the attach button/note
in `TaskDetailModal`, the `checkAttachmentAllowed` check in `addComment`, and
optionally the header note in `storage.rules`).

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
  collaborator entry at join time — rules can only inspect the *requester's*
  identity, never a third party's, so the fact has to be recorded when they
  join to be checkable when someone later tries to hand them the project.
  Transferring to an anonymous identity would leave the project effectively
  unowned once that visitor cleared their storage: nobody able to delete it,
  rotate its links, or manage its collaborators.

  **That flag comes from a `wasAnonymous` custom claim, NOT from
  `sign_in_provider` — and that distinction is load-bearing.** A join can only
  happen inside a `signInWithCustomToken` session (that's how the `joinToken`
  claim arrives at all), and *every* custom-token session reports
  `sign_in_provider == 'custom'` regardless of the account underneath. Pinning
  `isAnonymous` to `sign_in_provider == 'anonymous'` therefore evaluated false
  for every joiner including genuinely anonymous ones, silently recording them
  all as real accounts and defeating this very check. The join endpoint instead
  reads the visitor's real provider from their *original, pre-join* ID token —
  the last moment it's still visible — and mints it forward as `wasAnonymous`
  alongside `joinToken`. Both claims come from the same server-signed token, so
  neither is client-forgeable. A caller who already holds a custom-token session
  carries their previous claim forward, so a second join can't launder an
  anonymous identity into a real-looking one. Note also that reading an absent
  claim off `request.auth.token` *errors* rather than evaluating false, so the
  rule checks presence first (`'wasAnonymous' in request.auth.token`) and treats
  a missing claim as "real account" — otherwise a token minted before this
  existed would deny the join outright.
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

### Live sync for shared projects (Phase 1)

`useSharedProjectSync.js` is deliberately a **separate, smaller hook** from
`useCloudSync.js` rather than an extension of it, because the two have opposite
truth models and unifying them would mean re-reasoning about every existing
single-user behaviour under concurrency:

| | `useCloudSync` | `useSharedProjectSync` |
|---|---|---|
| Source of truth | localStorage | Firestore |
| What it reconciles | one person's devices | many people's concurrent edits |
| Storage granularity | one `users/{uid}` document | one document **per task** |

One document per task matters: two people editing *different* tasks never touch
the same document, so the last-write-wins policy only ever applies to two people
editing the *same* task.

**A shared task stays in the same `state.tasks` array as everything else**,
tagged with `sharedProjectId`. That's what lets Board, search, the task list,
drag-and-drop, dependencies and the detail modal work on shared tasks with no
changes at all. What differs is only where it persists, and which subsystems
must leave it alone:

- **Not persisted locally, not pushed through `users/{uid}`** — otherwise a
  second, independently-reconciled store would sit behind data that already has
  concurrent writers (the same failure mode that keeps `events` out of live
  sync).
- **Excluded from undo/redo.** `HistoryEntry` snapshots the *entire* task array,
  so a plain restore would revert collaborators' concurrent edits to tasks the
  undoing user never touched. `undo`/`redo` are thin wrappers that re-apply the
  live shared tasks afterwards (`preserveSharedTasks`), so every consumer still
  calls them unchanged.
- **Excluded from the auto-scheduler, with one deliberate exception.**
  `rebalanceEngine` computes against one person's routines, hours and
  calendar, so a shared task has no single owner's capacity to consume by
  default — UNLESS it's explicitly `assignedTo` (see `Task.assignedTo` in
  `types/index.js`) the current device's own signed-in uid, in which case
  `rebalanceEngine.js`'s `eligibleTasks` filter lets it through and schedules
  it against that one assignee's own capacity, same as a personal task. An
  unassigned shared task, or one assigned to someone else, stays excluded as
  before. Manual scheduling always works regardless of assignment — Board
  drag-and-drop, and `scheduleTaskAt` (used by `EventDetailModal`'s
  create-flow Task-mode toggle) — and produces a block in that one user's
  own, unshared `blocks`.
- **Excluded from the 30-day completed sweep**, which would otherwise delete
  other people's tasks on one user's local clock and retention preference.

**Writes are computed by diffing** the task array rather than hooked into each
mutation, because tasks are mutated through a whole-array `commit()` from a
dozen call sites and any new one would otherwise have to remember to sync.
**Deletes are the exception and are passed in explicitly** — "absent from the
array" is ambiguous, since an undo, a backup restore or a cloud pull all replace
it wholesale, and inferring a delete from any of those would destroy a
collaborator's data.

**Conflict policy: last write wins per task document.** No operational
transform, no field-level merge — out of scope for v1. The one deliberate
exception is recurring-task completion state, which is *merged* (see below).
The remote-apply path also carries a per-task race guard: a snapshot computed
before our own in-flight write can arrive after it, and applying it naively
would revert the edit on screen *and* overwrite the copy the pending write
derived from, losing it outright rather than delaying it.

Everything above is decided by pure functions in `src/utils/sharedTaskSync.js`
(no Firebase imports), unit-tested in `tests/unit/sharedTaskSync.test.js` — the
same precedent as `sharedProjectAccess.js` and `computeFingerprint`. The
decisions are tested rather than clicked because a concurrency bug found by
clicking is found late.

**Sections (Board columns) sync the same way, added after tasks.** A shared
project's sections live in the SAME `state.sections` array as personal ones,
tagged `sharedProjectId`, synced by their own write-diff/remote-apply pair
(`planSharedSectionWrites`/`planRemoteSectionApply`, siblings of the task
functions above, in the same file) and excluded from the same set of places:
local persistence, the live cloud-sync fingerprint (`computeFingerprint`/
`planRemoteDataMerge` in `useCloudSync.js`), and backups' personal-only
snapshot. Unlike tasks, sections are not part of the undo/redo history at all
(`sections` is a plain `useState`, not `useHistoryState`'s `{tasks, blocks}`),
so there's no `undo`/`redo` wrapper to re-apply live shared sections —
instead, `SchedulerContext`'s `setSectionsGuarded` wraps every `setSections`
call inside `useCloudSync` (the live listener, the initial pull, and backup
restore — all of which replace `sections` wholesale) with
`preserveSharedSections`, the section equivalent of `preserveSharedTasks`.

**Conflict policy for sections: plain last-write-wins, no exception** (unlike
tasks' recurring-completion merge — a section has no accumulator field).
`order` is the one field worth calling out: it's assigned once, at
section-creation time, and never rewritten afterward — Board's own column
drag-reorder is already local-only (`utils/boardColumnOrder.js`, predating
sharing), never touching the synced `order` field. The only way `order` can
even collide is two collaborators creating a section at nearly the same
moment and both computing it from the same stale count, producing a tied
value — a cosmetic tie-break, not data loss, so plain LWW is enough and no
fractional-indexing/CRDT scheme was built for it.

A section created directly inside an already-shared project (`addSection`) is
tagged `sharedProjectId` immediately by looking up the owning `Project`
record (`project.sharedProjectId`) — necessary because, for the *owner* of a
shared project, the local `Project.id` and `sharedProjectId` are different
values (only a *joined* collaborator's local project row has `id ===
sharedProjectId`, see `joinSharedProject`'s own comment). `shareProject`
uploads a project's existing sections in bulk alongside its tasks, with the
same "await the upload before tagging anything" ordering Phase 1 established
for tasks (see its own comment for the stranding bug that ordering fixes) —
sections and tasks upload concurrently via `Promise.all`, then are tagged
from one post-upload snapshot each (`stateRef.current`/`sectionsRef.current`).

A viewer-role collaborator cannot add, rename, delete, or (server-side)
reorder a section — `firestore.rules`' existing `sections/{sectionId}` block
already enforces this (`parentOwner() || parentEditor()` for writes); `Board
View` mirrors it client-side (via `computeEffectiveRole`) by hiding the
add/rename/delete affordances for a viewer, same precedent as
`TaskDetailModal`'s read-only comment thread. Column drag-*reorder* itself is
exempt from this gate, since it never writes to Firestore at all (see
`order` above).

**Presence** ("who else is viewing this project right now") lives at
`sharedProjects/{id}/presence/{uid}` — one doc per viewer, heartbeated every
`PRESENCE_HEARTBEAT_MS` (30s, `useSharedProjectSync.js`) while the project is
open. `firestore.rules` restricts a write to the caller's own uid and caps its
shape to `displayName`/`photoURL`/`lastSeenAt` only, so a viewer can't write
someone else's doc or smuggle in arbitrary data. There is no "leaving" write:
the web has no reliable goodbye event, so a closed tab simply stops
heartbeating. Staleness is instead decided client-side, by recency —
`computeActiveViewers` (`utils/sharedTaskSync.js`) filters out any entry whose
`lastSeenAt` is older than `PRESENCE_STALE_MS` (90s), so a viewer's avatar ages
out a few missed heartbeats after they disappear rather than staying stuck
forever.

### Recurring tasks and concurrency (`recurrenceState.js`)

Recurring completion used to be a read-modify-write on three fields derived from
their own previous value: `dueDate` advanced, `completedDates` appended,
`completionHistory` incremented. That's fine with one writer and silently
corrupting with two — last-write-wins is correct for *replace* fields and wrong
for accumulators, so a completion recorded from a stale snapshot would replace
the whole array and erase someone else's.

The source of truth is now two fields that merge without coordination:

- **`completedOccurrences`** — merged by **union**
- **`skippedThrough`** — merged by **max**

Both operations are commutative, associative and idempotent, so concurrent
completions converge regardless of arrival order and a repeat completion is a
no-op. `dueDate`, `completedDates` and `completionHistory` keep their exact
shapes but are now **derived** from those two, so every existing reader is
unchanged — and being derived makes last-write-wins on them self-healing.

`skippedThrough` exists for one specific reason worth not losing: completing a
task 30 days overdue jumps to the next occurrence after *today* rather than
building a 30-day backlog. A plain "first uncompleted occurrence" derivation
would regress that, so skipped-but-not-completed had to be representable
separately without inflating streaks.

`planOccurrenceCompaction` keeps the occurrence set bounded. It's the one
non-commutative operation here, safe only because it never has two writers — a
personal task has one by definition, a shared task has an owner. This matters
more on the personal path, where `firestoreSync.js` stores a user's *entire*
dataset in a single `users/{uid}` document, so growth competes with everything
else for one 1 MB budget.

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
│   ├── Dashboard/              # DashboardPage (default landing tab) — DashboardStats, NowNextCard, TodayAgenda, ProgressRings, NotesCard (+ notesModel.js)
│   ├── Calendar/              # WeekView (day/week time-grid, drag/resize), MonthView (density overview), CalendarPage, CalendarFilterMenu (show-type/project/tag filter — predicate lives in utils/calendarFilter.js)
│   ├── Board/                 # BoardView — Kanban-style Section columns, or a flat list for a project with no Sections yet
│   ├── Gantt/                 # GanttChart burn-down view
│   ├── Stats/                 # StatsDashboard + BarChart/PieChart
│   ├── Modals/                # AddTaskModal (Todoist-style quick-add), TaskDetailModal (sub-tasks open a nested instance of itself), BlockDetailModal, NoteEditorModal (mini Tiptap/markdown note editor — opened from NotesCard and from the command palette's "Add note"), EventDetailModal (create mode has an Event/Task toggle — Task mode schedules an existing same-day-due task onto the clicked slot via `scheduleTaskAt` instead of creating a `CalendarEvent`), ShortcutsModal (Settings → Keyboard shortcuts), ShareProjectModal (owner link/collaborator management, Phase 2), JoinProjectModal (`?join=<token>` landing, Phase 2)
│   ├── Nav/                   # Sidebar — desktop/tablet nav + a capped recent-projects strip (pin/rename/delete via ProjectActionsMenu) with a link into Projects/; BottomTabBar — mobile-only nav; AccountButton — sign-in/account menu (sidebar + mobile topbar)
│   ├── Projects/               # ProjectsPage — directory/launcher tab: fuzzy project search, Recent/Shared/My-projects columns, size/duration/creation-date sort (stats/sort logic in utils/projectStats.js)
│   ├── Tutorial/               # GuidedTour + its step content (guidedTourSteps.js)
│   ├── Common/                 # SearchBar (also searches/switches projects and jumps to matching Calendar events), ProjectActionsMenu, Linkified (renders URLs in notes as links), Toast, SmartChips, SmartTitleInput, SmartDurationInput, SmartRecurrenceInput, DependencyPicker, LabelPicker, DetailField, NumberField (min/max-enforcing number input — plain `<input type=number>` min/max only constrains the spinner), FieldRejectionHint (transient "that input wasn't accepted" message, paired with useFieldRejection), CompleteTaskConfirmModal (log actual time spent on completion), PresenceAvatars (who else is viewing a shared project), SharedProjectBadge (personal/"shared by me"/"shared with me" indicator), BulkActionBar (shared docked bottom bar for bulk multi-select edit/delete — List/Board/Calendar/TaskDetailModal's sub-task list)
│   ├── Settings/                # RoutineTimeline — drag-to-edit 24h fixed-routines timeline
│   ├── CommandPalette.jsx      # Ctrl+K "jump to anything" — fuzzy-searches Views/Projects/Tasks/Calendar Events/quick Actions
│   ├── TaskListPanel.jsx
│   ├── TaskProjectRail.jsx     # Tasks page's collapsible all-projects panel — an inline column on desktop, an overlay drawer on mobile, from one piece of state
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
│   ├── useListKeyboardNav.js      # Shared Arrow/Enter highlighted-row navigation + scroll-into-view for ranked-results dropdowns (CommandPalette, Sidebar/ManageProjectsModal/CalendarFilterMenu/SearchBar project search) — a separate hook from useComboboxMultiSelect (see that file's own doc comment on why), composed alongside it where a caller needs both (CalendarFilterMenu's FilterGroup)
│   ├── useSmartTaskTitle.js       # Shared smart-parse wiring for the title field
│   ├── useProjectSearch.js        # Shared query state + fuzzy ranking + keyboard nav for the app's three project-search boxes (ManageProjectsModal, TaskProjectRail, Sidebar)
│   ├── useSelectAllOnFocus.js     # App-wide "focusing a text field selects its contents" behavior, so an existing value can be replaced by typing
│   ├── useFieldRejection.js       # One-shot shake + message for a rejected input, so a refusing handler explains itself instead of silently returning
│   ├── useNoteMutations.js        # Notes create/update/delete over SchedulerContext — shared by NotesCard, the command palette's "Add note", and applyPlan's note operations
│   ├── useMenuPosition.js         # Anchored-vs-centered popover placement (forceCentered on mobile) + outside-click wiring; Escape is delegated to useEscapeLayer
│   ├── useEscapeLayer.js          # One shared stack deciding who handles Escape — the innermost open surface wins, so a dropdown inside a modal dismisses itself instead of discarding the modal's draft; see the file header for why DOM phase ordering can't express this
│   ├── useKeyboardShortcuts.js    # Global rebindable shortcuts (undo/redo/new task) — bindings in localStorage, editable from Settings → Keyboard shortcuts
│   ├── useSharedProjectSync.js    # Live multi-writer Firestore sync for shared projects (Phase 1, Collaborative Projects) — subscriptions, diff-and-push, presence heartbeat
│   ├── useCloudSync.js            # Cross-device Firestore sync (fingerprint/merge/race-guard logic, auto/manual backups) — see "Persistence"
│   ├── useGoogleCalendarSync.js   # Google Calendar OAuth + poll-based two-way event sync, today's-blocks push — see "Persistence"
│   ├── useJoinFlow.js             # Drives the `?join=<token>` share-link landing: anonymous sign-in, token resolution, name prompt, membership write (Phase 2)
│   ├── useMultiSelect.js          # Transient (not persisted) per-surface bulk-selection state — List/Board/Calendar/TaskDetailModal's sub-task list each get their own independent instance; makeSelectionKey/parseSelectionKey encode a block:<id>/event:<id> composite key scheme for Calendar's mixed ScheduledBlock+CalendarEvent selections
│   ├── useLongPressSelect.js      # Mobile long-press-to-enter-selection-mode, modeled on useReparentDrag's own long-press timing/threshold
│   └── useTaskBulkEditActions.js  # Shared Task-only bulk-edit action set (editable-field computation + apply/complete/delete handlers) reused by List and Board
├── migrations/
│   ├── migrateBlockedTimeToEvents.js  # One-time data-shape migration backfilling new event fields (description/location) onto pre-existing manual events — see file-level comments for removal timing
│   ├── migrateSubtasksToTasks.js      # One-time migration converting the old embedded Task.subtasks array into standalone parentId-linked Tasks — see file-level comments for removal timing
│   ├── migrateRecurrenceConsistency.js # One-time migration syncing recurrence across mismatched parent/sub-task chains — see file-level comments for removal timing
│   ├── migrateStaleRecurringRemainingHours.js # One-time migration repairing a recurring task stuck at remainingHours 0 from before it became recurring — see file-level comments for removal timing
│   └── migrateRecurrenceState.js       # One-time migration adopting utils/recurrenceState.js's convergent completedOccurrences/skippedThrough model on existing recurring tasks — see file-level comments for removal timing
├── services/
│   ├── todoistService.js         # Todoist API v1 wrapper + normalization
│   ├── googleCalendarService.js  # Google Calendar OAuth + two-way event sync (push/pull) + planCalendarRewrite/computeCalendarRewritePlan (opt-in reverse-direction "make Google match TaskFlow" event rewrite, primary-calendar-only) + planTodaysBlockPush/computeTodaysBlockPushPlan (today's ScheduledBlocks, one-way, delete-all-then-recreate)
│   ├── eventSyncService.js       # Google-wins merge/reconcile logic for pulled events
│   ├── firestoreSync.js          # Pull/push/live-subscribe to a signed-in user's synced data
│   ├── mockData.js               # Zero-config sample data
│   ├── sharedProjectService.js   # Firestore I/O for collaborative projects (per-task documents, presence, sections) — decisions live in utils/sharedTaskSync.js and utils/sharedProjectAccess.js
│   ├── shareLinkService.js       # Client wrapper around the Cloudflare Worker's `/share/*` endpoints (link create/rotate/revoke, token resolve, guest migration)
│   ├── aiQuickAddService.js      # Client wrapper around the AI Quick Add Cloudflare Worker (Claude/Gemini request relay)
│   ├── aiContextService.js       # Builds the workspace-snapshot markdown context sent with an AI Quick Add request
│   ├── aiPlanService.js          # Turns an AI Quick Add response into a reviewable, per-item-toggleable plan of changes
│   ├── aiModels.js               # Provider/model catalog for the AI Quick Add picker
│   └── dataRetention.js          # Centralized retention-duration constants/helpers — see "Data retention policies"
├── utils/
│   ├── dateUtils.js          # ISO date / "HH:MM" arithmetic
│   ├── intervalUtils.js      # Interval merge/subtract math
│   ├── durationParser.js     # Free-text duration extraction
│   ├── dateParse.js          # Free-text due-date phrase detection
│   ├── recurrence.js         # Free-text recurrence phrase detection (task due-date recurrence, e.g. "every monday")
│   ├── recurrenceExpansion.js # RRULE parsing + display-time expansion of recurring calendar events into visual instances
│   ├── recurrenceState.js    # Convergent completedOccurrences (union)/skippedThrough (max) model a recurring task's dueDate/completedDates/completionHistory are derived from — safe under concurrent shared-project writers
│   ├── smartParse.js         # Composes the above + priority/dependency detection
│   ├── dependencyUtils.js    # Cycle detection + transitive dependency/dependent traversal for dependsOn graphs
│   ├── taskValidation.js     # Standalone extraction of TaskDetailModal's four per-field edit gates (computeDueDateError/computeDueDateRequiredError/computeFixedTimeError/computeEnforcingAncestor) — callable from both the modal's own single-edit path and the bulk-edit engine
│   ├── bulkEditEngine.js     # Bulk multi-select's editable-field intersection (computeBulkEditableFields) + per-item validate/skip/apply orchestration (applyBulkEdit, using taskValidation.js's gates) + result-summary formatting
│   ├── taskFacets.js         # Derived task facets (blocked/overdue/etc.)
│   ├── taskTemplates.js      # Reusable shapes of work: capture a task subtree (buildTemplateFromTasks) with due dates flattened to day OFFSETS from the subtree's earliest date, then rebuild it around a new anchor (planTemplateInstantiation). Offsets are DERIVED from real dates at save time, so there's no offset-authoring UI and no chained-offset model; parent/dependency links become template-local ids and are remapped to the new tasks. Instantiation goes through SchedulerContext's instantiateTemplate so all the tasks land in one commit
│   ├── weeklyReview.js       # The weekly review's bucketing (finished / slipped / carriedOver — non-overlapping by construction) over a ROLLING 7 days, deliberately not a calendar week (no week-start setting exists, and a calendar week has a dead zone on Mondays). planMoveToNextWeek keeps the weekday and always lands in the next window, so a task weeks overdue can't be moved into the past. Capacity comes from the caller — see hooks/useWeeklyReview.js on why its denominator passes `blocks: []`
│   ├── trash.js              # Recoverable deletes of projects/sections/labels: an entry stores the deleted ROW plus the IDS of the tasks it detached (never task copies — a copy would overwrite whatever the user did since). planTrashRestore's rule is "re-attach only if the task still exists AND is still detached", so a restore never resurrects a deleted task or yanks one out of where it's since been filed. Shared projects/sections are never captured (their tasks live in Firestore and the document is gone). Pruned on load and on every delete — TRASH_RETENTION_DAYS + MAX_TRASH_ENTRIES
│   ├── rescheduleHistory.js  # The narrow "did the user push this deadline later?" rule behind Task.postponeCount + the "pushed N×" badge threshold — exclusions (resubmitted same value, pulled earlier, first date, recurring) are the design
│   ├── linkify.js            # Turns http(s)/www URLs in free text into clickable segments
│   ├── stripMarkdown.js      # Renders a markdown string as plain text for previews (note tiles, note search)
│   ├── downloadFile.js       # downloadTextFile/toSafeFilename — shared Blob-and-anchor download used by the JSON backup export and a note's "Export as Markdown"
│   ├── boardColumnOrder.js   # Board's device-local, per-project column order layered over synced Section.order
│   ├── nameSearch.js         # Single shared typo-tolerant/relevance-ranked name matcher (rankByNameSearch/scoreNameMatch) — the one source of truth for searching projects (and reused for Views/Actions) in Sidebar, ManageProjectsModal, SearchBar, useMentionAutocomplete, CommandPalette, and CalendarFilterMenu; don't add another ad-hoc `.includes()` matcher for names elsewhere
│   ├── calendarFilter.js     # Calendar show-mode/project/tag filter predicates (CalendarFilterMenu's logic) — project search itself now lives in nameSearch.js
│   ├── projectConstants.js   # "All Tasks"/"Inbox" pseudo-project sentinels + sidebar project ordering + the NO_SCHEDULE_PROJECT_ID bulk-exclusion pseudo-project (drop tasks here to keep them out of Re-balance schedule without toggling excludeFromAutoSchedule per task)
│   ├── projectStats.js       # Read-only per-project stats/sort for the Projects page: task count, top-level-only effective-hours total (avoids double-counting a parent's rolled-up subtask hours), sortProjectsBy(size|duration|created)
│   ├── sharedTaskSync.js     # Pure decision logic for shared-task Firestore sync: which fields merge vs. last-write-wins, presence staleness, in-flight write race guards (Phase 1)
│   ├── sharedProjectAccess.js # Pure access/role decisions for share links and collaborator joins — mirrors firestore.rules' own token logic; server-side/join-path only (Phase 0). Also `getAssignableCollaborators`, the candidate list for a task's "Assign to" — deliberately INCLUDES anonymous collaborators, unlike commentMentions.js's getMentionCandidates below, since an assignment is read live off current project state rather than stored as a permanent denormalized artifact
│   ├── commentMentions.js    # Parses/renders `@[Name](uid)` mentions in a shared task's comment thread (Phase 3) — mention candidates exclude anonymous collaborators (no durable identity for Phase 4's future notification fan-out to reach)
│   ├── joinFlow.js           # Pure sequencing decisions behind useJoinFlow.js (token caching, per-link display-name storage) (Phase 2)
│   └── avatarDisplay.js      # Shared avatar helpers (safe photoURL check, initials fallback) used by PresenceAvatars/SharedProjectBadge/ShareProjectModal
├── types/
│   └── index.js               # JSDoc typedefs for the whole domain model
├── styles/                    # global.css (tokens/breakpoints), calendar.css, dashboard.css, gantt.css, board.css, nav.css, tasklist.css, stats.css, forms.css, timer.css, tutorial.css
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
[Google Calendar](INTEGRATIONS.md#google-calendar)). A recurring
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

**Reversing Google Calendar's sync direction ("Rewrite Google Calendar to
match TaskFlow").** The routine sync (`eventSyncService.js`'s
`mergePulledGoogleEvents`) is explicitly "Google always wins" — a pulled
event always replaces the local copy, never the other way around. This
feature is the one deliberate exception: an explicit, opt-in action
(Settings → Integrations, and an optional post-restore follow-up prompt —
never run automatically) that flips the direction for one run, making
TaskFlow's current local **calendar events** authoritative and reconciling
Google's calendar to match.

**ScheduledBlocks are pushed to Google Calendar one-way, today-only, via
delete-all-then-recreate — never diffed/matched by id.** TaskFlow originally
pushed each scheduled block to Google as an event, with a persisted per-device
record of what had been pushed, orphan-record matching to recognize a block a
rebalance had re-minted under a new id, and update/delete passes to keep the
two in step. That whole mechanism was removed (v5.3.0): a block's id encodes
its placement (`blk_${taskId}_${date}_${startTime}`), so the scheduler
re-mints ids freely during a rebalance — and no amount of matching on top of
that reliably distinguished "this block moved" from "this block is new",
which kept manufacturing duplicate and missing events on users' real
calendars.

Block-push came back on a fundamentally different model
(`pushTodaysTasksToCalendar` in `useGoogleCalendarSync.js`): only **today's**
blocks are ever pushed, one-way (TaskFlow -> Google, never read back), and
every run **deletes every Google event tagged as TaskFlow's own** (via
`TASKFLOW_BLOCK_PROPERTY_KEY`) for today, unconditionally, then re-inserts
fresh from whatever's currently scheduled — the same delete-all fix already
proven for `planCalendarRewrite` above, applied to a second feature. No
`googleEventId` is ever stored on a `ScheduledBlock`, and no old Google event
is ever matched against a specific block by id. A debounced effect
(`computeTodaysBlockPushSignature`) watches today's blocks + the task fields
that affect what's pushed (title/priority/completion) and re-triggers the
push automatically — completing a task removes its block from Google on the
next run, and a rebalance/edit is reflected the same way. A
single-flight-plus-queue-one-follow-up guard (`computePushSingleFlightDecision`,
shared with `useCloudSync.js`'s cloud push) prevents two delete-all-then-
recreate runs from ever overlapping. Day rollover falls out for free: the
push always recomputes "today" fresh, and the periodic poll / visibility-
focus refresh both re-trigger it, so a tab left open (or backgrounded)
across midnight still cleans up yesterday's tagged events on its next tick.

Block events pushed by an OLDER build (before this rework, or from the
original pre-v5.3.0 feature) may still sit on a user's Google Calendar from a
day this feature never revisits. Those are deliberately **left alone** —
they're the user's own calendar data to keep or delete as they see fit — but
they are still recognized on pull (`isBlockSourcedEvent`, via the
`TASKFLOW_BLOCK_PROPERTY_KEY` extended property with a legacy "📋 "
title-prefix fallback) so they're never imported as phantom local events and
never re-pushed as a fresh CalendarEvent.

**Ongoing reconciliation for events.** `pushUnsyncedItemsToCalendar`
(`useGoogleCalendarSync.js`) sweeps every `CalendarEvent` still lacking a
`googleEventId` and pushes it. It runs on every periodic poll tick and behind
the manual "Push to Google Calendar" button. Without it, an event whose one
best-effort push from `addManualEvent`/`updateEvent` failed (offline, not yet
connected, tab closed mid-flight) would be stranded unsynced forever.
`isUnsyncedPushableEvent` (pure, unit-tested) decides eligibility: never a
subscribed/foreign-calendar event (pushing a copy onto the user's own primary
calendar would duplicate someone else's event), never a legacy block-mirror
row, never one already in the past, and never one missing date/time.

This sweep is also what makes **restore-then-push** work. A backup restored
onto a calendar that has since been cleared brings back events whose stored
`googleEventId` no longer exists on Google. `mergePulledGoogleEvents` doesn't
delete those: an in-scope event absent from a pull is only treated as a
genuine Google-side delete if this app instance has actually seen that id live
since load (`confirmedGoogleEventIdsRef` → `isGoogleConfirmed`). An
unconfirmed one is instead demoted back to unsynced (`googleEventId: null`,
`source: 'manual'`), which makes it eligible for this sweep, which re-creates
it on Google with a fresh id.

- **Planning** (`planCalendarRewrite`/`computeCalendarRewritePlan` in
  `googleCalendarService.js`, pure and unit-tested) produces
  `{ toDelete, toInsert }`: EVERY Google PRIMARY-calendar event in the date
  range goes into `toDelete` unconditionally, and every local authoritative
  item into `toInsert` as a fresh create.
- **Why delete-all instead of a diff.** The original design spared any Google
  event whose id was still claimed by a local item's `googleEventId`. That
  protection rule was itself the bug: a historical duplicate-push left users
  with two local rows for one logical event, each holding its own genuinely
  valid `googleEventId`, so both Google copies were "claimed" and both
  survived a rewrite that reported complete success. Deleting everything and
  re-inserting sidesteps local-state disagreement entirely — nothing survives
  to be wrongly protected. Accepted costs: an event created directly in Google
  Calendar on the primary calendar within the range is wiped too, and every
  kept event is recreated with a new id.
- **Safety boundary (the one thing that must never regress):** everything
  here operates ONLY on `calendarId: 'primary'` — the only calendar this
  app's own writes (`pushEventToCalendar`) have ever targeted. `computeCalendarRewritePlan` is the only place that fetches
  Google's events for this feature, and it fetches (and thus can only ever
  delete) `calendarId === 'primary'` events — a subscribed/shared calendar
  the user doesn't own is never even in the candidate set, so it's
  structurally impossible for `planCalendarRewrite` to schedule one of its
  events for deletion. This filter now carries the WHOLE boundary, since no
  per-event protection remains, so it matters more than ever.
  `rewriteGoogleCalendarFromTaskflow` (the executor, in
  `useGoogleCalendarSync.js`) mirrors this on the local side: a
  `CalendarEvent` sourced from a non-primary Google calendar is excluded
  from the authoritative set entirely (never re-created on primary as a
  duplicate).
- **Legacy block-mirror events.** Local rows mirroring a block pushed by an
  older build are dropped from the authoritative set (`isBlockSourcedEvent`)
  rather than re-pushed — re-creating one would put a TaskFlow-shaped event
  back on a calendar this app no longer manages blocks for.
  `dedupeAuthoritativeItems` is a final backstop that collapses anything that
  would still push two identical events, logging a warning since that
  indicates genuinely duplicated local rows.
- **Execution** (`rewriteGoogleCalendarFromTaskflow`) is the only place in
  this codebase that issues more than a handful of Calendar API calls, so
  it's also the only place with real batching precautions. Deletes and
  inserts each go through Google's BATCH endpoint (`gapi.client.newBatch()`,
  up to `MAX_BATCH_SIZE` = 50 sub-requests per HTTP round-trip), which is
  what keeps a several-hundred-event rewrite to seconds rather than minutes.
  A batch resolves as ONE promise and does not reject on individual
  sub-request failure, so per-item results are read out of the response map
  (`classifyBatchSubResponse`) and accumulated into `{succeeded, failed}`
  rather than aborting on first error; a 404/410 on a delete counts as
  success (already gone). Rate limits are handled at two levels: a 429
  against the batch endpoint itself gets one retry with backoff
  (`withRateLimitRetry`), while individual 429'd sub-requests are collected
  and retried in one smaller follow-up batch — never by re-running the whole
  original batch, which would re-insert already-succeeded items as
  duplicates. Pacing runs BETWEEN batches, never within one. Progress
  (`rewriteProgress`) counts individual events but advances a batch at a
  time. Because delete-all invalidates every pre-existing `googleEventId`,
  the executor re-stamps ids across local state afterward — writing the fresh
  id for successful inserts and CLEARING it to null otherwise, so a failed
  item is picked up by the next poll's auto-push instead of silently looking
  synced forever.

Some persisted state is deliberately **device-local** — it lives in
`localStorage` (usually via `usePersistedState`) but is deliberately kept
out of `BACKUP_FIELDS` and cloud sync, because it's a per-device view
preference rather than data a user would be sad to lose on a device switch:
dashboard widget visibility, calendar zoom level, the Tasks page's
per-view status filter (`taskflow_tasks_filter_by_view_v1`), the
Calendar's filter menu (`taskflow_calendar_filter_v1`), and the Google
Calendar synced-range bounds (`googleSyncedRangeBounds` — how far out THIS
device has fetched). Use a versioned key
for these so a shape change can't strand users on a stale persisted value,
and merge the loaded value over the defaults defensively rather than
trusting it.

**Cross-device merge and deletion tombstones.** `useCloudSync.js`'s
`planRemoteDataMerge` used to treat `tasks` as one atomic value — whichever
side (local or remote) "won" got its entire array applied wholesale. That
meant a device waking up with a stale local copy (e.g. a phone left open for
days) could push its own array AFTER a genuinely newer edit from another
device, and — because a fresh write simply lands "last" — silently overwrite
the newer edit even though its content was actually older. The whole-document
`lastWriteAt` staleness gate (`isRemoteWriteStale`) can't catch this: the
stale device's push IS a fresh write, just of stale content, so a doc-level
timestamp can't tell the two apart.

`mergeTasksByUpdatedAt` (`src/utils/taskMerge.js`) fixes this with a per-task
merge: for each task id present on either side, whichever copy has the newer
`updatedAt` wins (a task on only one side — e.g. just created, not yet synced
— is kept as-is). This is why every task mutation in `SchedulerContext.jsx`
must reliably stamp `updatedAt`; a mutation that forgets to would make that
task invisible to the merge's recency check. `ScheduledBlock`s are
deliberately NOT part of this merge — they have no stable id across a
rebalance (`rebalanceEngine.js`'s `rebalance()` regenerates every unlocked
block from scratch on each run, keeping only locked/historical/completed ones
by reference) and no `updatedAt` of their own, so per-block merging doesn't
make sense. Instead, whenever a per-task merge actually changes the task set,
`applyRemoteData` triggers a local rebalance (via `SchedulerContext.jsx`'s
`runRebalanceRef`/`triggerRebalanceFromMerge` — a forward-reference wrapper,
same pattern as `queueDueDateRebalanceRef`, since `useCloudSync` is called
before `runRebalance` itself is defined) so `blocks` regenerates fresh from
the merged tasks rather than staying an incompatible mix of two devices'
block arrays.

Deletion needed its own fix to work with this merge: `deleteTask` no longer
removes a task from the array outright — it tombstones it in place
(`deletedAt`/`updatedAt` stamped, heavy content fields cleared — see
`utils/taskTombstones.js`'s `tombstoneTasks`). Without this, the merge
couldn't tell "this task never existed on this device" apart from "it existed
here and was deleted," so a delete on one device could be silently undone by
a stale edit arriving from a device that never saw the delete. A tombstone
competes in the SAME `updatedAt` comparison as any live edit, with no special
casing — a delete newer than a stale edit correctly wins (the deletion
sticks), and an edit newer than an old tombstone correctly wins too (the task
"un-deletes", which is intentional: an undo, or the user recreating similar
content after deleting). Every UI-facing consumer of `useScheduler()` gets a
tombstone-filtered `tasks` view (`SchedulerContext.jsx`'s `visibleTasks`) —
tombstones are invisible everywhere except `stateRef`/persistence/sync, which
need to see them for the merge to work. A mount-time retention sweep
(`RETENTION_DAYS_DELETED_TASKS`, `dataRetention.js`) permanently purges
tombstones older than 30 days — long enough that a realistically-offline
device still sees the tombstone before it's gone for good. Point-in-time
backups exclude tombstones entirely (`backupService.js`'s
`excludeDeletedTasks`), same reasoning as excluding completed one-off tasks:
there's nothing to restore a tombstone to, and a much-later restore
reintroducing a dead entry would just create a zombie every live device had
already purged.

If signed in (see [Account & cross-device sync](SYNC-AND-SHARING.md#account--cross-device-sync)),
the same data also syncs to Firestore — `localStorage` on
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

### Data retention policies

Time-based cleanup is centralized in `src/services/dataRetention.js` to keep
all retention durations in one place and use consistent utility functions. When
adding new cleanup code, import the retention constant from this module instead
of inlining time math.

**Current policies:**

| Data | Retention | Cleanup Location |
|------|-----------|------------------|
| Personal completed tasks | 30 days | `SchedulerContext.jsx` on mount |
| Deleted task tombstones | 30 days | `SchedulerContext.jsx` on mount (`utils/taskTombstones.js`) |
| Google Calendar events | 365 days | `eventSyncService.js` during pulls |
| Automatic cloud backups | 14 most recent | `useCloudSync.js` hourly/daily |
| Manual cloud backups | 14 most recent | `useCloudSync.js` per-backup + daily |
| Shared project presence | 90 seconds stale | Client-side (no delete); add TTL policy in Console |
| Shared project tasks | No auto-cleanup | Owner/editor must delete; shared tasks are co-owned |
| Anonymous user profiles | Not yet limited | Add TTL policy in Console (30 days) |
| Expired share links | Not yet cleaned | Add Worker cron job |

**Utilities available:**

- `computeCutoffMs(days)` — timestamp cutoff for a retention period
- `computeCutoffIso(days)` — ISO date cutoff (local time, not UTC)
- `isStale(timestamp, days)` — boolean check for stale data
- `computeEffectivePurgeBoundary(syncedBounds, maxDays)` — cap retention when synced data extends further back

See the module's own doc comments for full signatures and usage examples.

### Guest identity

Every signed-out visitor is a **guest** by default, whether they just opened
the app directly or arrived via a project share link — one unified identity
either way, not two unrelated mechanisms. `src/utils/guestIdentity.js` holds
the durable piece of that identity: a single `localStorage` record,
`{uid, displayName}`, that both paths read/write.

- **Firebase Anonymous Auth is minted LAZILY, not on every page load.** An
  earlier version of this design called `signInAnonymously` proactively the
  moment no session was observed, so every guest would have a uid
  immediately. Live testing found two problems with that: it's a real
  network call on every single load (this app has always worked fully
  offline off `localStorage`, and a guest identity must stay additive on top
  of that, not a new hard dependency on reaching Firebase before the UI
  settles), and in any environment whose Firebase Auth authorized-domains
  list doesn't include the current host (true of this repo's own local dev/
  E2E setup on `localhost:5183`), the call fails with a console-logged error
  on every load. So a uid is only minted the moment something actually needs
  one: opening a share link (`useJoinFlow.js`'s `signInAnonymously` call,
  unchanged from before this feature) or renaming from Settings while
  already a member of at least one shared project (`renameAnonymousSelf` in
  `SchedulerContext.jsx` — a rename with no shared projects touches nothing
  remote, so it needs no uid at all). Until one exists, `user` is `null` and
  `guestIdentity.js`'s record simply has `uid: null` — the display name is
  still fully readable/writable with no Firebase session in the picture.
- **`AccountButton`/`SettingsPanel` treat "no real signed-in account" (missing
  `user` OR an anonymous one) as the one guest state**, not `isGuestUser(user)`
  alone (which requires `user` to be truthy) — this is what makes the guest UI
  show up correctly for a guest who has no Firebase session yet.
- **This fixes a real bug**: a guest's chosen name used to live ONLY
  denormalized onto `collaborators[uid].displayName` on each shared project
  they'd joined — removing them from every such project (or a fresh browser
  joining a second link) lost the name entirely. `guestIdentity.js`'s
  `resolveGuestDisplayName` now checks the local record first and only falls
  back to scanning `collaborators` for a guest who predates this record
  (opportunistically backfilling a hit it finds there).
- **Local guest data was never at risk of forking or being lost across this
  transition** — `tasks`/`sections`/etc. persist under plain, non-uid-scoped
  `localStorage` keys (see above), so a guest who starts using the app
  locally and later opens a share link keeps the exact same local data
  regardless of whether/when a uid gets minted.
- **Deliberately NOT in `BACKUP_FIELDS`** — same reasoning as the per-token
  name cache this record superseded (`anonJoinNames`, now removed): a guest's
  Firebase Anonymous Auth uid IS the device's identity, with nothing
  meaningful to restore it as on another device. Once a guest signs in with a
  real Google account (`linkWithCredential`, upgrading their uid in place —
  see `AuthContext.jsx`), the guest record simply stops being read for that
  uid; there's nothing to migrate out of it.

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
(`dateParse.js`, `recurrence.js`, plus inline priority/dependency/"sub
of"/section-shorthand detectors) that `smartParse.js` runs in sequence,
stripping each match before the next detector runs. `useSmartTaskTitle.js`
wires that logic into both the Add and Edit modals identically so they can't
drift apart. A detector that can match more than one candidate ambiguously
(the standalone "%section" shorthand, which searches every project's
sections at once) returns every qualifying candidate instead of guessing —
its chip is `expandable`, and clicking it opens a small popover
(`SmartChips.jsx`) to disambiguate; this mechanism is generic, not
section-specific, so a future ambiguous-match detector can reuse it. Beyond
that after-the-fact chip, "@label", "#project[/section]" and "%section" all
also get a live-while-typing suggestion dropdown (`useMentionAutocomplete.js`
+ `MentionDropdown.jsx`, wired into `SmartTitleInput.jsx`) — the two
mechanisms are independent: the dropdown helps pick a candidate before the
mention is finished, the chip reports/disambiguates the result once
`smartParse.js` has actually resolved it.

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

- **React 19**, function components + hooks only.
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
- **Tiptap** (+ `tiptap-markdown`) powers NoteEditorModal's mini WYSIWYG
  markdown editor — the only rich-text editing surface in the app; a note's
  `body` field stays a plain markdown string in storage/sync either way.

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
logic, the AI Quick Add context-scope filter and plan resolution/validation
— see `aiContextService.test.js`/`aiPlanService.test.js` — and the bulk
multi-select engine's editable-field intersection and per-item
validate/skip/apply decisions — see `taskValidation.test.js`,
`bulkEditEngine.test.js`, `multiSelectKeys.test.js`). Output (pass/fail
counts per file) prints straight to the terminal when it finishes.

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
(tasks, views, dashboard, settings/backups, search/shortcuts/undo, timer,
bulk multi-select). It works headless against seeded `localStorage` mock
data, no login required; `playwright.config.js`'s `webServer` block starts
the dev server automatically (or reuses one already on port 5183). Pass/fail
results print to the terminal; on failure, Playwright also writes an HTML
report you can open with `npx playwright show-report`.

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
[the AI Quick Add docs](INTEGRATIONS.md#ai-quick-add) for the deploy
steps) and restart `npm run dev`. Stop the `wrangler dev` terminal with
Ctrl+C whenever — it's not needed unless actively iterating on the Worker.

When locking down the deployed Worker's CORS (`ALLOWED_ORIGIN`, see
`cloudflare-worker/README.md`), point it at your own actual deployment
domain — this is a per-deployer value, not something to hardcode here.

**No service worker — ruled out as a caching suspect, if it comes up
again.** TaskFlow is installable (manifest.json + iOS meta tags, see
[Using the app](USAGE.md#layout-and-mobile)) but has **no
service worker** — confirmed by grepping the whole repo for
`navigator.serviceWorker`/`sw.js`/`workbox`/`vite-plugin-pwa` and finding
nothing. If the app ever "still looks stale after deploy," that's ordinary
browser/CDN HTTP caching (a hard refresh fixes it), not a service worker
deciding on its own when to fetch a new version — there isn't one to
suspect.

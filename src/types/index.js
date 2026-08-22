/**
 * ============================================================================
 * DOMAIN TYPE DEFINITIONS
 * ============================================================================
 * This file centralizes every shape used across the scheduler. We use JSDoc
 * typedefs instead of TypeScript so the project runs on plain Vite + React
 * with zero build-step changes, while still giving editors full autocomplete
 * and type-checking (via `// @ts-check` if the consumer enables it).
 * ============================================================================
 */

/**
 * @typedef {'low' | 'medium' | 'high' | 'urgent'} Priority
 * Priority order used for sorting: urgent(4) > high(3) > medium(2) > low(1)
 */

/**
 * @typedef {Object} Task
 * @property {string} id                     - Unique identifier (uuid).
 * @property {string} title                  - Human readable task title.
 * @property {string} [notes]                - Optional free-text notes/description.
 * @property {Array<{url: string, matchedText: string}>} [noteLinks] - Smart-parsed link phrases stripped out of `notes` (TaskDetailModal), persisted so they can still be rendered as pills after the raw phrase is gone from the notes text.
 * @property {number} estimatedHours         - Total hours required to complete the task. ONCE THIS TASK HAS ≥1
 *                                              sub-task (see `parentId` below), this stops being a directly-editable
 *                                              number and becomes a live rollup of its children's own effective
 *                                              estimatedHours instead (cascading — a child that itself has children
 *                                              returns ITS rollup) — see utils/taskHierarchy.js. TaskDetailModal
 *                                              disables the field and shows the computed total once that's true.
 * @property {number|null} [actualHours]     - Hours actually spent working the task, set only when completing a
 *                                              task that had a Pomodoro timer running/paused (see TimerContext +
 *                                              CompleteTaskContext.requestComplete). Undefined for every other
 *                                              task — never backfilled retroactively.
 * @property {number} remainingHours         - Hours not yet scheduled/completed (drives re-scheduling). Subject to
 *                                              the same container-parent rollup as `estimatedHours` above once this
 *                                              task has ≥1 sub-task.
 * @property {Priority} priority             - Task priority, drives allocation order. Stays independently editable
 *                                              even once a task becomes a container (see `parentId`) — unlike hours,
 *                                              this doesn't inherently derive from children.
 * @property {string|null} dueDate           - ISO date string (YYYY-MM-DD) or null if no deadline. OPTIONAL for a
 *                                              top-level task: it still shows up normally in the Tasks list and
 *                                              Board view (matching Todoist), but has no planning window, so the
 *                                              allocator/rebalance engine never place it on the calendar. A SUB-TASK
 *                                              (see `parentId`) is schedulable with or without one — an undated
 *                                              sub-task borrows its nearest ancestor's `dueDate` as urgency pressure
 *                                              instead (see allocator.js's resolveDueDate). On a CONTAINER task (≥1
 *                                              sub-task of its own), this due date is never scheduled directly
 *                                              either way — it's purely an input into its children's urgency.
 * @property {boolean} [isRecurring]         - True if this task repeats (imported from Todoist's `due.is_recurring`,
 *                                              or set directly for a locally-created task). Completing a recurring
 *                                              task advances `dueDate` to the next occurrence instead of setting
 *                                              `isCompleted` — see SchedulerContext.completeTask.
 * @property {string|null} [recurrenceString] - Natural-language recurrence phrasing (e.g. "every day", "every 2
 *                                              weeks"), imported verbatim from Todoist's `due.string` when present.
 *                                              Used by utils/recurrence.js to compute the next due date locally.
 *                                              Null/undefined for non-recurring tasks.
 * @property {{unit: 'day'|'week'|'month'|'year', count: number, days?: number[]}|null} [recurrenceRule] - Cached/
 *                                              derived parse of `recurrenceString` (utils/recurrence.js's
 *                                              parseRecurrenceRule, recomputed via deriveRecurrenceRule whenever
 *                                              `recurrenceString` is set/changed/cleared — see every call site that
 *                                              touches it: SchedulerContext's addTask/updateTask, todoistService,
 *                                              migrateSubtasksToTasks, mockData). Purely internal/derived — never
 *                                              shown or edited directly in the UI. Used by rebalanceEngine.js's
 *                                              generateTaskOccurrences to expand a recurring task into every day (or
 *                                              specific weekday) it actually repeats on, instead of only its single
 *                                              current `dueDate`. Null/undefined for non-recurring tasks (or a
 *                                              recurring task whose `recurrenceString` doesn't parse).
 * @property {string[]} [completedDates]     - DERIVED VIEW, not source of truth — see `completedOccurrences` below
 *                                              and utils/recurrenceState.js. ISO dates (YYYY-MM-DD) this recurring
 *                                              task's occurrence was completed on, most recent first, covering the
 *                                              last 7 days (older ones appear in `completionHistory` instead). Shape
 *                                              and meaning are unchanged from when this was written directly, so
 *                                              every reader (missedTasks.js, BoardView, TaskDetailModal,
 *                                              StatsDashboard) is unaffected — only the writer changed. Only
 *                                              meaningful for `isRecurring` tasks; undefined for everything else.
 * @property {Record<string, number>} [completionHistory] - DERIVED VIEW (see `completedDates` above). Monthly
 *                                              aggregate of completions older than that 7-day window, keyed by
 *                                              `"YYYY-MM"` (e.g. `{"2026-07": 23}`), so a trend/streak view can show
 *                                              history arbitrarily far back. Computed as `completionHistoryArchive`
 *                                              plus a rollup of `completedOccurrences`, rather than incremented in
 *                                              place — an increment is exactly what can't survive two writers.
 * @property {string} [recurrenceAnchor]     - SOURCE OF TRUTH. ISO date of the series' defining first occurrence,
 *                                              which every derived due date is computed forward from. Set when a
 *                                              task becomes recurring, and re-set (not advanced) when the user
 *                                              manually picks a new due date — see utils/recurrenceState.js's
 *                                              planSeriesReanchor. Absent on a recurring task only if it has no
 *                                              due date yet, in which case there's no series to anchor.
 * @property {string[]} [completedOccurrences] - SOURCE OF TRUTH for which occurrences are done. A SET, merged
 *                                              between clients by UNION (see mergeRecurringState) rather than
 *                                              last-write-wins, because a completion recorded from a stale snapshot
 *                                              would otherwise replace the whole array and erase someone else's.
 *                                              Union is commutative and idempotent, so concurrent completions
 *                                              converge and completing the same occurrence twice does nothing —
 *                                              which also fixes single-user double-click double-advance.
 *                                              `dueDate` is derived from this, not stored independently.
 * @property {string|null} [skippedThrough]  - SOURCE OF TRUTH. ISO date through which occurrences are closed out
 *                                              but were NOT completed, merged between clients by MAX. Exists to
 *                                              preserve the long-standing behaviour that completing a task 30 days
 *                                              overdue jumps to the next occurrence after today rather than
 *                                              building a 30-day backlog — those skipped occurrences must not count
 *                                              as completions or streaks/stats would be inflated.
 * @property {Record<string, number>} [completionHistoryArchive] - Frozen baseline of `completionHistory` captured at
 *                                              migration time, plus anything compacted since. Holds counts whose raw
 *                                              dates no longer exist, so it can't be recomputed — keeping it is what
 *                                              stops adopting this model from destroying long-term history. See
 *                                              migrations/migrateRecurrenceState.js.
 * @property {Object<string,{date?: string, deleted?: boolean}>} [overrides] - Per-occurrence override map keyed by
 *                                              the occurrence's ORIGINAL (recurrence-rule-generated) ISO date, even
 *                                              if that occurrence was later moved — mirrors CalendarEvent.overrides
 *                                              (see below), scoped down to what a Task occurrence actually needs:
 *                                              `date` moves that single occurrence off its normal pattern day
 *                                              without re-anchoring the task's own `dueDate` or shifting any other
 *                                              occurrence, and `deleted: true` skips that one occurrence entirely.
 *                                              Consulted by utils/recurrence.js's generateTaskOccurrences and
 *                                              rebalanceEngine.js's expandRecurringTasks the same way
 *                                              recurrenceExpansion.expandRecurringEvent consults an event's own
 *                                              overrides. Only meaningful for `isRecurring` tasks; undefined for
 *                                              everything else.
 * @property {Object<string, number>} [remainingHoursOverride] - Per-occurrence manual "time left" edit, keyed by the
 *                                              occurrence's ORIGINAL (pattern-generated) ISO date — same key
 *                                              convention as `overrides` above. A recurring task's `remainingHours`
 *                                              is never stored (see `remainingHours` below); it's computed fresh
 *                                              per-occurrence by rebalanceEngine.js's expandRecurringTasks as
 *                                              `estimatedHours - spent`. When a user manually sets "time left" on a
 *                                              specific occurrence, that value is recorded here instead, keyed by
 *                                              that occurrence's date, and consulted by expandRecurringTasks in
 *                                              place of the computed value (still clamped to
 *                                              `[0, estimatedHours]`). Deleted from this map when that occurrence is
 *                                              completed (see SchedulerContext.completeTask), so the next occurrence
 *                                              starts fresh at the full estimate rather than inheriting a stale
 *                                              manual value. Transient in-progress tracking, not synced completion
 *                                              state — merged last-write-wins like any other plain field (no special
 *                                              handling in utils/recurrenceState.js's mergeRecurringState needed).
 *                                              Only meaningful for `isRecurring` tasks; undefined for everything else.
 * @property {string} [projectId]            - Todoist project id, if synced.
 * @property {'todoist'|'manual'} source     - Where the task originated.
 * @property {boolean} isLocked              - If true, scheduler will NOT move existing blocks for this task.
 * @property {'morning'|'afternoon'|'evening'} [preferredTimeOfDay]
 *                                           - Optional "this belongs in the morning" hint. SOFT: it adds a per-hour cost for
 *                                             work placed outside the window (placementCost.js's timeOfDayCost) so the
 *                                             refinement pass prefers a matching slot, but never constrains the allocator —
 *                                             a hard constraint would produce unschedulable tasks with no visible reason.
 *                                             Window boundaries live in utils/timeOfDay.js.
 * @property {number} [boardOrder]          - Hand-ranked position within its Board column, ascending. Absent on any task
 *                                            never dragged into place, which sorts after ranked ones (see
 *                                            utils/boardCardOrder.js). Lives on the Task rather than device-local storage
 *                                            — unlike the sibling COLUMN order — so it syncs across devices and is shared
 *                                            on a shared board; that file explains why the reasoning differs.
 * @property {boolean} [excludeFromAutoSchedule] - If true, the auto-scheduler (rebalanceEngine.js's `eligibleTasks`
 *                                              filter) skips this task entirely — it never gets a block placed or
 *                                              moved by Re-balance schedule, the same carve-out phrasing used for
 *                                              shared-project tasks just above that filter. It can still be
 *                                              scheduled MANUALLY by dragging it onto the calendar, which produces a
 *                                              block in the user's own local blocks array like any other manual
 *                                              placement. Falsy/absent means no override (the normal case, task is
 *                                              eligible like any other).
 * @property {boolean} isCompleted           - Completion state. Recurring tasks never reach `true` via normal
 *                                              completion — see `isRecurring` above.
 * @property {string|null} [completedAt]     - ISO datetime stamped when `isCompleted` is set true (see
 *                                              SchedulerContext.completeTask), cleared back to null on restore
 *                                              (uncompleteTask). Drives the 30-day auto-delete sweep on load.
 * @property {string} [deletedAt]            - ISO datetime stamped by SchedulerContext.deleteTask instead of
 *                                              actually removing the task from `tasks` — a TOMBSTONE, so a future
 *                                              per-task cross-device merge can tell "never existed on this device"
 *                                              apart from "existed, then was deleted here," which a plain removal
 *                                              can't (see utils/taskTombstones.js). `notes`/`noteLinks`/`comments`/
 *                                              `deletedCommentIds` are cleared at tombstone time since they're the
 *                                              heaviest/most private fields with nothing left to show; `title` and
 *                                              every other field are left as-is (harmless, and useful for
 *                                              debugging). SchedulerContext filters every tombstoned task out of
 *                                              the `tasks` value it hands to the rest of the app (components never
 *                                              see this field), but it stays in `state`/persistence/cloud sync so
 *                                              the merge layer and the retention sweep (utils/taskTombstones.js's
 *                                              isStaleTombstone, RETENTION_DAYS_DELETED_TASKS in dataRetention.js)
 *                                              can see it. Undefined/absent for every normal, non-deleted task.
 * @property {number} minChunkHours          - Historical per-task minimum chunk size field; no longer read by the
 *                                              allocator. Splitting is now governed purely by a chunk-COUNT cap
 *                                              (round(durationHours*60/30), see maxChunksFor in allocator.js) plus
 *                                              a flat 5-minute floor (MIN_CHUNK_HOURS) on individual chunk size -
 *                                              a task's total remaining time is only ever placed as one chunk
 *                                              (never fragmented) if it's already at or under that 5-minute floor.
 * @property {number} maxChunkHours          - Largest allowed contiguous block per day (default 4h) - encourages context-switching breaks.
 * @property {string} createdAt              - ISO datetime.
 * @property {string} updatedAt              - ISO datetime.
 * @property {string|null} [sectionId]       - Todoist Section id this task lives in (board view column), or null.
 * @property {string|null} [sectionName]     - Denormalized section display name, or null for "No Section".
 * @property {string} [parentId]             - Id of this task's parent, if this task is a sub-task of another.
 *                                              Absent for top-level tasks. UI-enforced nesting cap of 2 levels deep
 *                                              (task -> sub-task -> sub-task of that sub-task — see
 *                                              TaskDetailModal's handleAddSubtask/isAtMaxSubtaskDepth), forward-only
 *                                              (no backfill against pre-existing data). A sub-task is a normal,
 *                                              independently-schedulable Task in every other respect (priority,
 *                                              dependencies, search, completion) — it competes for calendar capacity
 *                                              like any other task, needing a resolvable due date of its own or
 *                                              borrowed from the nearest dated ancestor, exactly like a top-level
 *                                              task needs its own (see allocator.js's resolveDueDate,
 *                                              rebalanceEngine.js's schedulable filter) — UNLESS it itself has ≥1
 *                                              sub-task of its own, in which case it becomes a schedule-container
 *                                              (see rebalanceEngine.js and `estimatedHours` above) rather than ever
 *                                              getting its own calendar block. An ancestor's `enforceDueDate` (see
 *                                              below) also propagates onto an undated sub-task borrowing that
 *                                              ancestor's due date — "must be done on this day" cascades down to the
 *                                              steps toward it. Excluded from Board/Gantt's own top-level card/row
 *                                              lists (see BoardView.jsx / GanttChart.jsx), which roll it up into its
 *                                              parent's progress badge instead.
 * @property {string} [todoistId]            - The task's raw numeric/string id in Todoist (source === 'todoist' only). Used to push edits back via todoistService.
 * @property {string[]} [dependsOn]          - IDs of other Tasks that this one must be scheduled AFTER — the
 *                                              dependent's blocks are placed to start no earlier than the end of its
 *                                              dependencies' last scheduled block, but an incomplete dependency does
 *                                              NOT exclude this task from scheduling (both are handed to the
 *                                              allocator together; see localSearch.js's dependency-ordering repair/
 *                                              move-validation and rebalanceEngine.js's `eligibleTasks`). Empty/absent
 *                                              means no dependencies. Manually completing a task is still blocked
 *                                              while a dependency is incomplete — see
 *                                              utils/dependencyUtils.areDependenciesMet, used by
 *                                              SchedulerContext.completeTask.
 * @property {boolean} [isPassive]           - True if this task can run unattended (e.g. laundry, something baking)
 *                                              and so may be scheduled to overlap other tasks' time blocks instead
 *                                              of competing for exclusive capacity — see allocator.js.
 * @property {string|null} [earliestDate]    - ISO date (YYYY-MM-DD). When set, this task's planning window can
 *                                              never start before this date — the allocator clamps its window-start
 *                                              to max(today, earliestDate) instead of just `today` — see
 *                                              allocator.js's getTaskWindow. Lets a user override the scheduler to
 *                                              say "don't touch this until at least day X", independent of
 *                                              dueDate/priority. Null/absent means no override (the normal case).
 * @property {boolean} [enforceDueDate]      - True if this task must be completed ON its due date — the allocator
 *                                              collapses its entire planning window to just `dueDate` (windowStart
 *                                              === windowEnd === dueDate), overriding bufferDays and earliestDate
 *                                              (the more restrictive setting wins) — see allocator.js's
 *                                              getTaskWindow. Only meaningful when `dueDate` is set; ignored
 *                                              otherwise. Falsy/absent means no override (the normal case).
 *                                              Propagates downward onto every descendant sub-task, the same way
 *                                              `isRecurring` propagates between parent and sub-tasks — see
 *                                              computeEnforceDueDateSyncUpdates, wired into SchedulerContext's
 *                                              addTask/updateTask. Unlike recurrence (which also falls back to a
 *                                              recurring descendant), this only ever flows downward: an ancestor
 *                                              with `enforceDueDate` + its own `dueDate` forces `enforceDueDate:
 *                                              true` onto every descendant, copying its `dueDate` too for any
 *                                              descendant that doesn't already have one of its own (see
 *                                              `dueDateInherited` below for how a descendant's own `dueDate` is
 *                                              told apart from one merely copied down from an ancestor). A
 *                                              descendant's own `enforceDueDate` never bubbles back up to its
 *                                              parent — a sub-task needing to be done on an exact day says nothing
 *                                              about whether the parent container itself must finish that same day.
 * @property {boolean} [dueDateInherited]    - True if this task's `dueDate` was copied down from an enforcing
 *                                              ancestor by computeEnforceDueDateSyncUpdates, rather than set
 *                                              directly by the user. Lets that sync function tell "no due date of
 *                                              its own yet" apart from "user deliberately set (or kept) this due
 *                                              date" on re-runs, so it knows whether to cascade a LATER change to
 *                                              the ancestor's `dueDate` onto this task too: true means keep
 *                                              tracking the ancestor, falsy means leave this task's date alone.
 *                                              Set to true only by that sync function; cleared by updateTask
 *                                              (SchedulerContext.jsx) the moment the user explicitly edits this
 *                                              task's own `dueDate`, at which point it's theirs and is never
 *                                              overwritten again. Falsy/absent is the normal case for any
 *                                              non-descendant task, or a descendant with its own due date.
 * @property {string|null} [fixedTime]       - "HH:MM" 24hr local time. When set, this task's block(s) must start at
 *                                              exactly this time on whatever day the allocator schedules them —
 *                                              overriding the normal first-fit placement within a day (the task is
 *                                              still scheduled/paced across its window like any other task; only the
 *                                              *time of day* is pinned, not the day itself). A non-passive fixedTime
 *                                              task also gets first crack at its slot via a dedicated pre-pass —
 *                                              see allocator.js's allocateTasks — so a higher-scored-but-not-fixedTime
 *                                              task can never bump it from its pinned time. If that exact slot is
 *                                              already taken on a given day, that day's placement is normally simply
 *                                              skipped (no fallback to another time) and any hours that can't be
 *                                              placed surface through the normal overflow reporting — EXCEPT when
 *                                              the task's whole window is a single day (enforceDueDate) with no other
 *                                              day to retry on, in which case leftover hours fall back to an ordinary
 *                                              first-fit slot elsewhere that same day (see placeAndRecordBlocks'
 *                                              allowSameDayFallback) and the task is flagged as `fixed_time_shifted`
 *                                              in allocateTasks' returned `timeShifted` list even if every hour still
 *                                              got placed. See allocator.js's placeFixedTimeInDay. Null/absent means
 *                                              no override (the normal case).
 * @property {string[]} [labelIds]           - IDs of Labels (see Label typedef) attached to this task, e.g. via the
 *                                              "@tag" smart-parse shorthand in the title. App-local only — has no
 *                                              Todoist equivalent and is never pushed/pulled by todoistService.
 * @property {string|null} [link]            - A URL associated with this task, detected via smart-parse when a
 *                                              plain link is typed into the title (see utils/smartParse.js) and
 *                                              stripped out of the displayed title. Wherever the title renders as
 *                                              read-only text (task list, board, dashboard) it becomes a click-
 *                                              through to this link instead of opening the detail view. App-local
 *                                              only — has no Todoist equivalent.
 * @property {Comment[]} [comments]          - Todoist-style comment thread (see Comment typedef below), newest
 *                                              last. Added/removed via SchedulerContext's addComment/deleteComment
 *                                              rather than updateTask directly, since a comment can carry a file
 *                                              that needs a matching Storage upload/delete alongside the Firestore
 *                                              write. App-local only — has no Todoist equivalent.
 * @property {string[]} [deletedCommentIds]  - Tombstones for comments deleted from a SHARED task's thread. The
 *                                              thread is MERGED across collaborators rather than overwritten (see
 *                                              utils/sharedTaskSync.js's mergeComments), and in a merge a missing
 *                                              comment is indistinguishable from one this client hasn't received
 *                                              yet — so without a tombstone a deleted comment would reappear on
 *                                              the next sync. Set only on shared tasks; personal tasks have a
 *                                              single writer and just drop the comment from `comments`.
 * @property {string|null} [assignedTo]      - Firebase uid of the collaborator a SHARED task (task.sharedProjectId
 *                                              set — see Project typedef's own `sharedProjectId` and
 *                                              utils/sharedTaskSync.js's isSharedTask) is assigned to, or null/absent
 *                                              for unassigned. Meaningless on a personal (non-shared) task, which has
 *                                              only one possible "owner" — the signed-in user — so it stays
 *                                              absent there, same convention as `authorUid`/`deletedCommentIds` above.
 *                                              The ONLY thing this field does: rebalanceEngine.js's `eligibleTasks`
 *                                              filter carves out a shared task assigned to the CURRENT device's
 *                                              signed-in uid as schedulable by that user's own auto-scheduler (their
 *                                              own routines/capacity/calendar), the one deliberate hole in that
 *                                              filter's otherwise-unconditional shared-task exclusion — see its own
 *                                              comment for why every other shared task still can't be. A plain field
 *                                              like any other on the task document, so it merges through the normal
 *                                              last-write-wins policy (utils/sharedTaskSync.js's mergeSharedTask) with
 *                                              no special-casing, and needs no BACKUP_FIELDS/computeFingerprint entry
 *                                              since shared-task content is already entirely out of scope for
 *                                              personal backups/live cloud sync (see backupService.js's BACKUP_FIELDS
 *                                              doc comment on shared-project content).
 */

/**
 * @typedef {Object} Collaborator
 * A single entry in a SharedProject's `collaborators` map (keyed by uid) —
 * see SharedProject typedef below. Written once at join time
 * (utils/sharedProjectAccess.js's planCollaboratorJoin) and updated
 * thereafter only by the project owner changing a role or removing the
 * entry. Covers both a logged-in Firebase user and an anonymous link visitor
 * (see Firebase Anonymous Auth in the Collaborative Projects spec, TODO.md).
 *
 * `firestore.rules` validates this shape on every join (see its
 * `joinEntryWellFormed`) — no extra keys are accepted, and the string fields
 * are length-capped. That's deliberate: `affectedKeys()` only reports that
 * `collaborators` changed, never what's inside an entry, so without an explicit
 * shape check a joiner could stuff arbitrary keys (`adminOverride: true`) or
 * hundreds of KB of junk into a document every member downloads. Keep this
 * typedef and that rule in sync — adding a field here means allowing it there.
 * @property {'editor'|'viewer'} role   - See utils/sharedProjectAccess.js's SHARE_ROLES. Never 'owner' — the
 *                                        owner is identified by SharedProject.ownerId, not an entry in this map.
 * @property {string} displayName       - Shown on avatars/mention autocomplete; user-chosen for anonymous
 *                                        visitors (prompted once, cached in localStorage per link/browser).
 *                                        Capped at 120 chars by the rules.
 * @property {string|null} photoURL     - Null for anonymous visitors (no profile photo to show). Capped at 500
 *                                        chars. Treat as untrusted when rendering — it's user-supplied, so never
 *                                        interpolate it into an href/src without validating the scheme (a
 *                                        `javascript:` URL here is exactly the kind of thing rules can't catch).
 * @property {string} joinedAt          - ISO datetime this uid first joined the project.
 * @property {boolean} isAnonymous      - Whether this uid is a Firebase Anonymous Auth visitor rather than a real
 *                                        account. Set at join time by the rules from the joiner's own verified
 *                                        `sign_in_provider` claim, NOT self-declared — a client that sends the
 *                                        wrong value simply fails the join. Exists because ownership can never be
 *                                        transferred to an anonymous identity (no durable account to own the
 *                                        project — it would vanish when they clear storage, leaving it
 *                                        unowned), and rules can only inspect the REQUESTER's provider, never a
 *                                        third party's, so the fact has to be recorded here at join time to be
 *                                        checkable later (see firestore.rules' `recipientIsRealAccount`).
 */

/**
 * @typedef {Object} SharedProjectLink
 * One of the two link types (view/edit) a SharedProject can expose. NOT a
 * field on the SharedProject document itself — see that typedef below for
 * why. Instead, this is the shape of an entry in the separate, client-
 * unreadable doc `sharedProjects/{projectId}/private/links`
 * (`{view: SharedProjectLink, edit: SharedProjectLink}`), which
 * `firestore.rules` locks with `allow read, write: if false` — no client,
 * not even the project owner, may read or write it directly. Only
 * server-side code (the join endpoint, running with privileged/service
 * credentials that bypass these rules) creates, rotates, or reads it;
 * `firestore.rules` itself reads it via `get()` to evaluate a presented
 * token (see its `links()`/`linkUsable()` helpers). Owner-facing "show me my
 * share link" is therefore also served by that same server-side endpoint,
 * never by a client-side Firestore read.
 * @property {string} token      - Unguessable random id (see utils/sharedProjectAccess.js's generateShareToken),
 *                                  NOT the Firestore doc id — lets the owner "revoke" a link by rotating just
 *                                  this token, without deleting/recreating the whole project doc.
 * @property {boolean} enabled   - False once revoked. A disabled link's token must never grant access again,
 *                                  even if presented (see utils/sharedProjectAccess.js's resolveTokenRole) — the
 *                                  owner re-enabling sharing generates a fresh token rather than flipping this
 *                                  back to true against the old one.
 * @property {*} [expiresAt]     - Optional expiry. Stored as a Firestore TIMESTAMP (not this app's usual ISO
 *                                  string) because `firestore.rules` has no ISO-8601 parser and must compare it
 *                                  directly against `request.time` — see `firestore.rules`' `linkUsable`.
 */

/**
 * @typedef {Object} SharedProject
 * A project a user has explicitly turned into a multi-user collaborative
 * project (Collaborative Projects feature, TODO.md — Phase 0). Lives in its
 * own top-level Firestore collection, `sharedProjects/{projectId}`, WITH ITS
 * OWN tasks/sections/comments as subcollections
 * (`sharedProjects/{projectId}/tasks/{taskId}`, etc.) — never inside a
 * `users/{uid}` doc, since more than one uid needs read/write access to it.
 * Per the feature's non-negotiable security requirement, this collection is
 * never `list`-able by Firestore rules — a doc is only reachable by exact id,
 * and only readable/writable by its owner, an existing collaborator, or
 * someone presenting one of its two live link tokens (see
 * utils/sharedProjectAccess.js's computeEffectiveRole, which is the single
 * source of truth both client code and (mirrored) Firestore rules must agree
 * with for this decision).
 *
 * DELIBERATELY DOES NOT HAVE a `links` FIELD. Share tokens used to live here
 * as `links: {view, edit}` — that was a CRITICAL privilege-escalation bug,
 * caught during security review: a Firestore `get` returns the WHOLE
 * document, and collaborators must be able to `get` this doc to use the
 * project at all, so ANY viewer could read `links.edit.token` straight out of
 * it, re-join presenting that token, and escalate themselves to editor.
 * Firestore has no field-level read rules — the unit of a read is one whole
 * document — so a secret and a document readable by a broader audience than
 * that secret's own can never coexist safely. The fix was to move tokens off
 * this document entirely, into the separate `sharedProjects/{projectId}
 * /private/links` doc, which `firestore.rules` locks with
 * `allow read, write: if false` (see SharedProjectLink typedef above for that
 * doc's shape, and `firestore.rules`' own header comment "WHERE TOKENS LIVE,
 * AND WHY NOT ON THIS DOCUMENT" for the full writeup). Rules still evaluate a
 * presented token via `get()` against that private doc when a visitor joins —
 * that's a privileged, rules-internal read, not a client one. The token a
 * visitor presents when joining arrives as a custom auth claim
 * (`request.auth.token.joinToken`), minted server-side by the join endpoint
 * after it validates the token — never as a field written onto this document
 * (an earlier version did that too, which persisted the token into the doc on
 * the join write and leaked it to every later reader, the same class of bug).
 * Client code must never expect a `links` key here, and any write that tries
 * to add one is rejected by `firestore.rules`.
 * @property {string} id
 * @property {string} ownerId                          - The creating user's Firebase uid. Always the strongest
 *                                                        role (OWNER) regardless of any collaborators entry —
 *                                                        see computeEffectiveRole.
 * @property {string} [ownerDisplayName]                 - Denormalized copy of the owner's display name at the
 *                                                        time of creation (or their most recent ownership
 *                                                        transfer) — see sharedProjectService.js's
 *                                                        createSharedProject/transferSharedProjectOwnership.
 *                                                        Lets any surface show "shared by <name>" without the
 *                                                        owner needing to be currently online (unlike a
 *                                                        `collaborators` entry's displayName, which only exists
 *                                                        for non-owners). Absent on a doc created before this
 *                                                        field existed — see utils/sharedProjectAccess.js's
 *                                                        resolveOwnerProfile for the read-side fallback chain
 *                                                        (this field, then live presence, then a generic label).
 * @property {string|null} [ownerPhotoURL]               - Same denormalization, for the owner's avatar.
 * @property {string} name
 * @property {string} [color]
 * @property {string} createdAt                         - ISO datetime.
 * @property {Record<string, Collaborator>} collaborators - Keyed by uid. Does NOT include the owner (see ownerId).
 */

/**
 * @typedef {Object} CommentAttachment
 * A single file attached to a Comment, stored in Firebase Storage under
 * `users/{uid}/attachments/{taskId}/...` (see services/attachmentService.js).
 * @property {string} url    - Public download URL, safe to render/link to directly.
 * @property {string} path   - Storage object path, kept so the file can be deleted later.
 * @property {string} name   - Original filename, for display.
 * @property {number} size   - Bytes.
 * @property {string} type   - MIME type, used to decide image-thumbnail vs generic-file rendering.
 */

/**
 * @typedef {Object} Comment
 * A single entry in a Task's comment thread (see Task.comments). Mirrors
 * Todoist's task comments: plain text, an optional single file attachment,
 * or both. The `author*`/`mentions` fields below are OPTIONAL extensions
 * added for the Collaborative Projects feature (TODO.md) — they're only ever
 * populated for a comment on a SharedProject's task (see SharedProject
 * typedef above), where a comment needs an attributable author and
 * @-mentionable participants. A comment on a personal (non-shared) task has
 * no audience to attribute/mention against, so these stay absent there —
 * this is the same embedded `Task.comments` array either way, not a
 * separate Comment shape/subcollection for shared projects.
 * @property {string} id
 * @property {string} text                        - May be empty if the comment is attachment-only.
 * @property {CommentAttachment|null} [attachment]
 * @property {string} createdAt                    - ISO datetime.
 * @property {string} [authorUid]                  - Firebase uid (real or anonymous) of whoever posted this
 *                                                    comment. Shared-project tasks only; absent for personal tasks
 *                                                    (there is exactly one possible author — the signed-in user —
 *                                                    so attribution is redundant there).
 * @property {string} [authorDisplayName]          - Denormalized display name at post time, so a later name change
 *                                                    (or a since-removed collaborator) doesn't retroactively alter
 *                                                    or blank out history.
 * @property {string|null} [authorPhotoURL]        - Denormalized alongside authorDisplayName, same reasoning. Null
 *                                                    for anonymous authors.
 * @property {string[]} [mentions]                 - Uids of collaborators @-mentioned in this comment's text —
 *                                                    stable references (see utils/sharedProjectAccess.js's
 *                                                    Collaborator), so a mention still resolves correctly even
 *                                                    after the mentioned user's display name changes. Drives the
 *                                                    notification fan-out (Phase 4). Shared-project tasks only.
 */

/**
 * @typedef {Object} Label
 * A lightweight, app-local tag a user can attach to Tasks via the "@tag"
 * smart-parse shorthand in the title (see utils/smartParse.js). Distinct
 * from Project — a task can carry any number of labels but only one project,
 * mirroring Todoist's own label/project distinction. Has no Todoist
 * equivalent; created/stored entirely in TaskFlow.
 * @property {string} id
 * @property {string} name
 * @property {string} color                  - CSS color value assigned once at creation (see utils/labelColor.js),
 *                                              kept stable afterward so the same tag always renders the same color.
 */

/**
 * @typedef {Object} Section
 * A Todoist Section (board-view column) belonging to a project.
 * @property {string} id
 * @property {string} name
 * @property {string} [projectId]
 * @property {number} [order]
 */

/**
 * @typedef {Object} Project
 * A Todoist Project — the top-level container Sections and Tasks belong to.
 * Used to populate the Board view's project filter and the sidebar's
 * project shortcuts.
 * @property {string} id
 * @property {string} name
 * @property {number} [order]
 * @property {boolean} [isPinned]      - Shown at the top of the sidebar's project list.
 * @property {string} [lastVisitedAt]  - ISO timestamp, updated whenever this project becomes the active one.
 * @property {string} [ownerId]         - Set only once this project has been explicitly turned into a
 *                                        collaborative one (Collaborative Projects feature, TODO.md — Phase 0).
 *                                        A personal (non-shared) project has no owner field at all and stays
 *                                        exactly as it is today, living entirely inside this user's own
 *                                        `users/{uid}` doc — sharing is opt-in per project, never automatic/
 *                                        retroactive, so most Project records never gain this field.
 *                                        Comparing this against the current user's uid is what distinguishes the
 *                                        THREE states the projects screen must show — deliberately NOT collapsed
 *                                        into a single `isShared` boolean, which can't express the difference and
 *                                        would hide exactly the fact users most need (which direction it's shared):
 *                                          - no ownerId          -> personal, private to you
 *                                          - ownerId === your uid -> "shared with others", you're the owner and
 *                                                                    other people can see it
 *                                          - ownerId !== your uid -> "shared with you", someone else owns it and
 *                                                                    your own role comes from their
 *                                                                    SharedProject.collaborators[yourUid].role
 *                                        Don't replace this with a boolean flag for convenience.
 * @property {string} [sharedProjectId] - Pointer to the corresponding `sharedProjects/{projectId}` Firestore doc
 *                                        (see SharedProject typedef above) once this project has moved there.
 *                                        Only an explicitly-shared project's tasks/sections/comments actually
 *                                        live under that doc's subcollections; everything else stays put — this
 *                                        field is how app code decides which store (personal vs shared) to
 *                                        read/write a given project's data from/to.
 */

/**
 * @typedef {Object} ScheduledBlock
 * A concrete, dated/timed slice of a Task placed on the calendar.
 * @property {string} id                     - Unique identifier for this block.
 * @property {string} taskId                 - FK to Task.id.
 * @property {string} date                   - ISO date (YYYY-MM-DD) this block occurs on.
 * @property {string} startTime              - "HH:MM" 24hr local time.
 * @property {string} endTime                - "HH:MM" 24hr local time.
 * @property {number} durationHours           - Convenience-cached duration (endTime - startTime).
 * @property {boolean} isLocked              - User has manually pinned this block; engine must not move it.
 * @property {boolean} isAutoScheduled       - True if placed by the engine (vs. manually dragged in).
 * @property {'scheduled'|'in-progress'|'done'} status
 * @property {boolean} [isPassive]           - Denormalized from Task.isPassive at placement time. True if this
 *                                              block is allowed to overlap other blocks in time (e.g. laundry
 *                                              running alongside other scheduled work) — calendar views should lay
 *                                              overlapping blocks out side-by-side rather than treating it as a
 *                                              conflict.
 */

/**
 * @typedef {Object} FixedRoutine
 * A recurring, non-negotiable block of time removed from daily capacity
 * BEFORE the scheduler ever runs (sleep, meals, hygiene, commute).
 * @property {string} id
 * @property {string} label                  - e.g. "Sleep", "Commute (AM)", "Lunch".
 * @property {string} startTime              - "HH:MM"
 * @property {string} endTime                - "HH:MM"
 * @property {number[]} daysOfWeek            - 0(Sun)-6(Sat) which days this routine applies to.
 * @property {boolean} isActive
 * @property {boolean} [isProtected]          - If true, this routine is mandatory and can't be deleted by the
 *                                              user (e.g. the seeded Sleep routines) — start/end time, days, and
 *                                              the isActive pause/resume toggle can still be changed freely, only
 *                                              deletion is blocked. Absent/undefined counts as false.
 */

/**
 * @typedef {Object} CalendarEvent
 * An externally-sourced (Google Calendar) or manually created event that
 * occupies time on a given day. Distinct from ScheduledBlock (task work).
 * @property {string} id
 * @property {string} title
 * @property {string} date                   - ISO date (YYYY-MM-DD)
 * @property {string} startTime              - "HH:MM"
 * @property {string} endTime                - "HH:MM"
 * @property {boolean} isFreeTime            - If true, scheduler treats this as available (ignore/override rule).
 * @property {boolean} [isAllDay]           - True for an all-day event (Google's `start.date` rather than `start.dateTime`).
 *                                            Stored with startTime '00:00'/endTime '23:59' so the capacity engine and
 *                                            calendar layout need no special case, but rendered in WeekView's all-day row
 *                                            rather than as a full-height block. `isFreeTime` defaults from Google's own
 *                                            `transparency` for these (a booked day of leave blocks the day, a birthday
 *                                            from a holiday calendar doesn't), and `canEdit` is forced false because the
 *                                            push path only knows how to write timed events.
 * @property {string} [endDate]             - Inclusive last day of a MULTI-day all-day event. Stored once and expanded into
 *                                            one instance per covered day at display/capacity time (see
 *                                            recurrenceExpansion.expandMultiDayEvent) — NOT as N rows, because
 *                                            mergePulledGoogleEvents keys local events by googleEventId in a Map.
 * @property {boolean} isRecurring
 * @property {string|null} googleEventId
 * @property {string} [calendarId]           - Google calendarId this event came from (primary or a subscribed calendar).
 * @property {string} [calendarName]         - Display name of the source calendar, e.g. "Lecture Timetable".
 * @property {'google'|'manual'} source
 * @property {string|null} [seriesId]        - Google's `recurringEventId` (the shared master-event id every
 *                                              instance of a recurring event carries) — lets "ignore this event"
 *                                              be applied to just this instance, this-and-following, or the whole
 *                                              series. Null for non-recurring or manually created events.
 * @property {string} [description]          - Plain text description, optional.
 * @property {string} [location]              - Plain text location, optional.
 * @property {string|null} [recurrenceRule]   - RFC5545 RRULE string (e.g. "FREQ=WEEKLY;BYDAY=MO,WE"), null/absent for non-recurring events.
 * @property {Object<string,Object>} [overrides] - Per-occurrence override map keyed by the occurrence's ORIGINAL (RRULE-generated) ISO date, even if that occurrence was later moved (e.g. `{"2026-08-04": {isFreeTime: true}}`), for overriding fields on a single occurrence of a recurring event without duplicating the record. Two keys are handled specially by recurrenceExpansion.expandRecurringEvent rather than just shallow-merged as display fields: `date` (moves the occurrence to a different day) and `deleted: true` (drops that occurrence from expansion entirely).
 * @property {string|null} [googleUpdatedAt]  - Google's `updated` timestamp as of the last pull/push, used for conflict detection.
 * @property {string|null} [localUpdatedAt]   - Stamped on every local edit, compared against `googleUpdatedAt` to decide whether to push local changes or accept Google's incoming version.
 * @property {boolean} [canEdit]              - Whether the user has 'owner'/'writer' access to this event's source calendar on Google (see googleCalendarService.fetchEvents). Absent/undefined (manual events, mock data) counts as editable — only an explicit `false` (a reader/freeBusyReader-shared calendar, e.g. a subscribed lecture timetable) gates Save/Delete/field-editing in EventDetailModal and drag/resize in WeekView.
 */

/**
 * @typedef {Object} SchedulingRules
 * Global configuration governing how the engine allocates hours.
 * @property {number} bufferDays              - Days before due date the task should be *finished* by (default 1).
 * @property {string} workDayStart            - "HH:MM" earliest hour work can be scheduled.
 * @property {string} workDayEnd              - "HH:MM" latest hour work can be scheduled.
 * @property {Object<number, {start?: string, end?: string, enabled?: boolean}>} [workHoursByDay]
 *                                           - Optional per-weekday override of the two fields above, keyed 0=Sunday..6=Saturday
 *                                             (same convention as FixedRoutine.daysOfWeek). Absent — the state of every rules
 *                                             object saved before this existed — means every day uses workDayStart/workDayEnd,
 *                                             so there is no migration. `enabled: false` marks a day not-working, which
 *                                             resolves to a zero-length window rather than a special case downstream. Always
 *                                             read via utils/workHours.js's resolveWorkWindow, never indexed directly; the
 *                                             scalars stay authoritative as the fallback and are what notify-worker reads.
 * @property {number} maxDailyDeepWorkHours    - Cap on total scheduled task-hours per day, to avoid burnout.
 * @property {number} horizonWeeks             - How many weeks ahead the scheduler plans across.
 * @property {boolean} frontLoadUrgent         - If true, urgent/high priority tasks are packed near their due dates first.
 * @property {number} minGapBetweenBlocksMins  - Minimum break minutes required between two scheduled blocks.
 * @property {boolean} [autoRescheduleEnabled] - When true (default), adding a task with a due date or Google Calendar events changing (sync/import) automatically queues a schedule rebalance. When false, the user must trigger Re-balance manually.
 */

/**
 * @typedef {Object} DayCapacity
 * Derived/computed capacity snapshot for a single calendar day - the core
 * unit the allocation algorithm consumes.
 * @property {string} date                   - ISO date.
 * @property {number} totalAvailableHours     - Hours left after subtracting routines + calendar events.
 * @property {number} allocatedHours          - Hours already claimed by scheduled blocks (this run).
 * @property {Array<{start:string,end:string}>} freeIntervals - Open time windows, sorted, in "HH:MM" pairs.
 * @property {Array<Object>} [busyIntervals] - Raw tagged busy intervals (minutes-since-midnight) used by the
 *   allocator to identify what occupies a fixedTime task's slot on failure — see capacityEngine.js's
 *   collectBusyIntervals.
 * @property {{start:number,end:number}} [workWindow] - The day's overall working-hours bounds (minutes-since-
 *   midnight, nowClamp-adjusted), distinct from freeIntervals — lets the allocator tell "occupied by something"
 *   apart from "outside working hours entirely" for a fixedTime task (see allocator.js's placeFixedTimeInDay).
 */

/**
 * @typedef {Object} HistoryEntry
 * A single snapshot in the Undo/Redo stack.
 * @property {string} id
 * @property {number} timestamp
 * @property {string} actionLabel            - Human-readable description, e.g. "Auto-scheduled 4 tasks".
 * @property {ScheduledBlock[]} blocksSnapshot
 * @property {Task[]} tasksSnapshot
 */

export {}; // This file only exports types (JSDoc); no runtime code.

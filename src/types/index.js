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
 * @property {string} [projectId]            - Todoist project id, if synced.
 * @property {'todoist'|'manual'} source     - Where the task originated.
 * @property {boolean} isLocked              - If true, scheduler will NOT move existing blocks for this task.
 * @property {boolean} isCompleted           - Completion state. Recurring tasks never reach `true` via normal
 *                                              completion — see `isRecurring` above.
 * @property {string|null} [completedAt]     - ISO datetime stamped when `isCompleted` is set true (see
 *                                              SchedulerContext.completeTask), cleared back to null on restore
 *                                              (uncompleteTask). Drives the 30-day auto-delete sweep on load.
 * @property {number} minChunkHours          - Smallest allowed contiguous block (default 0.5h) - prevents over-fragmentation.
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
 *                                              independently-schedulable Task — it competes for calendar capacity
 *                                              like any other task, dated or not (see allocator.js's
 *                                              prioritizeTasks/resolveDueDate) — UNLESS it itself has ≥1 sub-task of
 *                                              its own, in which case it becomes a schedule-container (see
 *                                              rebalanceEngine.js and `estimatedHours` above) rather than ever
 *                                              getting its own calendar block. Excluded from Board/Gantt's own
 *                                              top-level card/row lists (see BoardView.jsx / GanttChart.jsx), which
 *                                              roll it up into its parent's progress badge instead.
 * @property {string} [todoistId]            - The task's raw numeric/string id in Todoist (source === 'todoist' only). Used to push edits back via todoistService.
 * @property {string[]} [dependsOn]          - IDs of other Tasks that must be completed before this one is eligible
 *                                              for auto-scheduling. Empty/absent means no dependencies. Checked by
 *                                              rebalanceEngine before a task is handed to the allocator — see
 *                                              utils/dependencyUtils.areDependenciesMet.
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
 * @property {string|null} [fixedTime]       - "HH:MM" 24hr local time. When set, this task's block(s) must start at
 *                                              exactly this time on whatever day the allocator schedules them —
 *                                              overriding the normal first-fit placement within a day (the task is
 *                                              still scheduled/paced across its window like any other task; only the
 *                                              *time of day* is pinned, not the day itself). If that exact slot is
 *                                              already taken on a given day, that day's placement is simply skipped
 *                                              (no fallback to another time), and any hours that can't be placed
 *                                              surface through the normal overflow reporting — see allocator.js's
 *                                              placeFixedTimeInDay. Null/absent means no override (the normal case).
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
 * or both.
 * @property {string} id
 * @property {string} text                        - May be empty if the comment is attachment-only.
 * @property {CommentAttachment|null} [attachment]
 * @property {string} createdAt                    - ISO datetime.
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
 * @property {string} [color]
 * @property {number} [order]
 * @property {boolean} [isPinned]      - Shown at the top of the sidebar's project list.
 * @property {string} [lastVisitedAt]  - ISO timestamp, updated whenever this project becomes the active one.
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
 * @property {string|null} googleEventId     - Linked Google Calendar event id, once pushed.
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
 * @property {number} maxDailyDeepWorkHours    - Cap on total scheduled task-hours per day, to avoid burnout.
 * @property {number} horizonWeeks             - How many weeks ahead the scheduler plans across.
 * @property {boolean} frontLoadUrgent         - If true, urgent/high priority tasks are packed near their due dates first.
 * @property {number} minGapBetweenBlocksMins  - Minimum break minutes required between two scheduled blocks.
 */

/**
 * @typedef {Object} DayCapacity
 * Derived/computed capacity snapshot for a single calendar day - the core
 * unit the allocation algorithm consumes.
 * @property {string} date                   - ISO date.
 * @property {number} totalAvailableHours     - Hours left after subtracting routines + calendar events.
 * @property {number} allocatedHours          - Hours already claimed by scheduled blocks (this run).
 * @property {Array<{start:string,end:string}>} freeIntervals - Open time windows, sorted, in "HH:MM" pairs.
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

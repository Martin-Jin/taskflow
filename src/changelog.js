/**
 * ============================================================================
 * CHANGELOG
 * ============================================================================
 * User-facing "what's new" history, shown via ChangelogModal (Settings →
 * Versions, and auto-popped the first time a signed-in-or-not visitor loads
 * a build newer than the one they last saw — see App.jsx's
 * `lastSeenChangelogVersion`).
 *
 * Entries are newest-first. `CURRENT_VERSION` is always the first entry's
 * version — bump it (and add a new entry above) with every push that ships
 * a user-visible change. Written in plain English for end users, not a raw
 * commit log — group related commits into one entry if they shipped together
 * (e.g. same day) and skip anything with no user-visible effect.
 * ============================================================================
 */

export const CHANGELOG = [
  {
    version: '1.19.0',
    date: '2026-07-30',
    title: 'Sub-tasks can now be scheduled onto your calendar on their own',
    changes: [
      "Sub-tasks are now scheduled individually, even without their own due date — they compete for calendar time just like any other task, and borrow their parent task's due date as urgency if they don't have one.",
      'A task that has sub-tasks becomes a container for them: it no longer gets its own calendar block, and its estimated/remaining hours are now automatically computed from its sub-tasks instead of being editable directly.',
      "Calendar blocks for a sub-task now show which parent task they belong to, so you don't lose that context without opening it.",
      'Sub-task nesting is now capped at 2 levels deep.',
    ],
  },
  {
    version: '1.18.3',
    date: '2026-07-30',
    title: 'Balanced sound effect volumes',
    changes: [
      'Normalized the loudness of the add/complete/delete sound effects so none plays noticeably louder or quieter than the others at the same volume setting.',
    ],
  },
  {
    version: '1.18.2',
    date: '2026-07-30',
    title: 'Home-screen icon fixes for Android/Chrome installs',
    changes: [
      'Added proper 192x192 and 512x512 app icons to the install manifest, so Android/Chrome "Add to Home Screen" installs get a real icon instead of falling back to a generic one.',
    ],
  },
  {
    version: '1.18.1',
    date: '2026-07-30',
    title: 'AI Quick Add: fixed a plan-review crash and a wrong error message',
    changes: [
      'Fixed a bug where a proposed plan containing a dependency cycle (e.g. two tasks each depending on the other) could crash the review screen entirely instead of just flagging the cyclic tasks as invalid.',
      'A rejected Gemini API key now shows the same "check it in Settings" message as other providers, instead of a generic upstream-error message.',
    ],
  },
  {
    version: '1.18.0',
    date: '2026-07-30',
    title: 'AI Quick Add can now plan and organize your whole workspace',
    changes: [
      'AI Quick Add went from creating one task or event at a time to proposing a full set of changes in one request: creating tasks and events, breaking a task into subtasks, setting up dependencies ("do X after Y"), moving tasks between projects/sections, and creating/renaming/deleting projects, sections, and labels.',
      'Nothing is applied automatically — every request opens a new review screen listing each proposed change individually with a checkbox, so you can uncheck anything you don\'t want before applying.',
      'The AI now defaults to creating tasks (even ones with a deadline) rather than calendar events — events are reserved for things that must happen at a fixed real-world time regardless of workload (an appointment, meeting, flight), since this app\'s own scheduler already decides when task work actually gets done.',
      'Added a model picker next to the provider choice, defaulting to the fastest/cheapest model with reasoning enabled for each provider (Claude Haiku 4.5 / Gemini 3.5 Flash-Lite) — pick a stronger model from the same dropdown for harder requests. A provider you haven\'t added an API key for yet is disabled instead of erroring after the fact.',
      'Shows an approximate token count before you submit, and gives a specific message (with a "switch provider" shortcut where it helps) when a request hits a rate limit, quota, or context-size limit, instead of one generic failure.',
    ],
  },
  {
    version: '1.17.6',
    date: '2026-07-30',
    title: 'Task dependencies are now actually enforced',
    changes: [
      'Checking off a task that\'s still blocked on an unfinished dependency (the "blocked by dependency" badge) no longer silently completes it — it now shows a message naming what needs finishing first.',
      'Starting the Pomodoro timer on a blocked task is blocked too, with the same "finish X first" message — timing a task that can\'t be worked on yet doesn\'t make sense.',
      'Completing a task automatically clears it from any other task\'s dependency list, since it no longer needs to block anything once done.',
      'Clicking a scheduled block on the calendar now has a button to jump straight to the full task editor.',
      'Straightened out the task detail header: the parent/sub-task path now sits flush left, with the "..." menu moved next to the close button.',
    ],
  },
  {
    version: '1.17.5',
    date: '2026-07-30',
    title: 'AI Quick Add button regrouped, mobile speed-dial',
    changes: [
      'The AI Quick Add sparkle button now sits directly next to "Add task" instead of floating with a gap between them.',
      'On mobile, the floating "Add task" button now expands into two mini-buttons (AI Quick Add and Add task) when tapped, instead of AI Quick Add needing its own separate spot in the toolbar.',
    ],
  },
  {
    version: '1.17.4',
    date: '2026-07-30',
    title: 'Fixed remaining toolbar height mismatch',
    changes: [
      'The search bar next to the AI Quick Add and Add task buttons was still a couple pixels shorter than both, despite an earlier alignment fix — now matches their height exactly.',
    ],
  },
  {
    version: '1.17.3',
    date: '2026-07-30',
    title: 'Shorter "What\'s New" panel by default',
    changes: [
      'Settings → Versions now only shows the 2 newest versions by default, with a "See more versions" button to load the full history instead of always scrolling through everything at once.',
    ],
  },
  {
    version: '1.17.2',
    date: '2026-07-30',
    title: 'Google Calendar reconnect prompt, sync/backup fixes, and small polish',
    changes: [
      "Google's sign-in can't always silently renew itself in the background (it periodically expires and there's no way around a real reconnect within Google's security model) — Settings now clearly flags when this happens and offers a one-click reconnect, instead of sync just quietly going stale with no explanation.",
      'Editing a calendar event — dragging it to a new time, resizing it, or saving changes in its detail view — now shows an Undo toast just like task edits do, including undoing the corresponding push back to Google Calendar when connected.',
      'Added a "Pull from Google Calendar" button (Settings → Integrations, shown once connected) for manually re-fetching your Google events on demand — useful if you suspect drift or want to discard local changes to a synced event.',
      'Fixed a bug where "Back up now" (Settings → Backups) could save a cloud backup that silently turned interface animations off when later restored, and a bug where restoring a backup risked reintroducing duplicate calendar events.',
      'Fixed a bug in Add Task where editing the repeat count/unit for a weekday-specific recurrence (e.g. "every Sat and Sun") could silently downgrade it to a generic weekly repeat.',
      'Fixed dragging a calendar event or block sideways on mobile sometimes also triggering day-swipe navigation on release, unexpectedly paging the view. Moved the mobile "Today" button up into the main toolbar row, next to the date dropdown.',
      'Fixed the AI Quick Add sparkle button sitting noticeably shorter than the "Add task" button beside it, and stretching to fill the full row width on mobile.',
    ],
  },
  {
    version: '1.17.1',
    date: '2026-07-30',
    title: 'Home-screen install support',
    changes: [
      'Launching TaskFlow from a phone home-screen icon now hides the browser address bar/chrome, so it feels like a native app.',
      'Mobile visitors now see a one-time reminder that TaskFlow can be added to their home screen for a full-screen app experience, with instructions for their platform (also available anytime from Settings → Install app).',
      'Fixed a white strip below the bottom nav bar and a green strip at the top that clashed with the app background when installed to a phone home screen, and fixed the home-screen icon showing blank on iOS instead of TaskFlow\'s logo.',
    ],
  },
  {
    version: '1.17.0',
    date: '2026-07-30',
    title: 'AI Quick Add',
    changes: [
      'New "AI Quick Add" button (sparkle icon) next to Add Task in the Tasks list and Board view — type a free-form description, or attach a screenshot, and have AI (your choice of Claude or Gemini) turn it into a new task or calendar event automatically.',
      'Runs on your own Anthropic/Gemini API key, added in Settings → Integrations → AI Quick Add, rather than a shared one. Requires deploying a small companion Cloudflare Worker (free tier, holds no API keys of its own) — see the README for setup; if not set up, the button simply stays hidden.',
      'The guided tour now points out the sparkle button, and a "?" button inside the AI Quick Add panel opens a guide covering what it does, where to get a free key, and how to use it.',
      'Fixed "#project" smart parse resolving to the wrong, shorter-named project when typing a multi-word project name (e.g. "#Work Trip" no longer matches "Work"), and fixed a "#project"/"@label" mention typed after an "after <task>"/"depends on <task>" phrase being swallowed into the dependency match.',
    ],
  },
  {
    version: '1.16.0',
    date: '2026-07-30',
    title: 'Calendar redesigned to feel like Google Calendar mobile',
    changes: [
      'Added a 3-day view alongside Day/Week/Month.',
      'The date title is now a dropdown — tap it for a month-strip date picker to jump straight to any day.',
      'Day/Week/Month/3 Day is now picked from a hamburger menu next to the date, replacing the old tab row.',
      'Tapping a day-of-week column header in Week/3 Day view now jumps into Day view for that date, same as tapping a day in Month view.',
      'The "New event" button is now a floating "+" button in the corner (matching the Tasks page\'s "Add task" button), on both mobile and desktop.',
      'Prev/next arrows are hidden on mobile, since swiping the calendar already moves between days/weeks/months there.',
    ],
  },
  {
    version: '1.15.1',
    date: '2026-07-29',
    title: 'Search, calendar, and sync polish',
    changes: [
      "Undoing a change right after making it could occasionally get silently reverted a moment later by background cloud sync, making it look like the undo didn't work until you pressed it again — undo now sticks on the first try.",
      'Fixed smart-parsed links not showing or persisting correctly: in a sub-task\'s entry in its parent\'s list, after re-opening a title whose link was already saved, and after clicking back into a description that already had a link detected.',
      'Tasks page search now searches every task in the current project, instead of only the ones already matching the active status filter chip. Typing in the search bar (Tasks list or Board) now also suggests matching tasks, not just projects and tags; a bare "#" now shows a project picker right away.',
      'Two-finger pinch on the mobile calendar now zooms the time grid in and out, like the desktop trackpad-pinch/ctrl-scroll zoom already did. The mobile top bar (logo + account avatar) now only shows on the Dashboard tab, freeing up space on Tasks, Calendar, Stats, and Settings.',
      'Overlapping events/tasks shorter than 30 minutes still collapse into a tappable "N events" chip, but anything 30 minutes or longer now always gets its own visible spot next to it; desktop now also collapses runs of short overlapping items into a chip, matching mobile.',
      'Google Calendar events now refresh automatically when you switch back to the app after being away, instead of waiting up to 5 minutes for the next background poll. Added a refresh button next to "Re-balance schedule" on the Calendar page.',
      'Opening a sub-task now shows a "Parent > Sub-task" link at the top — click the parent\'s name to jump straight to it. Opening a task with sub-tasks shows a sub-task count in the same spot, and clicking through a parent/sub-task chain reuses the same edit window instead of opening a new one on top.',
      'Fixed a bug where typing "#project" in a new task\'s title would silently do nothing if the Add Task dialog had already been opened from within a specific project or board column.',
      "Removed the warning toasts that could pop up right when the app loads (e.g. from the automatic Google Calendar refresh or cloud sync) — those failures are now only logged quietly instead of interrupting you before you've done anything.",
    ],
  },
  {
    version: '1.15.0',
    date: '2026-07-29',
    title: 'Subtle animations, with an off switch',
    changes: [
      'Added a few small touches of motion throughout the app: a quick pop when you check off a task, and a gentle fade-in for dropdown menus.',
      'Added an "Interface animations" toggle in Settings for anyone who\'d rather turn all of it off — it also respects your device\'s reduce-motion setting automatically.',
      'Tidied up the Tasks page header: the project switcher/title and the view/filter menu now sit on one line, long project names truncate (and auto-scroll briefly every few seconds if they don\'t fit) instead of overflowing, and on mobile the view, filter, and project actions now share a single "⋯" menu so there\'s room for everything.',
    ],
  },
  {
    version: '1.14.0',
    date: '2026-07-29',
    title: 'Typo-tolerant smart parsing, bigger mobile header',
    changes: [
      'Smart parsing in the task title field now catches near-miss typos of due date, recurrence, and duration keywords (e.g. "tommorow") and offers the correction as a suggestion — press Tab to cycle between options and Enter to accept, or tap it on mobile.',
      'The mobile top bar now always shows the "TaskFlow" name next to the logo, and the account avatar is a bit bigger and easier to tap.',
    ],
  },
  {
    version: '1.13.0',
    date: '2026-07-29',
    title: 'Combined view/filter menu, more settings synced across devices',
    changes: [
      'Replaced the List/Board/Gantt tab bar and the separate Active/Completed/All/No due date filter row with a single "View" dropdown in the top-right corner, next to the "⋯" project menu.',
      'Each view now remembers its own filter independently — switching from List to Board no longer resets or shares the filter you had set.',
      'Board and Gantt can now be filtered by Scheduled/No due date/Completed too, not just List.',
      'Pinned links and custom keyboard shortcut rebindings now sync across your signed-in devices and are included in backups, like your other settings.',
      'Your light/dark theme choice is now included in backups too — it already synced live across devices, but restoring a backup previously wouldn\'t bring it back.',
    ],
  },
  {
    version: '1.12.0',
    date: '2026-07-29',
    title: 'Real sound effects, reordered tabs, and project management moved to sidebar',
    changes: [
      'Replaced the synthesized "beep" sound effects with real, higher-quality click sounds for adding, completing, uncompleting, and deleting tasks.',
      'Added a volume slider in Settings → Appearance so you can adjust (or mute) sound effects independently of turning them off entirely.',
      'Sound settings now sync across your devices and are included in backups, just like your other preferences.',
      'Reordered the task filter tabs to All, Scheduled, No due date, Completed.',
      'The "Add project" button in the sidebar is now "Manage projects" — it opens the same projects list/search/rename/pin/delete view as before, plus adding new ones. Removed the separate "Manage projects" button from the Tasks page.',
      'The Gantt view now shows the project name/dropdown and the "⋯" project actions menu, matching List and Board — and its bars now scope to the selected project instead of always showing every task.',
    ],
  },
  {
    version: '1.11.0',
    date: '2026-07-29',
    title: 'Sound effects, settings search, and shortcut feedback',
    changes: [
      'Added satisfying sound effects for adding, completing, uncompleting, and deleting tasks, and for opening a task\'s details — short, soft "pop" sounds rather than a bell or chime. Toggle them off anytime in Settings → Appearance.',
      'Added a search bar at the top of Settings to jump straight to a section instead of scrolling.',
      'Keyboard shortcuts (undo, redo, new task) now show a brief confirmation toast when pressed, so you always get feedback even if nothing visibly changes.',
      'The "What\'s New" list in Settings → Versions now groups patch-level bugfix updates under the feature release they belong to, instead of listing every point release separately.',
      'Fixed the New task shortcut sometimes reopening "Add task" by itself when switching back to the Tasks tab.',
      'Changed the New task shortcut\'s default from Ctrl+N to Alt+N — Ctrl+N is reserved by the browser (it opened a new browser window alongside the dialog). Rebind it from Settings → Keyboard shortcuts if you\'d like something else.',
    ],
  },
  {
    version: '1.10.0',
    date: '2026-07-29',
    title: 'Keyboard shortcuts, timer-aware task completion, and smarter time/repeat fields',
    changes: [
      'Removed the desktop top bar (Undo/Redo buttons) in favor of keyboard shortcuts — Ctrl+Z / Ctrl+Shift+Z for undo/redo, Ctrl+N to add a task from anywhere. Settings → Keyboard shortcuts lists every shortcut, searchable and rebindable.',
      'Completing a task with a Pomodoro timer running or paused now stops it automatically. If a timer was tracking that task, you\'ll be asked to confirm (and can edit) the actual time spent, which is logged on the task and shown as a new "Time logged" stat on the Stats page.',
      'The Estimated time field now smart-parses what you type (like "1h 30m" or "20 min") instead of showing a raw decimal, highlighting the part it understood and showing a plain-English duration hint (e.g. "1 hour 30 minutes") underneath.',
      'A task repeating on specific days (e.g. "Every week on Sun, Mon, Sat") no longer shows a redundant count/unit row — click the text to edit it directly (with the same smart-parse highlighting as the Title field), or use the ✕ to stop repeating.',
      'Fixed short durations like "5 min" incorrectly rounding up to 15 minutes, and a bug where the word "test" (or other words containing "est") could get eaten into a duration match, corrupting the title.',
      'The mobile top bar now shows the TaskFlow logo and name; removed the redundant tutorial button there (replay the guided tour from Settings instead).',
      'Floating notifications (toasts, undo prompt, timer widget) now stack neatly bottom-right instead of overlapping at opposite corners.',
      'Fixed "All Tasks" sometimes instantly redirecting to a different project if Board view had ever gotten stuck as its remembered view — the Board option is now hidden while All Tasks is active, since Board needs a single project to show.',
      'Fixed a day-specific repeat (e.g. "every week on Sun, Sat") not being recognized when typed or edited directly — it now highlights and saves correctly instead of silently losing the selected days.',
      'The Estimated time field now shows the plain-English duration ("20 minutes") in place, instead of a duplicate line underneath, and swaps to the short editable form when you click in. Clearing the field now actually sets the estimate to 0 instead of snapping back to the old value.',
      'Undoing a change (via the bottom-corner Undo notification) now updates an already-open task edit screen immediately, instead of requiring you to close and reopen it to see the reverted value.',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-07-29',
    title: 'Version history & fewer Google sign-in prompts',
    changes: [
      'Added this "What\'s New" panel — see everything that changed in each update, searchable, from Settings → Versions.',
      "Google Calendar no longer prompts you to sign in on every single app open — your connection now stays active for its full session instead of re-authenticating on every load.",
    ],
  },
  {
    version: '1.8.0',
    date: '2026-07-29',
    title: 'Fixed editing of recurring Google Calendar events',
    changes: [
      'Recurring events synced from Google Calendar can now be edited, dragged, resized, and deleted — previously this silently failed for anything that repeats.',
      'Editing a recurring event now asks whether the change applies to "this event", "this and following", or "all events", matching Google Calendar\'s own behavior, and single-occurrence edits push back to Google correctly.',
      'Tasks can now optionally be pinned to a fixed time of day instead of letting the auto-scheduler pick a slot.',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-07-29',
    title: 'Dashboard widget customization',
    changes: [
      'Dashboard sections you don\'t use (e.g. Pinned Links) can now be hidden via a gear-icon popover, with the remaining widgets expanding to fill the freed space.',
      'This preference is saved per device, same as your calendar zoom and task view settings.',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-07-29',
    title: 'Paste screenshots directly into comments',
    changes: [
      'You can now paste a screenshot (e.g. Win+Shift+S) straight into a task\'s comment box with Ctrl+V, instead of saving it to disk first and picking the file.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-07-29',
    title: 'Sub-tasks, comments with attachments, and sync fixes',
    changes: [
      'Sub-tasks are now full tasks in their own right — they show up alongside regular tasks and support everything a normal task does.',
      'Added a Completed tasks tab, with the ability to restore a completed task and an automatic 30-day cleanup of old completions.',
      'Tasks now support a comment thread with file attachments (Firebase-backed), similar to Todoist.',
      'Fixed a sync bug where a stale change from one device could overwrite newer data already saved to the cloud from another device.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-07-28',
    title: 'Task list, dashboard, and task detail refinements',
    changes: [
      'Added a dedicated Labels/tags page.',
      'The dashboard now distinguishes overdue tasks from tasks merely scheduled for today.',
      'Fixed save/cancel behavior and sizing glitches in the task detail editor.',
      'Fixed scrolling issues in Board view.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-07-27',
    title: 'Calendar rebuild, backups, and live cross-device sync',
    changes: [
      'Rebuilt calendar event editing to match Google Calendar\'s own look and feel.',
      'Added backup/restore — both as a local file export/import and as automatic snapshots saved to the cloud.',
      'Signed-in changes now sync live across every device you use TaskFlow on, instead of only updating on next load.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-07-26',
    title: 'Dashboard, smarter task parsing, and multi-project support',
    changes: [
      'Added the Dashboard tab.',
      'Typing a task title now supports Todoist-style project/section mentions with live autocomplete.',
      'Todoist import is now a one-time pull rather than an ongoing sync.',
      'Added support for multiple projects, with sidebar shortcuts and filters.',
      'Polished Board view and mobile layout.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-25',
    title: 'TaskFlow launch',
    changes: [
      'Initial release: an auto-scheduling engine that turns tasks with due dates into a planned calendar.',
      'One-time Todoist import and two-way Google Calendar sync.',
      'Google sign-in for cross-device sync.',
      'Light/dark theme, a fully responsive mobile layout, and a guided first-run tour.',
    ],
  },
];

export const CURRENT_VERSION = CHANGELOG[0].version;

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
    version: '1.13.1',
    date: '2026-07-29',
    title: 'More settings now follow you across devices',
    changes: [
      'Pinned links and custom keyboard shortcut rebindings now sync across your signed-in devices and are included in backups, like your other settings.',
      'Your light/dark theme choice is now included in backups too — it already synced live across devices, but restoring a backup previously wouldn\'t bring it back.',
    ],
  },
  {
    version: '1.13.0',
    date: '2026-07-29',
    title: 'Combined view and filter into one menu',
    changes: [
      'Replaced the List/Board/Gantt tab bar and the separate Active/Completed/All/No due date filter row with a single "View" dropdown in the top-right corner, next to the "⋯" project menu.',
      'Each view now remembers its own filter independently — switching from List to Board no longer resets or shares the filter you had set.',
      'Board and Gantt can now be filtered by Scheduled/No due date/Completed too, not just List.',
    ],
  },
  {
    version: '1.12.3',
    date: '2026-07-29',
    title: 'Gantt view now has a project switcher',
    changes: [
      'The Gantt view now shows the project name/dropdown and the "⋯" project actions menu, matching List and Board — and its bars now scope to the selected project instead of always showing every task.',
    ],
  },
  {
    version: '1.12.2',
    date: '2026-07-29',
    title: 'Moved project management into the sidebar',
    changes: [
      'The "Add project" button in the sidebar is now "Manage projects" — it opens the same projects list/search/rename/pin/delete view as before, plus adding new ones.',
      'Removed the separate "Manage projects" button from the Tasks page; use the sidebar (or the project picker\'s "See / manage all projects" option) instead.',
    ],
  },
  {
    version: '1.12.1',
    date: '2026-07-29',
    title: 'Reordered task tabs',
    changes: [
      'Reordered the task filter tabs to All, Scheduled, No due date, Completed.',
    ],
  },
  {
    version: '1.12.0',
    date: '2026-07-29',
    title: 'Real sound effects and a volume control',
    changes: [
      'Replaced the synthesized "beep" sound effects with real, higher-quality click sounds for adding, completing, uncompleting, and deleting tasks.',
      'Added a volume slider in Settings → Appearance so you can adjust (or mute) sound effects independently of turning them off entirely.',
      'Sound settings now sync across your devices and are included in backups, just like your other preferences.',
    ],
  },
  {
    version: '1.11.1',
    date: '2026-07-29',
    title: 'Fixed the "new task" shortcut',
    changes: [
      'Fixed the New task shortcut sometimes reopening "Add task" by itself when switching back to the Tasks tab.',
      'Changed the New task shortcut\'s default from Ctrl+N to Alt+N — Ctrl+N is reserved by the browser (it opened a new browser window alongside the dialog). Rebind it from Settings → Keyboard shortcuts if you\'d like something else.',
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
    ],
  },
  {
    version: '1.10.1',
    date: '2026-07-29',
    title: 'Fixes for the repeat field, estimated time, and live undo',
    changes: [
      'Fixed a day-specific repeat (e.g. "every week on Sun, Sat") not being recognized when typed or edited directly — it now highlights and saves correctly instead of silently losing the selected days.',
      'The Estimated time field now shows the plain-English duration ("20 minutes") in place, instead of a duplicate line underneath, and swaps to the short editable form when you click in. Clearing the field now actually sets the estimate to 0 instead of snapping back to the old value.',
      'Undoing a change (via the bottom-corner Undo notification) now updates an already-open task edit screen immediately, instead of requiring you to close and reopen it to see the reverted value.',
    ],
  },
  {
    version: '1.10.0',
    date: '2026-07-29',
    title: 'Keyboard shortcuts, smarter time & repeat fields, and timer-aware completion',
    changes: [
      'Removed the desktop top bar (Undo/Redo buttons) in favor of keyboard shortcuts — Ctrl+Z / Ctrl+Shift+Z for undo/redo, Ctrl+N to add a task from anywhere. Settings → Keyboard shortcuts lists every shortcut, searchable and rebindable.',
      'Completing a task with a Pomodoro timer running or paused now stops it automatically. If a timer was tracking that task, you\'ll be asked to confirm (and can edit) the actual time spent, which is logged on the task and shown as a new "Time logged" stat on the Stats page.',
      'The Estimated time field now smart-parses what you type (like "1h 30m" or "20 min") instead of showing a raw decimal, highlighting the part it understood and showing a plain-English duration hint (e.g. "1 hour 30 minutes") underneath.',
      'A task repeating on specific days (e.g. "Every week on Sun, Mon, Sat") no longer shows a redundant count/unit row — click the text to edit it directly (with the same smart-parse highlighting as the Title field), or use the ✕ to stop repeating.',
      'Fixed short durations like "5 min" incorrectly rounding up to 15 minutes, and a bug where the word "test" (or other words containing "est") could get eaten into a duration match, corrupting the title.',
      'The mobile top bar now shows the TaskFlow logo and name; removed the redundant tutorial button there (replay the guided tour from Settings instead).',
      'Floating notifications (toasts, undo prompt, timer widget) now stack neatly bottom-right instead of overlapping at opposite corners.',
      'Fixed "All Tasks" sometimes instantly redirecting to a different project if Board view had ever gotten stuck as its remembered view — the Board option is now hidden while All Tasks is active, since Board needs a single project to show.',
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

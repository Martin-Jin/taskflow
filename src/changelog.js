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
 * a user-visible change. Versions are normal semver: the minor rolls into
 * the next major at 9, so 1.99.0 is followed by 2.0.0 — never 1.100.0.
 * (1.100.0/1.101.0 briefly shipped and were renumbered to 2.0.0/2.1.0;
 * `lastSeenChangelogVersion` is compared with `!==`, not ordered semver,
 * so renumbering only costs an extra "What's New" pop.) Written in plain English for end users, not a raw
 * commit log — group related commits into one entry if they shipped together
 * (e.g. same day) and skip anything with no user-visible effect.
 * ============================================================================
 */

export const CHANGELOG = [
  {
    version: '6.10.2',
    date: '2026-08-21',
    title: 'Fixed duplicate "Updated event" notifications',
    changes: [
      'Saving a calendar event edit (via the Save button, or pressing Enter in the title/location field) was silently saving it twice — visible as the "Updated event" toast popping up twice for a single edit. Now saves (and notifies) once.',
    ],
  },
  {
    version: '6.10.1',
    date: '2026-08-21',
    title: 'Quieter note-editor toolbar button',
    changes: [
      'The "⋯" note-actions button in the note editor lost its boxy background/border to match the other plain icon buttons next to it.',
    ],
  },
  {
    version: '6.10.0',
    date: '2026-08-21',
    title: 'Notes got a real editor',
    changes: [
      'Notes now open in a proper mini markdown editor — a toolbar for bold/italic/strikethrough, headings, bullet/numbered/checklist lists, links, and code, similar to a lightweight Obsidian. Click a note (or "Add note") to edit directly — no more separate hover-only Edit button.',
      'Editing an existing note now saves automatically as you type, the same way editing a task already does.',
      'A note\'s "⋯" menu now holds Delete, in place of a hover-only remove button.',
      'Note tiles are now smaller and show one clean preview line (markdown formatting stripped) instead of two lines of raw syntax.',
      'The notes search box is now fuzzy and typo-tolerant, matching every other search box in the app.',
      'Removed "Import bookmarks" — it was left over from before Notes existed and is no longer needed.',
    ],
  },
  {
    version: '6.9.1',
    date: '2026-08-21',
    title: 'Fixed clipped focus rings, added an "All Tasks" icon',
    changes: [
      'The keyboard-focus highlight no longer gets cut off at the edge of a scrolling list (most noticeable tabbing through the new all-projects panel) — it now draws just inside each item instead of outside it, everywhere in the app.',
      '"All Tasks" now has an icon next to it everywhere "Inbox" does, instead of standing out as the one option without one.',
      'The all-projects panel\'s collapse button lost its boxy background/border to match the other plain icon buttons nearby.',
    ],
  },
  {
    version: '6.9.0',
    date: '2026-08-21',
    title: 'A cleaner sidebar and a new all-projects panel',
    changes: [
      'The sidebar\'s "Projects" list is now labeled "Recent projects" and dropped its redundant "See all projects" link (the Projects tab is already one click away).',
      'The Tasks page has a new collapsible "all projects" panel with its own search — a persistent column on desktop, an overlay that closes itself after you pick on mobile. It replaces the old project dropdown in the page header.',
    ],
  },
  {
    version: '6.8.8',
    date: '2026-08-21',
    title: 'A calmer, clearer dashboard',
    changes: [
      '"Right now" is now the dashboard\'s clear focal point, with a subtle highlighted background and a larger heading.',
      "Today's and this week's progress now show as one compact strip instead of two large cards, so they read as a supporting stat rather than competing for attention.",
      'The greeting at the top of the dashboard is smaller, so it no longer outweighs the actual content below it.',
    ],
  },
  {
    version: '6.8.7',
    date: '2026-08-21',
    title: 'Click a field, replace it',
    changes: [
      'Clicking (or tabbing) into a text field now selects its whole current value, so you can immediately start typing to replace it instead of having to select it yourself first. Applies app-wide.',
    ],
  },
  {
    version: '6.8.6',
    date: '2026-08-21',
    title: 'Calendar event edits no longer get lost',
    changes: [
      "Editing an existing calendar event's title, location, description, or time now saves automatically when you close the popup — you no longer have to specifically click \"Save\" for the edit to stick (Cancel still discards, as before).",
      'Pressing Enter in the title or location field now saves and closes the popup immediately.',
    ],
  },
  {
    version: '6.8.5',
    date: '2026-08-21',
    title: 'Fixed faint bulk-action buttons',
    changes: [
      'The toolbar buttons that appear when selecting multiple tasks (set priority, due date, delete, etc.) were nearly invisible against the bar behind them, especially in dark mode — they now have a clearly visible background.',
    ],
  },
  {
    version: '6.8.4',
    date: '2026-08-21',
    title: 'Motion that means something',
    changes: [
      "Completing a task now shows the checkmark for a beat before the row slides away, instead of both happening at once.",
      "Switching between List/Board/Gantt now cross-fades in instead of snapping.",
      "Dragging a calendar block or board card now has a proper \"pick up\" and \"put down\" feel instead of snapping between states.",
    ],
  },
  {
    version: '6.8.3',
    date: '2026-08-21',
    title: 'Cleaner, calmer task rows',
    changes: [
      "Task rows no longer show a \"low\" priority badge or \"no due date\" text — those are the common/default case, not something worth calling out on every row.",
      "The sub-task count, repeat, unattended, and blocked-by-dependency icons now sit together in one small group next to the title, instead of being scattered inline.",
      "A task with a lot of labels now shows the first few plus a \"+N\" pill instead of spilling onto extra lines.",
    ],
  },
  {
    version: '6.8.2',
    date: '2026-08-21',
    title: 'Calendar blocks are easier to read at a glance',
    changes: [
      "Fixed-routine blocks (like sleep or commute time) now always show their label and time, instead of only revealing them on hover — which never worked on touch screens.",
      "A task that can run unattended no longer looks like a scheduler-ignored event or a folded group of tasks — it now just shows its own \"can run unattended\" icon.",
      "A read-only calendar event (from a subscribed or shared calendar you can't edit) is now marked with a small lock badge, instead of only being discoverable by trying to drag it and having nothing happen.",
    ],
  },
  {
    version: '6.8.1',
    date: '2026-08-21',
    title: 'More Settings layout fixes',
    changes: [
      "Settings description text now wraps at the full width of its container instead of stopping early and leaving empty space on the right.",
      'Increased the left/right padding on Settings sections, and made the spacing above each section\'s title consistent across all of them.',
    ],
  },
  {
    version: '6.8.0',
    date: '2026-08-21',
    title: 'Quieter, cleaner look across the app',
    changes: [
      'Removed a lot of unnecessary hairline borders and boxes-within-boxes throughout the app — task detail fields, dropdown menus, the sidebar, Settings, sub-menus, and more now separate from each other with spacing instead of lines.',
      'Dropdown menus, tooltips, and other floating panels now rely on their shadow alone rather than a border, for a cleaner floating look.',
    ],
  },
  {
    version: '6.7.2',
    date: '2026-08-21',
    title: 'Task detail fills the screen properly on mobile',
    changes: [
      "The task detail view no longer gets clipped to a fixed desktop width on small screens — it now fills the available width like the rest of the app's mobile layout.",
    ],
  },
  {
    version: '6.7.1',
    date: '2026-08-21',
    title: 'Settings layout fixes',
    changes: [
      'The Settings content area now fills the available width on desktop instead of stopping short and leaving empty space on the right.',
      'Removed "Install app" from the Settings section list on desktop, where it never did anything — it only ever applies on mobile, so it now only appears there.',
    ],
  },
  {
    version: '6.7.0',
    date: '2026-08-21',
    title: 'Consistent modal design across the app',
    changes: [
      'Every dialog in the app — Add Project, Manage Projects, Share Project, task/event/block details, AI Quick Add and its plan review, and more — now opens with the same consistent sizing, spacing, and animation instead of each having its own slightly different look.',
      'Fixed the Todoist and AI-key "connected" status badges (Settings → Integrations) showing the wrong shade of green in light mode.',
      'Cleaned up inconsistent priority/label pill and empty-state styling throughout the app.',
    ],
  },
  {
    version: '6.6.0',
    date: '2026-08-21',
    title: 'Redesigned Settings navigation',
    changes: [
      'Settings is now a two-pane layout on desktop/tablet, with a sticky section rail on the left that highlights whichever section you\'re currently scrolled to — no more scrolling past a dozen unrelated cards to find one setting.',
      'Cleaned up a lot of inconsistent spacing and one-off styling throughout Settings so every section now looks and behaves the same way.',
    ],
  },
  {
    version: '6.5.0',
    date: '2026-08-20',
    title: 'Search-based "Assign to" picker, now including guests',
    changes: [
      'A shared task\'s "Assign to" menu (three-dot menu) is now a type-to-search box with a live-filtered dropdown instead of a plain list — much easier to use once a shared project has more than a handful of collaborators.',
      'Anonymous (guest/share-link) collaborators can now be assigned tasks too, the same as signed-in collaborators.',
      'Typing "assign to <name>" or "for <name>" into a shared task\'s title now smart-parses it as an assignment, the same way "#project" or "after <task>" already work.',
    ],
  },
  {
    version: '6.4.3',
    date: '2026-08-20',
    title: 'Polish for a few rough UI edges',
    changes: [
      'The task detail project picker no longer shows a jarring, unstyled "Other" group label above the "Do Not Auto-Schedule" option — it now uses the app\'s own themed dropdown styling throughout.',
      'The "Select" (multi-select) button is now disabled when the current list view has no tasks to select.',
      'Cleaned up the Share dialog, which had accumulated too many competing button/section borders — secondary actions (copy, rotate, disable, delete, set/clear expiry) now use a lighter touch, and the link-expiry date field now matches the app\'s dark theme instead of rendering with unstyled browser-default chrome.',
    ],
  },
  {
    version: '6.4.2',
    date: '2026-08-20',
    title: 'Fix a broken guided-tour step and stale tour copy',
    changes: [
      'Fixed the guided tour\'s "AI Quick Add" step, which pointed at an element that only exists once the Add-task button\'s speed-dial is expanded — it now points at the always-visible Add-task button instead, so the tour no longer silently loses its spotlight on that step.',
      'Fixed the tour\'s last step claiming "Replay guided tour" lives in the Danger Zone card it was spotlighting — it actually lives under Settings → Help.',
    ],
  },
  {
    version: '6.4.1',
    date: '2026-08-20',
    title: 'Fix back-to-back calendar blocks sometimes merging into a chip',
    changes: [
      'Fixed a week/day calendar view bug where three or more back-to-back scheduled blocks or events (e.g. 9:00-10:00, 10:00-11:00, 11:00-12:00, with zero gap and zero overlap) could randomly render merged into a single "N tasks" chip instead of as separate boxes, even though each one had plenty of room to display on its own.',
    ],
  },
  {
    version: '6.4.0',
    date: '2026-08-20',
    title: 'Assign shared tasks to a collaborator for auto-scheduling',
    changes: [
      'A task in a shared project can now be assigned to a specific collaborator (three-dot menu → "Assign to"). Once assigned to you, that task is scheduled by your own auto-scheduler against your own capacity, the same as any personal task — previously, every shared task was skipped by Re-balance entirely and could only be placed manually.',
    ],
  },
  {
    version: '6.3.0',
    date: '2026-08-20',
    title: 'A "Do Not Auto-Schedule" bucket for parking tasks',
    changes: [
      'Added a new "Do Not Auto-Schedule" option in the project picker (when adding or editing a task, or bulk-moving several at once) — moving a task into it keeps that task out of Re-balance/Reschedule entirely, as a bulk alternative to toggling the per-task "Excluded from auto-schedule" setting one at a time. It doesn\'t appear in the sidebar as a real project, since it isn\'t one.',
    ],
  },
  {
    version: '6.2.1',
    date: '2026-08-20',
    title: 'Fixed cloud sync getting stuck in a permanent, self-inflicted update loop',
    changes: [
      "Fixed a serious cloud-sync bug where TaskFlow could get stuck continuously re-sending and re-applying the same data forever, with nothing actually changing. The cloud database doesn't always preserve the exact internal order of a task's nested details (like its repeat settings or subtasks) when handing data back — so even though nothing had truly changed, TaskFlow saw it as \"different\" every single time, sent it right back up, saw its own echo as \"different\" again, and repeated endlessly. Beyond wasting resources, this meant the sync connection was almost never actually idle, which could cause a genuine edit made around the same time to get overwritten by this stale, looping data before it had a chance to properly stick. TaskFlow now compares data based on its actual content, not the order its details happen to be listed in.",
    ],
  },
  {
    version: '6.2.0',
    date: '2026-08-20',
    title: 'Adding a project now opens its own dedicated dialog',
    changes: [
      '"Add project" (on the Projects page and in the "Manage projects" dialog) now opens a small dedicated dialog styled to match "Add task", instead of an inline form buried in the projects list — same look and feel across both add-task and add-project.',
    ],
  },
  {
    version: '6.1.0',
    date: '2026-08-20',
    title: 'The Projects page now has an "Add project" button',
    changes: [
      'Previously the Projects page only had a floating AI Quick Add button — there was no direct way to add a plain project from there. It now has the same speed-dial FAB as the Tasks page: tap it to expand into "Add project" and AI Quick Add.',
    ],
  },
  {
    version: '6.0.9',
    date: '2026-08-20',
    title: 'Fixed a new project sometimes vanishing after a cross-device sync',
    changes: [
      'A brand-new project (or a rename, delete, pin, or settings change) created right before a background cross-device sync landed could occasionally get silently reverted, since sync had no way to tell that edit had just happened. This is the same class of race already fixed for sharing/joining a project — it\'s now fixed structurally for every such field, so a future one added the same way is protected automatically.',
    ],
  },
  {
    version: '6.0.8',
    date: '2026-08-19',
    title: 'Fixed same-time Calendar events rendering illegibly crowded',
    changes: [
      'When 3 or more events genuinely overlapped in time in the Week view (e.g. two identically-timed classes bridged by other nearby events into one crowded moment), each got squeezed into its own side-by-side column — fine for 2, but a 3rd made every column too narrow to read, looking like a jumbled, merged mess. Now caps side-by-side columns at 2 and groups anything beyond that into a tappable "N events" chip instead, the same way an already-too-short event does.',
    ],
  },
  {
    version: '6.0.7',
    date: '2026-08-19',
    title: 'Fixed a stale "no duration specified" warning in Add Task',
    changes: [
      'The "you haven\'t specified a duration" note kept showing even after smart-parse detected one from the title (e.g. "...8 hours") and an "Est. Nh" chip was clearly applied — it was checking whether you\'d manually edited the field, not whether a duration was actually set. Also made this warning visually distinct from the "Smart parse:" reference line right below it, which used to look identical.',
    ],
  },
  {
    version: '6.0.6',
    date: '2026-08-19',
    title: 'Fixed shared-project presence bursting Firestore writes',
    changes: [
      'If you had several shared projects open, the every-30-seconds "I\'m still here" presence update fired one separate write per project at once, forever. Enough shared projects (or bad timing against other syncing) could exhaust Firestore\'s write queue and stall other pending syncs, like sharing/joining a project — that\'s the likely cause behind sharing occasionally getting stuck on "Setting up sharing…". Presence updates (and a guest\'s self-rename, which had the same issue) are now sent as a single batched write instead.',
    ],
  },
  {
    version: '6.0.5',
    date: '2026-08-19',
    title: 'Fixed the scheduler stranding a tiny sliver block',
    changes: [
      'Once a day\'s deep-work budget was nearly used up by another task, a later task could still get squeezed into whatever tiny bit of budget remained — a random few-minute block — even though the day\'s calendar still had a much bigger open gap sitting right after it. The scheduler now skips a day like that and waits for a day with real room, instead of stranding a sliver and fragmenting the task across several extra days.',
    ],
  },
  {
    version: '6.0.4',
    date: '2026-08-18',
    title: 'The task description box now actually grows as tall as the event one',
    changes: [
      'A task\'s description field used to start scrolling after just 3 lines, well before the matching field on Calendar events (20 lines) — the previous fix for this didn\'t fully take effect due to a CSS ordering issue. Both now genuinely grow to the same height before scrolling kicks in.',
    ],
  },
  {
    version: '6.0.2',
    date: '2026-08-18',
    title: 'Fixed "Free capacity (week)" overstating today\'s hours',
    changes: [
      'Stats\' "Free capacity (week)" figure used to count all 24 hours of today as available even after some of the day had already passed — checking it at 5pm still showed today\'s full work window as free. It now excludes hours already elapsed today, matching what the scheduler itself would actually be able to place.',
    ],
  },
  {
    version: '6.0.1',
    date: '2026-08-18',
    title: 'Fixed a stuck sharing dialog and a Sleep routine gap',
    changes: [
      'Fixed a bug where sharing or joining a shared project could, in a narrow timing window, get silently reverted by a background sync — leaving the project missing from your list, or its Share dialog stuck forever on "Setting up sharing…". The Share dialog also now shows a "Try again" option instead of spinning forever if this (or a slow connection) happens.',
      'The one-time backfill that added a protected "Sleep" routine only ever ran once per account, so anyone who ended up with none afterward (deleted it, or never had one counted at the time) had no way to get it back. Now checked on every load: if you have no routine named "Sleep", one is added back.',
    ],
  },
  {
    version: '6.0.0',
    date: '2026-08-18',
    title: 'The Ctrl+K command palette can now jump straight to Calendar events',
    changes: [
      'The search bar\'s Tasks page already gained an Events group recently — the Ctrl+K "jump to anything" palette now searches Calendar events too, so you can find and open one from anywhere in the app, not just the Tasks page.',
      'Fixed the search bar\'s "Clear search" (×) button sitting a couple pixels off from vertically centered.',
    ],
  },
  {
    version: '5.9.0',
    date: '2026-08-18',
    title: 'Drag a sub-task back out to unparent it, plus an "unsubtask" quick-add phrase',
    changes: [
      'Dragging a sub-task onto another task already made it a sub-task of that task — now dragging it back out onto empty space in the list clears the link instead, the same way the existing "Remove from parent task" button does.',
      'Typing "unsubtask" into a task\'s title (quick-add or the task detail view) now removes its parent, mirroring the existing "sub of <task>" phrase that sets one.',
    ],
  },
  {
    version: '5.8.1',
    date: '2026-08-18',
    title: 'Fixed a first-time visit showing an empty Calendar, plus a stale-filter glitch',
    changes: [
      "A first-ever visit (or after signing out) used to show a completely empty Calendar tab, even though the Tasks page's own demo data always showed a handful of sample tasks — a leftover gap from when the Calendar's own demo events were never actually wired up. A fresh visit now shows a few sample calendar events too, alongside the existing sample tasks.",
      'Also fixed: changing the Calendar filter (e.g. switching to "Tasks only") could leave a stale event or task showing on the day before/after the one you were viewing until you swiped to it and back.',
    ],
  },
  {
    version: '5.8.0',
    date: '2026-08-18',
    title: 'Search now finds Calendar events too',
    changes: [
      'The Tasks page\'s search bar now has an "Events" section alongside Tasks, Projects, and Tags — type part of a calendar event\'s title, description, or location and it\'ll show up. Clicking one jumps straight to that day on the Calendar and opens the event.',
    ],
  },
  {
    version: '5.7.3',
    date: '2026-08-18',
    title: 'Moved the List/Board "Select" button up next to the view switcher',
    changes: [
      'The "Select" button on the Tasks page (List/Board) now sits inline with the view switcher and "⋯" menu at the top, instead of its own row below the search bar, and has no background until you hover or turn selection on.',
    ],
  },
  {
    version: '5.7.2',
    date: '2026-08-18',
    title: 'Cleaned up the multi-select "Select" button and bulk-edit bar',
    changes: [
      'The "Select" button (List, Board, and Calendar toolbars) is now an icon-only button with no border, so it sits more quietly among the other toolbar controls. The bulk-edit bar that appears along the bottom once you\'ve selected something also lost the border around each of its buttons.',
    ],
  },
  {
    version: '5.7.1',
    date: '2026-08-18',
    title: 'Fixed a busy day\'s "+N more" spilling into the next row in Month view',
    changes: [
      'On a busy day with more tasks/events than Month view had room to list, the "+N more" chip (and sometimes the tasks above it) could visually spill down into the next week\'s row instead of staying inside its own day\'s box. Each day now stays contained to its own cell no matter how packed it is, with the "+N more" indicator always visible.',
    ],
  },
  {
    version: '5.7.0',
    date: '2026-08-18',
    title: 'Select multiple tasks/cards/calendar items and edit them together',
    changes: [
      'List, Board, and Calendar (and a task\'s own sub-task list) now have a "Select" button that lets you tap/click several tasks, cards, or calendar events at once, then bulk-edit whatever field they share (due date, project, tags, priority, complete/incomplete) or delete them all together — deleting asks for confirmation first.',
      'On mobile, a long-press on a task/card also enters selection mode and selects that first item (Calendar\'s week/day view keeps its existing long-press-to-drag gesture, so there Select is reachable via the toolbar button instead).',
      'Selecting a mix of scheduled tasks and standalone calendar events only offers the fields that make sense for both — e.g. project and tags are hidden once a standalone event is part of the selection, since events don\'t have those.',
    ],
  },
  {
    version: '5.6.2',
    date: '2026-08-17',
    title: 'Fixed edits sometimes not reaching another device unless you switched back to make it stick',
    changes: [
      "Fixed a bug where an edit (rescheduling a task, checking something off, etc.) could fail to reach your other signed-in devices if you switched away from the tab shortly after making it — the change would only actually sync once you switched back. TaskFlow batches edits for a moment before sending them to the cloud, and browsers can pause a background tab's activity almost immediately after you switch away, cutting that batch off before it ever gets sent. That batching window is now much shorter, so an edit is far more likely to already be on its way to the cloud before you've had a chance to switch tabs.",
    ],
  },
  {
    version: '5.6.1',
    date: '2026-08-17',
    title: 'Fixed leftover scheduled-task entries lingering on Google Calendar',
    changes: [
      'Task blocks pushed to Google Calendar for a given day could get stuck there permanently if the app wasn\'t open to clean them up right at midnight (e.g. closed overnight) — since the cleanup only ever looked at the current day, yesterday\'s pushed entries were never revisited. It now also sweeps up a few days of stale entries on every push, so leftovers from a missed day get cleaned up instead of lingering forever.',
      'The description box in a calendar event\'s detail view (e.g. a synced Google Calendar event) used to scroll after only about 3 lines. It now grows up to about 20 lines before scrolling kicks in, so a longer synced description (class details, meeting notes, etc.) is visible without extra scrolling.',
    ],
  },
  {
    version: '5.5.7',
    date: '2026-08-17',
    title: 'Fixed the Board view "Add section" button size',
    changes: [
      'The "Add" button in the Board view\'s add-section form was stretched much wider than the "Cancel" button next to it. Both now size to their content, matching.',
    ],
  },
  {
    version: '5.5.6',
    date: '2026-08-17',
    title: 'Fixed calendar boxes losing their time label next to a close neighbor',
    changes: [
      'A calendar block or event tall enough to comfortably show its time range (e.g. "08:00-08:50") was hiding it anyway whenever a neighboring item started or ended close by in time — even with plenty of empty space left in the box. It now only hides the time label when the box itself is actually short enough to need the room.',
    ],
  },
  {
    version: '5.5.5',
    date: '2026-08-17',
    title: 'Fixed sync errors and edits needing a second try to stick',
    changes: [
      'Cloud backup cleanup was deleting old backups one at a time in a burst instead of in batches, which could exhaust Firestore\'s write queue on accounts with a lot of backups piled up — surfacing as "resource-exhausted" sync errors and other edits (like renaming a Board section) silently failing on the first try and only sticking on a retry. Backup cleanup is now batched so it can no longer crowd out other pending writes.',
    ],
  },
  {
    version: '5.5.4',
    date: '2026-08-16',
    title: 'Calendar cluster chips now show more titles on taller chips',
    changes: [
      'A calendar cluster chip (the "N more" style chip standing in for several small events/tasks squeezed together) now stacks each item\'s title on its own line, and shows as many titles as fit the chip\'s actual height instead of always cramming everything onto one truncated line — with a "+N more" line for anything that still doesn\'t fit.',
    ],
  },
  {
    version: '5.5.3',
    date: '2026-08-16',
    title: 'Fixed the timer widget growing off-screen with multiple timers running',
    changes: [
      'The floating timer widget could grow past the bottom of the screen once a second (or later) timer started, hiding its controls — it now repositions itself to stay fully on-screen whenever it changes size.',
    ],
  },
  {
    version: '5.5.2',
    date: '2026-08-16',
    title: 'Fixed a race that could revert a just-dragged scheduled task, needing a retry to stick',
    changes: [
      "Fixed a timing bug where dragging a scheduled task to a new day/time could sometimes visibly snap into place and then immediately revert back to its old position, needing a second (or third) attempt before it actually stuck. A piece of internal bookkeeping cloud sync uses to detect \"did a local edit just happen while I was waiting on the network\" was only updating after React had already moved on to the next step, instead of immediately — during that gap, a cloud sync response arriving from the network could look like it was safe to apply, wrongly overwrite the drag you'd just made, and get reverted a moment later. Most noticeable while signed in with cloud sync active, since more background activity there made the gap more likely to be hit.",
    ],
  },
  {
    version: '5.5.1',
    date: '2026-08-16',
    title: "Fixed today's Google Calendar sync sometimes getting permanently stuck at an old time",
    changes: [
      "Fixed a bug where rescheduling a task scheduled for today (dragging its block to a new time, editing it, or a re-balance moving it) could leave its Google Calendar entry stuck at its OLD time indefinitely, with no error shown. This happened once the app's short-lived Google access token silently expired mid-session (which happens roughly hourly) — the sync would keep quietly failing against the same dead token on every future change and every background check, forever, instead of noticing and reconnecting. It now detects an expired connection immediately and prompts you to reconnect, the same way every other Google Calendar sync path in the app already does.",
    ],
  },
  {
    version: '5.5.0',
    date: '2026-08-16',
    title: 'AI Quick Add is now available everywhere, with a new context-scope picker and smarter defaults',
    changes: [
      'AI Quick Add now has an entry point on every tab, not just Tasks/Board: a new mini-FAB next to "New event" in Calendar, and a standalone floating button on Dashboard, Projects, Stats, and Settings.',
      'AI Quick Add\'s panel has a new context-scope picker: choose "Full context" (as before), "No context" (nothing about your existing workspace is sent — the AI can still create new tasks/events/projects), or "Custom" (restrict to one project and/or a calendar event date range). Useful for a smaller/cheaper request or to keep the AI focused on one part of your workspace. Your last choice is remembered on that device.',
      'AI Quick Add now picks a more realistic time estimate for tasks it creates when you don\'t state one yourself, instead of defaulting to a near-zero placeholder — and it will suggest grouping a batch of related new tasks into board sections (e.g. "Venue", "Food", "Invitations" for a party) when that makes organizational sense.',
      'Applying an AI Quick Add plan that creates a new project now takes you straight to it, instead of leaving you on whatever tab you started from wondering if it worked.',
    ],
  },
  {
    version: '5.4.0',
    date: '2026-08-16',
    title: "Today's scheduled tasks now show up on Google Calendar",
    changes: [
      "Tasks scheduled for today now appear on your Google Calendar automatically, alongside your regular calendar events — no button to click. Google Calendar always mirrors what TaskFlow currently has scheduled for today: complete a task and its entry disappears, rebalance or edit your schedule and it updates to match. Only today's tasks are synced this way; anything scheduled for another day stays in TaskFlow only, exactly as before. This sync is one-way (TaskFlow to Google) — Google Calendar is never the source of truth for these and editing one there directly won't change anything in TaskFlow.",
      "This is a different (and more careful) design than an earlier version of this feature that was removed a few versions back for creating duplicate and missing calendar entries. Rather than trying to track each task's Google Calendar entry individually across schedule changes, TaskFlow now simply replaces the full set each time something changes, which avoids that whole class of bug.",
    ],
  },
  {
    version: '5.3.3',
    date: '2026-08-16',
    title: 'Cross-device sync no longer waits for the other device to reopen',
    changes: [
      'Switching to a device that\'s been sitting in the background for a while now pulls your latest tasks and settings as soon as you return to it, instead of showing stale data until the OTHER device happened to be reopened. The live sync connection can go stale after a long time in the background; TaskFlow now also re-checks with the cloud whenever the app becomes visible or focused again, the same way Google Calendar sync already did.',
      'The "Google Calendar disconnected" notification now has a Reconnect button right on it, so you can restore the connection with one click instead of having to go find the button in Settings yourself.',
    ],
  },
  {
    version: '5.3.2',
    date: '2026-08-15',
    title: 'Fixed cloud backups failing after a Google Calendar sync',
    changes: [
      'Fixed "Failed to create cloud backup" errors that could follow a Google Calendar push or edit. Google\'s API sometimes leaves out a timestamp TaskFlow expected on its reply, which was slipping through as an invalid value the cloud database flatly rejects. Downloading a backup to a file was unaffected — only the cloud-backup path was hit.',
    ],
  },
  {
    version: '5.3.1',
    date: '2026-08-15',
    title: 'Restored calendar events re-sync on their own, and less cloud traffic',
    changes: [
      'Calendar events restored from a backup now upload themselves back to Google Calendar automatically, within a minute. Previously they only went up if you happened to open and edit each one by hand: the background sync worked out that an event needed re-uploading, but the step that actually uploads it was still looking at the event as it stood a moment earlier, so it skipped it every time — for as long as the app stayed open.',
      'Fixed the knock-on effects of that. A restored event stuck in that state made TaskFlow re-check and re-save your schedule every minute, which is what was behind occasional "failed to create cloud backup" errors and re-balances that seemed to need a second click to stick.',
      'Clicking "Re-balance schedule" now reliably wins over any automatic re-balance queued in the background, instead of the two both running and the later one quietly replacing your result.',
      'Manually pushing your data to the cloud now waits for any automatic save already underway rather than running alongside it, so the two can no longer collide.',
    ],
  },
  {
    version: '5.3.0',
    date: '2026-08-15',
    title: 'Scheduled tasks stay in TaskFlow instead of being pushed to Google Calendar',
    changes: [
      'TaskFlow no longer copies your scheduled task blocks onto Google Calendar. Keeping them in step there was the source of a long run of duplicate and missing calendar entries: because a block\'s identity is tied to exactly when it sits, every re-balance that nudged a task could make TaskFlow lose track of which Google entry belonged to which block, leaving a stray copy behind and creating a fresh one alongside it. Your scheduled tasks are still fully visible in TaskFlow\'s own calendar and week views — they just no longer show up on your Google Calendar.',
      'Calendar events are unaffected and sync exactly as before, in both directions: events you create in TaskFlow are still uploaded, events from Google still appear here, and edits, moves and deletions still travel both ways. "Rewrite Google Calendar to match TaskFlow" now rewrites only your calendar events, and events restored from a backup are still re-uploaded to Google as needed.',
      'Task blocks that were already pushed to Google by an earlier version are left on your calendar untouched — TaskFlow will not delete them, so you can remove any you no longer want yourself. They will not reappear in TaskFlow as duplicate events.',
    ],
  },
  {
    version: '5.2.4',
    date: '2026-08-15',
    title: 'Fixed an intermittent crash when rescheduling',
    changes: [
      'Fixed an intermittent crash when re-balancing your schedule that sometimes meant clicking "Re-balance" more than once for it to actually go through. The schedule itself was usually still updated, but the crash cut the action short before the summary toast and the "couldn\'t be fully scheduled" details appeared, making it look like nothing had happened. It was most likely to strike when a reschedule was triggered automatically — for example just after editing a due date, or right after restoring a backup.',
    ],
  },
  {
    version: '5.2.3',
    date: '2026-08-15',
    title: 'Restored calendar events no longer vanish, and past events are left alone',
    changes: [
      'Fixed calendar events disappearing from TaskFlow after restoring a backup and syncing. If you had cleared or reconnected your Google Calendar since the backup was taken, the restored events pointed at calendar entries that no longer existed — so the next sync assumed you had deleted them and quietly removed them from TaskFlow too. Events that only exist in TaskFlow are now uploaded to Google Calendar instead of being deleted. Events you genuinely delete in Google Calendar are still removed from TaskFlow as before.',
      'TaskFlow no longer changes anything on your Google Calendar for days that have already passed. Previously, past events and finished task blocks could still be uploaded, rewritten or removed on Google — including by "Rewrite Google Calendar to match TaskFlow" — even though TaskFlow is forward-looking and does not schedule into the past. Your calendar history is now left exactly as it is, and only today onwards is kept in sync.',
    ],
  },
  {
    version: '5.2.2',
    date: '2026-08-15',
    title: 'Fixed Google Calendar events duplicating after rescheduling',
    changes: [
      'Fixed duplicate calendar events appearing after a re-balance moved a recurring task around — overlapping copies of the same block at the same time slot. When several of a task\'s blocks moved at once, TaskFlow could mix up which existing Google event belonged to which block, dragging one event onto the wrong day and creating a fresh duplicate for the one it lost track of. Each moved block now reliably updates its own event instead.',
      'Fixed TaskFlow\'s own scheduled blocks being pulled back in from Google Calendar as separate, redundant calendar entries a minute after being pushed. Those shadow copies stacked on top of the blocks they came from and could later be re-uploaded as real duplicates. Existing ones are cleaned up automatically on the next sync.',
    ],
  },
  {
    version: '5.2.1',
    date: '2026-08-15',
    title: 'Fixed "Restore & overwrite Google Calendar" refusing to run',
    changes: [
      'Fixed "Restore & overwrite Google Calendar" repeatedly refusing to run with "Already syncing — try again in a moment", with no way to proceed. It now takes over immediately instead of waiting on a routine background sync to finish — safe to do, since the rewrite is about to replace everything on your primary calendar anyway.',
    ],
  },
  {
    version: '5.2.0',
    date: '2026-08-15',
    title: 'Google Calendar duplicate events fixed at the source, and much faster rewrites',
    changes: [
      'Fixed the real cause of Google Calendar events duplicating over time. Every task block TaskFlow sends to Google was being read back on the next sync as if it were a separate calendar event, so the app ended up tracking the same thing twice — and then created a second copy of it on Google. This is why duplicates kept multiplying during normal use, and why they reappeared even while "Restore & overwrite Google Calendar" was running. Blocks are now tagged as TaskFlow\'s own, so they are never re-created as separate events.',
      '"Restore & overwrite Google Calendar" now clears your primary calendar for the affected dates and rebuilds it from scratch, rather than trying to work out which existing events to keep. That matching step was what let duplicates slip through. Please note: this means any event you created directly in Google Calendar (rather than in TaskFlow) on your primary calendar within those dates will also be removed by this action. Your other calendars — subscribed, shared, or work calendars — are never touched.',
      'Rewrites are dramatically faster. Changes are now sent to Google in batches of up to 50 instead of one at a time, turning a job that could take several minutes into one that usually takes seconds. The progress bar now moves in larger steps as each batch completes.',
      'Moving, rescheduling or deleting a scheduled task now updates Google Calendar properly during everyday use. Previously a task block was only ever sent to Google once, when it was first scheduled — dragging it to a new time, editing it, letting a re-balance move it, or deleting it all changed things only inside TaskFlow, leaving the old event sitting on Google Calendar at the original time. That is why stale and duplicate events built up between clean-ups. TaskFlow now moves the existing event instead of creating a second one, and removes events whose task is no longer scheduled.',
      'Calendar events you create or edit are now retried automatically if they fail to reach Google Calendar. Previously only scheduled task blocks were retried, so an event that failed to sync once (for example while offline) would stay missing from Google Calendar indefinitely.',
      'Scheduling now always produces the same result for the same set of tasks, instead of potentially shifting a block depending on how busy your device was at the time. A shifted block used to look brand new to Google Calendar sync, which could leave the old event behind and create another copy.',
      'Fixed an error that could interrupt cloud sync ("write stream exhausted") when several changes happened in quick succession, such as during a restore. Updates to the cloud are now sent one at a time instead of all at once.',
    ],
  },
  {
    version: '5.1.2',
    date: '2026-08-15',
    title: 'Full-screen progress overlay while rewriting Google Calendar',
    changes: [
      '"Restore & overwrite Google Calendar" now shows a full-screen progress overlay for its whole duration instead of just changing the button\'s label — it blocks the rest of the app until the rewrite finishes, making it clear you shouldn\'t navigate away or make other changes while Google Calendar events are actively being deleted/recreated.',
    ],
  },
  {
    version: '5.1.1',
    date: '2026-08-15',
    title: 'Fixed duplicate events surviving "Restore & overwrite Google Calendar"',
    changes: [
      'Fixed a bug where "Restore & overwrite Google Calendar" could leave duplicate copies of a recurring event (e.g. a repeating "Piano" event) on Google Calendar instead of cleaning them up — an earlier duplicate-event bug had left two local copies of the same event, each pointing at a different real Google event, so the rewrite treated both as legitimate and kept both instead of collapsing to one.',
    ],
  },
  {
    version: '5.1.0',
    date: '2026-08-15',
    title: 'Combined "Restore & overwrite Google Calendar" action',
    changes: [
      'Restoring a backup and making Google Calendar match it are now one single action ("Restore & overwrite Google Calendar", in Backups) instead of a restore followed by a separate follow-up prompt — closing a real gap where Google\'s background sync could silently undo a restore before you got the chance to click the follow-up.',
      'The standalone "Rewrite Google Calendar to match TaskFlow" button (previously under Integrations) has moved into the Backups section as part of this combined action; the plain "Restore" and "Restore from file" buttons are unchanged and still only touch local TaskFlow data.',
      "Fixed a related bug where a rewrite running at the same time as Google's background sync could fight over the same data — background syncing now pauses for the whole restore-and-overwrite sequence and resumes once it's done.",
    ],
  },
  {
    version: '5.0.3',
    date: '2026-08-14',
    title: 'Progress indicator for "Rewrite Google Calendar"',
    changes: [
      '"Rewrite Google Calendar to match TaskFlow" (Settings → Integrations) now shows live progress ("Rewriting… (42/500)") instead of a static "Rewriting…" label — with a large backlog of events to reconcile (e.g. after the duplicate-event bug some users hit), the button could look stuck for minutes even though it was steadily working through the list.',
    ],
  },
  {
    version: '5.0.2',
    date: '2026-08-14',
    title: 'Fixed: confirmation popups no longer rely on your browser',
    changes: [
      "Every \"Are you sure?\" confirmation (deleting a project/label/section, clearing all data, restoring a backup, disconnecting an integration, and more) now uses TaskFlow's own popup instead of the browser's native confirm dialog.",
      'Some browsers (seen in the wild: Firefox, under certain settings) silently block the native dialog entirely — no popup, no error, nothing — which made every one of those buttons look like it was doing nothing. The in-app popup can\'t be silently blocked this way.',
      'The "copy share link" fallback (used when your browser blocks clipboard access) also no longer relies on a native popup — it now shows the link directly in a toast notification instead.',
    ],
  },
  {
    version: '5.0.1',
    date: '2026-08-14',
    title: 'Fixed demo tasks reappearing after signing back in',
    changes: [
      "Signing out and back in could leave the sample demo tasks (\"Finish Q3 investor deck\" and friends) mixed in alongside your real synced tasks — sign-out was re-seeding the sample data on reload, and your real tasks getting pulled back in couldn't tell those apart from genuinely new tasks. Signing out now leaves a clean, empty slate instead, so a subsequent sign-in only shows your real data.",
    ],
  },
  {
    version: '5.0.0',
    date: '2026-08-14',
    title: 'New: rewrite Google Calendar to match TaskFlow',
    changes: [
      'Added a new, explicit action in Settings → Integrations, "Rewrite Google Calendar to match TaskFlow", for when your Google Calendar has drifted out of sync (e.g. after restoring an old backup) — it flips the normal sync direction and makes TaskFlow authoritative, deleting/updating events on your primary Google Calendar to match your current tasks, scheduled blocks, and calendar events.',
      "Safety: it only ever touches your own PRIMARY Google Calendar — any calendar you've merely subscribed to or been shared (e.g. a shared team calendar or a university timetable) is never modified, and it never wipes a wider date range than your own data actually spans.",
      'Restoring a backup (local file or cloud) now offers this as a separate, optional one-click follow-up afterward — restoring itself still only ever touches local TaskFlow data, exactly as before.',
      'Requires a clear confirmation before running, since — unlike other TaskFlow actions — it can delete real events on an external service that TaskFlow cannot undo.',
    ],
  },
  {
    version: '4.9.1',
    date: '2026-08-14',
    title: 'Fixed a second source of duplicate Google Calendar events, and cluster labels showing "Untitled"',
    changes: [
      "Completing a task (including a routine/recurring one) could still re-sync OTHER tasks' calendar blocks as if they were brand new, creating duplicate Google Calendar events over time — a second instance of the same bug fixed in 4.8.2, in a different code path (the same-day re-plan that runs after completing a task). If you're still seeing duplicated recurring events building up, this should stop new ones; existing duplicates still need manual cleanup in Google Calendar.",
      'Fixed the overlapping-events cluster chip (see 4.9.0) showing "Untitled" for every scheduled task inside it instead of the task\'s real title.',
    ],
  },
  {
    version: '4.9.0',
    date: '2026-08-14',
    title: 'Overlapping calendar events now get their own columns',
    changes: [
      "Week/Day view used to merge overlapping or short events into one combined \"N tasks/events\" chip. Every event now gets its own side-by-side column sized to its true duration, matching Google Calendar's layout — short events render as genuinely thin boxes instead of being puffed up to a fake minimum height.",
      "Grouping into a single chip still happens, but only once there's truly not enough room to show events individually — and that chip's label now lists the actual event/task titles it contains (e.g. \"Standup, Review, …\") instead of a generic \"3 events\" summary.",
    ],
  },
  {
    version: '4.8.2',
    date: '2026-08-14',
    title: 'Auto-scheduled tasks now sync to Google Calendar',
    changes: [
      "Tasks scheduled automatically (by Re-balance, including ones created through AI quick-add) or scheduled manually onto the calendar weren't reaching Google Calendar until you clicked \"Push to Google Calendar\" in Settings. They're now pushed automatically in the background.",
      "This replaces an earlier attempt at the same fix that had to be reverted — it was creating duplicate Google Calendar events on every schedule recalculation. If you saw duplicated recurring events (Piano, routine lectures, etc.) on your calendar, those are safe to delete manually in Google Calendar; new duplicates won't be created going forward.",
    ],
  },
  {
    version: '4.8.1',
    date: '2026-08-14',
    title: 'Fixed duplicate Google Calendar events',
    changes: [
      "Reverted the previous update's auto-push of scheduled tasks to Google Calendar — it was creating duplicate calendar events every time the schedule recalculated. Investigating a correct fix.",
    ],
  },
  {
    version: '4.8.0',
    date: '2026-08-14',
    title: 'Warning when Google Calendar stays disconnected',
    changes: [
      "If Google Calendar can't sync for an extended stretch (network issue, revoked access, etc.), you'll now get a notification prompting you to check your connection or reconnect in Settings — previously this only showed as a small badge in Settings that was easy to miss.",
    ],
  },
  {
    version: '4.7.0',
    date: '2026-08-14',
    title: 'Completed tasks free up their calendar slot',
    changes: [
      "Completed tasks no longer show a greyed-out block on the calendar — that slot is now completely free, and the scheduler treats it as open capacity for other work instead of still holding it as busy.",
      'If auto-reschedule is on (Settings → Scheduling rules), finishing a task early now immediately re-plans into the time it just freed up; with auto-reschedule off, that capacity stays available for the next manual "Re-balance".',
    ],
  },
  {
    version: '4.6.0',
    date: '2026-08-13',
    title: 'New "Inbox" for tasks with no project',
    changes: [
      'Added a permanent "Inbox" view (sidebar, Tasks project picker, Command Palette, and the Projects page) that shows every task with no project assigned — the same tasks that already land there when you delete a project.',
    ],
  },
  {
    version: '4.5.0',
    date: '2026-08-12',
    title: 'New "Scheduled" section in the Tasks list',
    changes: [
      "The Tasks list now shows a \"Scheduled\" section between Today and Upcoming, for tasks that have a calendar block placed today but aren't actually due today (e.g. a task due next week that you've scheduled time for today).",
      "Fixed a recurring task you'd already completed for today still showing up in that new Scheduled section.",
    ],
  },
  {
    version: '4.4.6',
    date: '2026-08-12',
    title: 'Cross-device sync no longer loses newer edits',
    changes: [
      "Fixed a real data-loss bug: a device that had been offline (e.g. your phone left open for a while) could overwrite a newer edit made on another device, purely because its sync happened to reach the cloud last. Tasks now merge per-task instead of one device's whole list winning outright — whichever device edited a given task most recently wins, for that task, so unrelated changes on both devices are kept.",
      'Deleting a task is now tracked more carefully behind the scenes so a delete on one device can no longer be silently undone by an older, unsynced edit arriving later from another device.',
    ],
  },
  {
    version: '4.4.5',
    date: '2026-08-12',
    title: 'Task editing reliability fixes',
    changes: [
      'Fixed removing a task from its parent sometimes silently reverting a moment later if a sidebar edit (e.g. priority) was made right before it — the task now reliably stays top-level.',
      'Fixed editing a due date (or other fields) on a recurring or deadline-linked task sometimes triggering several rapid, repeated saves in a row instead of one.',
    ],
  },
  {
    version: '4.4.4',
    date: '2026-08-12',
    title: 'Overdue recurring task double-scheduling fix',
    changes: [
      'Fixed a bug where moving an overdue recurring task\'s due date forward (e.g. onto today) could schedule it twice for the same day — once from its normal recurring pattern and once from the temporary catch-up adjustment, producing two separate time slots instead of one.',
    ],
  },
  {
    version: '4.4.3',
    date: '2026-08-12',
    title: 'Sync reliability fixes',
    changes: [
      'Fixed a cross-device sync bug where an edit made right before closing the app (e.g. on your phone) could fail to reach the cloud in time and then be silently forgotten — it now reliably retries on your next app open instead of only on your next edit.',
      'Fixed Google Calendar silently showing as connected (using placeholder events) instead of prompting you to reconnect when your Google access had actually been revoked and the periodic background sync could not recover on its own.',
    ],
  },
  {
    version: '4.4.2',
    date: '2026-08-11',
    title: 'Move-to picker text and "%section" highlight fixes',
    changes: [
      'Actually fixed the "move to" task picker\'s squished/overlapping result text — the previous 4.4.1 attempt addressed the wrong cause, letting the flex list layout keep shrinking each row below the height its text needed.',
      'A resolved "%section" mention in the title now gets the same highlight as other smart-parse detections ("#project", due dates, etc.) instead of showing no highlight at all despite correctly resolving.',
    ],
  },
  {
    version: '4.4.1',
    date: '2026-08-11',
    title: 'Smart-parse and "move to" picker fixes',
    changes: [
      '"%section" now also gets a live suggestion dropdown while you type, matching how "#project" and "@label" already behave — no more needing to finish typing and tap the resolved chip to see other matches.',
      'Fixed "%section" continuing to swallow the rest of the title after a match instead of stopping at the next space, which broke typing further words.',
      'Fixed squished, overlapping text in the "move to" task picker\'s search results list.',
      'Removed a stray border around the "move to" button next to a task\'s breadcrumb.',
    ],
  },
  {
    version: '4.4.0',
    date: '2026-08-11',
    title: 'Move tasks in and out of sub-task relationships',
    changes: [
      'A task can now be reparented after creation, four ways: "Remove from parent task" in its "..." menu, a new "move to" search picker next to its breadcrumb, dragging its card/row onto another task in Board or List view (works on mobile too, via a long press), or typing "sub of <task title>" / "subtask of <task title>" into its title.',
      'Added a shorter "%section" smart-parse shortcut for assigning a section without spelling out its project — if more than one project has a matching section, tap the suggestion to pick which one you meant.',
      'The "#project"/"@label" autocomplete while typing a title now uses Tab to cycle through suggestions (Enter still applies the highlighted one), instead of Tab immediately applying the first result.',
    ],
  },
  {
    version: '4.3.0',
    date: '2026-08-11',
    title: 'Timer widget fixes: live countdown, overtime, and a new "Mark as done"',
    changes: [
      'The floating timer widget now visibly counts down every second again, instead of only updating when you interacted with it.',
      'A timer that reaches zero no longer freezes at "Time\'s up" — it keeps counting into overtime (shown in red with a "+"), so you can see exactly how far over you\'ve gone.',
      'Stopping a timer now logs the time you worked (including any overtime) against the task\'s "Time left", instead of discarding it.',
      'Added a "Mark as done" button to the timer widget and the task detail timer controls, completing the task with the timer\'s elapsed time in one tap.',
      'The timer widget is now its own draggable floating window — drag it by its header to move it anywhere on screen, and its position is remembered on this device.',
    ],
  },
  {
    version: '4.2.0',
    date: '2026-08-11',
    title: 'Missing-info hint when adding a task',
    changes: [
      "The Add Task screen now shows a small note if you haven't set a project, due date, or duration once you start filling in a task — a gentle reminder, not a blocker.",
    ],
  },
  {
    version: '4.1.1',
    date: '2026-08-11',
    title: 'AI Quick Add can now attach links to tasks',
    changes: [
      'AI Quick Add can now set a task\'s link directly (e.g. an assignment page, submission portal, or doc URL) — previously it could only mention a URL in notes, so it never turned the task title into a clickable link the way typing a URL manually does.',
    ],
  },
  {
    version: '4.1.0',
    date: '2026-08-11',
    title: 'Faster editing for text fields',
    changes: [
      'Clicking into an editable field (task title, estimated time, project/section names, notes, and more) now selects its existing text so you can start typing right away.',
      'Pressing Enter in most editable fields now saves and exits the field, without needing to click away first.',
    ],
  },
  {
    version: '4.0.0',
    date: '2026-08-11',
    title: 'Track time left on a task as you work',
    changes: [
      'Added a "Time left" field to the task detail view, next to Estimated time — update it as you make progress and the scheduler will plan the rest of your day around what actually remains, instead of the original estimate.',
      'For repeating tasks, updating "Time left" only affects that occurrence — the next one starts fresh at the full estimate.',
      'The task timer moved from a button in the task details to a clock icon in the top-right corner of the task, next to the menu button — tap it to start, pause, resume, or stop the timer.',
      'Pausing the timer now offers to log the time you just worked as progress, pre-filled and editable, reducing "Time left" with one tap.',
    ],
  },
  {
    version: '3.9.1',
    date: '2026-08-11',
    title: 'Fix stale devices overwriting newer synced data',
    changes: [
      'Fixed a bug where a device that had been asleep or offline for a while (e.g. a phone waking up) could sync its outdated data and silently overwrite newer changes made on another device in the meantime. Cross-device sync now checks which data is actually newer before applying it.',
    ],
  },
  {
    version: '3.9.0',
    date: '2026-08-11',
    title: 'Calendar events now recover from network hiccups and cold starts',
    changes: [
      'Google Calendar events no longer go missing after a cold computer start or a brief network problem — TaskFlow now retries a failed refresh a few times instead of quietly giving up until the next background check.',
      'If nothing can be fetched from Google and you have no events showing, TaskFlow falls back to your latest cloud backup to fill them in — previously that only happened when Google Calendar was fully disconnected.',
      'Settings now shows a "Hasn\'t synced recently" note when Google Calendar is still connected but its background refreshes are failing, along with when it last succeeded — separate from the more urgent "disconnected, please reconnect" warning.',
      'If your devices disagree about whether Google Calendar is connected (e.g. one device is fine but another has lost its connection), TaskFlow now warns you and automatically retries the sync on the affected device instead of leaving it silently out of date.',
      'Opening the app now shows a brief "Connecting to Google Calendar…" notification while it reconnects in the background, so it is clear a sync is in progress instead of nothing appearing to happen.',
    ],
  },
  {
    version: '3.8.1',
    date: '2026-08-11',
    title: 'Fix completed recurring sub-tasks showing as uncompleted',
    changes: [
      'Opening a recurring sub-task after completing today\'s occurrence (from the parent task\'s Sub-tasks list) now correctly shows it checked off and offers "uncomplete" — it no longer looked incomplete and let you complete it again.',
    ],
  },
  {
    version: '3.8.0',
    date: '2026-08-10',
    title: 'Exclude a task from auto-scheduling',
    changes: [
      'Tasks now have an "Exclude from auto-schedule" toggle (in the task\'s "..." menu, or when adding a new task) — Re-balance schedule will skip it entirely, though you can still drag it onto the calendar yourself.',
      'Smart parse recognizes "!noauto" and "!manual" typed into a task title as shorthand for the same thing.',
    ],
  },
  {
    version: '3.7.0',
    date: '2026-08-10',
    title: 'Smart parse now understands "not before <date>"',
    changes: [
      'Typing phrases like "not before Friday", "don\'t start until tomorrow", or "can\'t start before March 3" into a task title now sets that task\'s earliest schedulable date automatically, the same way other smart-parse shorthand already works for due dates and priorities.',
    ],
  },
  {
    version: '3.6.1',
    date: '2026-08-10',
    title: 'Cleaned up the dashboard customize button',
    changes: [
      'The "adjust" button for customizing dashboard widgets no longer has a border or background, so it blends in better with the widgets below it.',
    ],
  },
  {
    version: '3.6.0',
    date: '2026-08-10',
    title: 'Rescheduling a recurring parent task now moves its recurring sub-tasks with it',
    changes: [
      "Manually changing a recurring parent task's due date now shifts each recurring sub-task's displayed due date to match, for that occurrence only — their own recurrence pattern is untouched, and the shift naturally clears itself once a sub-task is next completed and rolls forward on its own schedule.",
    ],
  },
  {
    version: '3.5.5',
    date: '2026-08-10',
    title: 'Fixed a recurring task jumping an extra week when completed after an off-pattern date move',
    changes: [
      'Completing a weekday-specific recurring task (e.g. "every Tue, Wed") right after manually moving its current occurrence to an off-pattern day now advances to the next matching day correctly. Previously it ignored the move and rolled forward from the old date instead, landing a full week later than expected.',
    ],
  },
  {
    version: '3.5.4',
    date: '2026-08-10',
    title: 'Fixed a recurring sub-task quietly reverting an enforced due date',
    changes: [
      "A recurring sub-task under a parent with \"enforce due date\" turned on could silently drift back to its old schedule after completing or rescheding it — the parent's date change wasn't fully applied to the sub-task's own recurrence, so it would snap back on the next check-off. It now re-anchors properly and stays in sync with the parent.",
    ],
  },
  {
    version: '3.5.3',
    date: '2026-08-10',
    title: 'Finishing a task early no longer leaves a stale block on the calendar',
    changes: [
      "Completing a task before a future scheduled block for it comes up now clears that block instead of leaving it sitting on the agenda/calendar styled as completed — that time slot never happened, so it's freed up (and re-balanced into other work) rather than kept around.",
    ],
  },
  {
    version: '3.5.2',
    date: '2026-08-09',
    title: 'Recurring sub-tasks no longer jump out of Today the moment you check them off',
    changes: [
      "Completing one recurring sub-task (e.g. a step in a daily routine) now marks it done for today without advancing its own due date — it stays visible and checked off in Today until every sibling is done too. Previously it immediately rolled forward to its next occurrence, making it vanish from Today's list while the rest of the group was still outstanding.",
      'Once the whole group is done (every sub-task completed, or the parent task completed directly), the parent and every recurring sub-task now advance to the next occurrence together, in lockstep.',
    ],
  },
  {
    version: '3.5.1',
    date: '2026-08-09',
    title: 'A task waiting on a dependency now still gets scheduled',
    changes: [
      "A task with an incomplete dependency is no longer left off the calendar entirely — it's now scheduled right alongside its dependency, just placed to start after the dependency's own scheduled time ends. Previously it wouldn't get a slot at all until the dependency was checked off, and showed a \"waiting to be completed first\" warning even when there was plenty of room to plan both.",
    ],
  },
  {
    version: '3.5.0',
    date: '2026-08-09',
    title: 'Schedule an existing task straight from a calendar slot',
    changes: [
      'Clicking an empty calendar slot to add something now offers an Event / Task toggle. Task mode lists the tasks due that day and drops the picked one straight onto the slot you clicked, instead of only being able to create a new calendar event there.',
    ],
  },
  {
    version: '3.4.4',
    date: '2026-08-09',
    title: 'Email notifications restricted to the intended recipient',
    changes: [
      "Email notifications only ever go to one fixed address (see Settings → Notifications), so the toggle is now only available on the account that address belongs to — other accounts see it disabled with an explanation instead of a toggle that silently did nothing for them.",
      'Cleaned up several stale/orphaned guest accounts whose leftover "email notifications on" setting was causing emails to keep arriving even after turning the toggle off on the current account.',
    ],
  },
  {
    version: '3.4.3',
    date: '2026-08-09',
    title: 'AI Quick Add now breaks down assignment documents',
    changes: [
      'Uploading (or asking to turn into tasks) an assignment brief, syllabus, or project spec now gets split into a parent task plus one sub-task per distinct deliverable (e.g. proposal, draft, final submission), with due dates, ordering, and any links/instructions from the document carried over — instead of one flat task.',
      'Fixed the Gemini provider ignoring the actual contents of an attached PDF/screenshot and proposing a vague placeholder task instead of reading the document — it could run out of response budget partway through "thinking" about a large attachment and return a truncated, garbage answer without any error being shown.',
    ],
  },
  {
    version: '3.4.2',
    date: '2026-08-09',
    title: 'Calendar toolbar polish',
    changes: [
      'The calendar filter button and the mobile Google Calendar refresh button now read as plain icon controls (no border/fill) instead of boxed buttons, matching the other toolbar icons.',
    ],
  },
  {
    version: '3.4.1',
    date: '2026-08-09',
    title: '"Apply to all sub-tasks" button fixes',
    changes: [
      'The "Apply to all sub-tasks" button no longer appears just because you edited the parent task\'s name or description (which was never actually applied to sub-tasks) — it now only shows up when you\'ve changed something that will actually cascade, like priority, due date, project/section, labels, or the passive flag.',
      'After clicking it, the button now disappears immediately instead of staying enabled with nothing new to apply — it reappears the next time you make another applicable change.',
    ],
  },
  {
    version: '3.4.0',
    date: '2026-08-09',
    title: 'AI Quick Add now accepts multiple screenshots and PDFs',
    changes: [
      'You can now attach up to 5 images and/or PDFs to a single AI Quick Add request (previously limited to one screenshot) — drag, paste, or pick multiple files at once, and remove individual attachments before submitting.',
    ],
  },
  {
    version: '3.3.9',
    date: '2026-08-09',
    title: "Fixed sub-task due dates not following a parent's \"enforce due date\" changes",
    changes: [
      'When a parent task with "enforce due date" enabled had its due date changed, sub-tasks that had inherited that date from the parent no longer updated to match — they now keep following the parent unless you\'ve given a sub-task its own due date directly.',
    ],
  },
  {
    version: '3.3.8',
    date: '2026-08-09',
    title: "Fixed the calendar's mobile Today/filter buttons drifting apart",
    changes: [
      'On mobile, the Today button and the filter icon in the calendar toolbar could end up with an inconsistent gap between them depending on whether the refresh icon was also showing — they now stay snugly grouped together at the right edge in every combination.',
    ],
  },
  {
    version: '3.3.7',
    date: '2026-08-09',
    title: 'Existing Sleep routines are now protected from accidental deletion too',
    changes: [
      'New accounts already got a "Sleep" routine that could be edited but not deleted, so the scheduler never loses track of when you sleep — but anyone who had already set up their own Sleep routine before that protection existed could still delete it by accident. Any routine labeled exactly "Sleep" is now protected the same way, whenever you already had one.',
    ],
  },
  {
    version: '3.3.6',
    date: '2026-08-08',
    title: 'Fixed a smart-parsed "@tag" label silently disappearing after saving a task',
    changes: [
      'Adding a label to an existing task by typing "@label" into its title (rather than picking one via the Labels field) could get created correctly but then silently drop off the task moments later, without any indication anything went wrong.',
      "Calendar's date-jump dropdown: picking a different month or day could fail to register the click on some page layouts, with no visible cause — the dropdown now reliably receives every click, even where the calendar grid behind it used to intercept them.",
    ],
  },
  {
    version: '3.3.5',
    date: '2026-08-07',
    title: 'Fixed deleting a shared project sometimes leaving it behind on the server',
    changes: [
      "Deleting a shared project you own could look like it fully worked (it disappeared from your list) while quietly failing to delete it on the server — most likely right after a fresh page load. A second delete attempt on the same project would then look necessary, since the leftover server copy could resurface. Deleting now reliably removes the server copy too.",
    ],
  },
  {
    version: '3.3.4',
    date: '2026-08-07',
    title: 'Fixed stale and incorrect presence avatars in shared projects',
    changes: [
      'Closing a tab could leave your avatar showing as "still viewing" a shared project for far longer than it should — presence now clears reliably when a tab closes, not just after it eventually ages out.',
      'If a guest renamed themselves, other viewers kept seeing their old name (or generic initials) in the presence avatars instead of the new one — the avatar now always reflects your current chosen name.',
    ],
  },
  {
    version: '3.3.3',
    date: '2026-08-07',
    title: 'Fixed a personal task\'s Project dropdown letting you pick a shared project by mistake',
    changes: [
      'A task\'s Project dropdown could list shared projects alongside your own, but picking one didn\'t actually move the task into that shared project — it just left the task in a broken, half-updated state. Shared projects no longer appear as an option there for a personal task.',
    ],
  },
  {
    version: '3.3.2',
    date: '2026-08-07',
    title: 'Fixed a false "no permission" error on the first attempt to delete a shared project',
    changes: [
      'Deleting a shared project you own sometimes showed a misleading "you don\'t have permission" error on the first try, even though the delete had actually gone through — a second attempt always "worked" because there was nothing left to delete. It now completes cleanly on the first try.',
    ],
  },
  {
    version: '3.3.1',
    date: '2026-08-07',
    title: 'Fixed Google Calendar sometimes showing disconnected after fully closing and reopening the browser',
    changes: [
      "Google Calendar could wrongly show as disconnected after fully closing and reopening the browser (not just refreshing the page), because a single flaky first reconnect attempt on a cold start was treated the same as a real disconnect. It now retries once before giving up, and only shows disconnected when Google actually confirms the connection is gone.",
    ],
  },
  {
    version: '3.3.0',
    date: '2026-08-07',
    title: "Using TaskFlow without signing in now remembers your name as a guest",
    changes: [
      "Every signed-out visitor is now a guest with one consistent identity, whether you just opened TaskFlow directly or joined it through a shared project's link — not two separate things.",
      "Fixed: a guest's chosen name used to live only on the shared projects they'd joined, so it was lost if they were ever removed from all of them (or asked for again if they joined a second link in the same browser). Your name is now remembered on this device independent of any project, and editable anytime from Settings.",
    ],
  },
  {
    version: '3.2.1',
    date: '2026-08-07',
    title: 'Editing more task settings now reschedules the task',
    changes: [
      "Changing a scheduled task's \"Lock to a day\" date, hard-deadline toggle, dependencies, priority, unattended flag, fixed time, or repeat pattern now reschedules it automatically, instead of only affecting future scheduling runs.",
      'Unlocking a previously locked task now schedules it right away instead of waiting for the next manual re-balance.',
    ],
  },
  {
    version: '3.2.0',
    date: '2026-08-07',
    title: '"Enforce due date" now applies to sub-tasks automatically',
    changes: [
      'If a task must be done on its due date, every one of its sub-tasks now inherits that same requirement automatically — the same way repeating tasks already keep their sub-tasks in sync.',
      'A sub-task whose "must be done on due date" setting is inherited this way shows a note explaining where it came from, and its checkbox is locked to match the parent.',
      'The "Apply to all sub-tasks" button no longer copies this setting manually — it now stays in sync on its own, just like repeat settings already did.',
    ],
  },
  {
    version: '3.1.1',
    date: '2026-08-07',
    title: 'Fixed shared-project tasks briefly disappearing after auto-scheduling',
    changes: [
      "Running the auto-scheduler/rebalance as a signed-in user no longer temporarily wipes out tasks from your shared projects — they used to vanish until a collaborator's own change synced back.",
    ],
  },
  {
    version: '3.1.0',
    date: '2026-08-07',
    title: 'Sleep is now a protected, non-deletable routine',
    changes: [
      'The Sleep fixed routine can no longer be accidentally deleted from Settings — you can still drag it to change its hours or pause it, but the delete button is gone for it.',
      'If your data predates this change and you have no fixed routines at all, a protected Sleep routine is added back automatically; if you already have any routine (Sleep or otherwise), nothing changes.',
    ],
  },
  {
    version: '3.0.17',
    date: '2026-08-07',
    title: 'Fixed a stale shared project lingering in your sidebar after losing access to it',
    changes: [
      "If a shared project's owner removes you as a collaborator, or deletes the project entirely, it now disappears from your project list right away instead of sticking around as a dead, unusable entry.",
    ],
  },
  {
    version: '3.0.16',
    date: '2026-08-07',
    title: 'Fixed Board view subtask counts briefly undercounting for recurring subtasks',
    changes: [
      'A card\'s "x/y subtasks done" tally on Board view no longer briefly undercounts a recurring subtask for a few days after it rolls forward to its next occurrence.',
    ],
  },
  {
    version: '3.0.15',
    date: '2026-08-07',
    title: 'Fixed remaining time not updating when a duration change came from the AI Assistant',
    changes: [
      'A task\'s "time left" now stays correct after the AI Assistant changes its estimated duration, instead of keeping the old value until you also edited it manually.',
    ],
  },
  {
    version: '3.0.14',
    date: '2026-08-07',
    title: 'AI Assistant better recognizes "lock this to a day" requests',
    changes: [
      'Asking the AI Assistant to lock a task to a specific day (e.g. "lock this to the 10th", "don\'t start before Monday") is now recognized directly, instead of sometimes being ignored or confused with "must be done on due date".',
      'The exam/test/lab due-date rule no longer misfires on ordinary tasks that just mention "lab" or "test" in their title or course section (e.g. a lab report) — it now only applies to an actual scheduled exam/test/lab session.',
    ],
  },
  {
    version: '3.0.13',
    date: '2026-08-07',
    title: 'AI Assistant now catches a contradictory "enforce due date" before it reaches the confirm screen',
    changes: [
      'An AI-proposed task change that would turn on "must be done on due date" without an actual due date is now flagged as an error on the confirm screen instead of silently going through and doing nothing.',
    ],
  },
  {
    version: '3.0.12',
    date: '2026-08-07',
    title: 'Fixed the "Enforce due date" checkbox briefly showing checked and disabled at once',
    changes: [
      'The "Must be done on due date" checkbox in a task\'s details no longer shows checked while also disabled with a "Set a due date first" hint — it now stays unchecked until a due date is actually set.',
    ],
  },
  {
    version: '3.0.11',
    date: '2026-08-07',
    title: 'Fixed a rescheduled recurring task showing its old due date in the Tasks list',
    changes: [
      "Moving a recurring task's occurrence onto a different day now correctly updates its due date and Overdue/Today/Upcoming section in the Tasks list, instead of leaving it showing the old date.",
    ],
  },
  {
    version: '3.0.10',
    date: '2026-08-07',
    title: 'Completing a task early now reschedules the rest of your plan',
    changes: [
      "Marking a task done well before its scheduled day now re-plans the whole schedule to fill the capacity that frees up, not just the rest of today.",
      "Fixed deleting a shared project after transferring its ownership sometimes failing with a permission error.",
    ],
  },
  {
    version: '3.0.9',
    date: '2026-08-07',
    title: 'Fixed the "Share project" dialog briefly showing the wrong state',
    changes: [
      'The share dialog no longer flashes "This project isn\'t shared" right after actually sharing it — it now shows a loading state instead while the sharing setup finishes.',
    ],
  },
  {
    version: '3.0.8',
    date: '2026-08-07',
    title: 'Completing a task early now clears its future calendar slot',
    changes: [
      "Marking a task done before its scheduled day arrives now removes that future block from the Calendar, since the work was never actually done on that day. Completed tasks otherwise keep showing on their scheduled day as before, as a record of what you finished and when.",
    ],
  },
  {
    version: '3.0.7',
    date: '2026-08-07',
    title: 'Fixed a recurring task showing as completed in Upcoming',
    changes: [
      'A recurring task whose most recent occurrence had already been completed could show up in the "Upcoming" list looking done — struck-through title, filled checkmark — even though its next occurrence hadn\'t happened yet. It now always shows in its normal, not-completed state until that occurrence is actually finished.',
    ],
  },
  {
    version: '3.0.6',
    date: '2026-08-07',
    title: 'One home for "Manage projects"',
    changes: [
      'Removed the sidebar\'s "Manage projects" button — the Projects page\'s "⋯" menu (which only ever offered this one action) is now a plain "Manage projects" button instead, so there\'s a single, clearer place to reach it.',
    ],
  },
  {
    version: '3.0.5',
    date: '2026-08-07',
    title: 'Fixed a stale due date after moving a recurring task off its usual days',
    changes: [
      "Moving a recurring task's due date onto a day outside its usual repeat pattern (e.g. moving a \"Sun/Mon/Wed/Fri\" task to a Thursday) now shows the new date immediately in the task detail popup and its \"Scheduled\" time, instead of appearing to snap back to the old date.",
    ],
  },
  {
    version: '3.0.4',
    date: '2026-08-07',
    title: 'Projects page polish: search, manage-projects menu, and cleanup',
    changes: [
      'Searching on the Projects page now narrows the Recent/Shared/My projects columns to matching projects too, not just the quick-jump dropdown.',
      'Project hours are now rounded to the nearest whole hour on the Projects page, instead of showing long decimals.',
      'Moved the "manage all projects" shortcut into the "⋯" menu (on both the Projects page and the Tasks page) instead of a separate icon button.',
      'The "Add"/"Cancel" buttons when adding a new project are no longer stretched full-width.',
    ],
  },
  {
    version: '3.0.3',
    date: '2026-08-07',
    title: 'Fixed: tasks and Board columns added to a shared project never reached collaborators',
    changes: [
      "A task or Board column created in a shared project now actually appears for everyone you've shared it with — previously it stayed visible only to whoever created it, even though it had synced correctly behind the scenes.",
    ],
  },
  {
    version: '3.0.2',
    date: '2026-08-07',
    title: 'AI Assistant edits on shared projects respect viewer permissions',
    changes: [
      "The AI Assistant can no longer edit or delete tasks in a shared project you can only view — it now refuses immediately with a clear message, instead of appearing to apply the change and then silently reverting it a moment later.",
    ],
  },
  {
    version: '3.0.1',
    date: '2026-08-07',
    title: 'Fixed the mobile Calendar view menu',
    changes: [
      "Fixed the Calendar page's mobile view-switcher menu (the hamburger icon) sometimes rendering misaligned or needing multiple taps to open or close.",
    ],
  },
  {
    version: '3.0.0',
    date: '2026-08-07',
    title: 'Right now / Next card is now clickable',
    changes: [
      'Clicking the "Right now" or "Next" item on the Dashboard now opens that task\'s or event\'s detail popup, matching how the Today\'s agenda list already worked.',
    ],
  },
  {
    version: '2.9.0',
    date: '2026-08-07',
    title: 'AI Assistant now fills in duration and priority automatically',
    changes: [
      "The AI Assistant now always sets a duration and priority when creating or updating tasks, making a reasonable assumption when you don't state one instead of leaving it blank.",
      "Exams, tests, and labs are now assumed to happen only on their due date (not just by it), with a 9am–12pm time block by default when you don't specify one.",
      "The AI Assistant can now set a task's \"not before\" date when your request or context makes clear it genuinely can't be started yet (e.g. an assignment that unlocks on a specific day), so the scheduler won't plan work on it earlier than that.",
    ],
  },
  {
    version: '2.8.0',
    date: '2026-08-07',
    title: 'A dedicated Projects page',
    changes: [
      'New "Projects" tab: a directory view with a greeting, a fast project search, and three columns — Recent, Shared, and My projects (sortable by size, duration, or creation date).',
      "The sidebar's project list is now a short recent-projects strip with a link to the full Projects page, instead of a long scrollable list with its own search box.",
    ],
  },
  {
    version: '2.7.3',
    date: '2026-08-07',
    title: 'Fixed the Escape key going dead after skipping the tour',
    changes: [
      "Fixed: on a brand-new visit, skipping the guided tour could silently break the Escape key for closing any dialog, menu, or search dropdown for the rest of that session.",
    ],
  },
  {
    version: '2.7.2',
    date: '2026-08-07',
    title: 'Collaboration fixes: lost comments, undo, and link roles',
    changes: [
      'Fixed: if two people commented on the same shared task at almost the same moment, one of the comments was silently lost. Both are now kept, and a comment you delete stays deleted.',
      'Fixed: Undo and Redo appeared to do nothing if you were a member of a shared project — the button worked but your change stayed on screen.',
      "Fixed: re-opening an old view-only link could silently demote you from editor to view-only on a project you'd been given edit access to. Your existing access is now always kept, and a link can only ever raise it.",
      'Opening your own project\'s share link now just opens the project, instead of adding you to your own collaborator list.',
      'Fixed: a display name containing brackets could hijack an @-mention, attributing it to the wrong person and garbling the message.',
      "View-only collaborators no longer see editable checkboxes, date and priority fields, or draggable board cards on a project they can't change — previously those edits appeared to work and then quietly reverted. If a change is refused, you now get told instead of it silently disappearing.",
    ],
  },
  {
    version: '2.7.1',
    date: '2026-08-06',
    title: 'Fixes for adding tasks, joining, and viewer permissions',
    changes: [
      'Fixed: a task added to a shared project appeared and then vanished a moment later, for everyone including the project owner. It saved correctly — it was being wrongly treated as deleted before it finished syncing.',
      'Fixed: opening a share link failed on the first attempt and only worked after reloading the page.',
      "View-only collaborators are no longer offered an \"add task\" button in a project they can't write to — previously the task appeared briefly and then disappeared.",
      'Fixed: adding a project could take two attempts, for the same reason deleting one did.',
      'Fixed: someone who closed their tab stayed listed as viewing a shared project indefinitely, instead of dropping off after a minute or so.',
    ],
  },
  {
    version: '2.7.0',
    date: '2026-08-06',
    title: 'Guests can rename themselves, and keep their projects when signing in',
    changes: [
      "If you joined a shared project via a link without an account, you can now change the name you picked, from Settings — it updates everywhere your collaborators see you. Comments you already posted keep the name you wrote them under.",
      'Fixed: signing in with Google after joining as a guest used to lose you access to the projects you\'d joined. Your membership now carries over to your account.',
      "TaskFlow no longer describes a guest session as \"signed in\", and no longer offers cloud sync or backups there — neither works without a real account, and the old wording implied your data was being kept when it only lived in that browser.",
    ],
  },
  {
    version: '2.6.1',
    date: '2026-08-06',
    title: 'Fix edits undoing themselves, and tasks not reaching collaborators',
    changes: [
      'Fixed: deleting a project could bring it straight back, and sharing a project could do nothing, until you did it a second time. An edit made while an earlier change was still saving could be overwritten by that earlier save landing late. This affected all your data, not just shared projects.',
      "Fixed: a task added to a project you'd already shared never reached your collaborators — it stayed on your own device. Tasks added from anywhere (quick add, the task form, AI plans, imports) now sync properly.",
    ],
  },
  {
    version: '2.6.0',
    date: '2026-08-06',
    title: 'Share links now work, and Board columns sync live',
    changes: [
      "Fixed: opening a share link never worked — joining a project always failed with a permission error, on both view and edit links. Links you've already sent out will now work; there's no need to create new ones.",
      "Board view columns (sections) on a shared project now sync live across everyone in it, the same way tasks already did — add, rename, or delete a column and every collaborator sees it immediately, and tasks land in the right column for everyone instead of just for you.",
      "View-only collaborators can look at a shared project's board but can no longer add, rename, or delete its columns.",
    ],
  },
  {
    version: '2.5.1',
    date: '2026-08-06',
    title: 'Attachments temporarily unavailable on shared project tasks',
    changes: [
      "File attachments on a shared project's task comments were never actually working — uploads would silently fail. The attach-file button is now hidden there with a short explanation, so it's clear upfront rather than failing after you pick a file. Text comments on shared tasks are unaffected, and attachments on your own personal tasks work exactly as before.",
    ],
  },
  {
    version: '2.5.0',
    date: '2026-08-06',
    title: 'Comment threads on shared tasks now show who said what',
    changes: [
      "Comments on a shared project's tasks now show each person's name and photo, instead of showing your own avatar on every comment in the thread.",
      'Type "@" in a comment to mention a collaborator by name — it inserts a stable reference that keeps pointing at the right person even if they change their display name later.',
      'Only the person who wrote a comment (or the project owner) can delete it. Comments on your own personal, non-shared tasks work exactly as before.',
      'View-only collaborators see a note that commenting needs edit access, rather than a comment box that would never post.',
      "The project owner's name and photo now show in the collaborator list and @-mention suggestions even when the owner isn't currently online.",
    ],
  },
  {
    version: '2.4.2',
    date: '2026-08-06',
    title: 'Fixes for shared projects',
    changes: [
      'Fixed: once a project was shared, the menu showed a dead "Shared project" label instead of a way back into the share settings — so links couldn\'t be rotated or revoked, and collaborator roles couldn\'t be changed. This hit mobile hardest, where that menu is the only route to those actions.',
      'Fixed: when two people completed different occurrences of the same recurring task, the next due date could land on a day already completed instead of moving forward.',
      'Shared projects now hold back rapid edits for a moment before saving, matching how your personal data already syncs.',
      'Fixed: the share-link box zoomed the page in when tapped on iPhone.',
      'The guided tour now mentions project sharing.',
    ],
  },
  {
    version: '2.4.1',
    date: '2026-08-06',
    title: 'Fix recurring task due dates reverting instantly',
    changes: [
      'Fixed: manually changing the due date of a monthly, yearly, or plain-weekly recurring task snapped it back to the old date right away instead of saving the new one.',
    ],
  },
  {
    version: '2.4.0',
    date: '2026-08-06',
    title: 'Invite people to a shared project by link',
    changes: [
      'Shared projects can now be shared with other people, not just across your own devices. "Share project" opens a dialog with two separate links: a view-only link for people who should just follow along, and an edit link for people who should be able to change things.',
      'Anyone can open a link and join — no account needed. They\'re asked once for a display name, and the project lands in their own project list, so nobody has to keep the link or dig it out of a chat later.',
      'You stay in control of a link after sending it: rotate it to invalidate the old URL, switch it off and back on, delete it outright, or give it an expiry date.',
      'The share dialog lists everyone who has joined. You can switch someone between viewer and editor, remove them, or hand the whole project over to another collaborator.',
      'Projects now show which way they\'re shared — nothing for your private ones, "shared by you" with who\'s in it for ones you own, and "shared with you" with the owner\'s name and your role for ones you joined. Knowing the direction matters more than just knowing it\'s shared.',
      'Fixed: turning a project into a shared project could empty it of tasks in some cases.',
      'Fixed: "Back up now" reported a failure even when the backup had actually saved.',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-08-06',
    title: 'Shared projects, syncing live across your devices',
    changes: [
      'You can now turn a project into a shared project from its "⋯" menu (on mobile, from the view/filter button). Its tasks move to the cloud and sync live, so a change made on your phone shows up on your laptop within moments without a refresh.',
      'Small avatars show who else is currently looking at a shared project.',
      'Sharing is opt-in per project — everything else stays private to you exactly as before, and nothing is moved unless you choose to share it.',
      'Shared projects aren\'t auto-scheduled, since the scheduler plans around one person\'s working hours and calendar. You can still drag a shared task onto your own calendar yourself.',
      'Undo now leaves shared projects alone, so pressing Ctrl+Z can never quietly reverse a change someone else made.',
      'Inviting other people by link is still to come — for now sharing a project keeps it in sync across your own devices.',
    ],
  },
  {
    version: '2.2.1',
    date: '2026-08-06',
    title: 'Small Tasks page and Calendar filter tweaks',
    changes: [
      '"See / manage all projects" moved out of the project-picker dropdown into its own button next to the project name on the Tasks page (folded into the existing "⋯" menu on mobile, where there\'s no room for a separate button).',
      'The Calendar filter menu\'s project search box now matches the size of the rest of the menu\'s text instead of looking oversized, while still avoiding iOS Safari\'s zoom-on-focus on touch devices.',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-08-06',
    title: 'Project search is typo-tolerant and relevance-ranked everywhere',
    changes: [
      'Every place you search for a project by name — the sidebar, the "Manage projects" list, the main search bar, "#project" mentions while typing a task title, the command palette (Ctrl/Cmd+K), and the Calendar filter menu\'s Projects list — now uses the same typo-tolerant, relevance-ranked search: prefix and substring matches come first, then close matches, then fuzzy (typo-tolerant) ones. Previously each did a plain "contains this text" match, so a single typo found nothing.',
      'The sidebar and "Manage projects" search now re-rank by match quality as you type, while still keeping pinned projects first and equally-good matches in their usual most-recently-visited order.',
      'All of those searches now work from the keyboard: arrow keys move through the results, Enter picks the highlighted one, and the active result is highlighted as you go — the way the command palette already worked.',
      'The Calendar filter menu\'s Projects list gained its own search box, shown once you have more than a handful of projects.',
      'Removed project colors, which were an unused leftover from importing Todoist projects (TaskFlow never let you set one) and only ever made the Calendar filter menu\'s Projects list look inconsistent.',
      'Added keyboard navigation to every project search box above: Arrow Up/Down moves a highlighted result, Enter picks it, and Escape clears the query (in the sidebar and Calendar filter — inside the "Manage projects" modal, Escape closes the whole modal instead, same as its other fields). The main search bar and command palette gained the same highlighted-row behavior for their own dropdowns.',
    ],
  },
  {
    version: '2.1.4',
    date: '2026-08-06',
    title: 'More reliable recurring task history',
    changes: [
      'Un-checking a recurring task now rolls its due date back to the occurrence you reopened, instead of leaving it moved on to the next one.',
      'Recurring task streaks and completion history are now counted from the record of which occurrences you actually completed, so they can no longer drift out of step with what you ticked off.',
      'Completing the same occurrence twice — for example from two devices at once, or when a completion is retried after a dropped connection — is now recognised as the same completion rather than counted twice.',
    ],
  },
  {
    version: '2.1.3',
    date: '2026-08-06',
    title: 'Fixed a few sources of unbounded storage growth',
    changes: [
      'Task comment threads are now capped at 200 comments per task — posting past the cap is blocked with a clear message until you delete an older comment to make room, rather than letting a thread grow forever.',
      'Fixed comment file attachments not being cleaned up from cloud storage when a completed task aged out of the automatic 30-day cleanup, leaving orphaned files behind.',
      'Fixed automatic daily cloud backups occasionally failing to prune old ones once enough manual backups had piled up, which could let more than the intended 14 automatic backups accumulate.',
      'Backups you take manually with "Back up now" are now also capped at the 14 most recent, pruned right after each new one (previously they were kept forever) — this is a separate cap from automatic backups\' own 14, so up to 14 of each can exist side by side.',
    ],
  },
  {
    version: '2.1.2',
    date: '2026-08-06',
    title: 'Fixed recurring tasks not scheduling when moved off their usual repeat days',
    changes: [
      'Fixed a bug where moving a single occurrence of a recurring task onto a day outside its normal repeat pattern (e.g. moving one occurrence of a Mon/Wed/Fri task to a Thursday) could leave it showing "0m remaining" and never get scheduled. The rest of the series now stays on its normal days, and completing the moved occurrence correctly advances to the next real occurrence.',
      'Fixed some recurring sub-tasks getting stuck showing "0m remaining" forever after becoming recurring (most commonly ones migrated from an old checklist-style sub-task) — a one-time fix repairs any task already stuck like this.',
      'Fixed the command palette (Ctrl/Cmd+K) keeping the first result highlighted when tabbing past it with the keyboard instead of following focus.',
    ],
  },
  {
    version: '2.1.1',
    date: '2026-08-06',
    title: 'Fixed recurring tasks staying marked complete after being rescheduled',
    changes: [
      'Fixed a bug where a recurring task or sub-task you\'d already completed today kept showing as checked off after you moved its due date back onto that day — it now correctly shows as not-yet-done again.',
      'Fixed the Board view\'s sub-task count (e.g. "2/3") not counting a recurring sub-task as done for today, even when it was.',
      'Recurring tasks can no longer have their due date cleared — you can move it to a different date, but not blank it, since a recurring task needs a date to know when its next occurrence is due.',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-08-06',
    title: 'A filter menu for the Calendar toolbar',
    changes: [
      'Added a Filter button to the Calendar toolbar (desktop and mobile) to narrow what shows on the grid: switch between "Tasks & events", "Tasks only", or "Events only", and multi-select by Project or Tag — projects/tags you add later are included automatically unless you\'ve explicitly narrowed the list. The trigger shows a small dot whenever a filter is active.',
      'When a filter hides everything in the visible week/month, the calendar now shows a clear "Nothing matches your filters" message with a one-tap "Clear filters" button, instead of looking like an empty calendar.',
      'Fixed the Tasks page\'s List/Board/Gantt status filter (Active/Completed/All/No due date) resetting back to its default every time you reloaded the app.',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-08-06',
    title: 'Reorder Board columns by dragging',
    changes: [
      'Board columns can now be dragged into whatever order you like — hover a column header and drag the grip handle on its left. Previously columns were stuck in a fixed order.',
      'Your chosen order is remembered per project, so it\'s still there next time you open the board. It\'s saved on this device only and never changes your section order in Todoist.',
      'New sections are added at the end of your arrangement rather than disturbing it, and the "No Section" column stays first.',
    ],
  },
  {
    version: '1.99.0',
    date: '2026-08-06',
    title: 'Recurring sub-tasks now inherit their parent\'s due date, not just its repeat rule',
    changes: [
      'Fixed a bug where a sub-task that became recurring (by syncing with a recurring parent, or vice versa) picked up the correct repeat rule but not the due date — it could end up recurring on the wrong day entirely.',
      'This now also handles weekday-specific repeat rules correctly (e.g. "every Wed and Sun"), snapping the synced due date forward to the first day that actually matches the rule instead of just copying a date that might fall on the wrong weekday.',
    ],
  },
  {
    version: '1.98.0',
    date: '2026-08-06',
    title: 'No more repeat overdue notifications for tasks you already finished',
    changes: [
      'Fixed overdue notifications (email and in-app) repeating day after day for tasks that were already completed or deleted. Completing or deleting a task now properly clears its notification state — previously that only worked if you pushed the due date forward, so a finished task could keep emailing you indefinitely.',
      'An overdue task is now notified about once per due date, rather than once every day it stays overdue. Changing a task\'s due date re-arms it, so a rescheduled-but-still-late task still gets a fresh reminder.',
      'Completing a task now syncs to the cloud immediately instead of after a short delay, so closing the tab right after ticking something off no longer leaves the reminder system thinking it\'s still outstanding.',
    ],
  },
  {
    version: '1.97.0',
    date: '2026-08-06',
    title: 'Recurring sub-tasks show as done for today, and auto-complete their parent',
    changes: [
      'A recurring sub-task now shows checked off in the Tasks list once it\'s completed for today, instead of always looking unchecked (it still resets and shows as due again once its recurrence rolls to the next occurrence).',
      'Once every sub-task under a parent is completed for the current cycle, the parent now automatically completes too (and repeats up the chain for nested sub-tasks).',
      'Restoring a completed recurring task or sub-task via the Tasks list now un-checks it for today (and un-completes a parent that had auto-completed because of it), rather than only working for one-off tasks.',
    ],
  },
  {
    version: '1.96.0',
    date: '2026-08-06',
    title: 'Recurring parent and sub-task recurrence now stay in sync',
    changes: [
      'A sub-task now automatically becomes recurring when its parent task is recurring (its steps toward a recurring goal should repeat too), and vice versa: making a sub-task recurring now also makes its parent recurring.',
      'Existing tasks with mismatched recurrence between a parent and its sub-tasks were synced once automatically when this shipped.',
      'The "Apply to all sub-tasks" button no longer copies recurrence — that now happens automatically, so it stays focused on priority, due date, project/section, labels, and the passive flag.',
    ],
  },
  {
    version: '1.95.4',
    date: '2026-08-06',
    title: 'Fixed the mobile calendar date-picker being unresponsive',
    changes: [
      'On mobile, the calendar\'s date-picker (and a few other menus that fall back to a centered popup on narrow screens) could open looking darkened and not respond to any taps — its own dimmed backdrop was invisibly sitting on top of it, silently blocking every click.',
    ],
  },
  {
    version: '1.95.3',
    date: '2026-08-05',
    title: 'Full smart-parsing in sub-tasks',
    changes: [
      'Adding a sub-task now catches every natural-language shortcut the main title field does, including recurrence, a fixed time, links, "run unattended," "enforce due date," and task dependencies — not just dates/priority/duration/project.',
      'The sub-task "Add" button\'s icon now sits after the label instead of before it.',
    ],
  },
  {
    version: '1.95.2',
    date: '2026-08-05',
    title: 'Full-bleed mobile calendar, centered date-picker, compact single-day date',
    changes: [
      "The calendar's time grid and month view now run edge-to-edge on mobile instead of sitting inset with side padding, and square off to match the toolbar above them.",
      'The date-picker dropdown now centers on screen on mobile instead of risking clipping off the side of a narrow phone.',
      'Single-day view no longer repeats the current date in both the toolbar and the grid — the previously-empty time-column corner now shows a compact date label instead.',
    ],
  },
  {
    version: '1.95.1',
    date: '2026-08-05',
    title: 'Fixed a rare change-reverting bug',
    changes: [
      'Fixed a bug where a newly added sub-task, or a task you just marked complete, could silently revert a fraction of a second later — most noticeable as a completion checkbox that snapped back and needed a second click.',
      'A repeating task\'s detail screen now shows only its current/next scheduled time instead of listing every future occurrence.',
    ],
  },
  {
    version: '1.95.0',
    date: '2026-08-05',
    title: 'Smarter scheduling, and fixed app-wide lag',
    changes: [
      'The scheduler now looks for a better overall arrangement of your tasks instead of just filling the first slot that fits — it favors keeping a task\'s time in one continuous block over scattering it across many days, and rewards finishing with some slack before the due date rather than cutting it close.',
      'Fixed the whole app feeling sluggish (including typing and animations lagging) while a focus timer was running, or while a modal like the calendar\'s edit-event screen was open.',
    ],
  },
  {
    version: '1.94.0',
    date: '2026-08-05',
    title: 'Smart parsing in sub-tasks, and scheduling info on the task screen',
    changes: [
      'Adding a sub-task now understands the same natural-language shortcuts as the main title field — dates, priority, duration, project/section, and tags all get detected and highlighted as you type.',
      'The task detail screen now shows when a task is currently scheduled (date and time), instead of only being visible on the calendar.',
    ],
  },
  {
    version: '1.93.22',
    date: '2026-08-05',
    title: 'Fixed calendar tasks drifting off their real position when crowded',
    changes: [
      'A crowded task could still visually drift a noticeable amount from its real scheduled time, even after previous fixes. Any real drift now folds crowded tasks into an "N tasks" chip instead, so a task\'s box always reflects its own actual time.',
    ],
  },
  {
    version: '1.93.21',
    date: '2026-08-05',
    title: 'Fixed calendar tasks still drifting past their real end time in a chain',
    changes: [
      'A chain of several short, crowded tasks could compound their visual stretch enough to push a real task\'s box well past its own end time, even though each individual push looked small. That chain now folds into an "N tasks" chip before the drift adds up.',
    ],
  },
  {
    version: '1.93.20',
    date: '2026-08-05',
    title: 'Fixed calendar "N tasks" chips silently dropping tasks when merging',
    changes: [
      'When a crowded run of tasks folded a real task together with an already-grouped chip, some of the grouped tasks could silently disappear from the resulting chip (and its count). All merged tasks are now preserved correctly.',
    ],
  },
  {
    version: '1.93.19',
    date: '2026-08-05',
    title: 'Fixed remaining cases of calendar tasks overflowing past their real end time',
    changes: [
      'The previous fix still let a small overflow through. Now a stretched task is only allowed to push the next task down as far as that task\'s own real end time — pushing past it always folds into an "N tasks" chip instead.',
    ],
  },
  {
    version: '1.93.18',
    date: '2026-08-05',
    title: 'Fixed calendar tasks still overflowing past their real end time',
    changes: [
      'The previous fix for this only caught extreme cases at max zoom-out. A short task stretched taller than its real time slot could still push the next task down far enough to overflow at any zoom level — that pair now reliably folds into an "N tasks" chip instead.',
    ],
  },
  {
    version: '1.93.17',
    date: '2026-08-05',
    title: 'Fixed calendar tasks visually overflowing past their real end time at max zoom-out',
    changes: [
      'A short task stretched taller than its real time slot could push the next task down far enough that its box overflowed past its own true end time on the hour axis. That pair now folds into an "N tasks" chip instead of rendering a misleading box.',
    ],
  },
  {
    version: '1.93.16',
    date: '2026-08-05',
    title: 'Fixed adjacent calendar tasks still visually overlapping',
    changes: [
      'A short task rendered taller than its real time slot could still visually collide with the very next task, since they were positioned independently. They now stack cleanly with no overlap.',
    ],
  },
  {
    version: '1.93.15',
    date: '2026-08-05',
    title: 'Fixed long-enough calendar tasks still getting swallowed into "N tasks" chips',
    changes: [
      'A task with plenty of room to show its own name (e.g. 45+ minutes) no longer gets folded into a neighboring chip just because a short task sits right next to it with no gap.',
    ],
  },
  {
    version: '1.93.14',
    date: '2026-08-05',
    title: 'Fixed overlapping calendar blocks and zoom-in not un-clustering tasks',
    changes: [
      'Two tasks scheduled at overlapping times could render stacked on top of each other instead of side-by-side.',
      'Zooming in on the calendar now properly un-clusters short tasks into separate boxes once there\'s enough room, instead of leaving them stuck in an "N tasks" chip.',
    ],
  },
  {
    version: '1.93.13',
    date: '2026-08-05',
    title: 'Fixed calendar clustering working backwards when zooming in',
    changes: [
      "Zooming in on the calendar (more room per hour) could paradoxically show MORE \"N tasks\" chips than zooming out — now clustering only ever eases up as you zoom in, never the reverse.",
      'Unrelated tasks/events no longer render with overlapping, collapsed-looking text at any zoom level.',
    ],
  },
  {
    version: '1.93.12',
    date: '2026-08-05',
    title: 'Fixed the calendar\'s tight-schedule fallback not triggering at all',
    changes: [
      "The single-line/\"N events\" fallback for busy, zoomed-out days (added in the previous update) wasn't actually triggering, due to a missing internal value — it now correctly kicks in.",
      'Fixed a run of 3+ tightly-packed blocks folding into several small overlapping chips instead of one clean chip.',
    ],
  },
  {
    version: '1.93.11',
    date: '2026-08-05',
    title: 'Fixed AI-created tasks failing to sync and a task-completion flicker',
    changes: [
      'Fixed "Failed to sync to the cloud" errors when editing a task the AI Quick Add created without an explicit priority.',
      'Fixed a task completion sometimes flickering and reverting, requiring a second click to actually mark it done — most noticeable on recurring tasks completed in quick succession.',
    ],
  },
  {
    version: '1.93.10',
    date: '2026-08-05',
    title: 'Fixed calendar blocks incorrectly stacking, and cramped-looking busy days when zoomed out',
    changes: [
      'Fixed some blocks on a busy day incorrectly chaining/stacking below unrelated, non-overlapping blocks instead of getting their own space.',
      "On busy days at the most zoomed-out level, two back-to-back blocks with only a little real time between them now shrink to a single line instead of looking like a jumbled, near-overlapping mess — and if there's truly no room even for that, they fold into a tappable \"N events\" chip like short tasks already do.",
    ],
  },
  {
    version: '1.93.9',
    date: '2026-08-05',
    title: 'Fixed remaining calendar axis drift and a stale completion tooltip',
    changes: [
      'Fixed the hour axis and grid still drifting out of alignment with scheduled blocks at the most zoomed-out level, caused by a floating-point rounding gap the earlier fix missed.',
      'Hovering a recurring task\'s block no longer shows a stale "Completed at" time left over from a different day\'s occurrence of the same task.',
    ],
  },
  {
    version: '1.93.8',
    date: '2026-08-05',
    title: 'Fixed calendar event alignment and floating search bar blur',
    changes: [
      "Calendar events and scheduled blocks now line up exactly with the time axis, instead of rendering a few pixels below where their gridline says they should be.",
      'When zoomed out far enough that a block would render too small to read, it now folds into a "N short tasks" chip the same way very short tasks already did — zooming back in un-collapses it once there\'s room again.',
      "The floating search bar on the Tasks and Settings pages now actually blurs the content scrolling underneath it, instead of the blur being too faint to notice.",
    ],
  },
  {
    version: '1.93.7',
    date: '2026-08-05',
    title: 'Fixed completed recurring sub-tasks not showing as done',
    changes: [
      'Completing a recurring sub-task (directly, or via its recurring parent) now correctly marks that occurrence as done everywhere — its calendar block gets the crossed-out "done" styling, it\'s protected from rebalancing, and it shows as complete in Today\'s Agenda and the dashboard.',
    ],
  },
  {
    version: '1.93.6',
    date: '2026-08-05',
    title: 'Completing a task early now frees up its slot for the rest of today',
    changes: [
      "Completing a task early now automatically opens up its time slot for other tasks scheduled later today, instead of leaving the freed time unused until your next manual re-balance.",
    ],
  },
  {
    version: '1.93.5',
    date: '2026-08-05',
    title: 'Fixed recurring parent tasks wiping sub-task due dates',
    changes: [
      'Completing a recurring parent task no longer blanks out its sub-tasks\' due dates. If a sub-task was set up to recur on its own (e.g. via "Apply to all sub-tasks"), its due date now correctly advances to its next occurrence instead of disappearing.',
    ],
  },
  {
    version: '1.93.4',
    date: '2026-08-05',
    title: 'Autocomplete popups close immediately after picking a suggestion',
    changes: [
      'Picking a project/section (or keyword) autocomplete suggestion now closes its popup right away, instead of leaving it open until you typed an extra space.',
      'AI Quick Add can now set "Enforce due date" on a task when you ask for it.',
    ],
  },
  {
    version: '1.93.3',
    date: '2026-08-05',
    title: 'Save on a task no longer closes it',
    changes: [
      'Clicking Save on a task\'s edit screen now just saves your changes and leaves the task open, instead of closing it — close it yourself with Escape or the close button when you\'re done.',
      'The keyboard hint on autocomplete suggestions (e.g. project/section) now shows just "Enter" when there\'s only one match, since there\'s nothing to Tab between.',
    ],
  },
  {
    version: '1.93.2',
    date: '2026-08-04',
    title: 'Sub-task input grows with your text; "+ Add" button stays put',
    changes: [
      'The "Add a sub-task" input now wraps to multiple lines (up to 3) as you type instead of scrolling horizontally in a single-line box. Enter still adds the sub-task; Shift+Enter inserts a newline.',
      'Fixed the "+ Add" button stretching taller alongside the input as it grew to more lines — it now stays a fixed size.',
    ],
  },
  {
    version: '1.93.1',
    date: '2026-08-04',
    title: 'Recurring calendar events now show on Today\'s agenda; overlaps flagged',
    changes: [
      'A recurring calendar event (e.g. a weekly gym slot or tutoring session you created directly in Google Calendar) now shows up correctly in "Today\'s agenda" every week — it used to only appear on the exact date of its very first occurrence and silently disappear every week after that, while non-recurring/subscribed events (like lecture timetables) were unaffected.',
      '"Right now" can now surface a calendar event, not just a scheduled task, as what\'s currently happening.',
      'When two or more things overlap at the same time, "Today\'s agenda" now tags the overlapping rows so it\'s clear they\'re concurrent rather than one after another, and "Right now" shows a "+N more" badge instead of silently hiding the other simultaneous item.',
    ],
  },
  {
    version: '1.93.0',
    date: '2026-08-04',
    title: 'More reliable overdue-email sync on tab close',
    changes: [
      'Completing a task and immediately closing the tab, switching apps, or putting your device to sleep could sometimes leave the completion un-synced, so the daily overdue-reminder email kept referencing a task you\'d already finished. The sync flush that runs when you leave the app now also triggers on browser tab/window close, closing another gap where the completion could be lost before it reached the cloud.',
    ],
  },
  {
    version: '1.92.1',
    date: '2026-08-04',
    title: 'AI Quick Add now catches malformed dates/times before they can be applied',
    changes: [
      'A due date, event date, or time that the AI proposes in a bad format (e.g. "next Tuesday" instead of an actual date) is now flagged as invalid on the review screen and can\'t be applied, instead of silently causing a broken date/time once you click Apply.',
      'An event whose end time isn\'t after its start time is now flagged the same way.',
    ],
  },
  {
    version: '1.92.0',
    date: '2026-08-04',
    title: 'Fixed-time tasks now always keep their exact slot',
    changes: [
      'A task with a fixed time (e.g. "Piano at 5pm") no longer loses its exact slot to a higher-priority flexible task during rebalancing — fixed-time tasks are now placed first, so their pinned time always wins unless another, more urgent fixed-time task genuinely needs the same slot.',
      'If a fixed-time task can\'t get its exact slot on a day with nowhere else to go and ends up placed at a different time that same day, that\'s now flagged as a scheduling conflict you can review, even when every hour still got scheduled somewhere.',
      'A fixed time that falls entirely outside your working hours is now called out with its own clear message ("outside your working hours") instead of a generic "not enough capacity" one.',
    ],
  },
  {
    version: '1.91.3',
    date: '2026-08-04',
    title: '"Apply to all sub-tasks" stays put; calendar toolbar cleanup',
    changes: [
      '"Apply to all sub-tasks" no longer flashes and disappears right after an edit — it now stays visible for the rest of the time you have the task open, since the sidebar auto-saves your edit ~500ms later and that used to hide the button again immediately.',
      'Removed the bordered box around the calendar\'s Refresh, Previous, Today, and Next buttons so they sit flush with the toolbar instead of standing out as separate boxes.',
      'Fixed a completed-late calendar block showing two overlapping left-edge stripes (its priority color plus a warning accent) — the accent conflicted with the priority color and has been removed; a late completion is still called out with a "Completed late" label in the Today view.',
    ],
  },
  {
    version: '1.91.2',
    date: '2026-08-04',
    title: 'Fixed recurrence not applying to sub-tasks; tidied up the Apply button',
    changes: [
      '"Apply to all sub-tasks" now also copies the repeat setting onto every sub-task — previously it copied priority, due date, project/section, labels, and passive flag but silently skipped recurrence.',
      '"Apply to all sub-tasks" now only appears after you\'ve actually changed one of the shared fields, instead of always showing whenever a task has sub-tasks — and it now matches the Save button\'s green styling.',
    ],
  },
  {
    version: '1.91.1',
    date: '2026-08-04',
    title: 'Sub-task count indicator, expand arrow moved to row edge',
    changes: [
      'A task with sub-tasks now shows a small count badge next to its title (alongside the repeat icon), so you can see how many sub-tasks it has without opening it.',
      'The expand/collapse arrow for sub-tasks moved from the left of the row to the right edge.',
    ],
  },
  {
    version: '1.91.0',
    date: '2026-08-03',
    title: 'Overhauled sub-task scheduling: real deadlines, not a free pass',
    changes: [
      'Sub-tasks now need a due date (their own, or one inherited from their nearest dated parent/grandparent) to be auto-scheduled — same rule as any top-level task. A sub-task with no date anywhere in its chain is a checklist item, not schedulable work.',
      'A sub-task\'s own due date can no longer be set later than its parent goal\'s — editing it in the task panel or dragging its calendar block past that deadline now shows a warning and is blocked.',
      'A scheduled sub-task\'s calendar block now shows its PARENT task\'s name (the goal), not its own — open the block to see which specific step it actually is.',
      'Added an "Apply to all sub-tasks" button on a task with sub-tasks, to copy its priority, due date, project/section, labels, and passive flag onto every sub-task and nested sub-sub-task at once.',
      'Added a "How do sub-tasks work?" help tooltip next to the Sub-tasks section explaining scheduling, nesting limits, and due-date rules.',
    ],
  },
  {
    version: '1.90.7',
    date: '2026-08-03',
    title: 'Fixed "ignore from scheduler" being lost on Google Calendar sync',
    changes: [
      'Events marked "Ignore this event" (so the scheduler treats them as free time) no longer get silently un-ignored the next time Google Calendar syncs — the ignored flag is now preserved across the sync instead of being overwritten by the freshly-pulled copy.',
    ],
  },
  {
    version: '1.90.6',
    date: '2026-08-03',
    title: 'Scheduler now reschedules when a task\'s estimated time changes',
    changes: [
      'Changing a task\'s Estimated time now automatically re-balances its existing scheduled block(s), the same way changing its due date already did — previously an already-scheduled task kept its old block size until the next manual "Re-balance schedule".',
    ],
  },
  {
    version: '1.90.5',
    date: '2026-08-03',
    title: 'Removed the redundant Calendar event overrides settings section',
    changes: [
      'Settings no longer has a "Calendar event overrides" list for marking events as free time — you can already do this by opening an event on the calendar, checking "Ignore this event", and choosing to apply it to the whole series.',
    ],
  },
  {
    version: '1.90.4',
    date: '2026-08-03',
    title: 'Fixed smart parse locking up when editing a task',
    changes: [
      'Fixed smart parse (e.g. typing "tomorrow" or "p2" into a task\'s title) permanently stopping in the task detail/edit view after its first suggestion applied — it would silently stop working for the rest of that edit, even for unrelated phrases, until the task was reopened.',
      'Also removed a leftover empty CSS rule flagged by the editor (no visual change).',
    ],
  },
  {
    version: '1.90.3',
    date: '2026-08-03',
    title: "Fixed Settings crash, Board search bar now matches List view exactly",
    changes: [
      'Fixed a crash that broke the entire Settings page whenever a repeating calendar event existed (introduced by the previous release\'s calendar-overrides grouping change).',
      "The Board view's search bar now renders in the same shared header as List view's, instead of a separate copy with its own spacing — the two are now visually identical, not just close.",
    ],
  },
  {
    version: '1.90.2',
    date: '2026-08-03',
    title: 'Cleaner calendar overrides list, consistent search bar spacing',
    changes: [
      'Settings → Calendar event overrides now lists each repeating event once instead of one row per occurrence, and toggling "Treat as free time" applies to the whole series.',
      'The striped "look but don\'t touch" styling is now shown only for events marked as free time (ignored by the scheduler) — read-only synced events display normally.',
      "Fixed the Board view's search bar sitting further from the page title than List view's; the two now match, with a bit more breathing room below Board's search bar.",
    ],
  },
  {
    version: '1.90.1',
    date: '2026-08-03',
    title: 'Fixed a stray border on help tooltip buttons',
    changes: [
      "Removed an unintended border around the small \"?\" help buttons (e.g. next to Repeat's recurrence settings).",
    ],
  },
  {
    version: '1.90.0',
    date: '2026-08-03',
    title: 'Smarter scheduling for split tasks',
    changes: [
      "The scheduler no longer wastes a task's last available time-split on a too-small early gap when a single larger block later in the day could fit the whole remaining time instead — fewer unnecessarily fragmented tasks like short practice sessions.",
    ],
  },
  {
    version: '1.89.0',
    date: '2026-08-03',
    title: 'Fixed routines hover behavior swapped back',
    changes: [
      "Fixed routines now always show their label and time in Settings, and only reveal them on hover on the Calendar page (this was accidentally swapped in the previous release).",
      'Removed the border/background from the calendar view-switcher (hamburger) button.',
    ],
  },
  {
    version: '1.88.0',
    date: '2026-08-03',
    title: 'Progress ring and Fixed routines fixes',
    changes: [
      "Fixed the Dashboard's progress ring percentage rendering off-center.",
      'Fixed routines in Settings now only show their label and time on hover, so a busy day of blocked-out routines reads as a cleaner strip of colored blocks at a glance.',
    ],
  },
  {
    version: '1.87.0',
    date: '2026-08-03',
    title: 'Make the Dashboard more compact and readable on mobile',
    changes: [
      'Quick Stats and the progress rings are now centered on mobile instead of left-aligned.',
      'Today\'s Agenda rows are more compact on mobile: times show just the start time, "Due today" becomes "Due", and the completion timestamp is hidden — so every row fits without being cut off.',
      'Long task/event names in Today\'s Agenda now auto-scroll into view instead of being cut off or silently truncated.',
    ],
  },
  {
    version: '1.86.0',
    date: '2026-08-03',
    title: 'Fix "missed task" emails for already-completed tasks',
    changes: [
      'Fixed the email notification worker sending "task missed" (and overdue/starting-soon) emails for tasks or scheduled blocks that had already been completed or marked done in the few minutes before the email actually went out.',
    ],
  },
  {
    version: '1.85.0',
    date: '2026-08-03',
    title: 'Fix remaining dashboard overflow on mobile',
    changes: [
      'Fixed the Dashboard cards themselves (not just individual text) still rendering wider than the screen on mobile, cutting off content on the right edge.',
    ],
  },
  {
    version: '1.84.0',
    date: '2026-08-03',
    title: 'Fix scheduler failing to use small leftover free time',
    changes: [
      'Fixed the scheduler reporting "No free time left" for a task even when a real, smaller free slot was available — it was wrongly requiring every split piece of a task to be at least 30 minutes long.',
      'Splitting a task across multiple time slots now only limits how many separate pieces it can be split into, not how small each piece can be, so short leftover gaps (as small as 5 minutes) can now be used.',
    ],
  },
  {
    version: '1.83.0',
    date: '2026-08-03',
    title: 'Fix mobile horizontal scroll on Tasks and Dashboard',
    changes: [
      'Fixed the Tasks page being able to wiggle/scroll sideways on mobile screens.',
      'Fixed long task titles in the Dashboard\'s "Right now", "Up next", and "Today\'s Agenda" widgets overflowing the page instead of truncating.',
    ],
  },
  {
    version: '1.82.0',
    date: '2026-08-03',
    title: 'Improve command palette keyboard-highlight contrast',
    changes: [
      'The command palette (Ctrl/Cmd+K) now highlights the selected row with a clearly visible green background when navigating with arrow keys or Tab, instead of a barely-visible shade close to the surface color.',
    ],
  },
  {
    version: '1.81.0',
    date: '2026-08-03',
    title: 'Google Calendar: fix reconnect on refresh; restore calendar events without a connection',
    changes: [
      'Fixed a bug where Google Calendar required manually clicking "Connect Calendar" again after every page refresh, even though it was already connected — the app now waits for sign-in to finish restoring before attempting the silent reconnect.',
      'Removed an outdated "Rebuilt your synced events..." message left over from a past one-time sync fix; connecting or syncing now just says "Google Calendar connected."',
      'If Google Calendar isn’t connected and a device has no locally saved calendar events (e.g. a new device, or after signing back in), your events — including recurring ones — are now automatically restored from your most recent cloud backup instead of showing an empty calendar.',
    ],
  },
  {
    version: '1.80.0',
    date: '2026-08-03',
    title: 'Fix repeated "missed task" emails',
    changes: [
      'Fixed a bug where "missed scheduled slot" email notifications could fire for tasks that were missed long ago (days or weeks in the past), sometimes producing a large burst of emails at once. Missed-slot emails now only fire for slots missed within the last 24 hours.',
    ],
  },
  {
    version: '1.79.0',
    date: '2026-08-03',
    title: 'Remove Plan Today and manual plan mode',
    changes: [
      'Removed the standalone "Plan today" button and manual "Plan Today" mode (the toggle, the "Unscheduled Today" tray, and the forced drag-onto-today behavior). "Re-balance schedule" remains the way to auto-schedule your tasks, and normal drag-and-drop of existing blocks onto any day is unaffected.',
    ],
  },
  {
    version: '1.78.0',
    date: '2026-08-03',
    title: 'Fix zero-duration scheduled blocks; add a 30-minute minimum split size',
    changes: [
      'Fixed a rare scheduling bug where a task could end up with a scheduled block whose start and end time were identical (shown as, e.g., a task starting and ending at the same minute) when the auto-scheduler was forced to squeeze in a tiny leftover sliver of time.',
      'The auto-scheduler no longer splits a task across multiple time slots into pieces smaller than 30 minutes. A task with 30 minutes or less of work remaining is now always scheduled as a single sitting rather than being fragmented.',
    ],
  },
  {
    version: '1.77.0',
    date: '2026-08-03',
    title: 'Fix multi-weekday recurrence and email notification timing; add auto-reschedule toggle; move mobile calendar refresh button',
    changes: [
      'Fixed a recurring task set to repeat on specific weekdays (e.g. "every Mon, Wed") jumping a full week ahead when completed, instead of advancing to the next of its listed days — completing a Monday occurrence now correctly moves it to that same week\'s Wednesday.',
      'Adding a new task with a due date, and Google Calendar events changing (via sync or import), now automatically queue a schedule rebalance instead of requiring a manual "Re-balance schedule" click — this can be turned off in Settings → Scheduling rules if you\'d rather always rebalance manually.',
      'On the mobile Calendar page, the Google Calendar refresh button moved up next to the date title and view menu (right-aligned) instead of sitting alone on its own row underneath.',
      'Fixed "due today" emails arriving at whatever random early-morning moment the notification check happened to run (e.g. 4am) — they\'re now sent once daily, right after your configured work-day start time, as a single consolidated "Good morning" email listing every task due that day instead of one email per task.',
      'Added a new "missed" email for a scheduled task whose time slot passed while still incomplete — separate from "overdue" (past due date). The email tells you whether it was also due that day or just missed its time slot, always including the due date, and re-sends if you reschedule it and miss it again.',
    ],
  },
  {
    version: '1.75.2',
    date: '2026-08-02',
    title: 'Fix AI Quick Add opening without an API key via the command palette; tidy help buttons',
    changes: [
      'The command palette\'s "Quick Add with AI" action now checks for a saved Anthropic/Gemini API key before opening the modal, matching the existing check on the Tasks page\'s AI Quick Add button — previously it opened regardless and let the request fail later.',
      'Removed the faint border around the small "?" help buttons.',
      'The Calendar page\'s two separate help buttons (next to Re-balance schedule and Plan today) are now a single combined help button at the right-most end of the toolbar.',
    ],
  },
  {
    version: '1.75.1',
    date: '2026-08-02',
    title: 'Fix Add task / AI Quick Add buttons overlapping the Tasks view menu',
    changes: [
      'Fixed the floating "Add task" / AI Quick Add buttons on the Tasks page rendering near the top-right corner instead of the bottom-right, overlapping (and blocking clicks on) the view/filter menu — a side effect of the previous release\'s header-docking fix.',
    ],
  },
  {
    version: '1.75.0',
    date: '2026-08-02',
    title: 'Guided tour covers Manual Plan Today; new help tooltips; AI Quick Add in the command palette',
    changes: [
      'The guided tour now covers "Schedule manually for today" — the calendar\'s opt-in mode that stashes today\'s auto-scheduled blocks into an Unscheduled Today tray so you can place them yourself.',
      'Added small "?" help tooltips explaining task dependencies, the free-text recurrence syntax ("every 2 weeks", "every mon and wed", ...), and what Re-balance schedule / Plan today actually do under the hood.',
      'The command palette (Ctrl/Cmd+K) can now launch "Quick Add with AI" directly, when it\'s configured.',
      'Fixed the Settings search bar disappearing entirely once you scrolled past it, and tightened/repositioned it for a bit more breathing room above "Account & sync".',
      'The Tasks page\'s floating header now actually docks closer to the top of the screen while scrolled (the previous two attempts at this didn\'t visibly take effect).',
      'The "Sign in with Google" button in Settings is no longer stretched to the full width of the page — it now sizes to its content and left-aligns like other buttons.',
    ],
  },
  {
    version: '1.74.1',
    date: '2026-08-02',
    title: 'Fix Settings search bar alignment and Tasks docking distance',
    changes: [
      'Fixed the Settings search bar rendering wider than the page content and centered instead of left-aligned, a regression from the previous release\'s blur fix.',
      'The Tasks page\'s floating header now actually docks closer to the top of the screen once scrolled — the previous release\'s fix for this wasn\'t visibly taking effect.',
    ],
  },
  {
    version: '1.74.0',
    date: '2026-08-02',
    title: 'Settings search bar blur, sticky header docking, and command palette fixes',
    changes: [
      'The Settings page\'s floating search bar now blurs the full width of the page while scrolled, matching the Tasks page, instead of leaving the area beside it unblurred.',
      'The Tasks page\'s floating header now docks a bit closer to the top of the screen once you scroll, instead of sitting at the same distance whether scrolled or not.',
      'Command palette (Ctrl/Cmd+K): quick Actions now show first in the results, pressing Tab from the search box now jumps to the first result instead of the close button, and the keyboard-selection highlight now matches the hover highlight instead of a boxy outline.',
    ],
  },
  {
    version: '1.73.0',
    date: '2026-08-02',
    title: 'Mobile search button now available on every tab',
    changes: [
      'The floating search/command-palette button (previously only on the Dashboard) now appears on every tab on mobile. It\'s also switched to a circular shape, and on tabs with their own floating "+" button (Tasks, Board, Calendar) it now stacks above it, shifting up automatically when that button\'s menu is expanded.',
      'Fixed a small gap of unblurred content that could peek out above the floating search bar on the Tasks and Settings pages while scrolled. The floating header also now docks sooner (sits closer to the top of the page) and blurs a little further past the search bar.',
      'Added back some breathing room between the Settings search bar and the first section below it ("Account & sync"), which had become too tight.',
    ],
  },
  {
    version: '1.72.0',
    date: '2026-08-02',
    title: 'Fixed email/in-app notifications spamming and firing for completed tasks',
    changes: [
      'Overdue notifications for high/urgent priority tasks used to re-send as often as every hour, which could add up to dozens of emails a day for a single task. They now fire at most once per day, matching every other notification type.',
      'Notifications now re-fire right away if a task\'s due date (or a scheduled block\'s time) changes, instead of staying silently suppressed because "something" already notified for that task today.',
      'Fixed a bug where completing a task right before closing the tab or switching apps could lose that change before it synced to the cloud, causing overdue reminders to keep arriving for a task you\'d already finished.',
    ],
  },
  {
    version: '1.71.0',
    date: '2026-08-02',
    title: 'Changing a scheduled task\'s due date now auto-rebalances the schedule',
    changes: [
      'Previously, moving a task\'s due date left its old scheduled block sitting on the calendar until you manually clicked "Re-balance schedule." Now, editing the due date of any task that already has a scheduled (unlocked) block automatically triggers a rebalance, so the calendar stays in sync with the new deadline right away.',
    ],
  },
  {
    version: '1.70.0',
    date: '2026-08-02',
    title: 'Unscheduled tray no longer shows up outside Manual Plan Today',
    changes: [
      'The "Unscheduled" list of draggable tasks above the calendar was appearing all the time, even when Manual Plan Today mode wasn\'t turned on. It\'s now only shown while that mode is active, and has been renamed to "Unscheduled Today" to make that clearer.',
    ],
  },
  {
    version: '1.69.0',
    date: '2026-08-02',
    title: 'Fixed a false scheduling conflict for tasks due beyond the visible planning window',
    changes: [
      'Fixed a bug where a task due well beyond the visible planning horizon (3 weeks by default) was incorrectly flagged as a scheduling conflict just because it couldn\'t fit into that visible window — it still has real time left before its actual due date, so it no longer shows up as "no free time left." A genuine conflict at a fixed time slot is still reported as before.',
    ],
  },
  {
    version: '1.68.0',
    date: '2026-08-02',
    title: 'Fixed white background behind the Google sign-in icon',
    changes: [
      'The "Sign in with Google" button showed a white square around the Google icon in dark mode. It now uses our own themed button instead of Google\'s rendered icon widget, so it matches the rest of the UI.',
    ],
  },
  {
    version: '1.67.0',
    date: '2026-08-02',
    title: 'Scheduler now splits a task across free gaps instead of falsely reporting a conflict',
    changes: [
      'Fixed a bug where a fixed-time recurring task (e.g. Piano) that genuinely collided with a real event or routine at its exact time was reported as "no free time left" for the whole day, even when plenty of free time was still open later — it now falls back to that later time instead.',
      'Also fixed a deeper issue: when a task\'s remaining time didn\'t fit into any single continuous open slot, the scheduler reported it as unschedulable instead of using the day\'s free time at all. It still prefers one uninterrupted block when possible, but will now split a task across several smaller gaps as a last resort, rather than leaving visibly free time unused and reporting a false conflict.',
    ],
  },
  {
    version: '1.66.0',
    date: '2026-08-02',
    title: 'Calendar FAB menu redesigned as animated floating buttons',
    changes: [
      'The desktop calendar "+" button no longer opens a dropdown list — tapping it now pops out "Schedule manually for today" and "New event" as two separate floating buttons, animating in the same way the task-list "Add task" button does.',
    ],
  },
  {
    version: '1.65.0',
    date: '2026-08-02',
    title: 'Fixed a third false "no free time" conflict for fixed-time recurring tasks',
    changes: [
      'Fixed a bug where a recurring task with a fixed practice/routine time (e.g. Piano, or a daily task like Practice questions) could report "no free time left" for a specific day even though the calendar clearly showed open time later that day — this happened when that day\'s fixed time slot had already passed (or was otherwise unavailable) and the occurrence had no other day to fall back to. It now uses any other free time that same day instead of giving up. A real scheduling collision (something else genuinely booked into that exact time) still reports a specific conflict as before.',
    ],
  },
  {
    version: '1.64.0',
    date: '2026-08-02',
    title: 'Fixed a second false "no free time" scheduling conflict',
    changes: [
      'Fixed a bug where the daily work-hours limit was cutting off the LATER part of an open day from the scheduler entirely (e.g. an evening bedtime routine, or any task needing a later time slot), even when almost none of that day\'s hours were actually in use yet — the limit is now enforced as a running budget as work gets placed, instead of pre-deleting later time slots from view.',
    ],
  },
  {
    version: '1.63.0',
    date: '2026-08-02',
    title: "Manual 'Plan Today' follow-ups: unscheduled tray, cross-device sync",
    changes: [
      "The Unscheduled tray (for dragging unplaced tasks onto a day) is shown again whenever there's unplaced work, regardless of whether Manual Plan Today mode is on — it had been unintentionally hidden outside that mode.",
      "Manual Plan Today's on/off state, and any auto-scheduled blocks set aside while it's on, now travel with backups and cross-device cloud sync instead of staying stuck on one device.",
    ],
  },
  {
    version: '1.62.0',
    date: '2026-08-02',
    title: 'Fixed false "no free time" scheduling conflicts',
    changes: [
      "Fixed a bug where a recurring task without a usable recurrence pattern could be flagged as a scheduling conflict (\"No free time left in this task's window\") even on days with plenty of open time, or after it had already been scheduled — the scheduler was double-demanding its full remaining hours instead of subtracting what was already scheduled/completed.",
    ],
  },
  {
    version: '1.61.0',
    date: '2026-08-02',
    title: "Fixed the calendar FAB's popover styling",
    changes: [
      "The desktop calendar FAB's popover menu (Schedule manually for today / New event) now uses the same anchored popover styling as the task detail view's \"...\" menu, instead of rendering unstyled.",
    ],
  },
  {
    version: '1.60.0',
    date: '2026-08-02',
    title: "Manual 'Plan Today' — schedule tasks manually for today only",
    changes: [
      "Added an opt-in Manual 'Plan Today' mode that appears in the calendar's bottom-right FAB popover. When enabled, an Unscheduled tray appears so tasks can be dragged onto TODAY only.",
      "While the mode is enabled, any auto-scheduled blocks that were placed for TODAY are removed and persisted so the user can build a manual plan for the day; these removed auto-scheduled blocks are restored if the user disables the mode.",
      "Desktop FAB now shows an Edit icon and opens a small popover (matching mobile's speed-dial style) containing the 'Schedule manually for today' toggle and New event action. Mobile FAB keeps its existing behaviour.",
      "Dragging an unscheduled task while Manual 'Plan Today' is active forces placement to TODAY and creates manual (non-auto-scheduled) blocks only for that day.",
      "This is an opt-in, local-only mode that only affects today and is persisted across reloads; it does not change the automatic scheduler's behaviour for other days.",
      "Fixed the scheduling-conflicts modal showing duplicate/incorrectly-grouped entries when multiple conflicts fell on the same day.",
    ],
  },
  {
    version: '1.59.0',
    date: '2026-08-02',
    title: 'Removed the floating Google account popup on the sign-in button',
    changes: [
      "Signed-out users could see a floating \"Sign in as ...\" Google account bubble pop up over the sidebar, overlapping other buttons. That bubble is Chrome's own account suggestion, and it turned out to be tied to the text-style \"Sign in with Google\" button specifically. The sign-in button is now Google's compact icon-only button (with our own \"Sign in with Google\" text drawn next to it) instead, which doesn't trigger the popup.",
    ],
  },

  {
    version: '1.58.0',
    date: '2026-08-02',
    title: 'Google sign-in fixed for real this time, using Google\'s own button',
    changes: [
      "Google sign-in still failed on some mobile browsers (blank accounts.google.com page, no error) even after switching to Google's own sign-in library, because that fix still relied on a browser popup window — and on browsers where a \"popup\" is really just the current tab navigating away, there's no window left to report a result back to. Sign-in now uses Google's own rendered \"Sign in with Google\" button, which resolves in place instead of needing a popup window at all.",
    ],
  },
  {
    version: '1.57.0',
    date: '2026-08-02',
    title: 'Polished the floating/blurred header on the Tasks list and Settings search',
    changes: [
      'The Tasks list title now sits a bit closer to the top of the page, and there\'s more breathing room between it and the search bar below.',
      'The blur behind the Tasks list header (and the Settings "jump to section" search) now washes over the whole top strip of the page as you scroll, instead of just a rounded box with an unblurred sliver peeking out above and to the sides of it.',
    ],
  },
  {
    version: '1.56.0',
    date: '2026-08-02',
    title: 'The Tasks list header now floats and blurs as one piece while scrolling',
    changes: [
      'The project title/view-switcher row and the search bar used to blur separately (only the search bar\'s own row floated) as you scrolled the Tasks list — they now float and blur together as a single header, with the blur fading in as you start scrolling instead of snapping on abruptly.',
    ],
  },
  {
    version: '1.55.0',
    date: '2026-08-02',
    title: 'Rescheduling a completed task reopens it, and overdue tasks stay out of "today" tiles',
    changes: [
      "Completing an overdue task and then changing its due date used to leave it stuck showing as completed on the Dashboard forever — editing the due date of a completed task now reopens it, since rescheduling means it isn't actually done.",
      "An overdue task's leftover calendar block could show up in \"Scheduled today\"/\"Completed today\" and Today's agenda alongside the \"Overdue & missed\" tile, effectively listing the same overdue task twice. Overdue tasks (due date already past) are now left out of those \"today\" views entirely — that info lives in \"Overdue & missed\" instead — whether or not the task has since been completed.",
    ],
  },
  {
    version: '1.54.0',
    date: '2026-08-02',
    title: "Fixed Google sign-in on browsers where Firebase's own popup silently broke",
    changes: [
      "Google sign-in still failed on some mobile browsers (confirmed on Firefox for Android) after the last fix, because Firebase's popup sign-in internally routes through the same fragile intermediate page a full-page redirect does — on browsers where a \"popup\" is really just a same-tab navigation, that's identical to the broken redirect flow. Sign-in now uses Google's own sign-in library directly instead of Firebase's built-in popup/redirect, avoiding that page entirely.",
    ],
  },
  {
    version: '1.53.0',
    date: '2026-08-02',
    title: 'Google sign-in no longer strands you on a broken Firebase page',
    changes: [
      "Google sign-in's full-page redirect fallback could leave you stranded on Firebase's own OAuth handler page showing a raw \"missing initial state\" error (seen on Firefox for Android, among other browsers) — a page outside the app that couldn't be recovered from. Sign-in now uses a pop-up only; if the browser blocks it, you get a clear in-app message telling you to allow pop-ups and try again, instead of ever leaving the app.",
    ],
  },
  {
    version: '1.52.0',
    date: '2026-08-02',
    title: "Fixed mobile sign-in prompt not showing when triggered from Settings",
    changes: [
      "The browser-sign-in prompt (shown when Google sign-in can't complete from an installed home-screen app) only rendered inside the account button — Settings has its own separate \"Sign in with Google\" button that silently did nothing on standalone/home-screen mode until switching to a tab that happened to pick up the pending state. The prompt now renders globally, so it shows immediately no matter where sign-in was triggered from.",
    ],
  },
  {
    version: '1.51.0',
    date: '2026-08-02',
    title: 'Scheduling-conflict details, capped calendar history, and a clearer mobile sign-in prompt',
    changes: [
      "Capped how far back on-demand calendar browsing keeps history: scrolling far enough back in the calendar view could keep that history synced indefinitely — retention is now capped at a rolling 1 year, same as anything never explicitly viewed.",
      "When Re-balance or Plan today can't fit every task, the notification now has a \"View details\" button showing exactly why each one didn't make it in — a specific conflicting calendar event/routine/task at its fixed time, an incomplete dependency it's still waiting on, or simply no free time left in its window.",
      "The scheduling conflicts details view now groups tasks into sections by the day they couldn't be scheduled for (Today, Tomorrow, or the date), and clicking a task jumps straight to that day on the Calendar instead of opening its edit view.",
      'Search bars that float over the page as you scroll (Tasks and Settings) now blur the content behind them instead of blending into it.',
      "Signing in from TaskFlow's installed home-screen icon on mobile could fail with a confusing browser error, since that context can't complete Google's sign-in redirect. Attempting to sign in there now shows a clear prompt to open TaskFlow in your regular browser instead, where sign-in works normally.",
    ],
  },
  {
    version: '1.50.0',
    date: '2026-08-01',
    title: 'A year of Google Calendar history, automatic backups, and a lighter sync window',
    changes: [
      'The event edit screen\'s Repeat field pointed to "the scope below" for enabling repeat-pattern edits on an existing series, but "Apply to" had already been moved above it — the hint now correctly says "above". Disabled Repeat controls now show a small explanation when clicked instead of silently doing nothing, and look visibly greyed out.',
      "Google Calendar sync used to only ever look forward from today, so a change made to a past event on Google Calendar never reached Taskflow no matter how long you waited. Sync now covers a full year back (in addition to the existing ~1 month ahead), and a non-recurring event that eventually ages past that year is automatically cleared out of Taskflow.",
      "Exporting a backup file, or creating a cloud backup snapshot, now includes your calendar events (Google Calendar bookings and blocked-time entries), so restoring an old backup brings your calendar back too. Live cross-device sync is unaffected — Google Calendar itself stays the sole source of truth there.",
      'The search bar on the Tasks list, Board, and Settings pages now stays within reach as you scroll down — it floats near the top of the page with a small gap instead of scrolling out of view, on both mobile and desktop.',
      'TaskFlow now automatically takes a cloud backup once a day while you\'re signed in, keeping the last 14 (older automatic ones are pruned to make room) — backups you create yourself with "Back up now" are kept forever and never affected by this.',
      'Settings now explains the sync/backup picture more clearly: tasks, boards, and settings sync live across your devices in the background, calendar events sync only through your connected Google Calendar account, and backups are a separate point-in-time safety net for everything, including events.',
      "After extending Google Calendar sync to cover a year of history, a calendar with a lot of events could silently disappear from Taskflow entirely — including the current week — because Google only returns up to 250 events per request and Taskflow wasn't asking for the rest. Taskflow now fetches every page of results.",
      'Background Google Calendar sync now keeps a modest rolling window (30 days back, 30 days forward) fresh automatically, instead of pulling a full year of history on every ~1-minute refresh. Scrolling the calendar view to a date outside that window now fetches the events for that range on demand.',
    ],
  },
  {
    version: '1.49.0',
    date: '2026-08-01',
    title: 'Editable event repeat patterns, and a string of recurring-event sync fixes',
    changes: [
      'You can now add, edit, or remove a repeat pattern on an event you\'ve already created. Replaced the "Every [number] [Day/Week/Month]" number + dropdown with a single free-text box (e.g. "every 2 weeks"), matching the smart autocomplete used elsewhere. Editing the repeat pattern on an event already part of a series only applies with "Apply to" set to "All events in the series".',
      'Deleting a single occurrence of a recurring Google Calendar event could silently reappear roughly a minute later if Taskflow\'s background sync checked Google before the deletion had fully gone through there — it now waits out that short window before trusting Google\'s copy again.',
      "If deleting an event fails for a real reason — not because it was already gone — Taskflow now puts it back and shows an error explaining why, instead of quietly looking deleted and then reappearing later. Fixed a rare race where two Google Calendar syncs running at the same time could let an older, slower fetch overwrite a newer one.",
      'Deleting one occurrence of a recurring event ("Apply to: This event") could look successful with no error, but never actually remove it on Google\'s side. A failed delete now correctly surfaces as a real error. Also moved the "Apply to" scope picker above the Repeat field in the event edit screen, since it was easy to miss why Repeat looked uneditable.',
      "Found the actual root cause of deleted/moved recurring-event occurrences reappearing every sync (even after a full Rebuild): Google reports a cancelled or moved single occurrence as its own separate item, not reliably as a change to the recurring event's own text. Taskflow now reads Google's actual per-occurrence signal directly.",
      "Taskflow used to guess the Google Calendar id of a single occurrence it was about to edit or delete. That guess broke for a recurring event that had previously been split (\"this and following\") directly in Google Calendar's own interface. Taskflow now looks up the occurrence's real id from Google first.",
      "A task set to \"must be done on due date\" could get stuck showing a scheduled time in the past that Reschedule/Plan today could never move. Stale, incomplete past blocks are now cleared and no longer counted as spent, so the task correctly reschedules onto its real due date.",
    ],
  },
  {
    version: '1.48.0',
    date: '2026-08-01',
    title: 'More Google Calendar sync fixes: phantom occurrences, faster polling, manual rebuild',
    changes: [
      'Fixed the real underlying cause of some Google Calendar recurring events showing occurrences in Taskflow that don\'t actually exist on Google — a cancelled or individually-moved occurrence\'s "EXDATE" was being ignored, so Taskflow kept regenerating that date from the plain repeat rule.',
      'Google Calendar syncs about every minute now instead of every 5, and also pulls immediately when you switch back to the Taskflow tab/window.',
      'Fixed a bug where deleting an event directly in Google Calendar (one that was originally created in Taskflow) never removed it from Taskflow. Added "Rebuild from Google Calendar" in Settings → Calendar — a repeatable, on-demand full wipe-and-rebuild of your synced events from whatever Google currently has.',
      'Fixed a bug where a Google Calendar fetch could silently exclude events landing exactly on the last day of the sync window. Fixed a leftover "cancelled" event record Google can return for a deleted single occurrence being mistaken for a still-live one-off event. Fixed "Delete" → "All events in the series" on a recurring event silently doing nothing.',
    ],
  },
  {
    version: '1.47.0',
    date: '2026-08-01',
    title: 'Fixed recurring/duplicate Google Calendar events; events now excluded from cross-device sync',
    changes: [
      'Deleting a recurring Google Calendar booking that repeats without a true recurrence rule now removes the whole series — or just the occurrences from that date on, per the scope you pick — instead of only the one clicked occurrence, which used to come back on the next sync.',
      'Fixed a bug where adding an event synced it to Google Calendar but then created a second duplicate copy in Taskflow on the next sync (with a one-time cleanup of any leftovers). If pushing a newly-added event to Google Calendar fails, you\'ll now see an error instead of it silently never showing up there. Events you create in Taskflow now render with the same styling as synced calendar events. You can now create a recurring event directly in Taskflow, syncing to Google Calendar as a real repeating event.',
      "Replaced the previous partial duplicate-event cleanup with a full one-time rebuild from Google Calendar on your next sync. Deleting an event that turns out to already be gone on Google's side no longer shows a \"failed to delete\" error. Typing \"every 2 weeks\", \"every Mon and Wed\", etc. into a new event's title now auto-fills the Repeat field, the same as it already works for tasks.",
      "Calendar events (Google-synced and local blocked-time alike) are no longer included in backup files, cloud backups, or cross-device sync — Google Calendar is now the only source of truth for them. This closes a real bug: a stale backup restore or cross-device sync could silently bring back an event you'd already deleted. Existing backup files with events in them still restore fine — the events field is now just ignored.",
    ],
  },
  {
    version: '1.46.0',
    date: '2026-08-01',
    title: 'Completed-task and Google Calendar sync fixes, plus a contrast pass',
    changes: [
      'Completing a task today, then hitting "Reschedule" or "Plan today", used to wipe that task\'s block for today entirely. Rescheduling now leaves a completed task\'s block for today untouched.',
      'Deleting a task whose scheduled block had synced to Google Calendar removed it from Taskflow but left the event on Google Calendar, which could then reappear locally. Deleting a task now also removes its Google Calendar event.',
      "Google Calendar sync used to need a fresh login popup whenever its short-lived connection expired, most noticeably right after refreshing the page. It now stays connected in the background and silently renews itself. Reordered the Google Calendar buttons so \"Push\" comes after \"Pull from Google Calendar\".",
      'Several shades of gray, red, orange, blue and green text in light mode (secondary descriptions, priority badges, error/warning/success text, visited links) were too faint to read comfortably. They\'re now darker and meet accessibility contrast standards.',
      'Settings → Integrations now has a "Disconnect" button next to "Push" for Google Calendar, which properly revokes access at Google (not just locally). "Push" now sits on its own row below the connection status/Pull buttons.',
    ],
  },
  {
    version: '1.45.0',
    date: '2026-08-01',
    title: 'Calendar event fixes, cleaner Settings, and account/backup bug fixes',
    changes: [
      'Deleting a Google Calendar-synced event could occasionally reappear a few seconds later and pop its edit window back open, if a calendar refresh landed before Google had finished processing the delete — deleting one now sticks the first time.',
      'Events on the calendar now show their time range under the title, matching how scheduled task blocks already look. Dragging an event or task block to reschedule it now makes the item you\'re dragging more transparent and highlights the drop-target preview more clearly.',
      'The "not connected" status pills in Settings (Todoist standalone mode, Claude/Gemini key not set) no longer show a circle icon and now use the app\'s neutral theme color instead of blue.',
      'Email notifications (Settings → Notifications) were silently failing to send, with no error anywhere — now fixed. Since this app has no verified email domain, notifications go to one fixed address you configure once, not to your account\'s own sign-in email.',
      'Signing out and signing into a different account no longer leaves the previous account\'s tasks/settings behind — signing out now clears local data so the next sign-in starts clean.',
      'Restoring a downloaded backup always failed with "Invalid backup file", even right after exporting it — scheduling rules were checked against the wrong internal shape. Backup export/import now works again.',
    ],
  },
  {
    version: '1.44.0',
    date: '2026-07-31',
    title: 'Completed-task visibility in search, due-date scheduling fix, and smarter fixed-time parsing',
    changes: [
      'Searching from the List view or the Ctrl+K command palette no longer surfaces completed tasks unless you\'re already viewing the "Completed" tab in List view. The search bar\'s suggestion dropdown now shows a "Show completed tasks" option when a search has completed matches.',
      'Tasks with "Enforce due date" turned on were sometimes scheduled into today\'s plan even when today wasn\'t their due date — the "Plan my day" scheduler now correctly leaves them for their actual due date.',
      'A bare number in a task title (e.g. "at 9") is no longer misread as a fixed time — it now needs an am/pm or minutes to be detected, and a standalone time with am/pm now works without the word "at" too. Fixed a bug where dismissing a smart-parsed suggestion, then editing to a different value of the same kind, could leave the original suggestion permanently stuck. Checking the "Fixed time" box no longer silently defaults to 9:00am — it starts blank, and Add/Save now blocks with a message until you actually pick a time.',
    ],
  },
  {
    version: '1.43.0',
    date: '2026-07-31',
    title: 'Undo for event creation, keep completed recurring tasks visible, dashboard/stats reorg, mobile calendar swipe carousel',
    changes: [
      'Creating a calendar event now shows an "Undo" notification, matching editing and deleting events.',
      "Completing a recurring task no longer immediately removes it from Today's agenda and the calendar — it now stays visible, crossed out, as a completed record before rolling over to its next occurrence.",
      'Dashboard: "Overdue" and "Missed" are now one combined stat tile, and a new "Completed today" tile was added.',
      'Stats page: added task-count tiles (active, due today, overdue & missed, completed today, total completed) and split the page into "Time & hours" and "Task counts" sections.',
      'Mobile: the dashboard\'s search button moved from the top bar to a floating button in the bottom-right corner, matching the "Add task" button style.',
      'Mobile: fixed a slight left/right spacing mismatch caused by the scrollbar reserving space on narrow screens — scrollbars no longer take up layout space on mobile.',
      'Mobile calendar: swiping between days/weeks/months now follows your finger live and settles onto whichever page you dragged to, instead of jumping straight there once a swipe is detected.',
      'The event description box starts about 50% taller before it scrolls.',
    ],
  },
  {
    version: '1.42.0',
    date: '2026-07-31',
    title: 'Scheduler, search, and calendar-event polish',
    changes: [
      "The timer option no longer shows on a parent task that has sub-tasks, since sub-tasks should be completed first.",
      "The scheduler no longer splits a task's last few leftover minutes into their own separate tiny block when a day's free time didn't line up evenly with the task's length.",
      'The search bar dropdown no longer suggests already-completed tasks — jumping to a finished task from search wasn\'t useful, so results now only show open tasks.',
      "The scheduler was only treating a repeating synced calendar event (e.g. a weekly class) as busy time on its very first occurrence — every later occurrence looked like open time and could get a task block scheduled right on top of it. It now correctly blocks out every occurrence.",
      'Deleting a calendar event now shows an "Undo" toast for a few seconds, so an accidental delete (including on a recurring event\'s "this"/"following" scope) can be reversed instead of being permanent right away.',
      'Smart parse can now pick up an exact time of day (e.g. "at 5pm", "at 12:30", "at 9") typed into a task title and sets it as the task\'s fixed time — independent of any due date, and independent of the existing "on the day" option.',
      'Descriptions synced from Google Calendar (which can contain HTML formatting from rich-text invites) are now converted to plain, readable text instead of showing raw HTML tags. The calendar event editing modal is a bit wider on desktop. Dragging a scheduled block on the calendar now keeps it centered under your cursor/finger, instead of snapping so the block\'s top edge lines up with the cursor.',
    ],
  },
  {
    version: '1.41.0',
    date: '2026-07-31',
    title: 'Fixed mobile drag crash, notification timing, and floating Add-task button',
    changes: [
      'Fixed a bug where long-pressing a calendar block, event, or unscheduled task on a phone or tablet to drag it could fail silently instead of starting the drag.',
      "Email and in-app notifications (overdue, due today, starting soon) now use your device's own timezone instead of always assuming UTC, so they no longer fire on the wrong day or at the wrong time if you're not in UTC.",
      'The "Add task" and "AI Quick Add" buttons in the Tasks list and Board views now float in the bottom-right corner on desktop too, matching the mobile layout.',
      "Completed tasks now stay visible (with a crossed-out, faded style) on Today's Agenda and the calendar instead of just disappearing, including a distinct amber accent for tasks completed after their scheduled time. Completed blocks can no longer be accidentally dragged or resized on the calendar.",
    ],
  },
  {
    version: '1.40.0',
    date: '2026-07-31',
    title: 'Recurring-task scheduling, and several small mobile/logic fixes',
    changes: [
      'A recurring task (e.g. "every Mon/Wed/Fri" or "every day") now actually gets scheduled on each of those days, instead of only showing up once per cycle. The task detail view now shows a small "completed X of the last 7 days" readout for recurring tasks.',
      'Board view (Tasks → Board) now displays correctly on phone-width screens — a CSS quirk was collapsing it into a near-invisible scroll box instead of showing the stacked columns on the page.',
      'Titles like "Read chapter 4 for 3.5 hours" no longer have the "3.5" mistaken for a date and silently stripped out as a due date instead of being read as a duration.',
      'A task with only overdue/stale scheduled blocks no longer shows a misleading 1-day bar sitting at today on the Gantt chart — it\'s now omitted instead.',
      'Reduced background blur behind modals on smaller screens, which was making scrolling inside them feel slightly laggy. General performance tuning for the task detail modal and task list so editing a task no longer causes the whole list underneath it to redo unnecessary work.',
    ],
  },
  {
    version: '1.39.0',
    date: '2026-07-31',
    title: 'Reduced-motion override, and a cleaner Google Calendar settings row',
    changes: [
      'Turning on Settings → Interface animations now shows motion even if your device has a system-wide "reduce motion" preference on — previously the OS setting silently won and animations stayed off no matter what.',
      'The "Push scheduled blocks to Google Calendar" button is now just labeled "Push", and only shows up once you\'ve actually connected Google Calendar. Fixed the Connect/Push buttons looking inconsistent — they now sit left-aligned together instead of Push stretching across the full row.',
    ],
  },
  {
    version: '1.38.0',
    date: '2026-07-31',
    title: 'A more polished feel: motion, hover previews, and a bit of depth',
    changes: [
      'Task list rows and board cards now glide into place when you complete, reorder, or filter tasks instead of snapping.',
      'Dragging or resizing a calendar block shows a live start–end time readout and a lifted "picked up" look while you drag.',
      'Hovering a calendar block, event, or Gantt row (desktop only) now shows a quick preview card with the full title, time, priority, and project when the text is too long to fit.',
      'Empty lists and widgets (no tasks, nothing scheduled, no notes) show a small icon instead of bare text, and the main view has a touch of background depth.',
      'All of the above is skipped automatically if you have Interface animations turned off in Settings.',
    ],
  },
  {
    version: '1.37.0',
    date: '2026-07-30',
    title: '"Plan today" — a lighter re-balance for just today, plus drag-to-schedule',
    changes: [
      'New "Plan today" button next to Re-balance schedule (Calendar toolbar, and the mobile FAB) fills only today\'s remaining free time by priority, without touching anything already scheduled on other days.',
      'You can now drag a task straight out of the new "Unscheduled" tray above the calendar grid onto any day to schedule it manually — works with touch (long-press to drag) too.',
    ],
  },
  {
    version: '1.36.0',
    date: '2026-07-30',
    title: 'Email notifications (self-hosted) and notification polish',
    changes: [
      'The notification system now has a server-side email half to go with in-app alerts: a scheduled backend worker can email you a task starting soon, overdue, or due today, even while TaskFlow isn\'t open. This is opt-in infrastructure you set up yourself (see notify-worker/README.md) with a free Resend account — it\'s not turned on by default for a fresh install.',
      'Confirmed the in-app and (self-deployed) email notifications always agree: same toggles, same "starting soon" threshold, same overdue re-notify pace, so switching a setting behaves identically on both channels.',
    ],
  },
  {
    version: '1.35.0',
    date: '2026-07-30',
    title: 'In-app notifications',
    changes: [
      'New Settings → Notifications section: turn on in-app alerts for a task starting soon (with a customizable "how many minutes ahead" threshold), a task becoming overdue, or a task due today.',
      "Alerts show up as your browser's native notification popup when permitted, falling back to TaskFlow's in-app toast otherwise — works whether the tab is focused or in the background.",
      'An overdue high/urgent priority task keeps re-notifying periodically until it\'s completed or rescheduled; lower-priority overdue tasks only notify once.',
    ],
  },
  {
    version: '1.34.0',
    date: '2026-07-30',
    title: 'Command palette: jump to anything with Ctrl+K',
    changes: [
      'Press Ctrl+K (or Cmd+K on Mac) anywhere to open a command palette that searches views, projects, and tasks, and runs quick actions like Add task, Re-balance schedule, and Toggle theme.',
      'On mobile, tap the new search icon in the Dashboard topbar to open the same palette.',
      "The shortcut is listed and customizable from Settings → Keyboard shortcuts, same as the others.",
    ],
  },
  {
    version: '1.33.0',
    date: '2026-07-30',
    title: 'Click a note to read the whole thing',
    changes: [
      "Note tiles truncate long bodies to 2 lines — clicking a tile's text now opens it in a read-only modal showing the full title and body, links still clickable. Editing and removing a note still work the same way via their corner buttons.",
    ],
  },
  {
    version: '1.32.0',
    date: '2026-07-30',
    title: 'Dead-end fixes: AI Quick Add and Gantt now point you to the fix',
    changes: [
      "AI Quick Add's \"no API key\" message now has an \"Open Settings\" button that jumps straight to Integrations, instead of just telling you where to go.",
      "Gantt view's empty state now has a working \"Re-balance schedule\" button, so you don't have to switch to Calendar to populate it.",
    ],
  },
  {
    version: '1.31.0',
    date: '2026-07-30',
    title: 'Scheduler clears blocking tasks faster',
    changes: [
      "A task that other work depends on now greedily fills each day's free time instead of splitting it evenly with unrelated tasks of similar priority — so it finishes sooner and unblocks whatever's waiting on it.",
    ],
  },
  {
    version: '1.30.0',
    date: '2026-07-30',
    title: 'Pinned links are now Notes',
    changes: [
      "Replaced the dashboard's Pinned Links widget with Notes: each note is a title plus a freeform text body instead of just a bookmark, still organized into the same folders. Paste a link into a note's body and it still auto-formats into a clickable link, just like in a task's description.",
      'Existing pinned links and folders migrate automatically into notes the first time you load this version — nothing to do on your end.',
      'Importing a browser bookmarks export still works, now creating one note per bookmark.',
    ],
  },
  {
    version: '1.29.0',
    date: '2026-07-30',
    title: 'Smarter scheduling around task dependencies, tidier mobile calendar toolbar',
    changes: [
      "The scheduler now factors dependencies into urgency, not just as an on/off gate: if a task is blocking something due soon, that pressure carries back onto the blocker so it gets scheduled sooner instead of waiting behind unrelated equal-priority work.",
      'On mobile, moved the "Re-balance schedule" button off the calendar toolbar (it was eating a full row) and into the "+" button in the bottom-right, which now expands into a small menu with Re-balance schedule and New event options.',
    ],
  },
  {
    version: '1.28.0',
    date: '2026-07-30',
    title: 'Sub-tasks now show up on the Gantt chart',
    changes: [
      "Fixed sub-tasks (and their parent tasks) disappearing entirely from the Gantt view — each sub-task now gets its own row, showing its parent task's name underneath for context. The parent itself no longer gets a row, since it has no scheduled work of its own.",
    ],
  },
  {
    version: '1.27.0',
    date: '2026-07-30',
    title: 'A more satisfying delete sound, a few new animations, and mobile button fixes',
    changes: [
      'Replaced the delete sound effect with a crisper, more satisfying click.',
      'Added small polish animations: AI Quick Add\'s mobile mini-buttons now pop in instead of appearing instantly, and tapping AI Quick Add without an API key saved gives a quick "shake" alongside the reminder toast.',
      'AI Quick Add is no longer allowed to open without an API key saved (on mobile it previously could) — the button stays visible either way, but now shows a reminder toast instead of opening a modal that would just fail later.',
      'Fixed the "Push scheduled blocks to Google Calendar" button wrapping into a centered, jagged two-line label on mobile — it now stacks full-width and left-aligns, and no longer stretches full-width unnecessarily on the wider range of mobile screens where its label fits on one line.',
    ],
  },
  {
    version: '1.26.0',
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
    version: '1.25.0',
    date: '2026-07-30',
    title: 'Home-screen icons and balanced sound volumes',
    changes: [
      'Added proper 192x192 and 512x512 app icons to the install manifest, so Android/Chrome "Add to Home Screen" installs get a real icon instead of falling back to a generic one.',
      'Normalized the loudness of the add/complete/delete sound effects so none plays noticeably louder or quieter than the others at the same volume setting.',
    ],
  },
  {
    version: '1.24.0',
    date: '2026-07-30',
    title: 'AI Quick Add can now plan and organize your whole workspace',
    changes: [
      'AI Quick Add went from creating one task or event at a time to proposing a full set of changes in one request: creating tasks and events, breaking a task into subtasks, setting up dependencies ("do X after Y"), moving tasks between projects/sections, and creating/renaming/deleting projects, sections, and labels.',
      'Nothing is applied automatically — every request opens a new review screen listing each proposed change individually with a checkbox, so you can uncheck anything you don\'t want before applying.',
      'The AI now defaults to creating tasks (even ones with a deadline) rather than calendar events — events are reserved for things that must happen at a fixed real-world time regardless of workload, since this app\'s own scheduler already decides when task work actually gets done.',
      'Added a model picker next to the provider choice, defaulting to the fastest/cheapest model with reasoning enabled for each provider (Claude Haiku 4.5 / Gemini 3.5 Flash-Lite) — pick a stronger model from the same dropdown for harder requests. A provider you haven\'t added an API key for yet is disabled instead of erroring after the fact.',
      'Shows an approximate token count before you submit, and gives a specific message (with a "switch provider" shortcut where it helps) when a request hits a rate limit, quota, or context-size limit, instead of one generic failure.',
      'Fixed a bug where a proposed plan containing a dependency cycle (e.g. two tasks each depending on the other) could crash the review screen entirely instead of just flagging the cyclic tasks as invalid. A rejected Gemini API key now shows the same "check it in Settings" message as other providers, instead of a generic upstream-error message.',
    ],
  },
  {
    version: '1.23.0',
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
    version: '1.22.0',
    date: '2026-07-30',
    title: 'AI Quick Add button regrouped, mobile speed-dial',
    changes: [
      'The AI Quick Add sparkle button now sits directly next to "Add task" instead of floating with a gap between them.',
      'On mobile, the floating "Add task" button now expands into two mini-buttons (AI Quick Add and Add task) when tapped, instead of AI Quick Add needing its own separate spot in the toolbar.',
    ],
  },
  {
    version: '1.21.0',
    date: '2026-07-30',
    title: 'Shorter "What\'s New" panel, and a toolbar height fix',
    changes: [
      'Settings → Versions now only shows the 2 newest versions by default, with a "See more versions" button to load the full history instead of always scrolling through everything at once.',
      'The search bar next to the AI Quick Add and Add task buttons was still a couple pixels shorter than both, despite an earlier alignment fix — now matches their height exactly.',
    ],
  },
  {
    version: '1.20.0',
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
    version: '1.19.0',
    date: '2026-07-30',
    title: 'Home-screen install support',
    changes: [
      'Launching TaskFlow from a phone home-screen icon now hides the browser address bar/chrome, so it feels like a native app.',
      'Mobile visitors now see a one-time reminder that TaskFlow can be added to their home screen for a full-screen app experience, with instructions for their platform (also available anytime from Settings → Install app).',
      'Fixed a white strip below the bottom nav bar and a green strip at the top that clashed with the app background when installed to a phone home screen, and fixed the home-screen icon showing blank on iOS instead of TaskFlow\'s logo.',
    ],
  },
  {
    version: '1.18.0',
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
    version: '1.17.0',
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
    version: '1.16.0',
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
      'Fixed the New task shortcut sometimes reopening "Add task" by itself when switching back to the Tasks tab, and changed its default from Ctrl+N to Alt+N — Ctrl+N is reserved by the browser. Rebind it from Settings → Keyboard shortcuts if you\'d like something else.',
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
      'Undoing a change (via the bottom-corner Undo notification) now updates an already-open task edit screen immediately, instead of requiring you to close and reopen it to see the reverted value. Also fixed a bug where the docs describing the top-bar/keyboard-shortcuts rework had gone stale.',
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

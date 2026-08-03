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

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
    version: '1.33.54',
    date: '2026-08-01',
    title: 'Capped how far back on-demand calendar browsing keeps history',
    changes: [
      "Scrolling far enough back in the calendar view could keep that history synced indefinitely, regardless of age. Retention is now capped at a rolling 1 year — once-viewed events older than a year are cleared out again on the next sync, same as anything never explicitly viewed.",
    ],
  },
  {
    version: '1.33.53',
    date: '2026-08-01',
    title: 'Google Calendar sync now stays lightweight, and widens itself as you browse',
    changes: [
      'Background Google Calendar sync now keeps a modest rolling window (30 days back, 30 days forward) fresh automatically, instead of pulling a full year of history on every ~1-minute refresh — a big improvement in how much needs fetching for a range most sessions never even look at.',
      "Scrolling the calendar view to a date outside that window now fetches the events for that range on demand — no need to disconnect/reconnect or wait for a routine sync. Once fetched, it stays synced for the rest of the session, including if you navigate back to today afterward.",
    ],
  },
  {
    version: '1.33.52',
    date: '2026-08-01',
    title: "Fixed a calendar that could go completely missing from sync once a year of history was included",
    changes: [
      "After extending Google Calendar sync to cover a year of history, a calendar with a lot of events (e.g. your own primary calendar, as opposed to a lighter subscribed one) could silently disappear from Taskflow entirely — including the current week — because Google only returns up to 250 events per request and Taskflow wasn't asking for the rest. Taskflow now fetches every page of results, so a busy calendar's events (past, present, and future) show up completely again.",
    ],
  },
  {
    version: '1.33.51',
    date: '2026-08-01',
    title: 'Automatic daily cloud backups, and clearer sync explanations',
    changes: [
      'TaskFlow now automatically takes a cloud backup once a day while you\'re signed in, keeping the last 14 (older automatic ones are pruned to make room) — backups you create yourself with "Back up now" are kept forever and never affected by this.',
      'Settings now explains the sync/backup picture more clearly: tasks, boards, and settings sync live across your devices in the background, calendar events sync only through your connected Google Calendar account (not the live sync), and backups are a separate point-in-time safety net for everything, including events.',
    ],
  },
  {
    version: '1.33.50',
    date: '2026-08-01',
    title: 'Search bars now float as you scroll',
    changes: [
      'The search bar on the Tasks list, Board, and Settings pages now stays within reach as you scroll down — it floats near the top of the page with a small gap instead of scrolling out of view, on both mobile and desktop.',
    ],
  },
  {
    version: '1.33.49',
    date: '2026-08-01',
    title: 'Calendar events are now included in backups',
    changes: [
      "Exporting a backup file, or creating a cloud backup snapshot, now includes your calendar events (Google Calendar bookings and blocked-time entries), so restoring an old backup brings your calendar back too. Live cross-device sync is unaffected — Google Calendar itself stays the sole source of truth there, only point-in-time backups now carry a copy as a safety net.",
    ],
  },
  {
    version: '1.33.48',
    date: '2026-08-01',
    title: 'Google Calendar sync now includes a year of history, and disabled Repeat controls now say why',
    changes: [
      "Google Calendar sync used to only ever look forward from today, so a change made to a past event on Google Calendar (creating or deleting one) never reached Taskflow no matter how long you waited. Sync now covers a full year back (in addition to the existing ~1 month ahead), and a non-recurring event that eventually ages past that year is automatically cleared out of Taskflow (it's untouched on Google Calendar itself — only the local copy is pruned).",
      'Disabled Repeat controls in the event edit screen (shown when "Apply to" isn\'t set to "All events in the series") now show a small explanation when clicked instead of silently doing nothing, and look visibly greyed out.',
    ],
  },
  {
    version: '1.33.47',
    date: '2026-08-01',
    title: 'Fixed misleading hint text for editing a recurring event\'s repeat pattern',
    changes: [
      'The event edit screen\'s Repeat field pointed to "the scope below" for enabling repeat-pattern edits on an existing series, but "Apply to" had already been moved above it in the previous update — the hint now correctly says "above".',
    ],
  },
  {
    version: '1.33.46',
    date: '2026-08-01',
    title: 'Fixed an enforce-due-date task getting permanently stuck on a stale past time slot',
    changes: [
      "A task set to \"must be done on due date\" could get stuck showing a scheduled time in the past that Reschedule/Plan today could never move, even with its due date pushed into the future. The scheduler was treating any leftover block dated before today as untouchable, unworked-on hours already \"spent\" — which could zero out the task's remaining time and silently exclude it from being replanned. Stale, incomplete past blocks are now cleared and no longer counted as spent, so the task correctly reschedules onto its real due date; a genuinely completed task's past block is still preserved as before.",
    ],
  },
  {
    version: '1.33.45',
    date: '2026-08-01',
    title: 'Fixed editing/deleting a single occurrence of a recurring event that had been split in Google Calendar itself',
    changes: [
      "Taskflow used to guess the Google Calendar id of a single occurrence it was about to edit or delete, built from the recurring event's own id. That guess broke for a recurring event that had previously been split (\"this and following\") directly in Google Calendar's own interface, causing a real, confirmed failed delete against Google. Taskflow now looks up the occurrence's real id from Google first, so this works correctly even for a previously-split series.",
    ],
  },
  {
    version: '1.33.44',
    date: '2026-08-01',
    title: 'Fixed deleted/moved recurring-event occurrences reappearing every sync, including after a Rebuild',
    changes: [
      "Found the actual root cause of occurrences reappearing: Google reports a cancelled or moved single occurrence of a recurring event as its own separate item, not reliably as a change to the recurring event's own text — Taskflow was only ever reading the text form, so the exclusion was silently lost on every sync (even a full \"Rebuild from Google Calendar\"), and the occurrence kept coming back. Taskflow now reads Google's actual per-occurrence signal directly, so a deleted or moved occurrence stays gone.",
    ],
  },
  {
    version: '1.33.43',
    date: '2026-08-01',
    title: 'Fixed a single-occurrence Google Calendar delete that could silently never actually happen, plus a Repeat-editor field-order fix',
    changes: [
      "Deleting one occurrence of a recurring Google Calendar event (\"Apply to: This event\") could look successful with no error, but never actually remove it on Google's side — it would then reappear once Taskflow trusted Google's copy again. A failed delete now correctly surfaces as a real error instead of being silently treated as \"already gone\".",
      'In the event edit screen, the "Apply to" scope picker (needed to enable editing an existing recurring event\'s Repeat pattern) was rendered below the Repeat field instead of above it, making it easy to miss why Repeat looked uneditable. Moved it above Repeat.',
    ],
  },
  {
    version: '1.33.42',
    date: '2026-08-01',
    title: 'Failed calendar deletes now tell you instead of silently coming back later; sync fetches no longer overlap',
    changes: [
      "If deleting an event (or an occurrence) from Google Calendar fails for a real reason — not because it was already gone — Taskflow now puts it back and shows an error explaining why, instead of quietly looking deleted and then reappearing on the next sync with no explanation.",
      'Fixed a rare race where two Google Calendar syncs running at the same time (e.g. clicking "Pull" right as a background sync was already running) could let an older, slower fetch overwrite a newer one — now only one sync runs at a time, and starting another while one is in progress just lets you know it\'s already syncing.',
    ],
  },
  {
    version: '1.33.41',
    date: '2026-08-01',
    title: 'Fixed a deleted recurring-event occurrence sometimes reappearing after about a minute',
    changes: [
      'Deleting a single occurrence of a recurring Google Calendar event (e.g. skipping one week of a weekly event) could silently reappear roughly a minute later if Taskflow\'s background sync checked Google before the deletion had fully gone through there — it now waits out that short window before trusting Google\'s copy again, so the deleted occurrence stays gone.',
    ],
  },
  {
    version: '1.33.40',
    date: '2026-08-01',
    title: 'Event repeat can now be edited (not just set at creation), with a smarter free-text box',
    changes: [
      'You can now add, edit, or remove a repeat pattern on an event you\'ve already created — previously "Repeat" only existed while creating a brand-new event.',
      'Replaced the "Every [number] [Day/Week/Month]" number + dropdown with a single free-text box (e.g. type "every 2 weeks"), matching the same smart autocomplete highlighting used elsewhere in Taskflow.',
      'Editing the repeat pattern on an event that\'s already part of a series only applies with "Apply to" set to "All events in the series", since a single occurrence or a "following" split doesn\'t have its own separate cadence.',
    ],
  },
  {
    version: '1.33.39',
    date: '2026-08-01',
    title: 'Fixed one-off Google Calendar events not deleting cleanly, and deleting a whole recurring series',
    changes: [
      'Fixed a bug where a Google Calendar fetch could silently exclude events landing exactly on the last day of the sync window, which made a live event on that day look Google-side-deleted and get removed from Taskflow.',
      'Fixed a leftover "cancelled" event record Google can return for a deleted single occurrence being mistaken for a still-live one-off event that then never really goes away.',
      'Fixed "Delete" → "All events in the series" on a recurring Google Calendar event silently doing nothing (This event / This and following were unaffected).',
    ],
  },
  {
    version: '1.33.38',
    date: '2026-08-01',
    title: 'Fixed deletions in Google Calendar not removing the event from Taskflow; added a manual "Rebuild from Google Calendar" option',
    changes: [
      'Fixed a bug where deleting an event directly in Google Calendar (one that was originally created in Taskflow) never removed it from Taskflow — it kept showing up until deleted manually here too. Newly-created and newly-synced events now stay fully two-way in sync, including deletions made on either side.',
      'Added "Rebuild from Google Calendar" in Settings → Calendar — a repeatable, on-demand full wipe-and-rebuild of your synced events from whatever Google currently has, for when stale/duplicate events won\'t clear with a normal Pull. (The earlier automatic one-time cleanup only ever ran once; this gives you a button instead.)',
    ],
  },
  {
    version: '1.33.37',
    date: '2026-08-01',
    title: 'Faster Google Calendar sync (~1 minute instead of ~5)',
    changes: [
      'Google Calendar syncs about every minute now instead of every 5, and also pulls immediately when you switch back to the Taskflow tab/window. Still not instant push-based sync (that would need a backend webhook), but changes show up much sooner.',
    ],
  },
  {
    version: '1.33.36',
    date: '2026-08-01',
    title: 'Fixed phantom recurring-event occurrences not on Google Calendar',
    changes: [
      'Fixed the real underlying cause of some Google Calendar recurring events showing occurrences in Taskflow that don\'t actually exist on Google — a cancelled or individually-moved occurrence of a recurring series (its "EXDATE") was being ignored, so Taskflow kept regenerating that date from the plain repeat rule as if nothing had changed.',
    ],
  },
  {
    version: '1.33.35',
    date: '2026-08-01',
    title: 'Calendar events no longer round-trip through backups/cloud sync',
    changes: [
      "Calendar events (Google-synced and local blocked-time alike) are no longer included in backup files, cloud backups, or cross-device sync — Google Calendar is now the only source of truth for them. This closes a real bug: a stale backup restore or cross-device sync could silently bring back an event you'd already deleted.",
      'Existing backup files with events in them still restore fine — the events field in them is now just ignored.',
    ],
  },
  {
    version: '1.33.34',
    date: '2026-08-01',
    title: 'More Google Calendar sync cleanup; smart "every ..." detection for new events',
    changes: [
      "Replaced the previous partial duplicate-event cleanup with a full one-time rebuild from Google Calendar on your next sync — this fixes leftover duplicate/orphaned events the partial version could still miss, at the cost of also clearing out any purely local blocked-time events that were never pushed to Google. You'll see a notice when it runs.",
      'Deleting an event (or a single occurrence of one) that turns out to already be gone on Google\'s side no longer shows a "failed to delete" error — that\'s the outcome a delete is going for anyway.',
      'Typing "every 2 weeks", "every Mon and Wed", etc. into a new event\'s title now auto-fills the Repeat field and strips the phrase from the title, the same as it already works for tasks.',
    ],
  },
  {
    version: '1.33.33',
    date: '2026-08-01',
    title: 'Fixed duplicate/reappearing Google Calendar events; added recurring events in Taskflow',
    changes: [
      'Fixed a bug where adding an event synced it to Google Calendar but then created a second duplicate copy in Taskflow on the next sync.',
      "The next sync after this update will do a one-time cleanup of any duplicate/stale events left over from that bug — you'll see a notice when it happens.",
      "If pushing a newly-added event to Google Calendar fails, you'll now see an error instead of it silently never showing up there.",
      'Events you create in Taskflow now render with the same styling as synced calendar events, instead of a red striped "blocked time" look.',
      'You can now create a recurring event directly in Taskflow (daily/weekly/monthly, with an optional end) — it syncs to Google Calendar as a real repeating event.',
    ],
  },
  {
    version: '1.33.32',
    date: '2026-08-01',
    title: 'Fixed recurring Google Calendar events reappearing after delete',
    changes: [
      'Deleting a recurring Google Calendar booking that repeats without a true recurrence rule (e.g. a weekly appointment synced as separate events) now removes the whole series — or just the occurrences from that date on, per the scope you pick — instead of only the one clicked occurrence, which used to come back on the next sync.',
    ],
  },
  {
    version: '1.33.31',
    date: '2026-08-01',
    title: 'Added a Google Calendar Disconnect button',
    changes: [
      'Settings → Integrations now has a "Disconnect" button next to "Push" for Google Calendar, which properly revokes access at Google (not just locally) rather than needing to do that manually from your Google account settings.',
      '"Push" now sits on its own row below the connection status/Pull buttons.',
    ],
  },
  {
    version: '1.33.30',
    date: '2026-08-01',
    title: 'Improved text contrast in light mode',
    changes: [
      'Several shades of gray, red, orange, blue and green text in light mode (secondary descriptions, priority badges, error/warning/success text, visited links) were too faint to read comfortably. They\'re now darker and meet accessibility contrast standards.',
    ],
  },
  {
    version: '1.33.29',
    date: '2026-08-01',
    title: 'Google Calendar now stays connected across page refreshes',
    changes: [
      "Google Calendar sync used to need a fresh login popup whenever its short-lived connection expired — most noticeably right after refreshing the page. It now stays connected in the background and silently renews itself, so reconnecting is only ever needed if you explicitly revoke access from your Google account.",
      'Settings → Integrations: reordered the Google Calendar buttons so "Push" comes after "Pull from Google Calendar" instead of before it.',
    ],
  },
  {
    version: '1.33.28',
    date: '2026-08-01',
    title: 'Fixed deleted tasks leaving stale Google Calendar events behind',
    changes: [
      'Deleting a task whose scheduled block had synced to Google Calendar removed it from Taskflow but left the event on Google Calendar, which could then reappear locally and need deleting a second time. Deleting a task now also removes its Google Calendar event.',
    ],
  },
  {
    version: '1.33.27',
    date: '2026-08-01',
    title: 'Fixed completed tasks disappearing from Today\'s Agenda after rescheduling',
    changes: [
      'Completing a task today, then hitting "Reschedule" or "Plan today", used to wipe that task\'s block for today entirely — it vanished from Today\'s Agenda and its calendar event instead of staying visible as completed. Rescheduling now leaves a completed task\'s block for today untouched.',
    ],
  },
  {
    version: '1.33.26',
    date: '2026-08-01',
    title: 'Fixed "Invalid backup file" on every backup restore',
    changes: [
      'Restoring a downloaded backup always failed with "Invalid backup file", even right after exporting it — scheduling rules were checked against the wrong internal shape. Backup export/import now works again.',
    ],
  },
  {
    version: '1.33.25',
    date: '2026-08-01',
    title: 'Fixed old account data carrying over after switching accounts',
    changes: [
      'Signing out and signing into a different account no longer leaves the previous account\'s tasks/settings behind — signing out now clears local data so the next sign-in starts clean.',
    ],
  },
  {
    version: '1.33.24',
    date: '2026-08-01',
    title: 'Fixed email notifications not actually sending',
    changes: [
      'Email notifications (Settings → Notifications) were silently failing to send, with no error anywhere — now fixed. Since this app has no verified email domain, notifications go to one fixed address you configure once (see notify-worker/README.md), not to your account\'s own sign-in email; the Settings help text now explains this.',
    ],
  },
  {
    version: '1.33.23',
    date: '2026-08-01',
    title: 'Cleaner status pills in Settings',
    changes: [
      'The "not connected" status pills in Settings (Todoist standalone mode, Claude/Gemini key not set) no longer show a circle icon and now use the app\'s neutral theme color instead of blue.',
    ],
  },
  {
    version: '1.33.22',
    date: '2026-08-01',
    title: 'Calendar event times, and an easier-to-see drag preview',
    changes: [
      'Events on the calendar now show their time range under the title, matching how scheduled task blocks already look.',
      'Dragging an event or task block to reschedule it now makes the item you\'re dragging more transparent and highlights the drop-target preview more clearly, so it\'s easier to see where it will land.',
    ],
  },
  {
    version: '1.33.21',
    date: '2026-08-01',
    title: 'Fix a deleted Google Calendar event reappearing and reopening',
    changes: [
      'Deleting a Google Calendar-synced event could occasionally reappear a few seconds later and pop its edit window back open, if a calendar refresh landed before Google had finished processing the delete — deleting one now sticks the first time.',
    ],
  },
  {
    version: '1.33.20',
    date: '2026-07-31',
    title: 'Smart-parsed fixed times, and a proper "Fixed time" checkbox',
    changes: [
      'A bare number in a task title (e.g. "at 9") is no longer misread as a fixed time — a time now needs an am/pm (e.g. "9pm") or minutes to be detected.',
      'A standalone time with am/pm now works without the word "at" too — e.g. typing "5pm" or "9:10pm" anywhere in the title sets the task\'s fixed time.',
      'Fixed a bug where dismissing a smart-parsed suggestion, then editing to a different value of the same kind, could leave the original suggestion permanently stuck and unable to re-trigger.',
      'Checking the "Fixed time" box no longer silently defaults to 9:00am — it starts blank, and Add/Save now blocks with a message until you actually pick a time.',
    ],
  },
  {
    version: '1.33.19',
    date: '2026-07-31',
    title: 'Fix "must be done on due date" tasks getting scheduled today',
    changes: [
      'Tasks with "Enforce due date" turned on were sometimes scheduled into today\'s plan even when today wasn\'t their due date — the "Plan my day" scheduler now correctly leaves them for their actual due date.',
    ],
  },
  {
    version: '1.33.18',
    date: '2026-07-31',
    title: 'Completed tasks hidden from search by default',
    changes: [
      'Searching from the List view or the Ctrl+K command palette no longer surfaces completed tasks unless you\'re already viewing the "Completed" tab in List view.',
      'The search bar\'s suggestion dropdown now shows a "Show completed tasks" option when a search has completed matches, so you can still find one if you need to.',
    ],
  },
  {
    version: '1.33.17',
    date: '2026-07-31',
    title: 'Undo event creation, fix recurring completions vanishing, dashboard/stats stat tiles',
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
    version: '1.33.16',
    date: '2026-07-31',
    title: 'Cleaner synced event descriptions, wider event modal, drag fix',
    changes: [
      'Descriptions synced from Google Calendar (which can contain HTML formatting from rich-text invites) are now converted to plain, readable text instead of showing raw HTML tags.',
      'The calendar event editing modal is a bit wider on desktop.',
      'Dragging a scheduled block on the calendar now keeps it centered under your cursor/finger, instead of snapping so the block\'s top edge lines up with the cursor.',
    ],
  },
  {
    version: '1.33.15',
    date: '2026-07-31',
    title: 'Smart parse: exact time of day',
    changes: [
      'Smart parse can now pick up an exact time of day (e.g. "at 5pm", "at 12:30", "at 9") typed into a task title and sets it as the task\'s fixed time — independent of any due date, and independent of the existing "on the day" option.',
    ],
  },
  {
    version: '1.33.14',
    date: '2026-07-31',
    title: 'Undo calendar event deletes',
    changes: [
      'Deleting a calendar event now shows an "Undo" toast for a few seconds, so an accidental delete (including on a recurring event\'s "this"/"following" scope) can be reversed instead of being permanent right away.',
    ],
  },
  {
    version: '1.33.13',
    date: '2026-07-31',
    title: 'Fix: scheduler ignoring repeating calendar events',
    changes: [
      "The scheduler was only treating a repeating synced calendar event (e.g. a weekly class) as busy time on its very first occurrence — every later occurrence looked like open time and could get a task block scheduled right on top of it. It now correctly blocks out every occurrence.",
    ],
  },
  {
    version: '1.33.12',
    date: '2026-07-31',
    title: 'Completed tasks no longer clutter search suggestions',
    changes: [
      'The search bar dropdown no longer suggests already-completed tasks — jumping to a finished task from search wasn\'t useful, so results now only show open tasks.',
    ],
  },
  {
    version: '1.33.11',
    date: '2026-07-31',
    title: 'Fix: scheduler scattering tiny leftover blocks',
    changes: [
      "The scheduler no longer splits a task's last few leftover minutes into their own separate tiny block (e.g. a stray 5-minute block next to the real one) when a day's free time didn't line up evenly with the task's length — that leftover now either merges into a real block or rolls over, instead of appearing as its own sliver.",
    ],
  },
  {
    version: '1.33.10',
    date: '2026-07-31',
    title: 'Fix: timer hidden on parent tasks',
    changes: [
      "The timer option no longer shows on a parent task that has sub-tasks, since sub-tasks should be completed first — timing the parent directly didn't make sense while it had children.",
    ],
  },
  {
    version: '1.33.9',
    date: '2026-07-31',
    title: 'Completed tasks stay visible on the calendar',
    changes: [
      "Completed tasks now stay visible (with a crossed-out, faded style) on Today's Agenda and the calendar instead of just disappearing, so you can see what you finished — including a distinct amber accent for tasks completed after their scheduled time.",
      'Completed blocks can no longer be accidentally dragged or resized on the calendar.',
    ],
  },
  {
    version: '1.33.8',
    date: '2026-07-31',
    title: 'Floating "Add task" button on desktop',
    changes: [
      'The "Add task" and "AI Quick Add" buttons in the Tasks list and Board views now float in the bottom-right corner on desktop too, matching the mobile layout, instead of sitting inline in the toolbar.',
    ],
  },
  {
    version: '1.33.7',
    date: '2026-07-31',
    title: 'Fix: notification timing for users outside UTC',
    changes: [
      "Email and in-app notifications (overdue, due today, starting soon) now use your device's own timezone instead of always assuming UTC, so they no longer fire on the wrong day or at the wrong time if you're not in UTC.",
    ],
  },
  {
    version: '1.33.6',
    date: '2026-07-31',
    title: 'Fixed broken drag on mobile calendar',
    changes: [
      'Fixed a bug where long-pressing a calendar block, event, or unscheduled task on a phone or tablet to drag it could fail silently instead of starting the drag.',
    ],
  },
  {
    version: '1.33.5',
    date: '2026-07-31',
    title: 'Smoother scrolling on mobile',
    changes: [
      'Reduced background blur behind modals on smaller screens, which was making scrolling inside them (e.g. the task detail view) feel slightly laggy.',
      'General performance tuning for the task detail modal and task list so editing a task no longer causes the whole list underneath it to redo unnecessary work.',
    ],
  },
  {
    version: '1.33.4',
    date: '2026-07-31',
    title: 'Fix: stale Gantt bars showing at "today"',
    changes: [
      'A task with only overdue/stale scheduled blocks no longer shows a misleading 1-day bar sitting at today on the Gantt chart — it\'s now omitted instead.',
    ],
  },
  {
    version: '1.33.3',
    date: '2026-07-31',
    title: 'Fix: decimal durations misread as dates',
    changes: [
      'Titles like "Read chapter 4 for 3.5 hours" no longer have the "3.5" mistaken for a date (e.g. 3rd of May) and silently stripped out as a due date instead of being read as a duration.',
    ],
  },
  {
    version: '1.33.2',
    date: '2026-07-31',
    title: 'Fix: Board view not showing on mobile',
    changes: [
      'Board view (Tasks → Board) now displays correctly on phone-width screens — a CSS quirk was collapsing it into a near-invisible scroll box instead of showing the stacked columns on the page.',
    ],
  },
  {
    version: '1.33.1',
    date: '2026-07-31',
    title: 'Recurring tasks now schedule every day they repeat',
    changes: [
      'A recurring task (e.g. "every Mon/Wed/Fri" or "every day") now actually gets scheduled on each of those days, instead of only showing up once per cycle.',
      'The task detail view now shows a small "completed X of the last 7 days" readout for recurring tasks, so you can see recent completion activity at a glance.',
    ],
  },
  {
    version: '1.32.2',
    date: '2026-07-31',
    title: 'Cleaner Google Calendar settings row',
    changes: [
      'The "Push scheduled blocks to Google Calendar" button is now just labeled "Push", and only shows up once you\'ve actually connected Google Calendar.',
      'Fixed the Connect/Push buttons looking inconsistent — they now sit left-aligned together instead of Push stretching across the full row.',
    ],
  },
  {
    version: '1.32.1',
    date: '2026-07-31',
    title: 'Interface animations now override reduced-motion at the OS level',
    changes: [
      'Turning on Settings → Interface animations now shows motion even if your device has a system-wide "reduce motion" preference on — previously the OS setting silently won and animations stayed off no matter what.',
    ],
  },
  {
    version: '1.32.0',
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
    version: '1.31.0',
    date: '2026-07-30',
    title: '"Plan today" — a lighter re-balance for just today, plus drag-to-schedule',
    changes: [
      'New "Plan today" button next to Re-balance schedule (Calendar toolbar, and the mobile FAB) fills only today\'s remaining free time by priority, without touching anything already scheduled on other days.',
      'You can now drag a task straight out of the new "Unscheduled" tray above the calendar grid onto any day to schedule it manually — works with touch (long-press to drag) too.',
    ],
  },
  {
    version: '1.30.0',
    date: '2026-07-30',
    title: 'Email notifications (self-hosted) and notification polish',
    changes: [
      'The notification system now has a server-side email half to go with in-app alerts: a scheduled backend worker can email you a task starting soon, overdue, or due today, even while TaskFlow isn\'t open. This is opt-in infrastructure you set up yourself (see notify-worker/README.md) with a free Resend account — it\'s not turned on by default for a fresh install.',
      'Confirmed the in-app and (self-deployed) email notifications always agree: same toggles, same "starting soon" threshold, same overdue re-notify pace, so switching a setting behaves identically on both channels.',
    ],
  },
  {
    version: '1.29.0',
    date: '2026-07-30',
    title: 'In-app notifications',
    changes: [
      'New Settings → Notifications section: turn on in-app alerts for a task starting soon (with a customizable "how many minutes ahead" threshold), a task becoming overdue, or a task due today.',
      "Alerts show up as your browser's native notification popup when permitted, falling back to TaskFlow's in-app toast otherwise — works whether the tab is focused or in the background.",
      'An overdue high/urgent priority task keeps re-notifying periodically until it\'s completed or rescheduled; lower-priority overdue tasks only notify once.',
    ],
  },
  {
    version: '1.28.0',
    date: '2026-07-30',
    title: 'Command palette: jump to anything with Ctrl+K',
    changes: [
      'Press Ctrl+K (or Cmd+K on Mac) anywhere to open a command palette that searches views, projects, and tasks, and runs quick actions like Add task, Re-balance schedule, and Toggle theme.',
      'On mobile, tap the new search icon in the Dashboard topbar to open the same palette.',
      "The shortcut is listed and customizable from Settings → Keyboard shortcuts, same as the others.",
    ],
  },
  {
    version: '1.27.0',
    date: '2026-07-30',
    title: 'Click a note to read the whole thing',
    changes: [
      "Note tiles truncate long bodies to 2 lines — clicking a tile's text now opens it in a read-only modal showing the full title and body, links still clickable. Editing and removing a note still work the same way via their corner buttons.",
    ],
  },
  {
    version: '1.26.0',
    date: '2026-07-30',
    title: 'Dead-end fixes: AI Quick Add and Gantt now point you to the fix',
    changes: [
      "AI Quick Add's \"no API key\" message now has an \"Open Settings\" button that jumps straight to Integrations, instead of just telling you where to go.",
      "Gantt view's empty state now has a working \"Re-balance schedule\" button, so you don't have to switch to Calendar to populate it.",
    ],
  },
  {
    version: '1.25.0',
    date: '2026-07-30',
    title: 'Scheduler clears blocking tasks faster',
    changes: [
      "A task that other work depends on now greedily fills each day's free time instead of splitting it evenly with unrelated tasks of similar priority — so it finishes sooner and unblocks whatever's waiting on it.",
    ],
  },
  {
    version: '1.24.0',
    date: '2026-07-30',
    title: 'Pinned links are now Notes',
    changes: [
      "Replaced the dashboard's Pinned Links widget with Notes: each note is a title plus a freeform text body instead of just a bookmark, still organized into the same folders. Paste a link into a note's body and it still auto-formats into a clickable link, just like in a task's description.",
      'Existing pinned links and folders migrate automatically into notes the first time you load this version — nothing to do on your end.',
      'Importing a browser bookmarks export still works, now creating one note per bookmark.',
    ],
  },
  {
    version: '1.23.0',
    date: '2026-07-30',
    title: 'Smarter scheduling around task dependencies, tidier mobile calendar toolbar',
    changes: [
      "The scheduler now factors dependencies into urgency, not just as an on/off gate: if a task is blocking something due soon, that pressure carries back onto the blocker so it gets scheduled sooner instead of waiting behind unrelated equal-priority work.",
      'On mobile, moved the "Re-balance schedule" button off the calendar toolbar (it was eating a full row) and into the "+" button in the bottom-right, which now expands into a small menu with Re-balance schedule and New event options.',
    ],
  },
  {
    version: '1.22.0',
    date: '2026-07-30',
    title: 'Sub-tasks now show up on the Gantt chart',
    changes: [
      "Fixed sub-tasks (and their parent tasks) disappearing entirely from the Gantt view — each sub-task now gets its own row, showing its parent task's name underneath for context. The parent itself no longer gets a row, since it has no scheduled work of its own.",
    ],
  },
  {
    version: '1.21.0',
    date: '2026-07-30',
    title: 'Push-to-Google-Calendar button no longer stretches unnecessarily on mobile',
    changes: [
      'Fixed the "Push scheduled blocks to Google Calendar" button stretching full-width (with a large empty gap after the label) on most mobile screen sizes — it now only goes full-width on the narrow range of screens where its label actually wraps to two lines.',
    ],
  },
  {
    version: '1.20.0',
    date: '2026-07-30',
    title: 'A more satisfying delete sound, a few new animations, and a couple of fixes',
    changes: [
      'Replaced the delete sound effect with a crisper, more satisfying click.',
      'Added small polish animations: AI Quick Add\'s mobile mini-buttons now pop in instead of appearing instantly, and tapping AI Quick Add without an API key saved gives a quick "shake" alongside the reminder toast.',
      'AI Quick Add is no longer allowed to open without an API key saved (on mobile it previously could) — the button stays visible either way, but now shows a reminder toast instead of opening a modal that would just fail later.',
      'Fixed the "Push scheduled blocks to Google Calendar" button wrapping into a centered, jagged two-line label on mobile — it now stacks full-width and left-aligns.',
    ],
  },
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

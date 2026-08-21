# Known limitations

The honest list of what TaskFlow does not do, or does only partly. Each entry
says why, since most of them are deliberate trade-offs rather than gaps waiting
to be filled.


- Cross-device sync (see [Account & cross-device
  sync](SYNC-AND-SHARING.md#account--cross-device-sync)) is live for tasks/blocks/boards/
  settings — a change on device A shows up on an already-open device B
  within moments via a background Firestore listener, no reload needed.
  Calendar events are excluded from this sync entirely (Google Calendar is
  their one source of truth — see [Backups](SYNC-AND-SHARING.md#backups)) and Google Calendar sync
  itself is the exception: it stays poll-based (see the next bullet), so a
  change made directly in Google Calendar can still take up to about a
  minute to appear.
- Google Calendar sync is two-way but poll-based, not truly real-time —
  pulls happen on sign-in/connect, a ~1-minute background poll while
  connected, on returning to the tab/window, and manual **Sync now**, not
  via a live webhook (no backend exists for that in this client-only SPA),
  so a change made directly in Google Calendar can take up to about a
  minute to appear in TaskFlow rather than being instant. On conflict (the
  same event changed in both places since the last sync), **Google
  Calendar's version always wins** — a local edit that hasn't been pushed
  yet can be silently overwritten by the next pull.
- All-day Google Calendar events are not imported or synced — only timed
  events are.
- Google Calendar sync keeps a modest rolling window (30 days back, 30 days
  forward, centered on today) fresh automatically in the background — pulls
  don't cover the account's entire calendar every time, since that would
  mean a much larger fetch on every ~1-minute poll for a range most sessions
  never even look at. Scrolling the calendar view (Week/Month/etc.) to a date
  outside that window fetches the additional range on demand instead, and
  once fetched it stays synced for the rest of the session — navigating back
  to "today" afterward doesn't drop it again. Retention is capped at a
  rolling 1 year regardless: a non-recurring event older than that (whether
  never synced at all, or on-demand fetched from further back than a year)
  is actively removed from TaskFlow's local mirror on the next sync (it
  stays on Google Calendar itself, only the local mirror is pruned); a
  recurring event's own occurrences roll in and out of view as the window
  advances day by day.
- Today's scheduled task blocks are pushed to Google Calendar one-way only
  (TaskFlow → Google) and only for *today* — a task block for any other day
  is TaskFlow-only. Google is never a source of truth for these entries and
  TaskFlow never reads them back, so editing or deleting one directly in
  Google Calendar has no effect in TaskFlow; the next automatic sync simply
  overwrites it back to match TaskFlow's current schedule.
- Todoist is a one-time import, not a sync — completing, editing, or
  deleting a Todoist-imported task in TaskFlow never writes back to
  Todoist. Re-importing later pulls in anything new/changed on Todoist's
  side, but won't reflect changes made here.
- Reconnecting Google Calendar is only ever needed if you actually revoke
  TaskFlow's access at Google's end (myaccount.google.com/permissions) —
  the server-side refresh-token flow (see [Google
  Calendar](INTEGRATIONS.md#google-calendar)) means an ordinary page refresh or
  closed tab never triggers it. When a revoke does happen, Settings
  surfaces a distinct "reconnect" prompt rather than failing silently.
- Undo/Redo (`useHistoryState`) only covers `tasks` and `blocks`. Calendar
  events get the same Undo-toast affordance through a parallel mechanism
  (editing, dragging, or resizing one — including reverting the matching
  Google Calendar push — can be undone), but they're not part of the same
  transactional stack as tasks/blocks. Board sections, Todoist projects, and
  labels live in their own `useState` and are not undoable at all —
  renaming/deleting a Board column or clearing all data cannot currently be
  undone, only the task-side effects of those actions can. Tasks in shared
  projects are deliberately excluded from undo/redo too — undoing only
  affects your own data, since restoring an old snapshot could otherwise
  revert a collaborator's concurrent edits.
</content>

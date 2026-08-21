# Sync, backups, and sharing

Everything in this file is optional. TaskFlow works fully standalone with no
sign-in, saving to the current browser's `localStorage` — see
[Persistence](DEVELOPMENT.md#persistence). Signing in adds cross-device sync,
cloud backups, and shared projects on top of that.

- [Account & cross-device sync](#account--cross-device-sync)
- [Backups](#backups)
- [Sharing a project](#sharing-a-project)

## Account & cross-device sync

Sign in with Google from the account button (the sidebar on desktop, the
topbar on mobile) or from **Settings → Account & sync**. This adds
cross-device sync on top of local storage, backed by
[Firebase](https://firebase.google.com/) (Auth + Firestore).

**How it works:**

- On first sign-in on a device, if nothing has been synced yet, that
  device's current local data is uploaded to become the cloud copy.
- On every subsequent sign-in (e.g. opening TaskFlow on a second device and
  signing in with the same Google account), the cloud copy is pulled down
  and **overwrites** whatever was local on that device — this is what makes
  a phone and a computer converge onto the same data instead of keeping two
  separate copies.
- From then on, local changes are pushed to the cloud automatically a
  moment after you make them (a short debounce so a burst of edits doesn't
  fire a write per keystroke).
- Sync is **live** while signed in: a background Firestore listener picks up
  a change pushed from another signed-in device and applies it here too,
  usually within a few seconds — no reload needed. **Settings → Account &
  sync → Sync now** is still there as a manual fallback (and it's what
  refreshes Google Calendar events, which don't push live — see [Google
  Calendar](INTEGRATIONS.md#google-calendar)).
- Signing out just signs out of the account — no local data is deleted.

**Setup, for anyone running their own copy of this app** (not needed if
you're just using someone else's deployment — sign-in works out of the box
there):

1. [Firebase console](https://console.firebase.google.com/) → create a
   project.
2. **Build → Authentication → Get started → Sign-in method → Google** →
   enable it.
3. **Build → Firestore Database → Create database** → start in **production
   mode**.
4. Deploy the rules in [`firestore.rules`](../firestore.rules), which restrict
   each user's synced data to that user only — either:
   - CLI: `firebase use --add` (pick your project), then
     `firebase deploy --only firestore:rules`, or
   - Console: **Firestore Database → Rules** (not Realtime Database → Rules —
     a different product with its own JSON-based rules editor, listed
     separately in the sidebar) → paste in the contents of
     [`firestore.rules`](../firestore.rules) → **Publish**.
5. Deploy the Firestore **indexes**: `firebase deploy --only firestore:indexes`.
   Cloud backups need a composite index to enforce their retention limits —
   without it, every "Back up now" reports a failure even though the backup
   itself saved fine.
6. Project settings (gear icon) → scroll to "Your apps" → add a Web app →
   copy the `firebaseConfig` object it gives you into `src/firebase.js`,
   replacing the values already there.
7. Sign-in itself uses Google Identity Services (GIS) rather than Firebase's
   own popup/redirect (see `AuthContext.jsx` for why), so it needs the same
   `VITE_GOOGLE_CLIENT_ID` OAuth Client ID used for [Google
   Calendar](INTEGRATIONS.md#google-calendar) below — set that up too (steps 1-5 there),
   even if you don't care about Calendar sync itself.
8. **Only if you want shared projects** (see [Sharing a project](#sharing-a-project)):
   **Build → Authentication → Sign-in method → Anonymous** → enable it. This
   is what lets someone open a share link and participate without making an
   account — the rules need *some* stable identity to authorize their writes
   against. Leave it off and everything else still works; share links just
   won't be usable by signed-out visitors.

The `firebaseConfig` values (API key, project id, etc.) are not secrets —
they identify the project, they don't authorize access to it — so it's
normal for them to live directly in client-side code rather than `.env`,
unlike the Todoist/Google Calendar credentials below. Access control is
enforced entirely by the Firestore rules from step 4.

## Backups

Independent of cross-device sync, **Settings → Backups** lets you download a
full snapshot of your tasks, boards, and settings as a `.json` file, or
restore one back in — both work whether or not you're signed in, since the
file path never touches Firestore.

If you're signed in, TaskFlow also keeps point-in-time snapshots in your
account: a "Back up now" button for an on-demand snapshot, and an automatic
one taken once a day while you're signed in with cloud sync active. These
live separately from the live sync doc described above (`users/{uid}`, which
is just "current state" and gets overwritten on every change) in their own
`users/{uid}/backups/{backupId}` subcollection, so they're a genuine
rollback point even if a bad sync or an accidental bulk-delete already
propagated to the live doc. **View backups** in Settings lists your recent
snapshots (newest first, tagged "Automatic" or "Manual") to restore or delete.

Both automatic and "Back up now" snapshots keep a rolling 2-week window
each, but as two **independent** pools of 14, not one shared pool: the 14
most recent automatic snapshots are kept (older ones pruned right after each
new one is created), and separately, the 14 most recent manual snapshots are
kept too (older ones pruned right after you create a new one, or on the
next daily automatic-backup check). So up to 14 automatic + 14 manual can
exist side by side.

Restoring — from a file or from a cloud snapshot — replaces your current
tasks, boards, and settings on this device, and asks for confirmation
first, same as **Clear all data** below. Already-completed one-off tasks
aren't included in any backup (there's nothing to restore them to);
recurring tasks always are, since completing one occurrence doesn't mark
the task itself as done.

**Calendar events are included in backups, but still excluded from live
cross-device cloud sync.** Google Calendar remains the single source of
truth for synced events day-to-day — TaskFlow mirrors whatever Google
currently has via polling/pulling (see [Google Calendar](INTEGRATIONS.md#google-calendar)
below), and any purely local "blocked time" entry (never pushed to Google)
is device-local by design. Live-syncing events across devices too would let
a stale, continuously-reconciled snapshot silently resurrect an event you'd
already deleted (in TaskFlow or directly in Google Calendar) — exactly the
kind of duplicate/reappearing-event bug that exclusion exists to prevent.
A one-off backup restore doesn't share that risk (it's an explicit,
user-initiated, one-directional action rather than an automatic background
sync), so backups do capture your events as a point-in-time safety net —
restoring an old backup will bring back whatever events it had, which may
since have changed or been deleted in Google Calendar.

**Restoring a backup only ever changes local TaskFlow data — it never
touches your actual Google Calendar.** Since Google Calendar remains the
source of truth for the live sync (above), the very next periodic pull
would otherwise silently re-overwrite whatever calendar-related data a
restore brought back. If you want your Google Calendar itself to reflect
what you just restored (or generally want to fix a Google Calendar that's
drifted out of sync with TaskFlow), use **Settings → Integrations →
"Rewrite Google Calendar to match TaskFlow"** — a separate, explicit,
opt-in action (never run automatically by restore itself) that flips the
normal sync direction: TaskFlow's current data becomes authoritative, and
Google is updated to match, deleting any conflicting events. It's scoped
tightly for safety — it only ever touches your own **primary** Google
Calendar (never a calendar you've merely subscribed to or been shared,
like a shared team calendar or a university timetable) and only within the
date range your own tasks/events actually span. It asks for a clear
confirmation first, since — unlike everything else in this section — it
can delete real events on an external service that TaskFlow can't undo.

## Sharing a project

A project can be turned into a **shared project** that other people work in
with you, live. Open a project's "⋯" menu → **Share project**. From the share
dialog you can generate two independent links:

- a **view link** — recipients can read the project but not change anything;
- an **edit link** — recipients can add, edit, and complete tasks.

Each link can be **rotated** (issues a new URL and kills the old one),
**revoked** (turned off but kept, so you can re-enable it), **deleted**
outright, or given an **expiry date**. The same dialog lists everyone who has
joined, lets you change someone between viewer and editor, remove them, or
hand ownership of the project to another collaborator.

**Anyone opening a link joins without needing an account** — they're asked
once for a display name so their changes are attributable, and the project is
filed into their own project list so they never need the link again. That name
is remembered for this browser (rename it anytime from Settings), so joining a
second share link later — or just using TaskFlow signed out in general — never
asks again. Signing in with Google instead gets you the same project across
your own devices. (Guest participation requires Anonymous sign-in to be
enabled on the Firebase project — step 8 of
[Account & cross-device sync](#account--cross-device-sync).)

Every project row shows which of three states it's in: nothing at all for a
private project, **shared by you** (with who's in it) for one you own and have
shared, and **shared with you** (with the owner's name and your role) for one
you joined. The direction matters — "other people can see this" is worth being
certain about.

A few deliberate limits worth knowing:

- **Tasks, Board columns (sections), and per-task comments all sync live.**
  A viewer-role collaborator can look at a shared project's board but can't
  add, rename, or delete its columns.
- **Scheduled time blocks are never shared.** Dragging a shared task onto your
  calendar schedules it for *you* only, and by default shared tasks are left
  out of the automatic scheduler, since capacity is a per-person thing. The
  one exception: a task's "⋯" menu lets an editor **assign it to a specific
  collaborator** via a type-to-search box (including guests, not just
  signed-in accounts) or unassign it, and a task assigned to *you* is
  scheduled by Re-balance schedule against your own capacity like any other
  task — an unassigned task, or one assigned to someone else, still stays out
  of it. Typing "assign to Alex" or "for Alex" into a shared task's title
  smart-parses the assignment too, same as `#project` or `after <task>`.
- **If two people edit the same task at once, the last write wins** — there's no
  field-by-field merge. Editing different tasks never conflicts. The one
  exception is recurring-task completion, which merges properly rather than
  overwriting.
- Sharing requires a real account; a guest can join a shared project but can't
  create one.

Share links need the Cloudflare Worker deployed (see
[`cloudflare-worker/README.md`](../cloudflare-worker/README.md)) — the link tokens
are secrets that no browser is ever allowed to read, so generating and
redeeming them happens server-side.


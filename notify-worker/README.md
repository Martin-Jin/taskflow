# TaskFlow notify-worker — email notifications

Backend half of the notification system (TODO.md #10, Phase 3). A plain Node
script (`index.js`) checks every user who has email notifications enabled for
tasks/blocks that are starting soon, missed, overdue, or due today, and emails
them via [Resend](https://resend.com). It's invoked on a schedule by a GitHub
Actions workflow (`.github/workflows/notifications.yml`), not by Firebase —
see the comments in `index.js`, `src/computeNotifications.js`, and
`src/notificationState.js` for the trigger rules and duplicate-send-safety
design.

- **Due today** is sent as ONE consolidated digest email per user
  ("Good morning! Here are the tasks due today: ...") rather than one email
  per task, and only fires once the user's own `rules.workDayStart` (Settings
  → Scheduling rules) has passed for that day in their timezone — not on
  whatever post-midnight cron tick happens to run first.
- **Missed** is a new trigger distinct from overdue: it fires when a
  scheduled block's end time passes with the task still incomplete,
  regardless of the task's own due date — the email distinguishes "due today
  and missed" from "missed but not due today/overdue" and always includes
  the due date. Re-arms if the task is rescheduled and misses again.
- **Overdue** (task's own `dueDate` is in the past) fires **once per `dueDate`
  value**, not once per day the task stays overdue. It re-arms only when the
  due date genuinely changes, so a rescheduled-but-still-late task does get a
  fresh email. This replaced an earlier once-per-calendar-day rule that caused
  repeat emails for already-finished tasks: the client's `isCompleted` push is
  debounced and best-effort on tab teardown, so a completion could fail to
  reach Firestore, and the daily re-arm then re-sent the same overdue email
  every day indefinitely. Keying on `dueDate` makes the trigger independent of
  sync timing. Relatedly, the "clear stale overdue state" pass is driven by the
  `overdue_*` docs that actually exist in `notificationState` rather than by a
  walk over the tasks array — a completed task is skipped by that walk and a
  deleted task isn't in it at all, so both used to leak their state doc forever.
- **Starting soon** is unchanged: fires once a scheduled block's start time
  is within the user's configured threshold, re-arming on reschedule.

This deliberately does NOT use Firebase Cloud Functions. Cloud Functions v2
and Secret Manager (which the original design used for the Resend key) both
require upgrading the Firebase project to the Blaze (pay-as-you-go) plan,
even though actual usage here sits well inside every relevant free tier.
Running this as a plain script on GitHub Actions' cron avoids that entirely —
GitHub Actions minutes are unlimited and free on a public repo, and there's
no Firebase billing plan requirement at all with this approach.

Nothing here runs automatically until you set it up — follow the steps below.

**Single-recipient limitation, by design:** without a verified custom domain,
Resend's sandbox mode only allows sending from `onboarding@resend.dev` to the
Resend account's own verified owner email — never an arbitrary address.
Since TaskFlow is personal/single-user, `index.js` doesn't try to look up a
per-user email at all; every notification, for any user, goes to one fixed
address set via the `NOTIFICATION_RECIPIENT` secret below. If this app is
ever used by more than one person, that requires verifying a domain at
resend.com/domains and switching `SENDER` in `index.js` to an address on it —
not needed for personal use.

## 1. Get a free Resend API key

1. Sign up at [resend.com](https://resend.com) — the free tier (3,000
   emails/month, 100/day) is more than enough for a personal app.
2. No domain setup needed. This script sends from Resend's shared
   `onboarding@resend.dev` address, which works with zero verification as
   long as every email goes to the Resend account's own owner address (see
   the single-recipient note above).
3. From the Resend dashboard, go to **API Keys** and create one (the default
   "Sending access" key is fine). Copy it — it looks like `re_xxxxxxxx...`
   (that's a placeholder, not a real key).

## 2. Get a Firebase service-account key

This script needs Admin SDK credentials to read Firestore and look up user
emails, since it isn't running inside Firebase's own infrastructure anymore.

1. Go to the [Firebase Console](https://console.firebase.google.com/) →
   project `storagetrackerapp-7bc55` → **Project Settings** → **Service
   Accounts**.
2. Click **Generate new private key**. This downloads a JSON file.

**This JSON file is a highly sensitive credential** — it grants full Admin
SDK access to your Firebase project and bypasses ALL Firestore security
rules. Never commit it to the repo, never paste it anywhere except GitHub's
encrypted secret UI below, and don't share the file.

## 3. Add three GitHub encrypted secrets

In this repo on GitHub: **Settings → Secrets and variables → Actions → New
repository secret**. Add:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the entire contents of the
  downloaded service-account JSON file as the value.
- `RESEND_API_KEY` — paste the Resend API key from step 1.
- `NOTIFICATION_RECIPIENT` — the email address every notification is sent
  to. This must be the same address your Resend account is registered
  under (its owner email) — see the single-recipient note above; sending to
  any other address gets rejected by Resend's API.

These are encrypted at rest by GitHub and only ever injected as environment
variables into the workflow run — they're never printed to logs or exposed
to the repo's contents.

## 4. That's it — the workflow runs itself

`.github/workflows/notifications.yml` runs on a 5-minute cron
(`schedule: */5 * * * *`), checking for due notifications and emailing via
Resend. No further setup needed once the three secrets above exist.

**To test a single run manually:** go to this repo's **Actions** tab →
**Notifications** workflow → **Run workflow** button (this uses the
workflow's `workflow_dispatch` trigger). Check the run's logs for errors.

**Caveat — GitHub disables idle scheduled workflows:** GitHub automatically
disables a scheduled workflow after 60 days with no commits to the repo (not
60 days without a *run* — commits to anything in the repo count). If
TaskFlow goes quiet for two months, notifications will silently stop firing.
Re-enable it from the **Actions** tab → **Notifications** workflow → **Enable
workflow** button, or trigger a one-off run in the meantime with
`workflow_dispatch` as above.

## Notes

- No Firestore rules changes needed: the script runs with the Admin SDK
  (`admin.firestore()` / `admin.auth()`), which always has full read/write
  access regardless of `firestore.rules` — those rules only gate client SDK
  access.
- Dedupe/throttle state lives at `users/{uid}/notificationState/{stateId}`,
  a small subcollection this script owns exclusively. It's not part of
  local/cloud backups (`backupService.js`'s `BACKUP_FIELDS`) — it's just a
  "have we already emailed this" marker, not data worth restoring.
- If you ever rotate the Resend key or the service-account key, just update
  the corresponding GitHub secret's value — no code changes needed.

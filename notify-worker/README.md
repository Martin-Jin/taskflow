# TaskFlow notify-worker — email notifications

Backend half of the notification system (TODO.md #10, Phase 3). A plain Node
script (`index.js`) checks every user who has email notifications enabled for
tasks/blocks that are starting soon, overdue, or due today, and emails them
via [Resend](https://resend.com). It's invoked on a schedule by a GitHub
Actions workflow (`.github/workflows/notifications.yml`), not by Firebase —
see the comments in `index.js`, `src/computeNotifications.js`, and
`src/notificationState.js` for the trigger rules and duplicate-send-safety
design (all unchanged from the original design).

This deliberately does NOT use Firebase Cloud Functions. Cloud Functions v2
and Secret Manager (which the original design used for the Resend key) both
require upgrading the Firebase project to the Blaze (pay-as-you-go) plan,
even though actual usage here sits well inside every relevant free tier.
Running this as a plain script on GitHub Actions' cron avoids that entirely —
GitHub Actions minutes are unlimited and free on a public repo, and there's
no Firebase billing plan requirement at all with this approach.

Nothing here runs automatically until you set it up — follow the steps below.

## 1. Get a free Resend API key

1. Sign up at [resend.com](https://resend.com) — the free tier (3,000
   emails/month, 100/day) is more than enough for a personal app.
2. No domain setup needed. This script sends from Resend's shared
   `onboarding@resend.dev` address, which works with zero verification as
   long as every email goes to the Resend account's own owner address —
   exactly this script's use case (it only ever emails a TaskFlow user their
   own Firebase Auth account email, never anyone else).
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

## 3. Add both as GitHub encrypted secrets

In this repo on GitHub: **Settings → Secrets and variables → Actions → New
repository secret**. Add two:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the entire contents of the
  downloaded service-account JSON file as the value.
- `RESEND_API_KEY` — paste the Resend API key from step 1.

These are encrypted at rest by GitHub and only ever injected as environment
variables into the workflow run — they're never printed to logs or exposed
to the repo's contents.

## 4. That's it — the workflow runs itself

`.github/workflows/notifications.yml` runs on a 5-minute cron
(`schedule: */5 * * * *`), checking for due notifications and emailing via
Resend. No further setup needed once the two secrets above exist.

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

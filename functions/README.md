# TaskFlow Cloud Functions — email notifications

Backend half of the notification system (TODO.md #10, Phase 3). A single
scheduled Cloud Function (`checkAndSendEmailNotifications` in `index.js`)
runs every minute, checks every user who has email notifications enabled for
tasks/blocks that are starting soon, overdue, or due today, and emails them
via [Resend](https://resend.com). See the comments in `index.js`,
`src/computeNotifications.js`, and `src/notificationState.js` for the
trigger rules and duplicate-send-safety design.

Nothing here is deployed yet — this is just the code. Follow the steps below
when you're ready to actually turn it on.

## 1. Install dependencies

```
cd functions
npm install
```

## 2. Get a free Resend API key

1. Sign up at [resend.com](https://resend.com) — the free tier (3,000
   emails/month, 100/day) is more than enough for a personal app.
2. No domain setup needed. This function sends from Resend's shared
   `onboarding@resend.dev` address, which works with zero verification as
   long as every email goes to the Resend account's own owner address —
   exactly this function's use case (it only ever emails a TaskFlow user
   their own Firebase Auth account email, never anyone else).
3. From the Resend dashboard, go to **API Keys** and create one (the default
   "Sending access" key is fine). Copy it — it looks like `re_xxxxxxxx...`
   (that's a placeholder, not a real key).

## 3. Set it as a Cloud Functions secret

Never put the real key in a file. Set it directly via the Firebase CLI,
which stores it in Secret Manager and injects it at runtime:

```
firebase functions:secrets:set RESEND_API_KEY
```

You'll be prompted to paste the key value. The function reads it via
`defineSecret('RESEND_API_KEY')` (see `index.js`) — this is the standard
Firebase Functions v2 secrets pattern, so nothing else needs configuring.

## 4. Deploy

```
firebase deploy --only functions
```

This deploys `checkAndSendEmailNotifications` as a Cloud Scheduler job that
invokes the function every minute (see `index.js`'s top comment for why
every-minute was chosen, and why it's effectively free at this app's scale).

## Notes

- The function needs no Firestore rules changes: it runs with the Admin SDK
  (`admin.firestore()` / `admin.auth()`), which always has full read/write
  access regardless of `firestore.rules` — those rules only gate client SDK
  access.
- Dedupe/throttle state lives at `users/{uid}/notificationState/{stateId}`,
  a small subcollection this function owns exclusively. It's not part of
  local/cloud backups (`backupService.js`'s `BACKUP_FIELDS`) — it's just a
  "have we already emailed this" marker, not data worth restoring.
- If you ever rotate the Resend key, just re-run
  `firebase functions:secrets:set RESEND_API_KEY` and redeploy — no code
  changes needed.

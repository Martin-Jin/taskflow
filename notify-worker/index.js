'use strict';

const admin = require('firebase-admin');
const { Resend } = require('resend');

const { computeCandidates } = require('./src/computeNotifications');
const { claimNotification, clearNotificationState } = require('./src/notificationState');
const { buildNotificationEmail } = require('./src/emailTemplate');

// Resend's no-setup shared sender. Safe with zero domain verification only
// because this script ever emails exactly one address per user: that
// user's own Firebase Auth account email (fetched below via the Admin SDK),
// never a third party — see TODO.md #10's confirmed decisions.
const SENDER = 'TaskFlow <onboarding@resend.dev>';

/**
 * ============================================================================
 * SCHEDULED EMAIL NOTIFICATIONS (TODO.md #10, Phase 3) — GitHub Actions worker
 * ============================================================================
 * Originally a Firebase Cloud Functions v2 scheduled trigger; moved to a
 * plain Node script invoked by a GitHub Actions cron workflow
 * (.github/workflows/notifications.yml) instead, because Cloud Functions v2
 * and Secret Manager both require the Blaze (pay-as-you-go) plan even for
 * free-tier usage, while GitHub Actions on this public repo has unlimited
 * free minutes. The trigger rules, dedupe/throttle logic, and email template
 * are unchanged — see src/computeNotifications.js and src/notificationState.js
 * for those. Only the invocation/credential plumbing changed:
 *   - Firebase Admin SDK auth is a service-account JSON
 *     (FIREBASE_SERVICE_ACCOUNT_JSON env var, the full downloaded JSON as a
 *     string) instead of Cloud Functions' implicit ambient credentials.
 *   - RESEND_API_KEY is a plain env var instead of a Secret Manager secret
 *     via `defineSecret`.
 *   - This script runs once per invocation and exits, instead of registering
 *     a long-lived scheduled trigger — GitHub Actions' cron IS the schedule
 *     now (see .github/workflows/notifications.yml).
 *
 * RUN FREQUENCY: the original Cloud Function ran every 1 minute (see prior
 * comment history) to guarantee not missing even the shortest configurable
 * "starting soon" window. GitHub Actions enforces a 5-minute floor on
 * scheduled workflows regardless of the cron expression used, so this now
 * runs every 5 minutes instead — see the workflow file for the tradeoff this
 * implies for very short thresholds.
 * ============================================================================
 */
async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is not set');
  }
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY env var is not set');
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();
  const resend = new Resend(resendApiKey);

  const now = Date.now();

  // Single-field equality query — Firestore auto-indexes this (no
  // composite index needed). The three per-trigger-type toggles aren't
  // filtered here (Firestore can't cheaply OR across separate boolean
  // fields); they're checked in-memory per user below instead.
  const usersSnap = await db.collection('users').where('notificationSettings.emailEnabled', '==', true).get();

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const settings = data.notificationSettings;

    if (!settings?.emailEnabled) continue; // defensive re-check; the query above should already guarantee this
    if (!settings.taskStartingSoon && !settings.taskOverdue && !settings.taskDueToday) continue;

    const tasks = data.tasks || [];
    const blocks = data.blocks || [];
    const { toNotify, toClear } = computeCandidates({ tasks, blocks, settings, now });

    // Clearing stale overdue dedupe-state is independent of whether
    // anything fires this run, so it always runs regardless.
    await Promise.all(toClear.map((c) => clearNotificationState(db, uid, c.stateId)));

    if (toNotify.length === 0) continue;

    let email;
    try {
      email = (await admin.auth().getUser(uid)).email;
    } catch (err) {
      console.error(`could not resolve auth email for user ${uid}, skipping`, err);
      continue;
    }
    if (!email) continue;

    for (const candidate of toNotify) {
      let claimed;
      try {
        claimed = await claimNotification(db, uid, candidate, now);
      } catch (err) {
        // Treat a failed claim as "don't send" — the safer side to fail on.
        console.error(`claim failed for ${uid}/${candidate.stateId}, skipping to avoid a possible duplicate`, err);
        continue;
      }
      if (!claimed) continue; // already sent this one, or its throttle says not yet

      const { subject, html } = buildNotificationEmail(candidate.type, candidate.task, buildDetailLine(candidate));

      try {
        await resend.emails.send({ from: SENDER, to: email, subject, html });
      } catch (err) {
        // State is already marked "sent" (the transaction already
        // committed) — a failed send here is a skipped email, not a
        // duplicate one. See notificationState.js for why that's the
        // deliberate tradeoff.
        console.error(`Resend send failed for ${uid}/${candidate.stateId}`, err);
      }
    }
  }
}

function buildDetailLine(candidate) {
  switch (candidate.type) {
    case 'startingSoon':
      return `Starts at ${candidate.block.startTime}`;
    case 'overdue':
      return `Was due ${candidate.task.dueDate}`;
    case 'dueToday':
      return 'Due date is today';
    default:
      return '';
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('notify-worker run failed', err);
    process.exit(1);
  });

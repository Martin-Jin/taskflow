'use strict';

const admin = require('firebase-admin');
const { Resend } = require('resend');

const { computeCandidates, isCandidateStillValid } = require('./src/computeNotifications');
const { claimNotification, clearNotificationState } = require('./src/notificationState');
const { buildNotificationEmail, buildDueTodayDigestEmail } = require('./src/emailTemplate');

// Resend's no-setup shared sender. Without a verified custom domain, Resend's
// sandbox mode restricts this address to sending ONLY to the Resend
// account's own verified owner email — never a per-user Firebase Auth email,
// which is why NOTIFICATION_RECIPIENT below is a single fixed address rather
// than looked up per user. This app is personal/single-user, so that's not a
// real limitation; if it's ever needed for other recipients, verify a domain
// at resend.com/domains and change this to an address on that domain.
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
  // Fixed recipient, not a per-user lookup — see SENDER's comment above for
  // why: Resend's sandbox mode only delivers to the account's own verified
  // address regardless of which TaskFlow user the notification is for.
  const notificationRecipient = process.env.NOTIFICATION_RECIPIENT;
  if (!notificationRecipient) {
    throw new Error('NOTIFICATION_RECIPIENT env var is not set');
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
    const rules = data.rules || {};
    const { toNotify, toClear } = computeCandidates({ tasks, blocks, settings, rules, now });

    // Clearing stale overdue dedupe-state is independent of whether
    // anything fires this run, so it always runs regardless.
    await Promise.all(toClear.map((c) => clearNotificationState(db, uid, c.stateId)));

    if (toNotify.length === 0) continue;

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

      // Re-check against a fresh read, not the run's initial snapshot
      // (`tasks`/`blocks` above) — see isCandidateStillValid's doc comment.
      if (candidate.type !== 'dueTodayDigest') {
        const freshUserSnap = await userDoc.ref.get();
        const freshData = freshUserSnap.data() || {};
        if (!isCandidateStillValid(candidate, freshData.tasks || [], freshData.blocks || [])) continue;
      }

      const { subject, html } =
        candidate.type === 'dueTodayDigest'
          ? buildDueTodayDigestEmail(candidate.tasks)
          : buildNotificationEmail(candidate.type, candidate.task, buildDetailLine(candidate));

      try {
        // The Resend SDK resolves (never throws) on API-level rejections —
        // it returns { data, error } instead. Only network/transport
        // failures land in the catch block below, so `error` must be
        // checked explicitly or a rejected send (e.g. sandbox sender
        // restricted to the account's own verified address) is silently
        // treated as a success.
        const { error } = await resend.emails.send({ from: SENDER, to: notificationRecipient, subject, html });
        if (error) throw error;
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
      return `Overdue — was due ${candidate.task.dueDate}`;
    case 'missed':
      // Distinguish "due today AND missed" from "missed but not due
      // today/overdue" per the user's ask — both cases always include the
      // due date so the email is unambiguous either way.
      if (candidate.isDueToday) return `Due today and missed — scheduled slot ended at ${candidate.block.endTime}, due ${candidate.dueDate}`;
      return `Missed scheduled slot (ended ${candidate.block.endTime})${candidate.dueDate ? `, due ${candidate.dueDate}` : ' — no due date set'}`;
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

'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { Resend } = require('resend');

const { computeCandidates } = require('./src/computeNotifications');
const { claimNotification, clearNotificationState } = require('./src/notificationState');
const { buildNotificationEmail } = require('./src/emailTemplate');

admin.initializeApp();
const db = admin.firestore();

// Set later by the user via `firebase functions:secrets:set RESEND_API_KEY`
// (see functions/README.md) — never hardcoded, never committed.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

// Resend's no-setup shared sender. Safe with zero domain verification only
// because this function ever emails exactly one address per user: that
// user's own Firebase Auth account email (fetched below via the Admin SDK),
// never a third party — see TODO.md #10's confirmed decisions.
const SENDER = 'TaskFlow <onboarding@resend.dev>';

/**
 * ============================================================================
 * SCHEDULED EMAIL NOTIFICATIONS (TODO.md #10, Phase 3)
 * ============================================================================
 * Cloud Functions v2 scheduled trigger — queries every user with email
 * notifications enabled, computes which of their tasks/blocks are due a
 * notification right now (mirroring the client's Phase 2 rules, see
 * src/hooks/useNotificationChecker.js), and emails via Resend. Per-user
 * per-type toggles are respected exactly like the client's in-app checker;
 * `inAppEnabled` is irrelevant here since this only ever fires an email.
 *
 * RUN FREQUENCY — why "every 1 minutes":
 * SettingsPanel.jsx's "starting soon" threshold input has an explicit floor
 * (`min="1"`), and the client's own in-app checker polls every 60s to match
 * (useNotificationChecker.js's CHECK_INTERVAL_MS). A looser server schedule
 * (e.g. every 5 minutes) isn't just "less timely" for a short threshold —
 * a whole 1-minute "starting soon" window could open and fully close
 * between two runs and never be observed at all, silently dropping that
 * notification rather than just delaying it. Running every minute is the
 * tightest cadence that's guaranteed not to miss the smallest threshold a
 * user can configure, and it keeps server/client cadence in parity. Cost is
 * a non-issue at this app's personal/few-user scale: ~43,200 invocations a
 * month sits well inside Cloud Functions' 2M/month free tier, and the vast
 * majority of runs do nothing more than one cheap Firestore query (no email
 * send, no per-task work) since most ticks find nothing newly due.
 *
 * retryCount: 0 — Cloud Scheduler's automatic retry-on-failure is turned
 * off. The dedupe transaction in notificationState.js already makes
 * overlapping/duplicate invocations safe, but there's no benefit to
 * *inviting* more overlap than the schedule itself already risks, and a
 * failed run is immediately superseded by next minute's run anyway (a
 * skipped tick just means the same due tasks get caught, and emailed, one
 * minute later).
 * ============================================================================
 */
exports.checkAndSendEmailNotifications = onSchedule(
  { schedule: 'every 1 minutes', secrets: [RESEND_API_KEY], retryCount: 0 },
  async () => {
    const now = Date.now();
    const resend = new Resend(RESEND_API_KEY.value());

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
        logger.error(`checkAndSendEmailNotifications: could not resolve auth email for user ${uid}, skipping`, err);
        continue;
      }
      if (!email) continue;

      for (const candidate of toNotify) {
        let claimed;
        try {
          claimed = await claimNotification(db, uid, candidate, now);
        } catch (err) {
          // Treat a failed claim as "don't send" — the safer side to fail on.
          logger.error(`checkAndSendEmailNotifications: claim failed for ${uid}/${candidate.stateId}, skipping to avoid a possible duplicate`, err);
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
          logger.error(`checkAndSendEmailNotifications: Resend send failed for ${uid}/${candidate.stateId}`, err);
        }
      }
    }
  }
);

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

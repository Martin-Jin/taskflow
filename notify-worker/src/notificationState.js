'use strict';

/**
 * ============================================================================
 * DEDUPE / THROTTLE STATE (Firestore-backed, safe against duplicate sends)
 * ============================================================================
 * Cloud Functions instances are not persistent between invocations, so any
 * "have we already emailed this" memory has to live in Firestore, at
 * users/{uid}/notificationState/{stateId} — one small doc per (trigger type,
 * task/block id). This is intentionally NOT part of BACKUP_FIELDS
 * (backupService.js): it's a send-dedupe marker, not user data worth
 * restoring — if a restore wipes it, the worst case is one possible re-sent
 * email, never data loss.
 *
 * WHY A TRANSACTION: Cloud Scheduler + Cloud Functions v2 give no hard
 * guarantee that exactly one invocation is ever in flight — a slow previous
 * run can still be finishing when the next tick fires, and a delivery retry
 * (see index.js's retryCount:0, which minimizes but doesn't by itself
 * eliminate this) could in principle overlap another run. A naive
 * "read state, decide, then separately write state" would race: two
 * overlapping invocations could both read "not yet sent" before either
 * writes, and both send. Wrapping the read + eligibility decision + write in
 * one Firestore transaction closes that gap — transactions serialize on the
 * document, so the second (losing) invocation's transaction is guaranteed to
 * observe the first (winning) invocation's already-committed write and
 * correctly comes back "not eligible", instead of both proceeding.
 *
 * The actual email send happens AFTER the transaction commits — Firestore
 * transactions can't safely wrap an external network call (they may be
 * retried internally by the SDK on contention, which would risk sending
 * multiple times off a single logical claim). So the failure mode if
 * Resend's send itself throws is a SKIPPED email (state is already marked
 * "sent" by the transaction that already committed), never a DUPLICATE one —
 * deliberately the safer side to fail on for a notification inbox.
 * ============================================================================
 */

/**
 * Attempts to claim the right to send one notification described by
 * `candidate` (see computeNotifications.js for its shape). Returns true if
 * the caller should proceed to send the email; false if another invocation
 * already sent it, or this type's own throttle says it isn't due yet.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 * @param {object} candidate
 * @param {number} now - epoch ms, passed in (not read fresh) so every
 *   candidate in one function run is judged against the same instant.
 */
async function claimNotification(db, uid, candidate, now) {
  const ref = db.collection('users').doc(uid).collection('notificationState').doc(candidate.stateId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;

    let eligible = false;
    let nextState = null;

    switch (candidate.type) {
      case 'startingSoon': {
        // Fires once per block id UNLESS the block's own date/time has
        // changed since the last time it fired (a reschedule after the
        // original notification already went out is a new occurrence, not a
        // repeat of the old one) — mirrors the client's firedStartingSoonRef
        // Set, except that one has no reschedule-awareness at all.
        const rescheduled = prev !== null && prev.scheduledAt !== candidate.scheduledAt;
        eligible = prev === null || rescheduled;
        nextState = { type: 'startingSoon', lastNotifiedAt: now, scheduledAt: candidate.scheduledAt };
        break;
      }

      case 'overdue': {
        // Once per calendar date for every priority, same as dueToday — a
        // still-overdue task should surface once/day, not spam every 5-
        // minute worker tick (which an hourly-repeat rule used to do for
        // urgent/high tasks: up to ~24 emails/day). Re-arms immediately,
        // regardless of date, if the task's dueDate itself changed (e.g. a
        // reschedule that's still in the past) so that's always treated as
        // fresh news worth a new email.
        const dueDateChanged = prev !== null && prev.dueDate !== candidate.dueDate;
        eligible = prev === null || dueDateChanged || prev.lastNotifiedDate !== candidate.todayISO;
        nextState = { type: 'overdue', lastNotifiedAt: now, lastNotifiedDate: candidate.todayISO, dueDate: candidate.dueDate };
        break;
      }

      case 'missed': {
        // Fires once per block id, same "unless rescheduled" rule as
        // startingSoon — a block whose time already passed once and got
        // reported is only worth a fresh email if the user then moved it to
        // a new date/time and STILL missed that one too.
        const rescheduled = prev !== null && prev.scheduledAt !== candidate.scheduledAt;
        eligible = prev === null || rescheduled;
        nextState = { type: 'missed', lastNotifiedAt: now, scheduledAt: candidate.scheduledAt };
        break;
      }

      case 'dueTodayDigest': {
        // Once per calendar date — the digest itself is already gated to not
        // fire before the user's workDayStart (see computeNotifications.js),
        // so this just prevents repeat sends on later ticks the same day.
        eligible = prev === null || prev.lastNotifiedDate !== candidate.todayISO;
        nextState = { type: 'dueTodayDigest', lastNotifiedAt: now, lastNotifiedDate: candidate.todayISO };
        break;
      }

      // NOTE: 'dueToday' (the old one-email-per-task variant) is gone —
      // replaced entirely by 'dueTodayDigest' above. No migration needed:
      // any stale users/{uid}/notificationState/dueToday_{taskId} docs from
      // before this change are simply never read again and can be ignored.
      default:
        return false;
    }

    if (!eligible) return false;
    tx.set(ref, nextState);
    return true;
  });
}

/**
 * Deletes a state doc if present. A plain delete (not wrapped in a
 * transaction) is fine here — this only ever clears an "overdue" doc once a
 * task is confirmed no longer overdue, which isn't racing any concurrent
 * claim for that SAME doc (a task can't be simultaneously overdue and not
 * overdue within one computeCandidates() pass), and worst case of a missed
 * clear is just one stale doc noticed again next run.
 */
async function clearNotificationState(db, uid, stateId) {
  await db.collection('users').doc(uid).collection('notificationState').doc(stateId).delete();
}

module.exports = { claimNotification, clearNotificationState };

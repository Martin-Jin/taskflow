/**
 * CalendarRewriteOverlay — full-screen blocking overlay shown for the
 * duration of "Rewrite Google Calendar to match TaskFlow" (and its
 * restore-and-overwrite combined variant — see useGoogleCalendarSync's
 * rewriteGoogleCalendarFromTaskflow / SchedulerContext's
 * restoreCloudBackupAndRewriteCalendar). Rendered once in App.jsx, same
 * singleton pattern as ConfirmModal/CompleteTaskConfirmModal: reads
 * isRewritingCalendar/rewriteProgress straight off SchedulerContext and
 * renders nothing when a rewrite isn't in flight.
 *
 * Unlike every other modal in this app, this one is DELIBERATELY not
 * dismissible — no close button, no Escape handling, no click-outside-to-
 * close. A rewrite is actively deleting/creating real Google Calendar
 * events; letting the user navigate away or fire off another action mid-
 * batch (e.g. editing a task that's about to be pushed, or clicking another
 * destructive button) is exactly the kind of concurrent-write race this
 * feature's own pollPausedRef/googleFetchInFlightRef guards were built to
 * prevent at the data layer — this overlay is the UI-level half of that
 * same guarantee, making it obvious (not just technically enforced) that
 * nothing else should be attempted until this finishes.
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';

export default function CalendarRewriteOverlay() {
  const { isRewritingCalendar, rewriteProgress } = useScheduler();
  if (!isRewritingCalendar) return null;

  const pct = rewriteProgress && rewriteProgress.total > 0 ? Math.round((rewriteProgress.done / rewriteProgress.total) * 100) : null;

  return (
    <div className="modal-overlay calendar-rewrite-overlay" role="alertdialog" aria-modal="true" aria-label="Rewriting Google Calendar">
      <div className="calendar-rewrite-panel">
        <RefreshCw size={28} className="calendar-rewrite-spinner" aria-hidden="true" />
        <h3 className="calendar-rewrite-title">Rewriting Google Calendar…</h3>
        <p className="calendar-rewrite-subtitle">
          Don't close this tab or make other changes until this finishes.
        </p>
        <div
          className="calendar-rewrite-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <div
            className="calendar-rewrite-progress-fill"
            style={{ width: pct != null ? `${pct}%` : '100%' }}
          />
        </div>
        <p className="calendar-rewrite-count">
          {rewriteProgress ? `${rewriteProgress.done} / ${rewriteProgress.total}` : 'Starting…'}
        </p>
      </div>
    </div>
  );
}

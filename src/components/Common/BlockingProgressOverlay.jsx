/**
 * BlockingProgressOverlay — full-screen blocking overlay for any operation
 * this app needs to keep the user from interrupting or working around.
 * Generalized from the earlier CalendarRewriteOverlay (moved to
 * deleted/src/components/Common/ — its own doc comment there has the
 * original single-purpose history) once a second, unrelated use case
 * appeared: the restore lock (see useCloudSync.js's acquireAndRunRestoreLock/
 * isRestoreLockActive) needs the exact same "don't let the user do anything
 * else right now" treatment, both for the device actively restoring a
 * backup and for every OTHER device waiting for that restore to finish.
 *
 * Rendered three times in App.jsx (once per situation), each with its own
 * `active`/copy, rather than one instance juggling three states internally —
 * simpler to reason about, and only one of the three is ever true at once in
 * practice, so there's no risk of them stacking visibly.
 *
 * Unlike every other modal in this app, this one is DELIBERATELY not
 * dismissible — no close button, no Escape handling, no click-outside-to-
 * close. Each of its uses is actively doing something that a stray click or
 * navigation could race against at the data layer (Google Calendar rewrite:
 * pollPausedRef/googleFetchInFlightRef; a restore: the cloud-sync lock
 * itself) — this overlay is the UI-level half of that same guarantee, making
 * it obvious (not just technically enforced) that nothing else should be
 * attempted until it clears.
 *
 * @param {boolean} active - render nothing when false.
 * @param {string} title
 * @param {string} subtitle
 * @param {{done: number, total: number}|null} [progress] - when given, shows
 *   a determinate progress bar and count (e.g. "12 / 40") instead of just an
 *   indeterminate spinner with "Starting…".
 */
import React from 'react';
import { RefreshCw } from 'lucide-react';

export default function BlockingProgressOverlay({ active, title, subtitle, progress = null }) {
  if (!active) return null;

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="modal-overlay blocking-progress-overlay" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="blocking-progress-panel">
        <RefreshCw size={28} className="blocking-progress-spinner" aria-hidden="true" />
        <h3 className="blocking-progress-title">{title}</h3>
        <p className="blocking-progress-subtitle">{subtitle}</p>
        <div
          className="blocking-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <div className="blocking-progress-fill" style={{ width: pct != null ? `${pct}%` : '100%' }} />
        </div>
        {progress && <p className="blocking-progress-count">{`${progress.done} / ${progress.total}`}</p>}
      </div>
    </div>
  );
}

/**
 * CompleteTaskConfirmModal — global singleton confirmation popup fired by
 * CompleteTaskContext.requestComplete when the task being completed has a
 * running/paused/done Pomodoro timer (see TimerContext). Mounted once in
 * App.jsx, alongside TimerWidget, so it renders correctly no matter which of
 * the app's three completion call sites (BoardView, TaskDetailModal,
 * TaskListPanel) triggered it, and layers above any modal already open
 * underneath it (see .complete-confirm-overlay in timer.css).
 *
 * The elapsed time is pre-filled but editable — covers "I pressed complete
 * later than I actually stopped working" by letting the user lower it to
 * what they actually spent instead of the stale/still-ticking timer value.
 */

import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import Modal from './Modal';
import { useCompleteTask } from '../../context/CompleteTaskContext';
import { formatTimerDuration } from '../../context/TimerContext';

export default function CompleteTaskConfirmModal() {
  const { pending, confirmComplete, cancelComplete } = useCompleteTask();
  if (!pending) return null;
  return <ConfirmModalInner pending={pending} onConfirm={confirmComplete} onCancel={cancelComplete} />;
}

function ConfirmModalInner({ pending, onConfirm, onCancel }) {
  const [hours, setHours] = useState(roundHours(pending.elapsedHours));

  // A fresh pending completion (different task, or the same one re-opened
  // after a cancel) should start from its own elapsed time, not whatever was
  // last typed here.
  useEffect(() => {
    setHours(roundHours(pending.elapsedHours));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.taskId]);

  function handleConfirm() {
    const parsed = Number(hours);
    onConfirm(Number.isFinite(parsed) && parsed >= 0 ? parsed : pending.elapsedHours);
  }

  return (
    <Modal
      onClose={onCancel}
      ariaLabel="Log time spent"
      size="sm"
      overlayClassName="complete-confirm-overlay"
      header={
        <h3 style={{ marginTop: 0, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 16 }}>
          <Timer size={16} aria-hidden="true" />
          Log time spent?
        </h3>
      }
    >
      {({ requestClose }) => (
        <>
          <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginTop: 0 }}>
            You tracked <strong>{formatTimerDuration(pending.elapsedHours * 3600)}</strong> on "{pending.taskTitle}" — log this as time
            spent?
          </p>
          <div className="form-row">
            <label htmlFor="complete-confirm-hours">Hours spent</label>
            <input
              id="complete-confirm-hours"
              type="number"
              min="0"
              step="0.1"
              autoFocus
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleConfirm}>
              Complete task
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Rounds to 1 decimal for display, same tolerance as the hours input's step. */
function roundHours(hours) {
  return Math.round(hours * 10) / 10;
}

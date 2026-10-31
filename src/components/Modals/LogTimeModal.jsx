/**
 * LogTimeModal — a small one-line popup for recording how much time was spent
 * on a task ("I completed [x] hours [y] minutes of this task"). The caller
 * decides what logging means; for the task list it lowers the task's "Time
 * left" and lets the scheduler tick off the blocks that covers (see
 * SchedulerContext's setRemainingHoursWithBlockInference).
 *
 * Both fields take digits only and ask for the numeric keyboard on phones.
 * Enter in the hours field moves on to minutes; Enter in minutes saves.
 */

import React, { useRef, useState } from 'react';
import Modal from '../Common/Modal';

const digitsOnly = (raw) => raw.replace(/\D/g, '');

export default function LogTimeModal({ taskTitle, onSave, onClose }) {
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const minutesRef = useRef(null);

  const totalHours = (Number(hours) || 0) + (Number(minutes) || 0) / 60;

  function handleSubmit(e, { requestClose }) {
    e.preventDefault();
    if (totalHours <= 0) return;
    onSave(totalHours);
    requestClose();
  }

  return (
    <Modal
      as="form"
      onSubmit={handleSubmit}
      onClose={onClose}
      ariaLabel={`Log time on ${taskTitle}`}
      size="sm"
      header={
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Log time</h3>
          <p className="form-hint" style={{ margin: '2px 0 0' }}>
            I completed…
          </p>
        </div>
      }
    >
      {({ requestClose }) => (
        <>
          <div className="log-time-sentence">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              autoFocus
              value={hours}
              placeholder="0"
              aria-label="Hours"
              onChange={(e) => setHours(digitsOnly(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  minutesRef.current?.focus();
                }
              }}
            />
            <span>hours</span>
            <input
              ref={minutesRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={minutes}
              placeholder="0"
              aria-label="Minutes"
              onChange={(e) => setMinutes(digitsOnly(e.target.value))}
            />
            <span>minutes of this task</span>
          </div>
          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={totalHours <= 0}>
              Log time
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

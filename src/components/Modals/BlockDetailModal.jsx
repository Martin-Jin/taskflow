/**
 * BlockDetailModal — edits a single ScheduledBlock's placement (date/start/
 * end time). Uses the same header + icon-labeled field-row language as
 * TaskDetailModal/EventDetailModal for visual consistency, just without the
 * two-column split — there's no free-text "main" content here (the title
 * and notes both belong to the parent Task and aren't editable from a
 * placement), so the field list runs full width instead of sitting in a
 * narrow sidebar next to empty space.
 */

import React, { useEffect, useState } from 'react';
import { Lock, Unlock, X, CalendarClock, Clock } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import DetailField from '../Common/DetailField';

export default function BlockDetailModal({ block, onClose }) {
  const { tasks, updateBlock, deleteBlock, toggleBlockLock } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const task = tasks.find((t) => t.id === block.taskId);
  const [startTime, setStartTime] = useState(block.startTime);
  const [endTime, setEndTime] = useState(block.endTime);
  const [date, setDate] = useState(block.date);

  // Resync local form fields if the underlying block changes identity
  // (e.g. it was dragged/resized elsewhere while this modal stayed open).
  useEffect(() => {
    setStartTime(block.startTime);
    setEndTime(block.endTime);
    setDate(block.date);
  }, [block.id, block.startTime, block.endTime, block.date]);

  if (!task) return null;

  function handleSave() {
    updateBlock(block.id, { date, startTime, endTime, isAutoScheduled: false });
    requestClose();
  }

  function handleDelete() {
    deleteBlock(block.id);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-detail"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420 }}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="block-detail-title"
        tabIndex={-1}
      >
        <div className="detail-header">
          <h3 id="block-detail-title" style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', flex: 1 }}>{task.title}</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <span className={`badge ${task.priority}`}>{task.priority}</span>
        </div>
        {task.notes && <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 0 }}>{task.notes}</p>}

        <div className="detail-sidebar detail-sidebar--full">
          <DetailField icon={CalendarClock} label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </DetailField>
          <DetailField icon={Clock} label="Start time">
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </DetailField>
          <DetailField icon={Clock} label="End time">
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </DetailField>
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'space-between' }}>
          <button
            className="btn detail-lock-btn"
            onClick={() => toggleBlockLock(block.id)}
            title={block.isLocked ? 'Unlock — allow the scheduler to rebalance this block' : 'Lock — protect this block from rebalance'}
          >
            {block.isLocked ? (
              <>
                <Lock size={14} aria-hidden="true" /> Unlock
              </>
            ) : (
              <>
                <Unlock size={14} aria-hidden="true" /> Lock
              </>
            )}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={handleDelete} style={{ color: 'var(--color-danger)' }}>
              Delete
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

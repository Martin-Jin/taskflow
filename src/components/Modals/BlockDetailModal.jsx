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
import { Lock, Unlock, X, CalendarClock, Clock, ExternalLink } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import Modal from '../Common/Modal';
import DetailField from '../Common/DetailField';
import Badge from '../Common/Badge';

export default function BlockDetailModal({ block, onClose, onOpenTask }) {
  const { tasks, updateBlock, deleteBlock, toggleBlockLock } = useScheduler();
  const task = tasks.find((t) => t.id === block.taskId);
  // Sub-task blocks show which parent task they belong to — the block's own
  // title is the sub-task's, which reads as orphaned context without this.
  const parentTask = task?.parentId ? tasks.find((t) => t.id === task.parentId) || null : null;
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

  function handleOpenTask() {
    onOpenTask?.(block.taskId);
  }

  return (
    <Modal onClose={onClose} ariaLabel={task.title} variantClassName="modal-detail">
      {({ requestClose }) => {
        function handleSave() {
          updateBlock(block.id, { date, startTime, endTime, isAutoScheduled: false });
          requestClose();
        }

        function handleDelete() {
          deleteBlock(block.id);
          requestClose();
        }

        return (
          <>
            <div className="detail-header">
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)' }}>{task.title}</h3>
                {parentTask && (
                  <p style={{ margin: '2px 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                    Sub-task of {parentTask.title}
                  </p>
                )}
              </div>
              {onOpenTask && (
                <button className="btn btn-icon" onClick={handleOpenTask} aria-label="Open task" title="Open task">
                  <ExternalLink size={16} />
                </button>
              )}
              <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div style={{ marginBottom: 10 }}>
              <Badge variant={task.priority}>{task.priority}</Badge>
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
          </>
        );
      }}
    </Modal>
  );
}

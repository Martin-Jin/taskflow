/**
 * SubtaskDetailModal — a compact edit view for a single Subtask, opened by
 * clicking its row in TaskDetailModal's checklist ("a sub-task is just a
 * task", per Todoist). Deliberately smaller than TaskDetailModal: a Subtask
 * has no priority/dueDate/scheduling of its own (see Subtask typedef — it's
 * never independently scheduled), so this only edits what it actually has:
 * title, notes, and completion.
 */

import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

export default function SubtaskDetailModal({ taskId, subtask, onClose }) {
  const { updateSubtask, removeSubtask } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState(subtask.title);
  const [notes, setNotes] = useState(subtask.notes || '');
  const [isCompleted, setIsCompleted] = useState(subtask.isCompleted);

  function handleSave() {
    updateSubtask(taskId, subtask.id, { title: title.trim() || subtask.title, notes, isCompleted });
    requestClose();
  }

  function handleDelete() {
    removeSubtask(taskId, subtask.id);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420 }}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subtask-detail-title"
        tabIndex={-1}
      >
        <h3 id="subtask-detail-title" style={{ marginTop: 0, fontFamily: 'var(--font-display)' }}>Edit sub-task</h3>

        <div className="form-row">
          <label>Title</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="form-row">
          <label>Notes</label>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional details…" />
        </div>

        <div className="form-row">
          <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={isCompleted} onChange={(e) => setIsCompleted(e.target.checked)} />
            Completed
          </label>
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'space-between' }}>
          <button className="btn" onClick={handleDelete} style={{ color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Trash2 size={14} /> Delete
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={requestClose}>
              Cancel
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

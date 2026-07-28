/**
 * SubtaskDetailModal — a compact edit view for a single Subtask, opened by
 * clicking its row in TaskDetailModal's checklist ("a sub-task is just a
 * task", per Todoist). Mirrors TaskDetailModal's own layout (completed
 * checkbox + click-to-edit title in the header, expanding description
 * below, a "..." menu for Delete, inline Save/Cancel under the description)
 * so the two feel like the same surface at different scales — deliberately
 * smaller, since a Subtask has no priority/dueDate/scheduling of its own
 * (see Subtask typedef — it's never independently scheduled), so this only
 * edits what it actually has: title, notes, and completion.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X, Check, MoreHorizontal } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useIsMobile } from '../../hooks/useIsMobile';
import Linkified from '../Common/Linkified';

export default function SubtaskDetailModal({ taskId, subtask, onClose }) {
  const { updateSubtask, removeSubtask } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState(subtask.title);
  const [notes, setNotes] = useState(subtask.notes || '');
  const [isCompleted, setIsCompleted] = useState(subtask.isCompleted);
  const [menuOpen, setMenuOpen] = useState(false);

  const notesRef = useRef(null);
  useAutosizeTextarea(notesRef, notes, { maxLines: 3 });

  // Same portaled/measured "..." menu as TaskDetailModal's, forced centered
  // on mobile rather than anchored — see useMenuPosition and its comment
  // there for why a corner-anchored 280px menu rarely fits a phone screen.
  const isMobile = useIsMobile();
  const menuTriggerRef = useRef(null);
  const {
    menuRef,
    mode: menuMode,
    style: menuStyle,
  } = useMenuPosition({
    isOpen: menuOpen,
    anchorRef: menuTriggerRef,
    onClose: () => setMenuOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  const isDirty = title !== subtask.title || notes !== (subtask.notes || '') || isCompleted !== subtask.isCompleted;

  function handleSave() {
    updateSubtask(taskId, subtask.id, { title: title.trim() || subtask.title, notes, isCompleted });
    requestClose();
  }

  function handleCancel() {
    setTitle(subtask.title);
    setNotes(subtask.notes || '');
    setIsCompleted(subtask.isCompleted);
  }

  function handleDelete() {
    removeSubtask(taskId, subtask.id);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-detail"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460 }}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sub-task details"
        tabIndex={-1}
      >
        <div className="detail-topbar">
          <div className="detail-menu">
            <button
              type="button"
              ref={menuTriggerRef}
              className="btn btn-icon menu-trigger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen &&
              createPortal(
                <>
                  {menuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setMenuOpen(false)} />}
                  <ul
                    ref={menuRef}
                    className={`detail-menu-dropdown ${menuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                    role="menu"
                    style={menuMode === 'anchored' ? menuStyle : undefined}
                  >
                    <li role="none">
                      <button type="button" role="menuitem" className="detail-menu-item detail-menu-item-danger" onClick={handleDelete}>
                        <Trash2 size={14} aria-hidden="true" />
                        Delete
                      </button>
                    </li>
                  </ul>
                </>,
                document.body
              )}
          </div>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="detail-editbox">
          <div className="detail-title-row">
            <button
              className={`task-checkbox ${isCompleted ? 'checked' : ''}`}
              onClick={() => setIsCompleted((v) => !v)}
              title={isCompleted ? 'Completed' : 'Mark complete'}
              aria-label={isCompleted ? `${title} completed` : `Mark ${title} complete`}
              style={{ marginTop: 6 }}
            >
              {isCompleted && <Check size={12} aria-hidden="true" />}
            </button>
            <div className="detail-title-wrap">
              <label htmlFor="subtask-detail-title" className="sr-only">
                Sub-task name
              </label>
              <input
                id="subtask-detail-title"
                className="smart-title-input"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sub-task name"
              />
            </div>
          </div>

          <label htmlFor="subtask-detail-notes" className="sr-only">
            Description
          </label>
          <textarea
            id="subtask-detail-notes"
            className="detail-notes-textarea"
            ref={notesRef}
            rows={1}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Description"
          />
          <Linkified text={notes} className="notes-link-preview" />
        </div>

        {isDirty && (
          <div className="detail-save-row">
            <button type="button" className="btn" onClick={handleCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

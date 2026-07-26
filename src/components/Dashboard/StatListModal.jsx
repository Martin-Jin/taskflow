import React from 'react';
import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

/**
 * Small popup listing the tasks behind a DashboardStats tile ("Missed" /
 * "Overdue") — parameterized by title/items/emptyMessage/renderItem so both
 * tiles share one modal shell instead of duplicating the overlay boilerplate.
 * Follows the same open/close convention as the app's other modals (see
 * TaskDetailModal/SubtaskDetailModal): parent owns open/close via a nullable
 * useState, this component just calls useAnimatedUnmount/useModalA11y and
 * reuses the shared .modal-overlay/.modal classes.
 */
export default function StatListModal({ title, items, emptyMessage, renderItem, onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>{title}</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {items.length === 0 ? (
          <div className="now-empty">{emptyMessage}</div>
        ) : (
          <ul className="missed-tasks-list stat-list-modal-list">{items.map(renderItem)}</ul>
        )}
      </div>
    </div>
  );
}

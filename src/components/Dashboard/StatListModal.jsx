import React from 'react';
import Modal from '../Common/Modal';
import EmptyState from '../Common/EmptyState';

/**
 * Small popup listing the tasks behind a DashboardStats tile ("Missed" /
 * "Overdue") — parameterized by title/items/emptyMessage/renderItem so both
 * tiles (and SchedulingConflictsModal) share one modal shell instead of
 * duplicating the overlay boilerplate. Parent owns open/close via a
 * nullable useState, same convention as the app's other modals.
 */
export default function StatListModal({ title, items, emptyMessage, renderItem, onClose }) {
  return (
    <Modal onClose={onClose} ariaLabel={title} variantClassName="modal-stat-list" title={title}>
      {items.length === 0 ? (
        <EmptyState>{emptyMessage}</EmptyState>
      ) : (
        <ul className="missed-tasks-list stat-list-modal-list">{items.map(renderItem)}</ul>
      )}
    </Modal>
  );
}

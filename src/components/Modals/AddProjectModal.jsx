/**
 * AddProjectModal — dedicated "Add project" dialog, styled to match
 * AddTaskModal's header (title input + X close) and footer (Cancel/Add
 * buttons) for visual consistency across the app's "add" flows. Reachable
 * from the Projects page's AddTaskFabGroup (ProjectsPage.jsx) and from
 * ManageProjectsModal's own "Add project" button (both wired via App.jsx) —
 * one shared UI instead of two different add-project patterns.
 *
 * Deliberately far smaller than AddTaskModal: Project (see types/index.js)
 * has no description, due date, priority, or label fields, so there's no
 * smart-parse, chips, or metadata sidebar to reproduce here — just a name.
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';
import Modal from '../Common/Modal';

export default function AddProjectModal({ onAddProject, onClose }) {
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e, { requestClose }) {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    setError('');
    try {
      const result = await onAddProject(trimmed);
      if (result?.ok) {
        requestClose();
      } else {
        setError('Could not create project.');
      }
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Add project"
      variantClassName="modal-detail"
      as="form"
      onSubmit={handleSubmit}
      header={({ requestClose }) => (
        <div className="detail-header">
          <div className="detail-title-wrap">
            <input
              autoFocus
              className="smart-title-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              maxLength={200}
            />
          </div>
          <button type="button" className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      )}
      footer={({ requestClose }) => (
        <>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={requestClose} disabled={isCreating}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isCreating || !name.trim()}>
              {isCreating ? '…' : 'Add project'}
            </button>
          </div>
        </>
      )}
    />
  );
}

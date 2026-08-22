/**
 * SaveViewModal — names the current search so it can be kept as a saved view
 * (see utils/savedViews.js).
 *
 * A purpose-built modal rather than a yes/no confirm (ConfirmContext takes no
 * input) or window.prompt (no validation, and it looks nothing like the rest of
 * the app). Validation runs through buildSavedView, so the rules — no blank
 * name, no duplicate, length cap, view cap — live in one place and can't drift
 * between here and anywhere else that saves a view.
 */

import React, { useState } from 'react';
import Modal from '../Common/Modal';
import FieldRejectionHint from '../Common/FieldRejectionHint';
import { useFieldRejection } from '../../hooks/useFieldRejection';
import { buildSavedView, MAX_SAVED_VIEW_NAME_LENGTH } from '../../utils/savedViews';

export default function SaveViewModal({ query, existingViews, onSave, onClose }) {
  const [name, setName] = useState('');
  const rejection = useFieldRejection();

  function handleSave(requestClose) {
    const result = buildSavedView({ name, query }, existingViews);
    if (!result.ok) {
      rejection.reject(result.error);
      return;
    }
    onSave(result.view);
    requestClose();
  }

  return (
    <Modal onClose={onClose} ariaLabel="Save this search as a view" size="sm" header={<h3 style={{ margin: 0 }}>Save as view</h3>}>
      {({ requestClose }) => (
        <>
          <div className="form-row">
            <label htmlFor="saved-view-name">Name</label>
            <FieldRejectionHint message={rejection.message} />
            <input
              id="saved-view-name"
              autoFocus
              value={name}
              maxLength={MAX_SAVED_VIEW_NAME_LENGTH}
              placeholder="e.g. Overdue and urgent"
              className={rejection.shakeProps.className}
              onAnimationEnd={rejection.shakeProps.onAnimationEnd}
              onChange={(e) => {
                rejection.clear();
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave(requestClose);
                }
              }}
            />
          </div>
          {/* Showing the query is the point: a name alone gives no way to tell
              two similar views apart later. */}
          <p className="form-hint">
            Saves the current search: <code>{query}</code>
          </p>
          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSave(requestClose)}>
              Save view
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

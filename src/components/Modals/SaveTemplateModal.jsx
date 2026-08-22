/**
 * SaveTemplateModal — names a task subtree so it can be reused as a template
 * (see utils/taskTemplates.js).
 *
 * Modeled on SaveViewModal: validation runs through `buildTemplateFromTasks`,
 * so the rules (no blank or duplicate name, length cap, template cap, per-
 * template task cap) live in one place and can't drift.
 *
 * The preview is doing real work, not decoration. What gets captured is the
 * task plus every descendant, and how the dates come back is the least obvious
 * part of the whole feature — so the modal states the task count, the span, and
 * that dates are stored as offsets, before the user commits to a name.
 */

import React, { useState } from 'react';
import Modal from '../Common/Modal';
import FieldRejectionHint from '../Common/FieldRejectionHint';
import { useFieldRejection } from '../../hooks/useFieldRejection';
import { buildTemplateFromTasks, describeTemplate, MAX_TEMPLATE_NAME_LENGTH } from '../../utils/taskTemplates';

export default function SaveTemplateModal({ rootTask, subtreeTasks, existingTemplates, onSave, onClose }) {
  const [name, setName] = useState(rootTask?.title || '');
  const rejection = useFieldRejection();

  // Built twice — once here for the preview, once on save against the real
  // name. Cheap (it's a map over at most MAX_TEMPLATE_TASKS entries) and it
  // means the preview can never describe something different from what saving
  // actually stores.
  const preview = buildTemplateFromTasks({ name: 'preview', tasks: subtreeTasks }, []);

  function handleSave(requestClose) {
    const result = buildTemplateFromTasks({ name, tasks: subtreeTasks }, existingTemplates);
    if (!result.ok) {
      rejection.reject(result.error);
      return;
    }
    onSave(result.template);
    requestClose();
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Save this task as a template"
      size="sm"
      header={<h3 style={{ margin: 0 }}>Save as template</h3>}
    >
      {({ requestClose }) => (
        <>
          <div className="form-row">
            <label htmlFor="template-name">Name</label>
            <FieldRejectionHint message={rejection.message} />
            <input
              id="template-name"
              autoFocus
              value={name}
              maxLength={MAX_TEMPLATE_NAME_LENGTH}
              placeholder="e.g. New client onboarding"
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
          {preview.ok ? (
            <p className="form-hint">
              Captures <strong>{describeTemplate(preview.template)}</strong> — this task and its sub-tasks, with their
              estimates and dependencies. Due dates are stored as spacing, not fixed dates, so you pick a start date
              each time you use it.
            </p>
          ) : (
            <p className="form-error">{preview.error}</p>
          )}
          <p className="form-hint">
            Not captured: the project (you choose one when using the template), recurrence, comments, and anything
            already scheduled or completed.
          </p>
          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!preview.ok} onClick={() => handleSave(requestClose)}>
              Save template
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

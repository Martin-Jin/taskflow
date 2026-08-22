/**
 * NewFromTemplateModal — pick a saved template, pick a start date and a
 * project, and get the whole shape of work back as real tasks (see
 * utils/taskTemplates.js).
 *
 * This modal also owns DELETING templates, deliberately. A template is only
 * ever reached from here, so a separate management screen in Settings would be
 * a second place to maintain for a list that's already on screen — and the
 * moment you notice a stale template is the moment you're looking for a good
 * one.
 *
 * The date is called a start date, not an anchor: the earliest task in the
 * shape lands on it and everything else keeps its original spacing (see
 * buildTemplateFromTasks on why offsets are relative to the earliest date).
 * The preview line spells out the resulting range before anything is created,
 * because "3 tasks over 11 days" is not the same commitment as "3 tasks today".
 */

import React, { useState } from 'react';
import { FileStack, Trash2, Folder, CalendarClock } from 'lucide-react';
import Modal from '../Common/Modal';
import EmptyState from '../Common/EmptyState';
import SelectMenu from '../Common/SelectMenu';
import DetailField from '../Common/DetailField';
import { useConfirm } from '../../context/ConfirmContext';
import { sortTemplates, describeTemplate, planTemplateInstantiation } from '../../utils/taskTemplates';
import { formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { NO_SCHEDULE_PROJECT_ID, NO_SCHEDULE_PROJECT_LABEL } from '../../utils/projectConstants';

export default function NewFromTemplateModal({
  templates,
  projects,
  activeProjectId,
  onInstantiate,
  onDeleteTemplate,
  onClose,
}) {
  const confirm = useConfirm();
  const ordered = sortTemplates(templates);
  const [selectedId, setSelectedId] = useState(ordered[0]?.id || null);
  const [startDate, setStartDate] = useState(toISODate(new Date()));
  const [projectId, setProjectId] = useState(activeProjectId || '');

  const selected = ordered.find((t) => t.id === selectedId) || null;

  // Planned with a throwaway id factory purely to describe the outcome — the
  // real instantiation re-plans with the context's own id generator, so no
  // preview id ever reaches the store.
  const previewDates = selected
    ? planTemplateInstantiation(selected, { anchorDate: startDate }, () => 'preview')
        .map((t) => t.dueDate)
        .filter(Boolean)
        .sort()
    : [];
  const lastDate = previewDates[previewDates.length - 1];

  async function handleDelete(template) {
    const ok = await confirm(
      `Delete the template "${template.name}"? Tasks you already created from it are unaffected.`,
      { confirmLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    onDeleteTemplate(template.id);
    if (template.id === selectedId) {
      setSelectedId(ordered.find((t) => t.id !== template.id)?.id || null);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Create tasks from a template"
      size="md"
      header={<h3 style={{ margin: 0 }}>New from template</h3>}
    >
      {({ requestClose }) =>
        ordered.length === 0 ? (
          <EmptyState icon={FileStack}>
            <p style={{ margin: 0 }}>No templates yet.</p>
            {/* Teaches the one route in — there is no other way to make one. */}
            <p className="form-hint" style={{ margin: 0 }}>
              Open a task with sub-tasks and choose "Save as template" from its ⋯ menu.
            </p>
          </EmptyState>
        ) : (
          <>
            <div className="template-list" role="radiogroup" aria-label="Templates">
              {ordered.map((template) => (
                <div key={template.id} className={`template-row ${template.id === selectedId ? 'is-selected' : ''}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={template.id === selectedId}
                    className="template-row-main"
                    onClick={() => setSelectedId(template.id)}
                  >
                    <span className="template-row-name">{template.name}</span>
                    <span className="form-hint template-row-meta">{describeTemplate(template)}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`Delete template "${template.name}"`}
                    title="Delete template"
                    onClick={() => handleDelete(template)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <DetailField icon={CalendarClock} label="Start date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <p className="form-hint">
                {selected && lastDate && lastDate !== startDate
                  ? `The first task is due ${formatDisplayDate(startDate)}, the last ${formatDisplayDate(lastDate)}.`
                  : selected && lastDate
                  ? `Everything is due ${formatDisplayDate(startDate)}.`
                  : 'This template has no due dates, so the tasks are created without any.'}
              </p>
            </DetailField>

            <DetailField icon={Folder} label="Project">
              <SelectMenu
                ariaLabel="Project for new tasks"
                value={projectId}
                onChange={setProjectId}
                options={[
                  { value: '', label: 'Inbox' },
                  ...projects
                    .filter((p) => p.name.trim().toLowerCase() !== 'inbox')
                    .map((p) => ({ value: p.id, label: p.name })),
                  { value: NO_SCHEDULE_PROJECT_ID, label: NO_SCHEDULE_PROJECT_LABEL, separatorBefore: true },
                ]}
              />
            </DetailField>

            <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={requestClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!selected}
                onClick={() => {
                  onInstantiate(selected, { anchorDate: startDate || null, projectId: projectId || null });
                  requestClose();
                }}
              >
                {selected ? `Create ${selected.tasks.length} task${selected.tasks.length === 1 ? '' : 's'}` : 'Create tasks'}
              </button>
            </div>
          </>
        )
      }
    </Modal>
  );
}

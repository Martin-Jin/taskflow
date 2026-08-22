/**
 * ============================================================================
 * BulkActionBar
 * ============================================================================
 * ONE shared docked bottom bar, same layout on desktop and mobile (no
 * bottom-sheet split) — appears once 1+ items are selected in any of List,
 * Board, Calendar, or TaskDetailModal's sub-task list. Shows the selection
 * count, whichever bulk-edit fields are valid for the CURRENT selection's
 * intersection (see utils/bulkEditEngine.js's computeBulkEditableFields —
 * fields not valid for every selected item are simply not rendered), a
 * Cancel/Deselect-all action, an optional Select-all action, and Delete
 * (gated behind useConfirm()).
 *
 * This component owns no selection state itself (see hooks/useMultiSelect.js
 * for that) and does no validation itself (see utils/bulkEditEngine.js) — it
 * only renders controls and hands the caller-chosen field/value up via
 * `onApplyField`, and reports Delete via `onDelete`. Each field's edit UI is a
 * small popover-free inline control (a native <select>/<input>) rather than
 * this app's richer pickers (LabelPicker/DependencyPicker), to keep this
 * already cross-cutting feature's surface area contained — see the
 * per-field render functions below.
 * ============================================================================
 */

import React, { useState } from 'react';
import { X, Trash2, CheckSquare, Square, Calendar, Repeat, Folder, Tag, Flag } from 'lucide-react';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { RECURRENCE_UNITS } from '../../utils/recurrence';
import { NO_SCHEDULE_PROJECT_ID, NO_SCHEDULE_PROJECT_LABEL } from '../../utils/projectConstants';
import NumberField from './NumberField';

/**
 * @param {object} props
 * @param {number} props.count - number of currently-selected items
 * @param {{dueDate: boolean, recurrence: boolean, project: boolean, labels: boolean, priority: boolean, status: boolean, delete: boolean}} props.editableFields
 * @param {import('../../types').Project[]} [props.projects]
 * @param {import('../../types').Label[]} [props.labels]
 * @param {(field: string, value: any) => void} props.onApplyField - e.g. onApplyField('dueDate', '2026-08-20')
 * @param {() => void} props.onMarkComplete
 * @param {() => void} props.onMarkIncomplete
 * @param {() => void} props.onDelete
 * @param {() => void} props.onCancel - Deselect all / exit selection mode
 * @param {() => void} [props.onSelectAll] - omit to hide the affordance (no obvious "all visible" set)
 */
export default function BulkActionBar({
  count,
  editableFields,
  projects = [],
  labels = [],
  onApplyField,
  onMarkComplete,
  onMarkIncomplete,
  onDelete,
  onCancel,
  onSelectAll,
}) {
  const [openField, setOpenField] = useState(null); // null | 'dueDate' | 'recurrence' | 'project' | 'labels' | 'priority'
  const [recurrenceCount, setRecurrenceCount] = useState(1);
  const [recurrenceUnit, setRecurrenceUnit] = useState('week');

  if (count === 0) return null;

  function toggleField(field) {
    setOpenField((prev) => (prev === field ? null : field));
  }

  function applyAndClose(field, value) {
    onApplyField(field, value);
    setOpenField(null);
  }

  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-action-bar-inner">
        <span className="bulk-action-bar-count">{count} selected</span>

        <div className="bulk-action-bar-fields">
          {editableFields.dueDate && (
            <div className="bulk-action-bar-field">
              <button type="button" className="btn btn-icon" title="Set due date" onClick={() => toggleField('dueDate')}>
                <Calendar size={14} />
              </button>
              {openField === 'dueDate' && (
                <div className="bulk-action-bar-popover">
                  <input
                    type="date"
                    autoFocus
                    onChange={(e) => applyAndClose('dueDate', e.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {editableFields.recurrence && (
            <div className="bulk-action-bar-field">
              <button type="button" className="btn btn-icon" title="Set recurrence" onClick={() => toggleField('recurrence')}>
                <Repeat size={14} />
              </button>
              {openField === 'recurrence' && (
                <div className="bulk-action-bar-popover">
                  <div className="bulk-action-bar-recurrence-row">
                    <span>Every</span>
                    <NumberField
                      min={1}
                      max={999}
                      unitLabel={recurrenceUnit + 's'}
                      value={recurrenceCount}
                      onCommit={setRecurrenceCount}
                      style={{ width: 50 }}
                    />
                    <select value={recurrenceUnit} onChange={(e) => setRecurrenceUnit(e.target.value)}>
                      {RECURRENCE_UNITS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="bulk-action-bar-popover-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => applyAndClose('recurrence', { count: recurrenceCount, unit: recurrenceUnit })}
                    >
                      Apply
                    </button>
                    <button type="button" className="btn" onClick={() => applyAndClose('recurrence', null)}>
                      Turn off
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {editableFields.project && projects.length > 0 && (
            <div className="bulk-action-bar-field">
              <button type="button" className="btn btn-icon" title="Move to project" onClick={() => toggleField('project')}>
                <Folder size={14} />
              </button>
              {openField === 'project' && (
                <div className="bulk-action-bar-popover">
                  <select autoFocus defaultValue="" onChange={(e) => applyAndClose('project', e.target.value)}>
                    <option value="" disabled>
                      Move to…
                    </option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {/* Synthetic destination, not a real Project record (see
                        projectConstants.js) — grouped separately so it reads
                        as distinct from the real project list above it. */}
                    <optgroup label="Other">
                      <option value={NO_SCHEDULE_PROJECT_ID}>{NO_SCHEDULE_PROJECT_LABEL}</option>
                    </optgroup>
                  </select>
                </div>
              )}
            </div>
          )}

          {editableFields.labels && labels.length > 0 && (
            <div className="bulk-action-bar-field">
              <button type="button" className="btn btn-icon" title="Add a tag" onClick={() => toggleField('labels')}>
                <Tag size={14} />
              </button>
              {openField === 'labels' && (
                <div className="bulk-action-bar-popover">
                  <select autoFocus defaultValue="" onChange={(e) => applyAndClose('labels', e.target.value)}>
                    <option value="" disabled>
                      Add tag…
                    </option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {editableFields.priority && (
            <div className="bulk-action-bar-field">
              <button type="button" className="btn btn-icon" title="Set priority" onClick={() => toggleField('priority')}>
                <Flag size={14} />
              </button>
              {openField === 'priority' && (
                <div className="bulk-action-bar-popover">
                  <select autoFocus defaultValue="" onChange={(e) => applyAndClose('priority', e.target.value)}>
                    <option value="" disabled>
                      Set priority…
                    </option>
                    {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {editableFields.status && (
            <>
              <button type="button" className="btn btn-icon" title="Mark complete" onClick={onMarkComplete}>
                <CheckSquare size={14} />
              </button>
              <button type="button" className="btn btn-icon" title="Mark incomplete" onClick={onMarkIncomplete}>
                <Square size={14} />
              </button>
            </>
          )}

          {editableFields.delete && (
            <button
              type="button"
              className="btn btn-icon bulk-action-bar-delete"
              title="Delete selected"
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className="bulk-action-bar-trailing">
          {onSelectAll && (
            <button type="button" className="btn" onClick={onSelectAll}>
              Select all
            </button>
          )}
          <button type="button" className="btn btn-icon" title="Cancel" aria-label="Cancel selection" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

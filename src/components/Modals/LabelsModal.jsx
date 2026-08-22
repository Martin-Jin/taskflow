/**
 * LabelsModal — lists every Label (tag) that currently exists in TaskFlow,
 * each with how many tasks currently carry it, so users can see their full
 * tag vocabulary at a glance rather than only discovering tags one task's
 * LabelPicker at a time. Supports renaming (updates the shared Label
 * record — every task referencing it by id picks up the new name for
 * free) and deleting (strips the tag off every task that had it, via
 * SchedulerContext.deleteLabel, which commits it as one undoable action).
 */

import React, { useMemo, useState } from 'react';
import { Tag, Pencil, Trash2, Check } from 'lucide-react';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import Modal from '../Common/Modal';
import EmptyState from '../Common/EmptyState';
import { useScheduler } from '../../context/SchedulerContext';
import { useConfirm } from '../../context/ConfirmContext';

export default function LabelsModal({ onClose }) {
  const { labels, tasks, renameLabel, deleteLabel } = useScheduler();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  // Escape cancels the in-progress rename rather than closing the whole modal.
  // Unmounting the input skips its onBlur, so the abandoned value is dropped
  // instead of committed — which is the point.
  useEscapeLayer(!!editingId, () => {
    setEditingId(null);
    setEditValue('');
  });

  const labelsWithCounts = useMemo(() => {
    const countByLabelId = new Map();
    for (const t of tasks) {
      for (const id of t.labelIds || []) {
        countByLabelId.set(id, (countByLabelId.get(id) || 0) + 1);
      }
    }
    return labels
      .map((l) => ({ ...l, count: countByLabelId.get(l.id) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [labels, tasks]);

  function startRename(label) {
    setEditingId(label.id);
    setEditValue(label.name);
  }

  function commitRename() {
    if (editingId && editValue.trim()) renameLabel(editingId, editValue);
    setEditingId(null);
    setEditValue('');
  }

  async function handleDelete(label) {
    const message =
      label.count > 0
        ? `Delete "${label.name}"? It will be removed from ${label.count} task${label.count === 1 ? '' : 's'}.`
        : `Delete "${label.name}"?`;
    if (await confirm(message, { confirmLabel: 'Delete' })) deleteLabel(label.id);
  }

  return (
    <Modal onClose={onClose} ariaLabel="All tags" variantClassName="modal-stat-list" title="Tags">
      {labelsWithCounts.length === 0 ? (
        <EmptyState>No tags yet — add one to a task with "@tag" in its title.</EmptyState>
      ) : (
        <ul className="missed-tasks-list stat-list-modal-list">
          {labelsWithCounts.map((l) => (
            <li
              key={l.id}
              className="missed-tasks-item scheduled-today-item"
              style={{ background: 'var(--color-bg-page)' }}
            >
              <span className="label-swatch" style={{ background: l.color, flexShrink: 0 }} />
              {editingId === l.id ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    }
                    // Escape cancels the rename via the escape layer registered
                    // above — a keydown here never sees it (see useEscapeLayer).
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <span className="missed-tasks-title" style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1 }}>
                  <Tag size={12} style={{ color: l.color, flexShrink: 0 }} />
                  {l.name}
                </span>
              )}
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 12, flexShrink: 0 }}>
                {l.count} task{l.count === 1 ? '' : 's'}
              </span>
              <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                {editingId === l.id ? (
                  <button
                    className="btn btn-icon"
                    onClick={commitRename}
                    aria-label="Save name"
                    title="Save"
                    style={{ border: 'none', background: 'transparent' }}
                  >
                    <Check size={13} />
                  </button>
                ) : (
                  <button
                    className="btn btn-icon"
                    onClick={() => startRename(l)}
                    aria-label={`Rename ${l.name}`}
                    title="Rename"
                    style={{ border: 'none', background: 'transparent' }}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                <button
                  className="btn btn-icon"
                  onClick={() => handleDelete(l)}
                  aria-label={`Delete ${l.name}`}
                  title="Delete"
                  style={{ border: 'none', background: 'transparent', color: 'var(--color-danger)' }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
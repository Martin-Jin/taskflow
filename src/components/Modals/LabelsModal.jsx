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
import { X, Tag, Pencil, Trash2, Check } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useScheduler } from '../../context/SchedulerContext';

export default function LabelsModal({ onClose }) {
  const { labels, tasks, renameLabel, deleteLabel } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

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

  function handleDelete(label) {
    const message =
      label.count > 0
        ? `Delete "${label.name}"? It will be removed from ${label.count} task${label.count === 1 ? '' : 's'}.`
        : `Delete "${label.name}"?`;
    if (window.confirm(message)) deleteLabel(label.id);
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="All tags"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Tags</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {labelsWithCounts.length === 0 ? (
          <div className="now-empty">No tags yet — add one to a task with "@tag" in its title.</div>
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
                      if (e.key === 'Escape') {
                        setEditingId(null);
                        setEditValue('');
                      }
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
      </div>
    </div>
  );
}
/**
 * ShortcutsModal — Settings → Keyboard shortcuts. Lists every global
 * shortcut (see useKeyboardShortcuts) plus non-editable ones handled
 * elsewhere in the app (Escape-to-close), with a search bar to filter and a
 * lightweight per-row editor: click "Edit" to either record a real keypress
 * or pick one of a few common presets from a dropdown, then Save.
 *
 * Bindings are persisted to localStorage only (see useKeyboardShortcuts) —
 * this is a personal device preference, not app data, so it's deliberately
 * left out of backups/cloud sync.
 */

import React, { useMemo, useState } from 'react';
import { X, Search, Keyboard, RotateCcw, Pencil } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import {
  SHORTCUT_DEFS,
  PRESET_COMBOS,
  comboFromEvent,
  comboFor,
  setShortcutBinding,
  resetShortcutBinding,
} from '../../hooks/useKeyboardShortcuts';

export default function ShortcutsModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  // Bumped whenever a binding changes, to force the combo lookups (which
  // read straight from localStorage, not React state) to recompute.
  const [version, setVersion] = useState(0);

  const filteredDefs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_DEFS;
    return SHORTCUT_DEFS.filter((d) => d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
  }, [query]);

  function startEditing(id) {
    setEditingId(id);
    setRecording(false);
    setError('');
  }

  function cancelEditing() {
    setEditingId(null);
    setRecording(false);
    setError('');
  }

  function isDuplicate(combo, excludeId) {
    return SHORTCUT_DEFS.some((d) => d.editable && d.id !== excludeId && comboFor(d.id) === combo);
  }

  function applyCombo(id, combo) {
    if (!combo) return;
    if (isDuplicate(combo, id)) {
      setError(`"${combo}" is already used by another shortcut.`);
      return;
    }
    setShortcutBinding(id, combo);
    setVersion((v) => v + 1);
    cancelEditing();
  }

  function handleRecordKeyDown(e, id) {
    // Escape isn't handled here — useModalA11y's capture-phase listener
    // (see hooks/useModalA11y.js) already intercepts it first to close the
    // whole modal, matching every other modal's Escape-to-close behavior.
    // Use the ✕ button instead to cancel just this row's edit.
    if (e.key === 'Escape') return;
    e.preventDefault();
    // A bare modifier key press (still holding it down, nothing else yet)
    // isn't a usable combo on its own — wait for the following key.
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    applyCombo(id, comboFromEvent(e));
  }

  function handleReset(id) {
    resetShortcutBinding(id);
    setVersion((v) => v + 1);
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list modal-shortcuts"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Keyboard shortcuts</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="sidebar-project-search">
          <Search size={13} className="sidebar-project-search-icon" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shortcuts…"
            aria-label="Search shortcuts"
          />
        </div>

        {filteredDefs.length === 0 ? (
          <div className="now-empty">No shortcuts match "{query}".</div>
        ) : (
          <ul className="missed-tasks-list stat-list-modal-list">
            {filteredDefs.map((d) => {
              const combo = comboFor(d.id);
              const isDefault = combo === d.defaultCombo;
              const isEditing = editingId === d.id;
              return (
                <li
                  key={d.id}
                  className="missed-tasks-item scheduled-today-item"
                  style={{ background: 'var(--color-bg-page)', flexWrap: 'wrap' }}
                >
                  <span style={{ flex: 1, minWidth: 140 }}>
                    <span className="missed-tasks-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Keyboard size={12} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
                      {d.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      {d.description}
                    </span>
                  </span>

                  {!d.editable ? (
                    <kbd className="shortcut-kbd" title="Not customizable">
                      {d.defaultCombo}
                    </kbd>
                  ) : isEditing ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <input
                        autoFocus
                        readOnly
                        value={recording ? 'Press keys…' : comboFor(d.id)}
                        onFocus={() => setRecording(true)}
                        onBlur={() => setRecording(false)}
                        onKeyDown={(e) => handleRecordKeyDown(e, d.id)}
                        style={{ width: 130, textAlign: 'center', cursor: 'pointer' }}
                        aria-label={`Record new key combo for ${d.label}`}
                      />
                      <select
                        value=""
                        onChange={(e) => e.target.value && applyCombo(d.id, e.target.value)}
                        aria-label={`Pick a preset combo for ${d.label}`}
                        style={{ fontSize: 12 }}
                      >
                        <option value="">Or pick a preset…</option>
                        {PRESET_COMBOS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-icon" onClick={cancelEditing} aria-label="Cancel" title="Cancel">
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <kbd className="shortcut-kbd">{combo}</kbd>
                      <button
                        className="btn btn-icon"
                        onClick={() => startEditing(d.id)}
                        aria-label={`Edit ${d.label} shortcut`}
                        title="Edit"
                        style={{ border: 'none', background: 'transparent' }}
                      >
                        <Pencil size={13} />
                      </button>
                      {!isDefault && (
                        <button
                          className="btn btn-icon"
                          onClick={() => handleReset(d.id)}
                          aria-label={`Reset ${d.label} to default`}
                          title="Reset to default"
                          style={{ border: 'none', background: 'transparent' }}
                        >
                          <RotateCcw size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 8, marginBottom: 0 }}>{error}</p>
        )}
        <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 10, marginBottom: 0 }}>
          Shortcuts don't fire while typing in a text field. Custom combos are saved on this device only.
        </p>
      </div>
    </div>
  );
}

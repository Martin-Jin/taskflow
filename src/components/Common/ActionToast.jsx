import React from 'react';
import { Undo2, X } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';

/**
 * Google-Calendar-style "Task added"/"Event saved" toast with an inline
 * Undo, replacing the old always-on "last action" text in the topbar.
 * Separate from the general-purpose Toast (sync/backup status) so an
 * undo opportunity never gets silently overwritten by an unrelated
 * success/error message landing in the same slot.
 */
export default function ActionToast({ toast, onUndo, onDismiss }) {
  const { isClosing, close } = useAutoDismiss(toast, onDismiss);

  if (!toast) return null;

  return (
    <div className={`action-toast ${isClosing ? 'is-closing' : ''}`}>
      <span style={{ flex: 1 }}>{toast.label}</span>
      <button
        className="btn btn-icon action-toast-undo"
        onClick={() => {
          onUndo();
          close();
        }}
      >
        <Undo2 size={14} />
        Undo
      </button>
      <button
        className="btn btn-icon"
        style={{ padding: 2, border: 'none', background: 'none' }}
        onClick={close}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

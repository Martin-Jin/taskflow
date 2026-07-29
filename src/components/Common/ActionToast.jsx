import React, { useEffect, useState } from 'react';
import { Undo2, X } from 'lucide-react';

const EXIT_DURATION = 160;

/**
 * Google-Calendar-style "Task added"/"Event saved" toast with an inline
 * Undo, replacing the old always-on "last action" text in the topbar.
 * Separate from the general-purpose Toast (sync/backup status) so an
 * undo opportunity never gets silently overwritten by an unrelated
 * success/error message landing in the same slot.
 */
export default function ActionToast({ toast, onUndo, onDismiss }) {
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setIsClosing(false);
    const timer = setTimeout(() => setIsClosing(true), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = setTimeout(onDismiss, EXIT_DURATION);
    return () => clearTimeout(timer);
  }, [isClosing, onDismiss]);

  if (!toast) return null;

  return (
    <div className={`action-toast ${isClosing ? 'is-closing' : ''}`}>
      <span style={{ flex: 1 }}>{toast.label}</span>
      <button
        className="btn btn-icon action-toast-undo"
        onClick={() => {
          onUndo();
          setIsClosing(true);
        }}
      >
        <Undo2 size={14} />
        Undo
      </button>
      <button
        className="btn btn-icon"
        style={{ padding: 2, border: 'none', background: 'none' }}
        onClick={() => setIsClosing(true)}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2, X } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info, loading: Loader2 };

export default function Toast({ notification, onDismiss }) {
  // `loading` toasts (e.g. "Connecting to Google Calendar...") represent an
  // in-progress operation with no fixed duration — they're meant to be
  // explicitly replaced by a success/warning/error notification once that
  // operation resolves, not to silently time out and disappear while it's
  // still running. Every other type keeps the normal auto-dismiss behavior.
  const { isClosing, close } = useAutoDismiss(notification, onDismiss, {
    duration: notification?.type === 'loading' ? Infinity : undefined,
  });

  if (!notification) return null;

  const Icon = ICONS[notification.type] || Info;

  return (
    <div className={`toast ${notification.type} ${isClosing ? 'is-closing' : ''}`}>
      <Icon size={16} strokeWidth={2} className={notification.type === 'loading' ? 'spin' : undefined} />
      <span style={{ flex: 1 }}>{notification.message}</span>
      {notification.actionLabel && (
        <button
          className="btn-link"
          onClick={() => {
            notification.onAction?.();
            close();
          }}
        >
          {notification.actionLabel}
        </button>
      )}
      <button className="btn btn-icon" style={{ padding: 2, border: 'none', background: 'none' }} onClick={close}>
        <X size={14} />
      </button>
    </div>
  );
}

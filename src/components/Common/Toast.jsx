import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };

export default function Toast({ notification, onDismiss }) {
  const { isClosing, close } = useAutoDismiss(notification, onDismiss);

  if (!notification) return null;

  const Icon = ICONS[notification.type] || Info;

  return (
    <div className={`toast ${notification.type} ${isClosing ? 'is-closing' : ''}`}>
      <Icon size={16} strokeWidth={2} />
      <span style={{ flex: 1 }}>{notification.message}</span>
      <button className="btn btn-icon" style={{ padding: 2, border: 'none', background: 'none' }} onClick={close}>
        <X size={14} />
      </button>
    </div>
  );
}

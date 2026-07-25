import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };
const EXIT_DURATION = 160;

export default function Toast({ notification, onDismiss }) {
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!notification) return;
    setIsClosing(false);
    const timer = setTimeout(() => setIsClosing(true), 6000);
    return () => clearTimeout(timer);
  }, [notification]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = setTimeout(onDismiss, EXIT_DURATION);
    return () => clearTimeout(timer);
  }, [isClosing, onDismiss]);

  if (!notification) return null;

  const Icon = ICONS[notification.type] || Info;

  return (
    <div className={`toast ${notification.type} ${isClosing ? 'is-closing' : ''}`}>
      <Icon size={16} strokeWidth={2} />
      <span style={{ flex: 1 }}>{notification.message}</span>
      <button className="btn btn-icon" style={{ padding: 2, border: 'none', background: 'none' }} onClick={() => setIsClosing(true)}>
        <X size={14} />
      </button>
    </div>
  );
}

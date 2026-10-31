import React, { useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2, X } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { useMotionEnabled } from '../../hooks/useMotionEnabled';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info, loading: Loader2 };

// How long each extra line of a long message stays readable while it scrolls
// into view (matches the step timing in .toast-message-text's animation).
const SCROLL_MS_PER_LINE = 1500;

export default function Toast({ notification, onDismiss }) {
  // `loading` toasts (e.g. "Connecting to Google Calendar...") represent an
  // in-progress operation with no fixed duration — they're meant to be
  // explicitly replaced by a success/warning/error notification once that
  // operation resolves, not to silently time out and disappear while it's
  // still running. Every other type keeps the normal auto-dismiss behavior.
  const messageRef = useRef(null);
  const motionEnabled = useMotionEnabled();
  // How many lines of the message are hidden below the two-line window. Only
  // ever above 0 on mobile, where CSS caps the message at two lines (see
  // .toast-message); on wider screens the toast just grows to fit.
  const [hiddenLines, setHiddenLines] = useState(0);

  useLayoutEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 1;
    setHiddenLines(Math.max(0, Math.round((el.scrollHeight - el.clientHeight) / lineHeight)));
  }, [notification?.message]);

  // A long message gets extra time on screen so the scroll can finish and the
  // last line can still be read before the toast closes.
  const baseDuration = notification?.type === 'loading' ? Infinity : 6000;
  const { isClosing, close } = useAutoDismiss(notification, onDismiss, {
    duration: baseDuration + (motionEnabled ? hiddenLines * SCROLL_MS_PER_LINE : 0),
  });

  if (!notification) return null;

  const Icon = ICONS[notification.type] || Info;

  return (
    <div className={`toast ${notification.type} ${isClosing ? 'is-closing' : ''}`}>
      <Icon size={16} strokeWidth={2} className={notification.type === 'loading' ? 'spin' : undefined} />
      {/* With animations on, the hidden lines scroll into view one at a time;
          with them off the message is a plain scrollable area instead. */}
      <span
        ref={messageRef}
        className={`toast-message${hiddenLines > 0 ? (motionEnabled ? ' is-scrolling' : ' is-scrollable') : ''}`}
        style={{ '--toast-hidden-lines': hiddenLines, '--toast-scroll-ms': `${SCROLL_MS_PER_LINE}ms` }}
      >
        <span className="toast-message-text">{notification.message}</span>
      </span>
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

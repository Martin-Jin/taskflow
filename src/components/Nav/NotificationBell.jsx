/**
 * ============================================================================
 * NotificationBell — the in-app mention inbox
 * ============================================================================
 * A bell with an unread count that opens a list of "X mentioned you on <task>"
 * entries. Clicking an entry marks it read and opens that task. Rendered next
 * to AccountButton (sidebar, mobile dashboard topbar, mobile task header) and
 * renders nothing unless a real account is signed in — guests and signed-out
 * visitors have no inbox. See hooks/useMentionInbox.js and
 * utils/mentionNotifications.js.
 *
 * The panel is portaled to document.body with fixed positioning so the
 * sidebar's and topbar's overflow can't clip it. It sits at z-index 200, the
 * same layer as the account menu, which is below the guided tour overlay
 * (1000), so the tour is never covered by it. On a phone it spans the screen
 * width instead of anchoring to the button.
 *
 * The task opens in its own TaskDetailModal rendered from here, so the bell
 * works wherever it is mounted without App wiring.
 * ============================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck } from 'lucide-react';
import useMentionInbox from '../../hooks/useMentionInbox';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { useScheduler } from '../../context/SchedulerContext';
import TaskDetailModal from '../Modals/TaskDetailModal';
import { formatDisplayDateTime } from '../../utils/dateUtils';

/**
 * @param {{ menuAlign?: 'up'|'down' }} props - whether the panel opens above or below the button
 */
export default function NotificationBell({ menuAlign = 'down' }) {
  const { available, items, unreadCount, markRead, markAllRead } = useMentionInbox();
  const { tasks, setNotification } = useScheduler();
  const [open, setOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  useEscapeLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return undefined;
    function onClickOutside(e) {
      if (buttonRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  if (!available) return null;

  function toggle() {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setAnchor({ left: r.left, right: window.innerWidth - r.right, top: r.bottom + 6, bottom: window.innerHeight - r.top + 6 });
    }
    setOpen((v) => !v);
  }

  function openItem(item) {
    if (!item.read) markRead(item.id);
    setOpen(false);
    if (tasks.some((t) => t.id === item.taskId)) setOpenTaskId(item.taskId);
    else setNotification?.({ type: 'info', message: 'That task is no longer available.' });
  }

  const panelStyle = anchor
    ? menuAlign === 'up'
      ? { left: anchor.left, bottom: anchor.bottom }
      : { right: Math.max(anchor.right, 8), top: anchor.top }
    : undefined;
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="notification-bell-btn"
        onClick={toggle}
        aria-label={unreadCount ? `Mentions, ${unreadCount} unread` : 'Mentions'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Mentions"
        data-testid="notification-bell"
      >
        <Bell size={18} />
        {unreadCount > 0 && <span className="notification-bell-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="notification-panel"
            style={panelStyle}
            role="dialog"
            aria-label="Mentions"
            data-testid="notification-panel"
          >
            <div className="notification-panel-header">
              <span className="notification-panel-title">Mentions</span>
              {unreadCount > 0 && (
                <button type="button" className="notification-mark-all" onClick={markAllRead}>
                  <CheckCheck size={14} />
                  Mark all read
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <p className="notification-empty">Nothing yet. You will see it here when someone mentions you in a shared task.</p>
            ) : (
              <ul className="notification-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`notification-item ${item.read ? '' : 'is-unread'}`}
                      onClick={() => openItem(item)}
                    >
                      <span className="notification-item-line">
                        <strong>{item.senderName}</strong> mentioned you on <strong>{item.taskTitle}</strong>
                      </span>
                      {item.snippet && <span className="notification-item-snippet">{item.snippet}</span>}
                      {item.createdAtMs != null && (
                        <span className="notification-item-time">{formatDisplayDateTime(new Date(item.createdAtMs).toISOString())}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body
        )}

      {openTask && createPortal(<TaskDetailModal task={openTask} onClose={() => setOpenTaskId(null)} />, document.body)}
    </>
  );
}

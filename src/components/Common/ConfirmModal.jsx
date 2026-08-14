/**
 * ConfirmModal — global singleton renderer for ConfirmContext's pending
 * confirmation request (see that file's header for why this replaces every
 * window.confirm call site). Mounted once in App.jsx, same pattern as
 * CompleteTaskConfirmModal: a context holds at most one pending request,
 * this component renders it when present and renders nothing otherwise.
 *
 * Message text is shown with `white-space: pre-wrap` — a few call sites
 * (e.g. "Rewrite Google Calendar to match TaskFlow?" in SettingsPanel) build
 * a multi-paragraph message with embedded "\n\n", which needs to keep
 * rendering as separate paragraphs, not collapse onto one line the way a
 * plain <p> would.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useConfirmRequest } from '../../context/ConfirmContext';

export default function ConfirmModal() {
  const { request, resolve } = useConfirmRequest();
  if (!request) return null;
  return <ConfirmModalInner request={request} resolve={resolve} />;
}

function ConfirmModalInner({ request, resolve }) {
  const { isClosing, requestClose } = useAnimatedUnmount(() => resolve(false));
  const modalRef = useModalA11y(requestClose);

  function handleConfirm() {
    resolve(true);
  }

  return (
    <div className={`modal-overlay confirm-modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-confirm"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={request.danger ? 'Confirm destructive action' : 'Confirm'}
        tabIndex={-1}
      >
        {request.danger && (
          <AlertTriangle size={20} className="confirm-modal-icon" aria-hidden="true" />
        )}
        <p className="confirm-modal-message">{request.message}</p>
        <div className="addtask-footer" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={requestClose} autoFocus>
            {request.cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={request.danger ? { background: 'var(--color-danger)', borderColor: 'var(--color-danger)' } : undefined}
            onClick={handleConfirm}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

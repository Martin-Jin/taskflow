/**
 * Modal — the shared overlay/dialog shell every modal in the app should be
 * built on. Wraps the useAnimatedUnmount + useModalA11y pair (exit animation,
 * focus trap, Escape-to-close, open-modal stack) and the standard
 * .modal-overlay/.modal markup that used to be hand-copied into every one of
 * ~20 modal files — replacing 15 bespoke class combos and ~10 hardcoded
 * inline pixel widths with one `size` prop on a fixed scale.
 *
 * `header`/`children`(body)/`footer` may each be a plain ReactNode OR a
 * function `({ requestClose, isClosing }) => ReactNode` — nearly every real
 * modal needs `requestClose` in more than one place (an X button in the
 * header, a Cancel button in the footer, closing itself after a successful
 * submit), so this is a render-prop, not a plain children prop, whenever
 * that's needed. `title` is a convenience for the common case (a plain
 * string heading + the standard X-close button) — pass `header` instead for
 * anything bespoke (e.g. a title INPUT rather than static text).
 *
 * `as="form"` wraps header+body+footer together in a single
 * <form onSubmit={(e) => onSubmit(e, ctx)}>, matching modals like
 * AddProjectModal where the whole dialog (title field included) submits as
 * one unit — the header is NOT pulled outside the form in that mode, since
 * every such modal in this app wants Enter-to-submit from the title field
 * itself. `onSubmit` gets the same `{ requestClose, isClosing }` ctx as the
 * other slots, so it can close the modal on a successful submit.
 *
 * `dismissible={false}` (JoinProjectModal's mid-flow "can't dismiss while
 * busy" case) disables overlay-click-to-close and Escape — passed straight
 * through to useModalA11y as a no-op close, the same technique that modal
 * already used by hand before this component existed.
 *
 * `guardDismiss` is the softer version of that: a `() => boolean` consulted
 * on each CASUAL dismissal (Escape, overlay click, and the `attemptClose`
 * handed to slots) — return false to refuse and, presumably, say why. It
 * deliberately does NOT gate `requestClose`, so an explicit Cancel button or
 * a post-submit self-close is never blocked; a slot wires the guarded
 * `attemptClose` to its X button and the unguarded `requestClose` to Cancel.
 * See NoteEditorModal, where dismissing a half-written note used to discard
 * it with no explanation.
 *
 * NOT every modal in the app is on this yet — some have deliberately
 * bespoke shapes (JoinProjectModal's busy-gated dismissal, TaskDetailModal's
 * own multi-panel layout) migrated separately, on their own terms, rather
 * than forced through this shell.
 */

import React from 'react';
import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

function resolveSlot(slot, ctx) {
  return typeof slot === 'function' ? slot(ctx) : slot;
}

export default function Modal({
  onClose,
  ariaLabel,
  size = 'md',
  title,
  header,
  footer,
  children,
  as = 'div',
  onSubmit,
  variantClassName = '',
  overlayClassName = '',
  dismissible = true,
  guardDismiss,
}) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const attemptClose = () => {
    if (guardDismiss && guardDismiss() === false) return;
    requestClose();
  };
  const modalRef = useModalA11y(dismissible ? attemptClose : () => {});
  const ctx = { requestClose, attemptClose, isClosing };

  // .stat-list-modal-header (not .detail-header) is the correct match for a
  // plain static-text title: .detail-header is shaped for AddProjectModal/
  // AddTaskModal's title INPUT (align-items: flex-start, room for a taller
  // stack), while .stat-list-modal-header is already built for exactly this
  // "space-between, single-line h3 + close button" case (see StatListModal,
  // the pattern this generalizes). A bespoke header (a title input, extra
  // badges, etc.) should pass `header` instead of `title`.
  const resolvedHeader =
    header !== undefined
      ? resolveSlot(header, ctx)
      : title !== undefined && (
          <div className="stat-list-modal-header">
            <h3>{title}</h3>
            <button type="button" className="btn btn-icon detail-header-close" onClick={attemptClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        );

  const inner = (
    <>
      {resolvedHeader}
      {resolveSlot(children, ctx)}
      {footer !== undefined && resolveSlot(footer, ctx)}
    </>
  );

  const Wrapper = as === 'form' ? 'form' : React.Fragment;
  const wrapperProps = as === 'form' ? { onSubmit: (e) => onSubmit?.(e, ctx) } : {};

  return (
    <div className={`modal-overlay ${overlayClassName} ${isClosing ? 'is-closing' : ''}`} onClick={dismissible ? requestClose : undefined}>
      <div
        className={`modal modal-size-${size} ${variantClassName}`}
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        <Wrapper {...wrapperProps}>{inner}</Wrapper>
      </div>
    </div>
  );
}

/**
 * ============================================================================
 * ConfirmContext
 * ============================================================================
 * App-wide replacement for window.confirm(). Some browsers (seen in the wild:
 * Firefox, under certain permission/anti-spam states) silently refuse to show
 * window.confirm/window.prompt for a page at all — no dialog, no error, no
 * console warning — which left every destructive-action button in the app
 * (Delete project, Clear all data, Restore backup, ...) doing NOTHING with
 * zero feedback. A real React-rendered modal can never be suppressed that
 * way, so every window.confirm call site in the app now goes through the
 * `useConfirm()` hook exposed here instead.
 *
 * API mirrors window.confirm's call shape as closely as possible so each of
 * the ~21 migrated call sites stays a small diff:
 *
 *   const confirm = useConfirm();
 *   if (await confirm('Delete this?')) { ... }
 *
 *   // Or with options (title/labels/danger style) for sites that want them:
 *   if (await confirm('Delete "X"? This cannot be undone.', {
 *     confirmLabel: 'Delete',
 *     danger: true,
 *   })) { ... }
 *
 * Only one confirmation can be pending at a time (a discrete user click, same
 * assumption CompleteTaskContext makes for its own single-pending-request
 * state) — resolved with `true` on confirm, `false` on cancel/dismiss
 * (Escape, overlay click, or unmounting for any other reason), exactly like
 * window.confirm's boolean return. The pending promise's resolver is kept in
 * a ref (not state) since it's a plain function, never read by render.
 * ============================================================================
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  // { message, confirmLabel, cancelLabel, danger } | null
  const [request, setRequest] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setRequest({
        message,
        confirmLabel: options.confirmLabel || 'Confirm',
        cancelLabel: options.cancelLabel || 'Cancel',
        danger: options.danger ?? true, // most call sites are destructive; opt out per-site if not
      });
    });
  }, []);

  const resolve = useCallback((result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  const value = { request, resolve, confirm };

  return <ConfirmContext.Provider value={value}>{children}</ConfirmContext.Provider>;
}

/** Returns the imperative `confirm(message, options) => Promise<boolean>` function. */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx.confirm;
}

/** Internal: only ConfirmModal (the singleton renderer) needs the raw request/resolve pair. */
export function useConfirmRequest() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirmRequest must be used within a ConfirmProvider');
  return ctx;
}

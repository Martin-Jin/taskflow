/**
 * useAnimatedUnmount — small helper for the "play an exit animation, then
 * actually unmount" pattern shared by every modal (AddTaskModal,
 * TaskDetailModal, BlockDetailModal). React unmounts immediately when a
 * parent stops rendering a component, which would otherwise cut off any
 * CSS exit transition — so callers use `requestClose` in place of calling
 * `onClose` directly, and the modal keeps rendering (with an `.is-closing`
 * class applied) for `exitDuration` ms before the real onClose fires.
 *
 * When motion is off there's no exit animation to wait for, so the delay is
 * skipped entirely and onClose fires immediately — otherwise closing would
 * still lag by exitDuration even though the modal vanished instantly. The
 * check reads the same `data-animations` attribute (and reduced-motion query)
 * the CSS gates on, so there's one source of truth for "motion is off".
 */

import { useEffect, useRef, useState } from 'react';

function motionDisabled() {
  return (
    document.documentElement.getAttribute('data-animations') === 'off' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useAnimatedUnmount(onClose, exitDuration = 160) {
  const [isClosing, setIsClosing] = useState(false);
  const timeoutRef = useRef(null);

  // Clear any pending exit timer if the component unmounts for a reason
  // other than requestClose (e.g. a parent re-render removes it outright) —
  // otherwise the timeout still fires onClose against an unmounted tree.
  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  function requestClose() {
    if (isClosing) return;
    if (motionDisabled()) {
      onClose();
      return;
    }
    setIsClosing(true);
    timeoutRef.current = setTimeout(onClose, exitDuration);
  }

  return { isClosing, requestClose };
}

/**
 * useAnimatedUnmount — small helper for the "play an exit animation, then
 * actually unmount" pattern shared by every modal (AddTaskModal,
 * TaskDetailModal, BlockDetailModal). React unmounts immediately when a
 * parent stops rendering a component, which would otherwise cut off any
 * CSS exit transition — so callers use `requestClose` in place of calling
 * `onClose` directly, and the modal keeps rendering (with an `.is-closing`
 * class applied) for `exitDuration` ms before the real onClose fires.
 */

import { useEffect, useRef, useState } from 'react';

export function useAnimatedUnmount(onClose, exitDuration = 160) {
  const [isClosing, setIsClosing] = useState(false);
  const timeoutRef = useRef(null);

  // Clear any pending exit timer if the component unmounts for a reason
  // other than requestClose (e.g. a parent re-render removes it outright) —
  // otherwise the timeout still fires onClose against an unmounted tree.
  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  function requestClose() {
    if (isClosing) return;
    setIsClosing(true);
    timeoutRef.current = setTimeout(onClose, exitDuration);
  }

  return { isClosing, requestClose };
}

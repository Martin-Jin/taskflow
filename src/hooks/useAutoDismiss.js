/**
 * useAutoDismiss — shared timer logic for toast-style notifications that
 * auto-close after `duration` ms and then play a CSS exit animation for
 * `exitDuration` ms before actually calling `onDismiss` (mirrors the
 * "animate out, then unmount" idea in useAnimatedUnmount, but re-arms on
 * every new `value` rather than being a one-shot close). Used by both
 * Toast and ActionToast so the timer/animation pattern only exists once.
 */

import { useEffect, useState } from 'react';

export const EXIT_DURATION = 160;

export function useAutoDismiss(value, onDismiss, { duration = 6000, exitDuration = EXIT_DURATION } = {}) {
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!value) return;
    setIsClosing(false);
    const timer = setTimeout(() => setIsClosing(true), duration);
    return () => clearTimeout(timer);
  }, [value, duration]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = setTimeout(onDismiss, exitDuration);
    return () => clearTimeout(timer);
  }, [isClosing, onDismiss, exitDuration]);

  return { isClosing, close: () => setIsClosing(true) };
}

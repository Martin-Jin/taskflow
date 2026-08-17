/**
 * ============================================================================
 * useLongPressSelect
 * ============================================================================
 * Mobile entry point into bulk-select mode: long-press a task/card/calendar
 * item to enter selection mode AND select that first item in one gesture.
 * Modeled directly on useReparentDrag.js's own long-press pattern (same
 * LONG_PRESS_MS=250ms touch-start-then-branch structure, same "did we move
 * too far before the timer fired, so this is a scroll not a press" abort) —
 * shared here as one hook rather than re-implementing the timer/threshold
 * logic three times (List, Board, Calendar).
 *
 * Deliberately NOT reusing useReparentDrag itself: that hook's long-press
 * always ends in either a reparent-drag or nothing, and only fires while its
 * own `disabled` is false; this one only cares about "was this touch held
 * long enough without moving" and hands off a plain callback, independent of
 * any drag/reparent state.
 * ============================================================================
 */

import { useCallback, useRef } from 'react';

const LONG_PRESS_MS = 250;
const MOVE_ABORT_THRESHOLD_PX = 8;

/**
 * @param {object} params
 * @param {boolean} [params.disabled] - e.g. already in selection mode (nothing to "enter"), or a
 *   read-only/viewer surface that shouldn't offer selection at all.
 * @param {(key: string) => void} params.onLongPress - called with the item's key once the press
 *   lands (enters selection mode + selects this item — see call sites).
 * @returns {{ onTouchStart: (e: React.TouchEvent, key: string) => void }}
 */
export function useLongPressSelect({ disabled = false, onLongPress }) {
  const timerRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });

  const clear = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    window.removeEventListener('touchmove', handleMoveRef.current);
    window.removeEventListener('touchend', handleEndRef.current);
    window.removeEventListener('touchcancel', handleEndRef.current);
  }, []);

  // Stable refs to the move/end handlers so `clear` (a useCallback with an
  // empty dep array) can always remove exactly the listener instance that
  // was actually attached, without needing onTouchStart itself in its deps.
  const handleMoveRef = useRef(() => {});
  const handleEndRef = useRef(() => {});

  const onTouchStart = useCallback(
    (e, key) => {
      if (disabled) return;
      const touch = e.touches?.[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };

      handleMoveRef.current = (moveEvent) => {
        const t = moveEvent.touches?.[0];
        if (!t) return;
        const dx = t.clientX - startRef.current.x;
        const dy = t.clientY - startRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_ABORT_THRESHOLD_PX) clear(); // scrolling, not a long-press
      };
      handleEndRef.current = () => clear();

      timerRef.current = setTimeout(() => {
        clear();
        onLongPress(key);
      }, LONG_PRESS_MS);

      window.addEventListener('touchmove', handleMoveRef.current, { passive: true });
      window.addEventListener('touchend', handleEndRef.current);
      window.addEventListener('touchcancel', handleEndRef.current);
    },
    [disabled, onLongPress, clear]
  );

  return { onTouchStart };
}

/**
 * useDraggableWindowPosition — drag-to-reposition for TimerWidget's floating
 * window, the only consumer of this so far (see TimerWidget.jsx). Plain
 * pointer events (onPointerDown/move/up + setPointerCapture) rather than a
 * shared drag-and-drop abstraction, since the rest of the app's drag
 * patterns (BoardView/CalendarPage/WeekView) are all list-reordering, a
 * different mechanism — this is free-form "move a floating window" dragging
 * with no existing precedent to reuse.
 *
 * Position is the window's top-left corner in viewport px, persisted to
 * localStorage only (device-local, like theme/dashboard-widget-visibility —
 * NOT synced to the cloud or included in backups, see TimerContext's own
 * "Intentionally local-only" note). Defaults to bottom-right, offset above
 * where BottomTabBar/the mobile search FAB sit on small screens so a fresh
 * install doesn't start the window on top of either.
 *
 * Clamps to the viewport on every drag frame and again on resize (e.g.
 * rotating a phone, or resizing a desktop window), so the window can never
 * end up stuck off-screen.
 *
 * A click (negligible pointer movement) still toggles collapse — only a
 * genuine drag (pointer moved past a small threshold) suppresses the click,
 * so dragging the header doesn't also fire onClick at the end of the
 * gesture.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPersisted, savePersisted } from '../utils/persistence.js';

const STORAGE_KEY = 'timerWidgetPosition';
const CLICK_MOVE_THRESHOLD_PX = 6;
const EDGE_MARGIN = 12;
// Keeps the default spot clear of BottomTabBar + the mobile search FAB,
// both anchored bottom-right on small screens (see global.css).
const MOBILE_BOTTOM_CLEARANCE = 130;

function clampPosition(pos, el) {
  if (!el) return pos;
  const width = el.offsetWidth || 260;
  const height = el.offsetHeight || 40;
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(EDGE_MARGIN, pos.x), maxX),
    y: Math.min(Math.max(EDGE_MARGIN, pos.y), maxY),
  };
}

function getDefaultPosition() {
  const isMobile = window.innerWidth < 640;
  return {
    x: Math.max(EDGE_MARGIN, window.innerWidth - 260 - EDGE_MARGIN),
    y: Math.max(EDGE_MARGIN, window.innerHeight - (isMobile ? MOBILE_BOTTOM_CLEARANCE : 90)),
  };
}

export default function useDraggableWindowPosition({ onClick, contentSizeKey }) {
  const containerRef = useRef(null);
  const [position, setPosition] = useState(() => loadPersisted(STORAGE_KEY, null) ?? getDefaultPosition());
  const dragState = useRef(null); // { startX, startY, originX, originY, moved }

  // Re-clamp on resize (rotation, desktop window resize) so a position valid
  // at one viewport size can't leave the window stuck off-screen at another.
  useEffect(() => {
    function handleResize() {
      setPosition((prev) => clampPosition(prev, containerRef.current));
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Re-clamp whenever the caller's content changes size (e.g. TimerWidget
  // gaining/losing rows as timers start/stop) — position only tracks the
  // viewport by default, so a window anchored near the bottom edge could
  // otherwise grow taller than the remaining space below it and push its own
  // controls off-screen.
  useEffect(() => {
    if (contentSizeKey === undefined) return;
    setPosition((prev) => clampPosition(prev, containerRef.current));
  }, [contentSizeKey]);

  useEffect(() => {
    savePersisted(STORAGE_KEY, position);
  }, [position]);

  const setHeaderRef = useCallback((el) => {
    containerRef.current = el?.closest('.timer-widget') || el;
  }, []);

  const handlePointerDown = useCallback((e) => {
    // Only the primary button/touch/pen contact starts a drag.
    if (e.button != null && e.button !== 0) return;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((e) => {
    const drag = dragState.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > CLICK_MOVE_THRESHOLD_PX || Math.abs(dy) > CLICK_MOVE_THRESHOLD_PX) drag.moved = true;
    if (!drag.moved) return;
    setPosition(clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, containerRef.current));
  }, []);

  const handlePointerUp = useCallback((e) => {
    const drag = dragState.current;
    dragState.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag && !drag.moved) onClick?.();
  }, [onClick]);

  return {
    style: { position: 'fixed', left: position.x, top: position.y, right: 'auto', bottom: 'auto' },
    headerRef: setHeaderRef,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
    },
  };
}

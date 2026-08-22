/**
 * useMenuPosition — shared positioning logic for the app's small anchored
 * popup menus (ProjectActionsMenu, SelectMenu, TaskDetailModal's "..."
 * menu). Each of these independently computed a
 * `getBoundingClientRect`-based anchored position (right-aligned dropdown,
 * flip-above when there's no room below, ...) but none of them checked
 * whether that anchored position actually fits the viewport — on a narrow
 * phone screen a corner-anchored menu can end up clipped off-screen, or
 * survive only via an ad-hoc clamp that leaves it looking disconnected from
 * its trigger.
 *
 * This hook keeps each menu's own anchoring math (passed in as
 * `computeAnchored`) but adds the missing piece: once the menu has actually
 * mounted and its real rendered size is known, it checks the anchored box
 * against the viewport. If it doesn't fit, the menu switches to "centered"
 * mode — a fixed, viewport-centered popup — and the caller renders a
 * `.menu-popover-backdrop` behind it (see global.css) so it reads as a
 * lightweight modal instead of a dropdown that might clip.
 *
 * `forceCentered` skips the anchored attempt entirely (see
 * TaskDetailModal's detail-menu, which forces this on mobile rather than
 * bothering to measure a corner menu that rarely has room on a phone
 * screen).
 *
 * Also owns the close-on-outside-click wiring every one of these menus
 * already needed individually — clicking the centered mode's backdrop lands
 * here too, since the backdrop is neither the anchor nor the menu itself.
 * Close-on-Escape is delegated to useEscapeLayer, so an open menu inside a
 * modal beats the modal to the keypress.
 *
 * The initial style for a not-yet-measured menu is off-screen and hidden
 * rather than guessed, so the very first paint (post-measurement, thanks to
 * this running in useLayoutEffect before the browser paints) is always the
 * correct one — no anchored-then-jump-to-centered flash.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEscapeLayer } from './useEscapeLayer';

const VIEWPORT_MARGIN = 8;

const HIDDEN_STYLE = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' };

export function useMenuPosition({ isOpen, anchorRef, onClose, computeAnchored, forceCentered = false }) {
  const menuRef = useRef(null);
  const [state, setState] = useState({ mode: 'anchored', style: HIDDEN_STYLE });

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    if (forceCentered) {
      setState({ mode: 'centered', style: null });
      return undefined;
    }

    function reposition() {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;

      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const anchored = computeAnchored(anchorRect, menuRect);

      const left = anchored.left ?? 0;
      const top = anchored.top !== undefined ? anchored.top : window.innerHeight - (anchored.bottom ?? 0) - menuRect.height;
      const right = left + menuRect.width;
      const bottom = top + menuRect.height;
      const overflows =
        left < VIEWPORT_MARGIN ||
        right > window.innerWidth - VIEWPORT_MARGIN ||
        top < VIEWPORT_MARGIN ||
        bottom > window.innerHeight - VIEWPORT_MARGIN;

      setState((prev) => {
        const next = overflows ? { mode: 'centered', style: null } : { mode: 'anchored', style: { position: 'fixed', ...anchored } };
        if (prev.mode === next.mode && shallowStyleEqual(prev.style, next.style)) return prev;
        return next;
      });
    }

    // Scroll fires far more often than a frame renders (and capture-phase
    // here means it fires for scrolling anywhere in the document, not just
    // near this menu), so coalesce bursts down to one reposition — with its
    // layout-forcing getBoundingClientRect calls — per animation frame
    // instead of one per scroll event.
    let frameRequested = false;
    function scheduleReposition() {
      if (frameRequested) return;
      frameRequested = true;
      requestAnimationFrame(() => {
        frameRequested = false;
        reposition();
      });
    }

    reposition();
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
    return () => {
      window.removeEventListener('resize', scheduleReposition);
      window.removeEventListener('scroll', scheduleReposition, true);
    };
  }, [isOpen, forceCentered]);

  // Escape goes through the shared layer stack rather than a listener of this
  // hook's own. An open menu is usually inside a modal, and the modal is a
  // layer too — registering here (only while open, so this lands above the
  // modal) is what makes one Escape close just the menu instead of throwing
  // away the draft behind it.
  useEscapeLayer(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handlePointerDown(e) {
      if (anchorRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onClose();
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isOpen, onClose]);

  return { menuRef, mode: state.mode, style: state.style };
}

function shallowStyleEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

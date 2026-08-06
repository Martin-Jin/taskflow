/**
 * ProjectActionsMenu — the "⋯" popover used for a project's Rename / Pin /
 * Delete actions, shared between the sidebar's project rows and the List
 * view's project header so both look and behave identically. Portaled to
 * document.body and positioned via getBoundingClientRect (same approach as
 * SelectMenu) because sidebar rows sit inside an `overflow-y: auto` project
 * list — an in-flow popup would get clipped there. Falls back to a centered
 * popup with a dim backdrop (see useMenuPosition) if the anchored position
 * wouldn't fit the viewport, rather than clamping it into a spot that no
 * longer lines up with the trigger.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2, Users } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';

// The Rename/Pin/Delete buttons themselves, split out so ViewFilterMenu can
// fold them into its own combined mobile popover (see that file's
// `projectActions` prop) without duplicating this markup.
export function ProjectActionsItems({ isPinned, isShared, onRename, onTogglePin, onDelete, onShare, runAndClose }) {
  return (
    <>
      <button type="button" role="menuitem" className="project-actions-item" onClick={() => runAndClose(onRename)}>
        <Pencil size={13} />
        Rename
      </button>
      {/* Optional so the call sites that don't offer sharing (e.g. the List
          view's project header) keep working unchanged. Once a project IS
          shared this becomes a non-interactive status line rather than
          disappearing — "shared" is exactly the state a user most needs to be
          certain about, so it shouldn't be invisible. */}
      {onShare &&
        (isShared ? (
          <div className="project-actions-item project-actions-item-static" role="presentation">
            <Users size={13} />
            Shared project
          </div>
        ) : (
          <button type="button" role="menuitem" className="project-actions-item" onClick={() => runAndClose(onShare)}>
            <Users size={13} />
            Share project
          </button>
        ))}
      <button type="button" role="menuitem" className="project-actions-item" onClick={() => runAndClose(onTogglePin)}>
        {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
        {isPinned ? 'Unpin' : 'Pin'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="project-actions-item project-actions-item-danger"
        onClick={() => runAndClose(onDelete)}
      >
        <Trash2 size={13} />
        Delete
      </button>
    </>
  );
}

export default function ProjectActionsMenu({ isPinned, isShared, onRename, onTogglePin, onDelete, onShare, ariaLabel = 'Project actions' }) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);

  // Returns focus to the trigger so keyboard/screen-reader users don't lose
  // their place after an action (focus would otherwise fall back to <body>).
  // Safe even for onRename, whose own autofocused input takes focus back on
  // the next render — this just avoids the dead moment in between.
  function closeMenu() {
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  // Anchors the dropdown's right edge to the trigger's right edge (matching
  // this menu's old fixed-180px-wide math, now driven by the real measured
  // width) and flips above the trigger when there's no room below — see
  // useMenuPosition for the overflow check that falls back to a centered
  // popup when even that doesn't fit the viewport.
  const { menuRef, mode, style } = useMenuPosition({
    isOpen,
    anchorRef: buttonRef,
    onClose: closeMenu,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  function runAndClose(fn) {
    fn();
    closeMenu();
  }

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-icon project-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={14} />
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={closeMenu} />}
            <div
              ref={menuRef}
              className={`project-actions-dropdown ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              role="menu"
              style={mode === 'anchored' ? style : undefined}
            >
              <ProjectActionsItems
                isPinned={isPinned}
                isShared={isShared}
                onRename={onRename}
                onTogglePin={onTogglePin}
                onDelete={onDelete}
                onShare={onShare}
                runAndClose={runAndClose}
              />
            </div>
          </>,
          document.body
        )}
    </>
  );
}

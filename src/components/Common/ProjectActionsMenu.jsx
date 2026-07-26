/**
 * ProjectActionsMenu — the "⋯" popover used for a project's Rename / Pin /
 * Delete actions, shared between the sidebar's project rows and the List
 * view's project header so both look and behave identically. Portaled to
 * document.body and positioned via getBoundingClientRect (same approach as
 * SelectMenu) because sidebar rows sit inside an `overflow-y: auto` project
 * list — an in-flow popup would get clipped there.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';

export default function ProjectActionsMenu({ isPinned, onRename, onTogglePin, onDelete, ariaLabel = 'Project actions' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const buttonRef = useRef(null);
  const dropdownRef = useRef(null);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    function reposition() {
      const trigger = buttonRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const dropdownHeight = dropdownRef.current?.offsetHeight ?? 140;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceBelow < dropdownHeight && rect.top > spaceBelow;
      setPosition({
        left: rect.right - 180,
        top: openAbove ? undefined : rect.bottom + 4,
        bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
      });
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handlePointerDown(e) {
      if (buttonRef.current?.contains(e.target)) return;
      if (dropdownRef.current?.contains(e.target)) return;
      setIsOpen(false);
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Returns focus to the trigger so keyboard/screen-reader users don't lose
  // their place after an action (focus would otherwise fall back to <body>).
  // Safe even for onRename, whose own autofocused input takes focus back on
  // the next render — this just avoids the dead moment in between.
  function closeMenu() {
    setIsOpen(false);
    buttonRef.current?.focus();
  }

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
        position &&
        createPortal(
          <div
            ref={dropdownRef}
            className="project-actions-dropdown"
            role="menu"
            style={{ position: 'fixed', left: Math.max(8, position.left), top: position.top, bottom: position.bottom }}
          >
            <button type="button" role="menuitem" className="project-actions-item" onClick={() => runAndClose(onRename)}>
              <Pencil size={13} />
              Rename
            </button>
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
          </div>,
          document.body
        )}
    </>
  );
}

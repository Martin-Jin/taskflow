/**
 * HelpTooltip — small "?" icon button that reveals a short explanatory
 * popover on click. For a spot that needs one or two sentences of context
 * near a control (not a whole guided-tour step, and not enough content to
 * justify a dedicated modal like SmartParseGuideModal/AIQuickAddGuideModal).
 *
 * Positioning/outside-click/Escape handling all reuse useMenuPosition — the
 * same hook SelectMenu/ProjectActionsMenu are built on — so this behaves
 * identically to the rest of the app's anchored popups (flips to a centered
 * backdrop-modal on screens too small to fit it anchored, e.g. mobile).
 *
 * Usage: <HelpTooltip label="What does this do?">Explanation text.</HelpTooltip>
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';

export default function HelpTooltip({ label = 'Help', children, size = 14 }) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);

  const { menuRef, mode, style } = useMenuPosition({
    isOpen,
    anchorRef: buttonRef,
    onClose: () => setIsOpen(false),
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8),
        top: openAbove ? undefined : anchorRect.bottom + 6,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 6 : undefined,
      };
    },
  });

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-icon help-tooltip-trigger"
        onClick={() => setIsOpen((v) => !v)}
        aria-label={label}
        aria-expanded={isOpen}
        title={label}
      >
        <HelpCircle size={size} />
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setIsOpen(false)} />}
            <div
              ref={menuRef}
              role="tooltip"
              className={`help-tooltip-popover ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              style={mode === 'anchored' ? style : undefined}
            >
              {children}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

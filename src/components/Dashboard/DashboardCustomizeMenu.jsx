/**
 * DashboardCustomizeMenu — the gear-icon popover on the dashboard that lets
 * a user show/hide individual widgets (see dashboardWidgets.js). Same
 * anchored-popover pattern as ProjectActionsMenu (portaled + useMenuPosition
 * so it can't get clipped), except it stays open across clicks — each
 * checkbox toggles a widget without closing the menu, since picking several
 * in one visit is the common case.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { DASHBOARD_WIDGETS } from './dashboardWidgets';

export default function DashboardCustomizeMenu({ widgets, onToggleWidget }) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);

  function closeMenu() {
    setIsOpen(false);
    buttonRef.current?.focus();
  }

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

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-icon dashboard-customize-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Customize dashboard"
        title="Customize dashboard"
        onClick={() => setIsOpen((v) => !v)}
      >
        <SlidersHorizontal size={16} />
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={closeMenu} />}
            <div
              ref={menuRef}
              className={`project-actions-dropdown dashboard-customize-dropdown ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              role="menu"
              style={mode === 'anchored' ? style : undefined}
            >
              <p className="dashboard-customize-heading">Show on dashboard</p>
              {DASHBOARD_WIDGETS.map(({ key, label }) => (
                <label key={key} className="dashboard-customize-item">
                  <input type="checkbox" checked={widgets[key] !== false} onChange={() => onToggleWidget(key)} />
                  {label}
                </label>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

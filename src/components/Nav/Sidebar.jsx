/**
 * ============================================================================
 * Sidebar
 * ============================================================================
 * Desktop-only nav rail: the Workspace tab switch (Dashboard/Calendar/Tasks/
 * Projects/Stats/Settings) and a footer slot for the account button and
 * mentions bell.
 *
 * There used to be a "Pinned projects" group under the tabs (All Tasks, Inbox,
 * and any pinned projects). It was removed: switching project is covered by the
 * Projects page, the Tasks page's "Manage projects" icon and the search bar,
 * so the sidebar's copy only added clutter.
 *
 * COLLAPSING — three modes, chosen in Settings → Appearance (state in
 * SidebarPrefsContext, rules in utils/sidebarMode.js):
 *   - 'always' — the full sidebar, always.
 *   - 'toggle' (default) — clicking the sidebar's right edge
 *     (`.sidebar-edge-handle`) collapses it to a "rail" (a narrow icon-only
 *     strip: the logo alone replaces the name, each tab shrinks to its icon)
 *     and opens it again. Hovering the edge shows an arrow pointing the way
 *     it will move.
 *   - 'hover'  — resting state is the rail; the full sidebar opens OVER the
 *     page while the pointer is on it (or keyboard focus is inside it), so the
 *     page never shifts. A short delay on opening stops a pointer merely
 *     crossing the left edge from flashing it open.
 * The same markup serves every look. Text that disappears in the rail sits in
 * a `.sidebar-label` span, and CSS (nav.css, "Sidebar rail") hides it, so
 * nothing re-mounts when the look changes. Rail buttons get a title and
 * aria-label, since their visible text is gone.
 *
 * Only rendered on desktop — mobile has no sidebar and uses BottomTabBar.
 * ============================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import BrandMark from '../Common/BrandMark';
import { useSidebarPrefs } from '../../context/SidebarPrefsContext';

export default function Sidebar({ tabs, activeTab, onSelectTab, footer }) {
  const { sidebarMode, sidebarCollapsed, toggleSidebarCollapsed } = useSidebarPrefs();
  const isHoverMode = sidebarMode === 'hover';

  /* Hover mode: open while the pointer is on the sidebar, or while keyboard
     focus is inside it. Only KEYBOARD focus counts (:focus-visible) — a mouse
     click on a tab leaves focus behind on that button, and counting it would
     keep the sidebar stuck open after the pointer left. Both changes are
     delayed slightly: opening, so a pointer crossing the edge doesn't flash
     it; closing, so a brief slip off the edge doesn't snap it shut. */
  const [pointerInside, setPointerInside] = useState(false);
  const [keyboardInside, setKeyboardInside] = useState(false);
  const hoverTimer = useRef(null);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!isHoverMode) {
      setPointerInside(false);
      setKeyboardInside(false);
    }
  }, [isHoverMode]);

  function setPointerSoon(inside) {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPointerInside(inside), inside ? 120 : 200);
  }

  const hoverOpen = isHoverMode && (pointerInside || keyboardInside);
  // The rail look: collapsed by the user (toggle mode), or resting (hover mode).
  const isRail = isHoverMode ? !hoverOpen : sidebarMode === 'toggle' && sidebarCollapsed;
  // Rail buttons have no visible text, so name them for tooltips and screen readers.
  const railLabel = (label) => (isRail ? { title: label, 'aria-label': label } : {});

  return (
    <div className={`sidebar-slot ${isHoverMode ? 'is-overlay' : ''}`}>
      <aside
        className={`sidebar ${isRail ? 'is-rail' : ''} ${hoverOpen ? 'is-open' : ''}`}
        onMouseEnter={isHoverMode ? () => setPointerSoon(true) : undefined}
        onMouseLeave={isHoverMode ? () => setPointerSoon(false) : undefined}
        onFocus={
          isHoverMode
            ? (e) => {
                if (e.target.matches(':focus-visible')) setKeyboardInside(true);
              }
            : undefined
        }
        onBlur={
          isHoverMode
            ? (e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setKeyboardInside(false);
              }
            : undefined
        }
      >
        <div className="sidebar-brand-row">
          <div className="brand" data-tour="brand">
            <BrandMark className="brand-mark" />
            <span className="sidebar-label">TaskFlow</span>
          </div>
        </div>

        <div className="nav-group">
          <div className="nav-group-label">Workspace</div>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => onSelectTab(t.id)}
              data-tour={`nav-${t.id}`}
              aria-current={activeTab === t.id ? 'page' : undefined}
              {...railLabel(t.label)}
            >
              <t.icon size={16} strokeWidth={2} />
              <span className="sidebar-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">{footer}</div>
      </aside>
      {/* Toggle mode: the sidebar's right edge opens and closes it. There is
          deliberately no button inside the sidebar itself. Hovering the edge
          tints it and nudges an arrow in the direction it will move. */}
      {sidebarMode === 'toggle' && (
        <button
          type="button"
          className={`sidebar-edge-handle ${sidebarCollapsed ? 'is-collapsed' : 'is-expanded'}`}
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

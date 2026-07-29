/**
 * ============================================================================
 * BottomTabBar
 * ============================================================================
 * Mobile (< 640px) replacement for the desktop sidebar. Now that Board and
 * Gantt live as views inside the Tasks page rather than their own tabs,
 * there are only four top-level destinations (Calendar / Tasks / Stats /
 * Settings) — small enough to show directly in one row, with no "More"
 * overflow sheet needed.
 * ============================================================================
 */

import React from 'react';

export default function BottomTabBar({ tabs, activeTab, onSelectTab }) {
  return (
    <nav className="bottom-tab-bar" aria-label="Primary">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`bottom-tab-item ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => onSelectTab(t.id)}
          data-tour={`nav-${t.id}`}
          aria-current={activeTab === t.id ? 'page' : undefined}
        >
          <span className="bottom-tab-icon">
            <t.icon size={20} strokeWidth={2} />
          </span>
          <span className="bottom-tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

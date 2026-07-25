/**
 * ============================================================================
 * BottomTabBar
 * ============================================================================
 * Mobile (< 640px) replacement for the desktop sidebar. Shows the four
 * highest-frequency destinations directly (Calendar / Tasks / Board /
 * Gantt) plus a "More" slot that opens MoreSheet for the two lower-frequency
 * screens (Stats / Settings) — a bottom tab bar beats a hamburger drawer
 * here because navigation *is* the primary interaction in this app, and a
 * drawer would add an extra tap to the most common action.
 * ============================================================================
 */

import React from 'react';
import { MoreHorizontal } from 'lucide-react';

const PRIMARY_TAB_IDS = ['calendar', 'tasks', 'board', 'gantt'];
// Exported so MoreSheet (the "More" slot's own destination list) stays in
// sync with this bar's primary/overflow split without a second copy.
export const MORE_TAB_IDS = ['stats', 'settings'];

export default function BottomTabBar({ tabs, activeTab, onSelectTab, onOpenMore }) {
  const primaryTabs = tabs.filter((t) => PRIMARY_TAB_IDS.includes(t.id));
  const isMoreActive = MORE_TAB_IDS.includes(activeTab);

  return (
    <nav className="bottom-tab-bar" aria-label="Primary">
      {primaryTabs.map((t) => (
        <button
          key={t.id}
          className={`bottom-tab-item ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => onSelectTab(t.id)}
        >
          <span className="bottom-tab-icon">
            <t.icon size={20} strokeWidth={2} />
          </span>
          <span className="bottom-tab-label">{t.label}</span>
        </button>
      ))}
      <button className={`bottom-tab-item ${isMoreActive ? 'active' : ''}`} onClick={onOpenMore}>
        <span className="bottom-tab-icon">
          <MoreHorizontal size={20} strokeWidth={2} />
        </span>
        <span className="bottom-tab-label">More</span>
      </button>
    </nav>
  );
}

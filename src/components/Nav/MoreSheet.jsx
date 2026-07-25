/**
 * ============================================================================
 * MoreSheet
 * ============================================================================
 * Bottom sheet opened from BottomTabBar's "More" slot, listing the two
 * lower-frequency destinations (Stats / Settings) that don't get a direct
 * mobile tab slot. Selecting one switches the active tab and closes the
 * sheet; tapping the backdrop or the close affordance closes it without
 * changing tabs.
 * ============================================================================
 */

import React from 'react';
import { MORE_TAB_IDS } from './BottomTabBar';

export default function MoreSheet({ tabs, activeTab, onSelectTab, onClose }) {
  const moreTabs = tabs.filter((t) => MORE_TAB_IDS.includes(t.id));

  return (
    <div className="more-sheet-overlay" onClick={onClose}>
      <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="more-sheet-handle" />
        {moreTabs.map((t) => (
          <button
            key={t.id}
            className={`more-sheet-item ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => {
              onSelectTab(t.id);
              onClose();
            }}
          >
            <span className="bottom-tab-icon">
              <t.icon size={18} strokeWidth={2} />
            </span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

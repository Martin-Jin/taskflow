/**
 * SidebarPrefsContext — how the desktop sidebar behaves, shared between the
 * sidebar itself, the app shell (which sizes its left column to match) and
 * Settings → Appearance (where the mode is chosen).
 *
 * Why it's a context: the shell, the sidebar and the settings card each need
 * the same two values. Three separate `usePersistedState` copies would each
 * hold their own in-memory value and never notice each other's changes.
 *
 * Both values are DEVICE-LOCAL on purpose — they're left out of BACKUP_FIELDS
 * and cross-device sync. A narrow laptop and a wide desktop monitor want
 * different layouts, so one device's choice shouldn't be pushed onto the other.
 *
 * Modes (see utils/sidebarMode.js for the rules):
 *   - 'toggle' — the default. A button in the sidebar collapses it to an icon
 *                strip; clicking the strip's right edge opens it again. The
 *                last choice is remembered.
 *   - 'always' — the full sidebar, always (the original behaviour).
 *   - 'hover'  — the sidebar rests as an icon strip and slides open over the
 *                page while the pointer is on it.
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { normalizeSidebarMode, isSidebarRail, DEFAULT_SIDEBAR_MODE } from '../utils/sidebarMode';

const SidebarPrefsContext = createContext(null);

export function SidebarPrefsProvider({ children }) {
  const [storedMode, setSidebarMode] = usePersistedState('sidebarMode', DEFAULT_SIDEBAR_MODE);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState('sidebarCollapsed', false);

  // A stored value we don't recognise (hand-edited storage, a mode removed in
  // a later version) falls back to the default rather than breaking layout.
  const sidebarMode = normalizeSidebarMode(storedMode);

  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), [setSidebarCollapsed]);

  const value = useMemo(
    () => ({
      sidebarMode,
      setSidebarMode,
      sidebarCollapsed: !!sidebarCollapsed,
      toggleSidebarCollapsed,
      // True when the layout reserves only the narrow icon strip — what the
      // shell uses to size its left column.
      sidebarIsRail: isSidebarRail(sidebarMode, !!sidebarCollapsed),
    }),
    [sidebarMode, setSidebarMode, sidebarCollapsed, toggleSidebarCollapsed]
  );

  return <SidebarPrefsContext.Provider value={value}>{children}</SidebarPrefsContext.Provider>;
}

export function useSidebarPrefs() {
  const ctx = useContext(SidebarPrefsContext);
  if (!ctx) throw new Error('useSidebarPrefs must be used within a SidebarPrefsProvider');
  return ctx;
}

/**
 * Sidebar display modes — the small set of rules behind the "Sidebar" choice in
 * Settings → Appearance (state lives in context/SidebarPrefsContext.jsx).
 *
 * Kept as plain functions so the rules can be unit tested without rendering.
 *
 * A "rail" is the collapsed look: a narrow strip showing only icons (and the
 * app logo in place of its name).
 */

export const SIDEBAR_MODES = ['always', 'toggle', 'hover'];
export const DEFAULT_SIDEBAR_MODE = 'toggle';

/** Anything that isn't a known mode becomes the default. */
export function normalizeSidebarMode(value) {
  return SIDEBAR_MODES.includes(value) ? value : DEFAULT_SIDEBAR_MODE;
}

/**
 * Whether the page layout should reserve only the narrow strip.
 *
 *   - 'always': never — the full sidebar is always shown.
 *   - 'toggle': when the user has collapsed it.
 *   - 'hover':  always — the strip is what's reserved; the full sidebar slides
 *               out OVER the page while hovered, so the page never shifts.
 */
export function isSidebarRail(mode, collapsed) {
  if (mode === 'hover') return true;
  if (mode === 'toggle') return !!collapsed;
  return false;
}

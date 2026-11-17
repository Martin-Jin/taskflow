/**
 * Coverage for the sidebar display-mode rules (src/utils/sidebarMode.js).
 *
 * The cases that matter are the ones that would leave the page layout wrong:
 * "hover" must always reserve only the narrow strip (the open sidebar floats
 * over the page), while "always" must never shrink no matter what stale
 * collapsed flag is stored from an earlier "toggle" session.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSidebarMode, isSidebarRail, DEFAULT_SIDEBAR_MODE } from '../../src/utils/sidebarMode';

describe('normalizeSidebarMode', () => {
  it('defaults to the collapse-button mode', () => {
    expect(DEFAULT_SIDEBAR_MODE).toBe('toggle');
  });

  it('keeps each known mode', () => {
    expect(normalizeSidebarMode('always')).toBe('always');
    expect(normalizeSidebarMode('toggle')).toBe('toggle');
    expect(normalizeSidebarMode('hover')).toBe('hover');
  });

  it('falls back to the default for anything unrecognised', () => {
    expect(normalizeSidebarMode('collapsed')).toBe(DEFAULT_SIDEBAR_MODE);
    expect(normalizeSidebarMode(null)).toBe(DEFAULT_SIDEBAR_MODE);
    expect(normalizeSidebarMode(undefined)).toBe(DEFAULT_SIDEBAR_MODE);
    expect(normalizeSidebarMode(true)).toBe(DEFAULT_SIDEBAR_MODE);
  });
});

describe('isSidebarRail', () => {
  it('"always" is never a rail, even with a stale collapsed flag', () => {
    expect(isSidebarRail('always', false)).toBe(false);
    expect(isSidebarRail('always', true)).toBe(false);
  });

  it('"toggle" follows the collapsed flag', () => {
    expect(isSidebarRail('toggle', false)).toBe(false);
    expect(isSidebarRail('toggle', true)).toBe(true);
  });

  it('"hover" is always a rail, whatever the collapsed flag says', () => {
    expect(isSidebarRail('hover', false)).toBe(true);
    expect(isSidebarRail('hover', true)).toBe(true);
  });
});

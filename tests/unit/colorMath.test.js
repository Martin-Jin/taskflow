/**
 * Coverage for colorMath.js. The contrast formula is an accessibility floor,
 * not a style preference, so it's checked against WCAG's own reference values
 * rather than just round-tripped against itself — a self-consistent but
 * subtly wrong formula would pass every test that only checks conversions
 * against each other.
 */

import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  relativeLuminance,
  contrastRatio,
  nudgeForContrast,
} from '../../src/utils/colorMath';

describe('hex/rgb round trip', () => {
  it('parses 6-digit and 3-digit hex the same way', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('round-trips rgb -> hex -> rgb for a range of colors', () => {
    for (const hex of ['#000000', '#ffffff', '#1d9e75', '#c23c48', '#123456']) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it('clamps out-of-range channels rather than producing invalid hex', () => {
    expect(rgbToHex({ r: 300, g: -10, b: 128 })).toBe('#ff0080');
  });
});

describe('rgb/hsl round trip', () => {
  it('round-trips a range of colors within rounding tolerance', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#1d9e75', '#c23c48', '#808080']) {
      const rgb = hexToRgb(hex);
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it('identifies pure black, white and gray correctly', () => {
    expect(rgbToHsl({ r: 0, g: 0, b: 0 }).l).toBe(0);
    expect(rgbToHsl({ r: 255, g: 255, b: 255 }).l).toBe(100);
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0);
  });

  it('preserves hue and saturation when only lightness changes', () => {
    const hsl = rgbToHsl(hexToRgb('#1d9e75'));
    const lighter = hslToRgb({ ...hsl, l: hsl.l + 10 });
    const hslBack = rgbToHsl(lighter);
    expect(Math.abs(hslBack.h - hsl.h)).toBeLessThan(1);
    expect(Math.abs(hslBack.s - hsl.s)).toBeLessThan(2);
  });
});

describe('relativeLuminance — checked against the WCAG spec, not just itself', () => {
  it('gives black 0 and white 1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });

  it('matches the WCAG worked contrast ratio for pure red vs. white (~4:1)', () => {
    // This is the standard reference figure quoted in the WCAG 2.x
    // techniques docs for #FF0000 on #FFFFFF.
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(3.998, 1);
  });

  it('gives black-on-white the maximum ratio of 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('gives identical colors a ratio of exactly 1', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#1d9e75', '#fafaf9')).toBeCloseTo(contrastRatio('#fafaf9', '#1d9e75'), 10);
  });
});

describe('nudgeForContrast', () => {
  it('leaves a color alone if it already meets the target', () => {
    expect(nudgeForContrast('#000000', '#ffffff', 4.5)).toBe('#000000');
  });

  it('darkens a light color against a light background to reach the target', () => {
    const nudged = nudgeForContrast('#e0ffe0', '#ffffff', 4.5);
    expect(contrastRatio(nudged, '#ffffff')).toBeGreaterThanOrEqual(4.5 - 0.01);
  });

  it('lightens a dark color against a dark background to reach the target', () => {
    const nudged = nudgeForContrast('#101010', '#1c1b17', 3);
    expect(contrastRatio(nudged, '#1c1b17')).toBeGreaterThanOrEqual(3 - 0.01);
  });

  it('preserves hue while nudging, so the result still reads as the same color family', () => {
    const original = rgbToHsl(hexToRgb('#3355aa'));
    const nudged = nudgeForContrast('#3355aa', '#3a3a3a', 7);
    const after = rgbToHsl(hexToRgb(nudged));
    expect(Math.abs(after.h - original.h)).toBeLessThan(2);
  });

  it('reaches any achievable ratio for a saturated mid-tone color on either background', () => {
    for (const bg of ['#ffffff', '#000000', '#1c1b17', '#fafaf9']) {
      const nudged = nudgeForContrast('#5588cc', bg, 4.5);
      expect(contrastRatio(nudged, bg)).toBeGreaterThanOrEqual(4.5 - 0.05);
    }
  });

  it('does not throw when asked for an unreachable ratio, and gets as close as the extreme allows', () => {
    // No color reaches 21:1 against a mid-gray background other than the
    // extremes it can't be pushed past.
    const nudged = nudgeForContrast('#808080', '#808080', 21);
    expect(typeof nudged).toBe('string');
    expect(contrastRatio(nudged, '#808080')).toBeGreaterThan(contrastRatio('#808080', '#808080'));
  });
});

import { describe, it, expect } from 'vitest';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, relativeLuminance, contrastRatio, nudgeForContrast } from '../../src/utils/colorMath';

describe('hexToRgb / rgbToHex round-trip', () => {
  it('round-trips a variety of colors exactly', () => {
    const colors = ['#000000', '#ffffff', '#1d9e75', '#a35f1c', '#123456', '#abcdef'];
    for (const hex of colors) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it('parses known channel values', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('clamps and rounds out-of-range/fractional channels', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe('#00ff80');
  });
});

describe('rgbToHsl / hslToRgb round-trip', () => {
  it('round-trips within rounding tolerance for a range of colors', () => {
    const colors = ['#1d9e75', '#a35f1c', '#226f84', '#c23c48', '#736d60', '#ffffff', '#000000', '#808080'];
    for (const hex of colors) {
      const hsl = rgbToHsl(hexToRgb(hex));
      const back = rgbToHex(hslToRgb(hsl));
      const { r: r1, g: g1, b: b1 } = hexToRgb(hex);
      const { r: r2, g: g2, b: b2 } = hexToRgb(back);
      expect(Math.abs(r1 - r2)).toBeLessThanOrEqual(1);
      expect(Math.abs(g1 - g2)).toBeLessThanOrEqual(1);
      expect(Math.abs(b1 - b2)).toBeLessThanOrEqual(1);
    }
  });

  it('gray (equal channels) has zero saturation', () => {
    const { s } = rgbToHsl({ r: 128, g: 128, b: 128 });
    expect(s).toBeCloseTo(0, 5);
  });

  it('pure red is hue 0, full saturation, 50% lightness', () => {
    const { h, s, l } = rgbToHsl({ r: 255, g: 0, b: 0 });
    expect(h).toBeCloseTo(0, 1);
    expect(s).toBeCloseTo(100, 1);
    expect(l).toBeCloseTo(50, 1);
  });
});

describe('relativeLuminance', () => {
  it('white is 1, black is 0', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG-published reference: red on white is ~3.998:1', () => {
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(3.998, 2);
  });

  it('white on black (and vice versa) is 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('a color against itself is 1:1', () => {
    expect(contrastRatio('#1d9e75', '#1d9e75')).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#1d9e75', '#fafaf9')).toBeCloseTo(contrastRatio('#fafaf9', '#1d9e75'), 5);
  });
});

describe('nudgeForContrast', () => {
  const LIGHT_BG = '#fafaf9'; // this app's --color-bg-page (light)
  const DARK_BG = '#1c1b17'; // this app's --color-bg-page (dark)

  it('leaves an already-passing color unchanged', () => {
    // Near-black already clears 4.5:1 against a light background.
    const color = '#0f6e56';
    expect(contrastRatio(color, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
    expect(nudgeForContrast(color, LIGHT_BG, 4.5)).toBe(color);
  });

  it('nudges a very low-contrast color to reach 4.5:1 on a light background', () => {
    const color = '#e1f5ee'; // near-white mint, fails badly against a near-white bg
    const nudged = nudgeForContrast(color, LIGHT_BG, 4.5);
    expect(contrastRatio(nudged, LIGHT_BG)).toBeGreaterThanOrEqual(4.5 - 0.01);
  });

  it('nudges a very low-contrast color to reach 3:1 on a dark background', () => {
    const color = '#242320'; // close to the dark bg itself
    const nudged = nudgeForContrast(color, DARK_BG, 3);
    expect(contrastRatio(nudged, DARK_BG)).toBeGreaterThanOrEqual(3 - 0.01);
  });

  it('handles a near-white seed nudged against a light background', () => {
    const nudged = nudgeForContrast('#fefefe', LIGHT_BG, 4.5);
    expect(contrastRatio(nudged, LIGHT_BG)).toBeGreaterThanOrEqual(4.5 - 0.01);
  });

  it('handles a near-black seed nudged against a dark background', () => {
    const nudged = nudgeForContrast('#010101', DARK_BG, 3);
    expect(contrastRatio(nudged, DARK_BG)).toBeGreaterThanOrEqual(3 - 0.01);
  });

  it('preserves hue/saturation while only lightness changes', () => {
    const color = '#3355ee';
    const { h: hBefore, s: sBefore } = rgbToHsl(hexToRgb(color));
    const nudged = nudgeForContrast(color, LIGHT_BG, 7);
    const { h: hAfter, s: sAfter } = rgbToHsl(hexToRgb(nudged));
    expect(hAfter).toBeCloseTo(hBefore, 0);
    expect(sAfter).toBeCloseTo(sBefore, 0);
  });

  it('reaches target ratios for several seed/background pairs', () => {
    const pairs = [
      { color: '#5dcaa5', bg: '#fafaf9', target: 4.5 },
      { color: '#5dcaa5', bg: '#1c1b17', target: 3 },
      { color: '#c23c48', bg: '#ffffff', target: 4.5 },
      { color: '#226f84', bg: '#000000', target: 3 },
      { color: '#b0527a', bg: '#fafaf9', target: 4.5 },
    ];
    for (const { color, bg, target } of pairs) {
      const nudged = nudgeForContrast(color, bg, target);
      expect(contrastRatio(nudged, bg)).toBeGreaterThanOrEqual(target - 0.01);
    }
  });

  it('gracefully returns the most extreme lightness when the target is unreachable (two similar mid-tone grays)', () => {
    // Two close-together mid grays can't reach a 21:1 (max possible) ratio no
    // matter how far lightness is pushed in one direction — this should
    // return the extreme value on whichever side the background picks,
    // rather than hang or throw searching for an unreachable boundary.
    const nudged = nudgeForContrast('#888888', '#777777', 21);
    expect(() => hexToRgb(nudged)).not.toThrow();
    expect(contrastRatio(nudged, '#777777')).toBeGreaterThan(contrastRatio('#888888', '#777777'));
  });
});

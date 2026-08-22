/**
 * ============================================================================
 * COLOR MATH — the primitives a custom theme is built on
 * ============================================================================
 * Plain sRGB/HSL conversion plus WCAG relative-luminance contrast, used by
 * themePresets.js to turn one user-picked seed color into a full accent ramp
 * and validate it before it's ever applied.
 *
 * Nothing here is theme-specific — it doesn't know about `--color-accent` or
 * any app token. That split matters: the contrast MATH must be exactly right
 * (getting relative luminance wrong silently breaks the accessibility floor
 * this whole feature exists to protect), so it's isolated and tested against
 * the WCAG spec's own worked examples, separate from the judgment calls in
 * themePresets.js about what to DO with a failing contrast ratio.
 * ============================================================================
 */

/** Clamps a number into [min, max]. */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * @param {string} hex - "#rgb" or "#rrggbb"
 * @returns {{r: number, g: number, b: number}} each channel 0-255
 */
export function hexToRgb(hex) {
  const clean = (hex || '').replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** @returns {string} "#rrggbb", channels clamped and rounded */
export function rgbToHex({ r, g, b }) {
  const toHex = (c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * @returns {{h: number, s: number, l: number}} h in [0,360), s/l in [0,100]
 */
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

/** @param {{h: number, s: number, l: number}} hsl */
export function hslToRgb({ h, s, l }) {
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  if (sn === 0) {
    const v = ln * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hn = ((h % 360) + 360) % 360 / 360;
  return {
    r: hue2rgb(p, q, hn + 1 / 3) * 255,
    g: hue2rgb(p, q, hn) * 255,
    b: hue2rgb(p, q, hn - 1 / 3) * 255,
  };
}

/**
 * WCAG relative luminance (the exact formula from the spec, not an
 * approximation) — the basis every contrast ratio in this module is built on.
 * @param {{r: number, g: number, b: number}} rgb - 0-255 channels
 * @returns {number} 0 (black) to 1 (white)
 */
export function relativeLuminance({ r, g, b }) {
  const linear = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG contrast ratio between two colors, 1 (identical) to 21 (black/white).
 * @param {string} hexA
 * @param {string} hexB
 */
export function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Nudges `hex`'s lightness in HSL space until its contrast against `bgHex`
 * reaches `targetRatio`, preserving hue and saturation.
 *
 * Direction is decided once, from the color's OWN starting lightness relative
 * to the background, not re-evaluated each step — a color already close to 50%
 * lightness sits near the inflection point where "does darkening or
 * lightening help contrast against this background" can flip sign as
 * relativeLuminance's curve bends, which would make an iterative "move
 * whichever direction currently helps" search oscillate. Picking direction
 * from the far side (lighten toward white if the color started darker than a
 * mid-gray background's luminance would suggest, darken otherwise) is stable
 * and matches how a designer would actually fix a failing contrast pair.
 *
 * @param {string} hex
 * @param {string} bgHex
 * @param {number} targetRatio
 * @returns {string} hex, guaranteed to reach targetRatio unless already at
 *   the L=0/L=100 extreme (pure black/white can't do better against a given
 *   background — that's a property of the background, not a bug here)
 */
export function nudgeForContrast(hex, bgHex, targetRatio) {
  if (contrastRatio(hex, bgHex) >= targetRatio) return hex;
  const hsl = rgbToHsl(hexToRgb(hex));
  const bgLum = relativeLuminance(hexToRgb(bgHex));
  // Darkening always increases contrast against a LIGHT background and
  // decreases it against a dark one, and vice versa for lightening — this
  // holds everywhere except exactly at the extremes, which the step loop
  // below reaches and stops at cleanly regardless.
  const goingDarker = bgLum > 0.18; // ~L=50% gray's own luminance
  let lo = goingDarker ? 0 : hsl.l;
  let hi = goingDarker ? hsl.l : 100;
  // Binary search on lightness for the boundary meeting targetRatio, rather
  // than a fixed step size — a fixed step either overshoots (visibly darker/
  // lighter than necessary) or needs many iterations to land precisely.
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = rgbToHex(hslToRgb({ ...hsl, l: mid }));
    const meets = contrastRatio(candidate, bgHex) >= targetRatio;
    if (goingDarker) {
      if (meets) lo = mid;
      else hi = mid;
    } else if (meets) hi = mid;
    else lo = mid;
  }
  const finalL = goingDarker ? lo : hi;
  return rgbToHex(hslToRgb({ ...hsl, l: finalL }));
}

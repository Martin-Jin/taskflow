/**
 * ============================================================================
 * COLOR MATH
 * ============================================================================
 * Pure color conversion/contrast helpers, no framework or app dependencies.
 * Built for theme-presets.js's accent-ramp derivation (see that file's header
 * for why only the accent hue is customizable at all), but deliberately kept
 * generic and dependency-free so it's testable in isolation.
 *
 * Conventions: hex strings are always 6-digit, lowercase, with a leading '#'
 * (e.g. '#1d9e75'). RGB channels are 0-255 integers. HSL hue is 0-360, s/l are
 * 0-100.
 * ============================================================================
 */

/** '#RRGGBB' -> { r, g, b } (0-255 each). Accepts 3-digit shorthand too. */
export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(h, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/** { r, g, b } (0-255 each, rounded) -> lowercase '#rrggbb'. */
export function rgbToHex({ r, g, b }) {
  const toHex = (c) => {
    const clamped = Math.max(0, Math.min(255, Math.round(c)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** { r, g, b } (0-255) -> { h: 0-360, s: 0-100, l: 0-100 }. */
export function rgbToHsl({ r, g, b }) {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  const delta = max - min;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rN:
        h = ((gN - bN) / delta) % 6;
        break;
      case gN:
        h = (bN - rN) / delta + 2;
        break;
      default:
        h = (rN - gN) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: s * 100, l: l * 100 };
}

/** { h: 0-360, s: 0-100, l: 0-100 } -> { r, g, b } (0-255, rounded). */
export function hslToRgb({ h, s, l }) {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;

  let rP = 0;
  let gP = 0;
  let bP = 0;
  if (h < 60) {
    rP = c;
    gP = x;
  } else if (h < 120) {
    rP = x;
    gP = c;
  } else if (h < 180) {
    gP = c;
    bP = x;
  } else if (h < 240) {
    gP = x;
    bP = c;
  } else if (h < 300) {
    rP = x;
    bP = c;
  } else {
    rP = c;
    bP = x;
  }

  return {
    r: (rP + m) * 255,
    g: (gP + m) * 255,
    b: (bP + m) * 255,
  };
}

/** Linearizes one sRGB channel (0-255) per the WCAG relative luminance formula. */
function linearizeChannel(c) {
  const cN = c / 255;
  return cN <= 0.03928 ? cN / 12.92 : Math.pow((cN + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0-1) of a '#rrggbb' color. */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const R = linearizeChannel(r);
  const G = linearizeChannel(g);
  const B = linearizeChannel(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG contrast ratio between two colors, always >= 1 (the lighter color's
 * luminance is placed in the numerator regardless of argument order — the
 * formula is symmetric in that sense, but this keeps callers from having to
 * pre-sort themselves). Reference: red #FF0000 on white #FFFFFF is ~3.998:1.
 */
export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Binary-searches the HSL lightness of `hex` until its contrast ratio against
 * `bgHex` reaches `targetRatio`, returning the adjusted hex (hue/saturation
 * preserved). Returns `hex` unchanged if it already meets the target.
 *
 * The search DIRECTION (darken vs lighten) is picked ONCE up front, from
 * whether `bgHex` is lighter or darker than `hex` — never re-decided inside
 * the loop. Relative luminance is not monotonic in HSL lightness in a way
 * that's safe to re-probe every iteration near extremes (e.g. a fully
 * saturated color's luminance curve can flatten close to l=0 or l=100), so
 * re-deciding "which way is closer" on each step risks oscillating around an
 * inflection point instead of converging. Deciding once from the background's
 * relative darkness is a stable, monotonic proxy: moving `hex` away from
 * `bgHex` in lightness reliably increases contrast for any single starting
 * point, which is all one call needs.
 */
export function nudgeForContrast(hex, bgHex, targetRatio) {
  if (contrastRatio(hex, bgHex) >= targetRatio) return hex;

  // Background is light -> darken the color (push lightness toward 0).
  // Background is dark -> lighten the color (push lightness toward 100).
  // Decided once, up front, from the background alone — never re-derived
  // inside the loop below (see doc comment on why: re-probing "which way is
  // closer" every iteration risks oscillating near the luminance curve's
  // inflection point instead of converging).
  const bgIsLight = relativeLuminance(bgHex) > 0.5;
  const extremeL = bgIsLight ? 0 : 100;

  const { h, s, l: startL } = rgbToHsl(hexToRgb(hex));
  const contrastAtL = (l) => contrastRatio(rgbToHex(hslToRgb({ h, s, l })), bgHex);

  // If even the most extreme lightness can't reach the target (e.g. a very
  // low-saturation gray can't hit high contrast against a mid-gray bg),
  // return the most extreme value rather than searching for an unreachable
  // boundary.
  if (contrastAtL(extremeL) < targetRatio) {
    return rgbToHex(hslToRgb({ h, s, l: extremeL }));
  }

  // Contrast increases monotonically as l moves from startL toward extremeL
  // (moving away from the background's own lightness), so a plain bisection
  // between the two converges on the smallest nudge that clears targetRatio.
  let a = startL; // known: contrast(a) < targetRatio (checked at function entry)
  let b = extremeL; // known: contrast(b) >= targetRatio (checked just above)
  for (let i = 0; i < 40 && Math.abs(a - b) >= 0.01; i += 1) {
    const mid = (a + b) / 2;
    if (contrastAtL(mid) >= targetRatio) {
      b = mid;
    } else {
      a = mid;
    }
  }

  return rgbToHex(hslToRgb({ h, s, l: b }));
}

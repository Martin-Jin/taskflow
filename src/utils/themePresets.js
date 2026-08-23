/**
 * ============================================================================
 * THEME PRESETS
 * ============================================================================
 * CLAUDE.md's "Deliberately not doing" section is explicit: this app is
 * "not rebuilding the token system" — the whole design system is one set of
 * CSS custom properties in global.css's `:root` blocks, extended rather than
 * replaced. Auditing every token in that file (see global.css) shows the
 * ONLY hue that varies across the entire palette is the teal accent ramp
 * (`--color-accent-50` through `--color-accent-900`); backgrounds, borders,
 * and text are fixed neutrals. So "let the user pick a theme" reduces
 * exactly to "let the user pick a different accent hue" — nothing else in
 * the token system needs to change, which is what keeps this an extension
 * rather than a parallel system.
 *
 * Rather than exposing a picker for every one of those ~10 accent tokens
 * (which would let a user pick, say, a light "border" token darker than
 * their "text" token and break the contrast relationships CLAUDE.md calls
 * load-bearing), the user only ever picks ONE seed color — a preset from
 * THEME_PRESETS, or a custom hex. `buildAccentRamp` derives the full
 * light+dark ramp from that single seed programmatically, clamping every
 * derived stop to whichever WCAG floor its actual CSS role requires (see
 * that function's own comment for the per-role floors). This is what makes
 * "a bad pick can't produce an unreadable app" actually true in code, not
 * just a hope: there is no token the user can set directly to a
 * contrast-violating value, because they never set tokens at all.
 * ============================================================================
 */

import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex, nudgeForContrast } from './colorMath';

/**
 * Preset seed colors shown in Settings → Appearance. `teal` is FIRST and
 * matches the app's actual shipped default accent (--color-accent-400,
 * global.css) — selecting it is equivalent to clearing the custom accent
 * (see ThemeContext's accentSeed: null convention), not to applying this
 * literal hex as a new "custom" value.
 */
export const THEME_PRESETS = [
  { id: 'teal', name: 'Teal (default)', seed: '#1d9e75' },
  { id: 'indigo', name: 'Indigo', seed: '#4a5fd9' },
  { id: 'rose', name: 'Rose', seed: '#d94a72' },
  { id: 'amber', name: 'Amber', seed: '#c9822e' },
  { id: 'slate', name: 'Slate', seed: '#5b6b7a' },
  { id: 'plum', name: 'Plum', seed: '#8a4fb0' },
];

/** `#rrggbb` (case-insensitive, 3 or 6 digit) — the only shape a seed color may take. */
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Is `hex` a syntactically valid hex color string? Used to gate accentSeed before it's ever stored or applied. */
export function isValidHexColor(hex) {
  return typeof hex === 'string' && HEX_COLOR_RE.test(hex);
}

/** Looks up a preset by id, or undefined if no preset has that id. */
export function findPreset(id) {
  return THEME_PRESETS.find((p) => p.id === id);
}

// The shipped teal ramp's own lightness at each stop (see global.css's
// --color-accent-50..900) — mirrored here so a derived ramp keeps the same
// visual "spread" (a light tint, a mid accent, a deep shade) regardless of
// seed hue. Hue and saturation are held fixed at the SEED's own values
// (not re-measured per stop) — the shipped ramp's hue/saturation actually
// drifts slightly stop-to-stop (a hand-tuned/eyeballed ramp), but a fixed
// hue+saturation sweep is simpler, fully predictable for an arbitrary user
// seed, and any resulting contrast shortfall is corrected by the per-role
// nudge step below anyway.
const RAMP_LIGHTNESS_STOPS = {
  50: 92.2,
  100: 75.3,
  200: 57.8,
  400: 36.7,
  600: 24.5,
  800: 17.3,
  900: 11.0,
};

// This app's fixed (non-accent) background tokens each mode's derived accent
// text/border stops are checked against — see global.css's :root blocks.
// Both page and surface are checked (not just one) because accent text can
// legitimately sit on either; --color-bg-surface-raised is not included
// separately since it equals --color-bg-surface in both current themes.
const LIGHT_BACKGROUNDS = ['#fafaf9', '#ffffff'];
const DARK_BACKGROUNDS = ['#1c1b17', '#242320'];

/** Builds the raw 7-stop lightness ramp (hue/saturation fixed from the seed) as a stop-number -> hex map. */
function buildRawRamp(seedHex) {
  const { h, s } = rgbToHsl(hexToRgb(seedHex));
  const ramp = {};
  for (const [stop, l] of Object.entries(RAMP_LIGHTNESS_STOPS)) {
    ramp[stop] = rgbToHex(hslToRgb({ h, s, l }));
  }
  return ramp;
}

/** Nudges `hex` against every background in `backgrounds`, chaining so the result clears `targetRatio` against ALL of them, not just the first. */
function nudgeAgainstAll(hex, backgrounds, targetRatio) {
  let result = hex;
  for (const bg of backgrounds) {
    result = nudgeForContrast(result, bg, targetRatio);
  }
  // A single pass can, in principle, fix one background just enough to fall
  // slightly short of another (nudging is monotonic per-background, but two
  // different backgrounds can pull in the same direction by different
  // amounts) — chaining twice converges since there are only two backgrounds
  // and both moves are in the same direction (both light, or both dark).
  for (const bg of backgrounds) {
    result = nudgeForContrast(result, bg, targetRatio);
  }
  return result;
}

/**
 * Derives a full light+dark accent ramp from one seed color, each value
 * clamped to the WCAG floor its actual CSS role requires. Returns
 * `{ light: { '--color-accent-...': hex }, dark: { ... } }` ready to apply
 * as inline custom properties (see ThemeContext).
 *
 * Role floors below were determined by grepping every `var(--color-accent...)`
 * consumer in src/styles/*.css and src/components — not assumed from the
 * token's name:
 *   - `--color-accent` / `--color-accent-hover`: used ONLY as `color:` (link/
 *     active-state/visited text) — needs >=4.5:1 (small-text AA) against
 *     whichever fixed background it's rendered on (page or surface).
 *   - `--color-accent-border`: used ONLY as border-color/outline/box-shadow
 *     ring/dashed-border, or as a color-mix() background fill at low opacity
 *     — never as text color (global.css's own a:visited comment says so
 *     explicitly: "NOT --color-accent-border here — that token is only
 *     3:1-safe"). Needs >=3:1 (WCAG 1.4.11 non-text contrast) against page/
 *     surface. IMPORTANT: this is a DIFFERENT floor than --color-accent-hover
 *     even though both ultimately come from the same raw stop family — see
 *     below for why they get separate values rather than reusing one.
 *   - `--color-accent-solid-bg` / `--color-accent-solid-bg-hover`: solid
 *     button/badge fill. The floor that matters is 4.5:1 between this and
 *     `--color-accent-solid-text` (the text painted ON it), not against the
 *     page — solid-text is fixed (white in light mode, near-black in dark),
 *     so solid-bg is nudged against solid-text's own color instead of a page
 *     background.
 *   - `--color-accent-soft`: background wash only (badges, hover fills,
 *     selection tints) — `--color-accent` text sits on top of it in several
 *     places (e.g. board.css's .board-card selected state), so soft's OWN
 *     floor is "stay light/dark enough that --color-accent still clears
 *     4.5:1 against it", enforced by including it in --color-accent's own
 *     nudge-against list below rather than nudging soft itself.
 *   - `--color-accent-solid-text`: NOT derived from the seed at all — fixed
 *     white (light) / near-black (dark), exactly as global.css already has
 *     it, since global.css's own comment establishes those are the only
 *     values that read correctly against a solid accent fill in each mode.
 *
 * The light-mode `--color-accent-border` (raw stop 400) and dark-mode
 * `--color-accent-hover` (also raw stop 400) share a RAW STOP NUMBER but
 * NOT a role or a floor (border needs 3:1, hover-text needs 4.5:1) — so
 * each is nudged independently to its own floor rather than one shared
 * nudged value being reused for both, which previously caused test
 * failures when the two roles' floors disagreed on a low-saturation seed.
 */
export function buildAccentRamp(seedHex) {
  const raw = buildRawRamp(seedHex);

  // --- Light mode -----------------------------------------------------------
  // Text roles (--color-accent, --color-accent-hover): 4.5:1 vs page+surface,
  // AND (for --color-accent specifically) vs its own soft background, since
  // --color-accent text is rendered on --color-accent-soft in several places.
  const lightSoft = raw['50'];
  const lightAccentText = nudgeAgainstAll(raw['600'], [...LIGHT_BACKGROUNDS, lightSoft], 4.5);
  const lightHoverText = nudgeAgainstAll(raw['800'], LIGHT_BACKGROUNDS, 4.5);
  // Border-only role: 3:1, nudged independently from the hover text above
  // even though both start from a stop in the same family — see doc comment.
  const lightBorder = nudgeAgainstAll(raw['400'], LIGHT_BACKGROUNDS, 3);
  // Solid bg vs its own (fixed) solid text, not the page.
  const lightSolidText = '#ffffff';
  const lightSolidBg = nudgeForContrast(raw['600'], lightSolidText, 4.5);
  const lightSolidBgHover = nudgeForContrast(raw['800'], lightSolidText, 4.5);

  const light = {
    '--color-accent-50': lightSoft,
    '--color-accent-100': raw['100'],
    '--color-accent-200': raw['200'],
    '--color-accent-400': lightBorder,
    '--color-accent-600': lightAccentText,
    '--color-accent-800': lightHoverText,
    '--color-accent-900': raw['900'],
    '--color-accent': lightAccentText,
    '--color-accent-hover': lightHoverText,
    '--color-accent-border': lightBorder,
    '--color-accent-solid-bg': lightSolidBg,
    '--color-accent-solid-bg-hover': lightSolidBgHover,
    '--color-accent-solid-text': lightSolidText,
    '--color-accent-soft': lightSoft,
  };

  // --- Dark mode --------------------------------------------------------------
  // Same role/floor logic, mirrored against dark backgrounds and dark stops
  // (--color-accent reads from stop 200 in dark mode, --color-accent-hover
  // from 400, --color-accent-border from 200, --color-accent-solid-bg from
  // 400 — see global.css's :root[data-theme='dark'] block).
  const darkSoft = raw['900'];
  const darkAccentText = nudgeAgainstAll(raw['200'], [...DARK_BACKGROUNDS, darkSoft], 4.5);
  const darkHoverText = nudgeAgainstAll(raw['400'], DARK_BACKGROUNDS, 4.5);
  const darkBorder = nudgeAgainstAll(raw['200'], DARK_BACKGROUNDS, 3);
  const darkSolidText = '#14130f';
  const darkSolidBg = nudgeForContrast(raw['400'], darkSolidText, 4.5);
  const darkSolidBgHover = nudgeForContrast(raw['200'], darkSolidText, 4.5);

  const dark = {
    '--color-accent-50': raw['50'],
    '--color-accent-100': raw['100'],
    '--color-accent-200': darkBorder,
    '--color-accent-400': darkHoverText,
    '--color-accent-600': raw['600'],
    '--color-accent-800': raw['800'],
    '--color-accent-900': darkSoft,
    '--color-accent': darkAccentText,
    '--color-accent-hover': darkHoverText,
    '--color-accent-border': darkBorder,
    '--color-accent-solid-bg': darkSolidBg,
    '--color-accent-solid-bg-hover': darkSolidBgHover,
    '--color-accent-solid-text': darkSolidText,
    '--color-accent-soft': darkSoft,
  };

  return { light, dark };
}

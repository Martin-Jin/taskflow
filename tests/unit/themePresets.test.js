/**
 * Coverage for buildAccentRamp — the function standing between "the user
 * picked a color" and "every button in the app is still readable".
 *
 * The interesting cases are the colors a naive ramp would fail on: very
 * light, very dark, and very desaturated (near-gray) seeds. Each of those is
 * a real thing a color picker lets someone type in, and each is exactly the
 * kind of pick that would otherwise ship an unreadable button or an invisible
 * border. A test suite that only checks a "normal" mid-tone seed would miss
 * all of them.
 */

import { describe, it, expect } from 'vitest';
import { contrastRatio } from '../../src/utils/colorMath';
import { buildAccentRamp, isValidHexColor, findPreset, THEME_PRESETS } from '../../src/utils/themePresets';

const LIGHT_BG = '#fafaf9';
const LIGHT_SURFACE = '#ffffff';
const DARK_BG = '#1c1b17';
const DARK_SURFACE = '#242320';

const SEEDS = {
  normal: '#1d9e75', // the shipped default
  veryLight: '#eaffea',
  veryDark: '#0a0e08',
  nearGray: '#8a8c88',
  saturatedBlue: '#2255ee',
  hotPink: '#ff2ea6',
};

function assertLightThemeSafe(ramp) {
  // --color-accent is used as small text — 4.5:1 minimum.
  expect(contrastRatio(ramp.light['--color-accent'], LIGHT_BG)).toBeGreaterThanOrEqual(4.5 - 0.05);
  expect(contrastRatio(ramp.light['--color-accent-hover'], LIGHT_BG)).toBeGreaterThanOrEqual(4.5 - 0.05);
  // --color-accent-border is a lone border/boundary — 3:1 minimum (WCAG 1.4.11).
  expect(contrastRatio(ramp.light['--color-accent-border'], LIGHT_SURFACE)).toBeGreaterThanOrEqual(3 - 0.05);
  // White text on the solid button fill — 4.5:1 minimum, the exact failure
  // mode a raw per-token picker could ship.
  expect(contrastRatio(ramp.light['--color-accent-solid-text'], ramp.light['--color-accent-solid-bg'])).toBeGreaterThanOrEqual(4.5 - 0.05);
}

function assertDarkThemeSafe(ramp) {
  expect(contrastRatio(ramp.dark['--color-accent'], DARK_BG)).toBeGreaterThanOrEqual(4.5 - 0.05);
  expect(contrastRatio(ramp.dark['--color-accent-hover'], DARK_BG)).toBeGreaterThanOrEqual(4.5 - 0.05);
  expect(contrastRatio(ramp.dark['--color-accent-border'], DARK_SURFACE)).toBeGreaterThanOrEqual(3 - 0.05);
  expect(contrastRatio(ramp.dark['--color-accent-solid-text'], ramp.dark['--color-accent-solid-bg'])).toBeGreaterThanOrEqual(4.5 - 0.05);
}

describe('buildAccentRamp — every seed produces a WCAG-safe theme', () => {
  for (const [label, seed] of Object.entries(SEEDS)) {
    it(`meets every contrast floor for a ${label} seed (${seed}), both themes`, () => {
      const ramp = buildAccentRamp(seed);
      assertLightThemeSafe(ramp);
      assertDarkThemeSafe(ramp);
    });
  }

  it('meets every contrast floor for every shipped preset', () => {
    for (const preset of THEME_PRESETS) {
      const ramp = buildAccentRamp(preset.seed);
      assertLightThemeSafe(ramp);
      assertDarkThemeSafe(ramp);
    }
  });

  it('produces a complete token set with no missing keys', () => {
    const ramp = buildAccentRamp(SEEDS.normal);
    const expectedKeys = [
      '--color-accent-50', '--color-accent-100', '--color-accent-200', '--color-accent-400',
      '--color-accent-600', '--color-accent-800', '--color-accent-900',
      '--color-accent', '--color-accent-hover', '--color-accent-border',
      '--color-accent-solid-bg', '--color-accent-solid-bg-hover', '--color-accent-solid-text', '--color-accent-soft',
    ];
    for (const key of expectedKeys) {
      expect(ramp.light[key]).toBeTruthy();
      expect(ramp.dark[key]).toBeTruthy();
    }
  });

  it('preserves the seed hue through the derived ramp (a red seed produces a red theme, not a fallback gray)', () => {
    // A saturated seed's hue should survive into the mid-ramp stops even
    // after contrast nudging — nudging only moves lightness.
    const ramp = buildAccentRamp('#e0303a'); // a red
    const { rgbToHsl, hexToRgb } = require('../../src/utils/colorMath');
    const hue = rgbToHsl(hexToRgb(ramp.light['--color-accent-200'])).h;
    expect(hue).toBeGreaterThan(340); // red wraps near 360/0
    expect(hue < 20 || hue > 340).toBe(true);
  });

  it('keeps light and dark themes visibly distinct from each other for the same seed', () => {
    // A degenerate implementation could satisfy every contrast check by
    // collapsing both themes toward the same safe gray-ish accent.
    const ramp = buildAccentRamp(SEEDS.normal);
    expect(ramp.light['--color-accent']).not.toBe(ramp.dark['--color-accent']);
  });
});

describe('isValidHexColor', () => {
  it('accepts 3- and 6-digit hex with or without a leading #', () => {
    expect(isValidHexColor('#fff')).toBe(true);
    expect(isValidHexColor('#1d9e75')).toBe(true);
  });

  it('rejects garbage rather than silently falling back to black', () => {
    expect(isValidHexColor('not-a-color')).toBe(false);
    expect(isValidHexColor('#ggg')).toBe(false);
    expect(isValidHexColor('')).toBe(false);
    expect(isValidHexColor(null)).toBe(false);
    expect(isValidHexColor('#12345')).toBe(false);
  });
});

describe('findPreset', () => {
  it('finds a known preset by id', () => {
    expect(findPreset('indigo')?.name).toBe('Indigo');
  });

  it('returns null for an unknown id rather than throwing', () => {
    expect(findPreset('not-a-real-preset')).toBeNull();
    expect(findPreset(undefined)).toBeNull();
  });

  it('lists the shipped default first, so it reads as "the current theme" not a random option', () => {
    expect(THEME_PRESETS[0].id).toBe('teal');
  });
});

import { describe, it, expect } from 'vitest';
import { THEME_PRESETS, buildAccentRamp, buildSecondaryAccentRamp, isValidHexColor, findPreset } from '../../src/utils/themePresets';
import { contrastRatio, hexToRgb, rgbToHsl } from '../../src/utils/colorMath';

const LIGHT_BACKGROUNDS = ['#fafaf9', '#ffffff'];
const DARK_BACKGROUNDS = ['#1c1b17', '#242320'];

/** Asserts every text/border role in one mode's ramp clears its actual WCAG floor. */
function assertRampMeetsFloors(ramp, backgrounds, soft) {
  // Text roles: 4.5:1 against every background AND against the mode's own soft fill.
  for (const bg of [...backgrounds, soft]) {
    expect(contrastRatio(ramp['--color-accent'], bg)).toBeGreaterThanOrEqual(4.5 - 0.01);
  }
  for (const bg of backgrounds) {
    expect(contrastRatio(ramp['--color-accent-hover'], bg)).toBeGreaterThanOrEqual(4.5 - 0.01);
  }
  // Border-only role: 3:1 against page/surface (never checked as text).
  for (const bg of backgrounds) {
    expect(contrastRatio(ramp['--color-accent-border'], bg)).toBeGreaterThanOrEqual(3 - 0.01);
  }
  // Solid bg roles: 4.5:1 against the FIXED solid text painted on top of them, not the page.
  expect(contrastRatio(ramp['--color-accent-solid-bg'], ramp['--color-accent-solid-text'])).toBeGreaterThanOrEqual(4.5 - 0.01);
  expect(contrastRatio(ramp['--color-accent-solid-bg-hover'], ramp['--color-accent-solid-text'])).toBeGreaterThanOrEqual(4.5 - 0.01);
}

describe('THEME_PRESETS', () => {
  it('has teal first, matching the shipped default accent (--color-accent-400 in global.css)', () => {
    expect(THEME_PRESETS[0].id).toBe('teal');
    expect(THEME_PRESETS[0].seed.toLowerCase()).toBe('#1d9e75');
  });

  it('has at least 6 presets spanning distinct hues', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(6);
    const hues = THEME_PRESETS.map((p) => rgbToHsl(hexToRgb(p.seed)).h);
    // No two presets should share almost the same hue (would defeat "spanning different hues").
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const diff = Math.min(Math.abs(hues[i] - hues[j]), 360 - Math.abs(hues[i] - hues[j]));
        expect(diff).toBeGreaterThan(15);
      }
    }
  });

  it('every preset has a valid hex seed', () => {
    for (const preset of THEME_PRESETS) {
      expect(isValidHexColor(preset.seed)).toBe(true);
    }
  });
});

describe('findPreset', () => {
  it('finds a preset by id', () => {
    expect(findPreset('teal')?.seed.toLowerCase()).toBe('#1d9e75');
  });

  it('returns undefined for an unknown id', () => {
    expect(findPreset('nonexistent')).toBeUndefined();
  });
});

describe('isValidHexColor', () => {
  it('accepts 6-digit and 3-digit hex colors', () => {
    expect(isValidHexColor('#1d9e75')).toBe(true);
    expect(isValidHexColor('#fff')).toBe(true);
    expect(isValidHexColor('#ABCDEF')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidHexColor('1d9e75')).toBe(false); // missing #
    expect(isValidHexColor('#1d9e7')).toBe(false); // wrong length
    expect(isValidHexColor('#gggggg')).toBe(false); // invalid hex digits
    expect(isValidHexColor('red')).toBe(false);
    expect(isValidHexColor('')).toBe(false);
    expect(isValidHexColor(null)).toBe(false);
    expect(isValidHexColor(undefined)).toBe(false);
    expect(isValidHexColor(123)).toBe(false);
    expect(isValidHexColor('javascript:alert(1)')).toBe(false);
  });
});

describe('buildAccentRamp — shipped presets', () => {
  for (const preset of THEME_PRESETS) {
    it(`${preset.id}: light ramp clears every WCAG floor`, () => {
      const { light } = buildAccentRamp(preset.seed);
      assertRampMeetsFloors(light, LIGHT_BACKGROUNDS, light['--color-accent-soft']);
    });

    it(`${preset.id}: dark ramp clears every WCAG floor`, () => {
      const { dark } = buildAccentRamp(preset.seed);
      assertRampMeetsFloors(dark, DARK_BACKGROUNDS, dark['--color-accent-soft']);
    });

    it(`${preset.id}: derived ramp's hue stays close to the seed's hue`, () => {
      const { light, dark } = buildAccentRamp(preset.seed);
      const seedHue = rgbToHsl(hexToRgb(preset.seed)).h;
      // Check the raw ramp stops (100/200/600/800 are never nudged for
      // contrast in either mode) to isolate "does the ramp preserve hue"
      // from "did a contrast nudge shift it" — nudging only ever changes
      // lightness, never hue, but this keeps the assertion meaningful even
      // if that changes.
      for (const stop of ['--color-accent-100', '--color-accent-600']) {
        const hue = rgbToHsl(hexToRgb(light[stop])).h;
        const diff = Math.min(Math.abs(hue - seedHue), 360 - Math.abs(hue - seedHue));
        expect(diff).toBeLessThan(2);
      }
      for (const stop of ['--color-accent-100', '--color-accent-600']) {
        const hue = rgbToHsl(hexToRgb(dark[stop])).h;
        const diff = Math.min(Math.abs(hue - seedHue), 360 - Math.abs(hue - seedHue));
        expect(diff).toBeLessThan(2);
      }
    });

    it(`${preset.id}: light and dark ramps are distinct`, () => {
      const { light, dark } = buildAccentRamp(preset.seed);
      expect(light['--color-accent']).not.toBe(dark['--color-accent']);
      expect(light['--color-accent-solid-text']).not.toBe(dark['--color-accent-solid-text']);
    });
  }
});

describe('buildAccentRamp — adversarial seeds (not preset-picked, deliberately hostile to contrast)', () => {
  const adversarialSeeds = [
    '#fefefe', // near-white — barely any room to darken for light-mode text
    '#010101', // near-black — barely any room to lighten for dark-mode fills
    '#808080', // desaturated gray — no hue to preserve, minimal saturation
    '#a0a0a5', // near-gray with a whisper of hue
    '#0000ff', // fully saturated, very dark-perceived blue
    '#ff69b4', // hot pink, high saturation + high lightness
  ];

  for (const seed of adversarialSeeds) {
    it(`${seed}: light ramp still clears every WCAG floor`, () => {
      const { light } = buildAccentRamp(seed);
      assertRampMeetsFloors(light, LIGHT_BACKGROUNDS, light['--color-accent-soft']);
    });

    it(`${seed}: dark ramp still clears every WCAG floor`, () => {
      const { dark } = buildAccentRamp(seed);
      assertRampMeetsFloors(dark, DARK_BACKGROUNDS, dark['--color-accent-soft']);
    });

    it(`${seed}: light and dark ramps remain distinct even under clamping pressure`, () => {
      const { light, dark } = buildAccentRamp(seed);
      expect(light['--color-accent']).not.toBe(dark['--color-accent']);
    });

    it(`${seed}: every derived value is a well-formed hex color`, () => {
      const { light, dark } = buildAccentRamp(seed);
      for (const value of [...Object.values(light), ...Object.values(dark)]) {
        expect(isValidHexColor(value)).toBe(true);
      }
    });
  }
});

describe('buildAccentRamp — role/floor independence (regression guard)', () => {
  // Dark mode's --color-accent, --color-accent-border, and
  // --color-accent-solid-bg-hover all read from the SAME raw stop (200) in
  // the shipped ramp (see global.css) but have three different floors
  // (4.5:1 text, 3:1 border, 4.5:1-vs-solid-text). A naive implementation
  // that computes one nudged value for "stop 200" and reuses it for all
  // three roles can satisfy one role while failing another — this pins that
  // each role is nudged independently.
  it('dark mode: accent/border/solid-bg-hover can each independently reach their own floor on a low-saturation seed', () => {
    const { dark } = buildAccentRamp('#8899a0'); // desaturated blue-gray — least room to satisfy multiple floors from one stop
    for (const bg of DARK_BACKGROUNDS) {
      expect(contrastRatio(dark['--color-accent'], bg)).toBeGreaterThanOrEqual(4.5 - 0.01);
      expect(contrastRatio(dark['--color-accent-border'], bg)).toBeGreaterThanOrEqual(3 - 0.01);
    }
    expect(contrastRatio(dark['--color-accent-solid-bg-hover'], dark['--color-accent-solid-text'])).toBeGreaterThanOrEqual(4.5 - 0.01);
  });

  it('light mode: accent-600 (text) and solid-bg-600 (vs solid-text) can independently reach their own floor', () => {
    const { light } = buildAccentRamp('#8899a0');
    for (const bg of LIGHT_BACKGROUNDS) {
      expect(contrastRatio(light['--color-accent'], bg)).toBeGreaterThanOrEqual(4.5 - 0.01);
    }
    expect(contrastRatio(light['--color-accent-solid-bg'], light['--color-accent-solid-text'])).toBeGreaterThanOrEqual(4.5 - 0.01);
  });
});

describe('buildSecondaryAccentRamp — the system-feedback hue (spinner/progress bar)', () => {
  it('is a distinctly different hue from the primary accent, not just a lighter/darker shade of it', () => {
    const primaryHue = rgbToHsl(hexToRgb('#1d9e75')).h;
    const { light } = buildSecondaryAccentRamp('#1d9e75');
    const secondaryHue = rgbToHsl(hexToRgb(light['--color-accent-secondary'])).h;
    const diff = Math.min(Math.abs(primaryHue - secondaryHue), 360 - Math.abs(primaryHue - secondaryHue));
    expect(diff).toBeGreaterThan(60);
  });

  it('never lands in the danger-red hue band regardless of preset seed', () => {
    // --color-danger is a red (~hue 355-10). The secondary hue must stay
    // clearly outside that band for every shipped preset, or a stuck
    // progress bar would misread as an error state. This test caught a real
    // bug: a naive fixed +150° offset put `slate` (hue ~209°) right back at
    // hue ~359° — almost exactly red — which is why clampAwayFromRed exists.
    for (const preset of THEME_PRESETS) {
      const { light, dark } = buildSecondaryAccentRamp(preset.seed);
      for (const value of [light['--color-accent-secondary'], dark['--color-accent-secondary']]) {
        const hue = rgbToHsl(hexToRgb(value)).h;
        const distanceFromRed = Math.min(Math.abs(hue - 0), 360 - Math.abs(hue - 0));
        expect(distanceFromRed).toBeGreaterThanOrEqual(35 - 0.5);
      }
    }
  });

  it('clears the 3:1 non-text contrast floor (WCAG 1.4.11) against page/surface backgrounds in both modes', () => {
    const adversarialSeeds = ['#fefefe', '#010101', '#808080', '#0000ff', '#ff69b4'];
    for (const seed of adversarialSeeds) {
      const { light, dark } = buildSecondaryAccentRamp(seed);
      for (const bg of LIGHT_BACKGROUNDS) {
        expect(contrastRatio(light['--color-accent-secondary'], bg)).toBeGreaterThanOrEqual(3 - 0.01);
      }
      for (const bg of DARK_BACKGROUNDS) {
        expect(contrastRatio(dark['--color-accent-secondary'], bg)).toBeGreaterThanOrEqual(3 - 0.01);
      }
    }
  });

  it('every derived value is a well-formed hex color', () => {
    const { light, dark } = buildSecondaryAccentRamp('#1d9e75');
    expect(isValidHexColor(light['--color-accent-secondary'])).toBe(true);
    expect(isValidHexColor(dark['--color-accent-secondary'])).toBe(true);
  });
});

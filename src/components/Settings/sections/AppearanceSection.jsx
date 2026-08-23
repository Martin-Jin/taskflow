/**
 * Settings → Appearance — light/dark theme, accent color (theme presets +
 * custom seed color), sound effects + volume, and the interface-animations
 * toggle (see useMotionEnabled for where the latter is actually read).
 */

import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useTheme } from '../../../context/ThemeContext';
import { useSound } from '../../../context/SoundContext';
import { THEME_PRESETS, isValidHexColor } from '../../../utils/themePresets';

export default function AppearanceSection({ sectionRef }) {
  const { animationsEnabled, setAnimationsEnabled } = useScheduler();
  const { theme, setTheme, accentSeed, setAccentSeed } = useTheme();
  const { soundEnabled, setSoundEnabled, soundVolume, setSoundVolume, playComplete } = useSound();

  // Local draft for the custom-hex text field, so an in-progress/invalid
  // keystroke (e.g. "#1d9e7" mid-type) doesn't get force-corrected back to
  // the last valid accentSeed on every render — only a syntactically valid
  // hex ever actually calls setAccentSeed. Re-seeded from accentSeed
  // whenever it changes from elsewhere (a preset click, a cross-device sync
  // pull) via the input's key/defaultValue-free controlled value below.
  const [hexDraft, setHexDraft] = useState(accentSeed || '');

  // Keeps the text field in sync when accentSeed changes from somewhere
  // OTHER than this field itself (a preset click, or a remote sync pull) —
  // without this, picking a preset would leave the text field showing
  // whatever the user last typed instead of the preset's hex.
  useEffect(() => {
    setHexDraft(accentSeed || '');
  }, [accentSeed]);

  function handlePresetClick(preset) {
    // The default/first preset stores `null`, not its literal hex — same
    // "don't pin today's default" convention as accentSeed's own null
    // default (see ThemeContext), so a future change to the shipped teal
    // isn't silently overridden for someone who long ago clicked "Teal".
    setAccentSeed(preset.id === THEME_PRESETS[0].id ? null : preset.seed);
  }

  function handleHexInput(value) {
    setHexDraft(value);
    const normalized = value.startsWith('#') ? value : `#${value}`;
    if (isValidHexColor(normalized)) setAccentSeed(normalized);
  }

  // Which preset (if any) is currently selected — the default preset is
  // "selected" both when accentSeed is null AND when it happens to exactly
  // match the default's own seed (e.g. restored from an old backup that
  // predates the null convention).
  const selectedPresetId = THEME_PRESETS.find((p) => (p.id === THEME_PRESETS[0].id ? !accentSeed : p.seed === accentSeed))?.id;

  return (
    <div className="card settings-card" data-tour="appearance-card" ref={sectionRef}>
      <h3>Appearance</h3>
      <p className="settings-hint">Switch between a warm off-white and a warm charcoal theme. Your choice is saved on this device.</p>
      <div className="theme-toggle" role="group" aria-label="Color theme" data-tour="appearance-toggle">
        <button
          type="button"
          className={`theme-toggle-option ${theme === 'light' ? 'active' : ''}`}
          aria-pressed={theme === 'light'}
          onClick={() => setTheme('light')}
        >
          <Sun size={14} />
          Light
        </button>
        <button
          type="button"
          className={`theme-toggle-option ${theme === 'dark' ? 'active' : ''}`}
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme('dark')}
        >
          <Moon size={14} />
          Dark
        </button>
      </div>

      <p className="settings-hint">Accent color, used for buttons, links, and highlights. Applies to both light and dark.</p>
      <div className="accent-swatch-row" role="group" aria-label="Accent color presets">
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`accent-swatch ${selectedPresetId === preset.id ? 'selected' : ''}`}
            style={{ background: preset.seed }}
            title={preset.name}
            aria-label={preset.name}
            aria-pressed={selectedPresetId === preset.id}
            onClick={() => handlePresetClick(preset)}
          />
        ))}
        <label htmlFor="accentCustomColor" className="settings-inline" style={{ position: 'relative' }}>
          <input
            type="color"
            id="accentCustomColor"
            value={isValidHexColor(accentSeed) ? accentSeed : THEME_PRESETS[0].seed}
            onChange={(e) => handleHexInput(e.target.value)}
            aria-label="Custom accent color picker"
          />
        </label>
        <input
          type="text"
          className="accent-custom-hex"
          value={hexDraft}
          onChange={(e) => handleHexInput(e.target.value)}
          placeholder="#1d9e75"
          maxLength={7}
          aria-label="Custom accent color hex value"
        />
      </div>

      <div className="form-row settings-toggle-row">
        <input type="checkbox" id="soundEnabled" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
        <label htmlFor="soundEnabled">Sound effects</label>
      </div>
      <p className="settings-hint">Short sounds when you add, complete, uncomplete, or delete a task.</p>
      <div className="form-row settings-toggle-row">
        <label htmlFor="soundVolume" style={{ margin: 0, opacity: soundEnabled ? 1 : 0.5 }}>
          Volume
        </label>
        <input
          type="range"
          id="soundVolume"
          min="0"
          max="1"
          step="0.05"
          value={soundVolume}
          disabled={!soundEnabled}
          onChange={(e) => setSoundVolume(Number(e.target.value))}
          onMouseUp={() => soundEnabled && playComplete()}
          onTouchEnd={() => soundEnabled && playComplete()}
          onKeyUp={() => soundEnabled && playComplete()}
          style={{ flex: 1, opacity: soundEnabled ? 1 : 0.5 }}
        />
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 34, textAlign: 'right', opacity: soundEnabled ? 1 : 0.5 }}>
          {Math.round(soundVolume * 100)}%
        </span>
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="animationsEnabled"
          checked={animationsEnabled}
          onChange={(e) => setAnimationsEnabled(e.target.checked)}
        />
        <label htmlFor="animationsEnabled">Interface animations</label>
      </div>
      <p className="settings-hint">Motion for modals, toasts, and task transitions.</p>
    </div>
  );
}

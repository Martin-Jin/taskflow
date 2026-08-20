/**
 * Settings → Appearance — light/dark theme, sound effects + volume, and the
 * interface-animations toggle (see useMotionEnabled for where the latter is
 * actually read).
 */

import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useTheme } from '../../../context/ThemeContext';
import { useSound } from '../../../context/SoundContext';

export default function AppearanceSection({ sectionRef }) {
  const { animationsEnabled, setAnimationsEnabled } = useScheduler();
  const { theme, setTheme } = useTheme();
  const { soundEnabled, setSoundEnabled, soundVolume, setSoundVolume, playComplete } = useSound();

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

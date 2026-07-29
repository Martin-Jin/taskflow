/**
 * SoundContext — the on/off toggle for Taskflow's synthesized sound effects
 * (see src/services/soundService.js) plus the play* wrappers every call site
 * uses, so no consumer needs to remember to check `soundEnabled` itself.
 *
 * Persisted via usePersistedState (localStorage-only, like the theme toggle
 * used to be before it gained cloud sync) — a personal on/off preference
 * doesn't need to follow the user across devices.
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import {
  playAddSound,
  playCompleteSound,
  playUncompleteSound,
  playDeleteSound,
  playSelectSound,
} from '../services/soundService';

const SoundContext = createContext(null);

export function SoundProvider({ children }) {
  const [soundEnabled, setSoundEnabled] = usePersistedState('soundEnabled', true);

  const playAdd = useCallback(() => { if (soundEnabled) playAddSound(); }, [soundEnabled]);
  const playComplete = useCallback(() => { if (soundEnabled) playCompleteSound(); }, [soundEnabled]);
  const playUncomplete = useCallback(() => { if (soundEnabled) playUncompleteSound(); }, [soundEnabled]);
  const playDelete = useCallback(() => { if (soundEnabled) playDeleteSound(); }, [soundEnabled]);
  const playSelect = useCallback(() => { if (soundEnabled) playSelectSound(); }, [soundEnabled]);

  const value = useMemo(
    () => ({ soundEnabled, setSoundEnabled, playAdd, playComplete, playUncomplete, playDelete, playSelect }),
    [soundEnabled, setSoundEnabled, playAdd, playComplete, playUncomplete, playDelete, playSelect]
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound() {
  const ctx = useContext(SoundContext);
  if (!ctx) throw new Error('useSound must be used within a SoundProvider');
  return ctx;
}

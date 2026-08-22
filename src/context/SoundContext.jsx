/**
 * SoundContext — thin wrapper around soundService.js's play* functions for
 * every consumer EXCEPT SchedulerContext itself (which calls soundService
 * directly — see its own comment on why: SoundProvider is rendered inside
 * SchedulerProvider so it can read `soundEnabled`/`soundVolume` from
 * useScheduler(), which means SchedulerContext can't call back into
 * useSound() without a circular provider dependency).
 *
 * `soundEnabled`/`soundVolume` themselves are NOT owned here — they live in
 * SchedulerContext as plain synced/backed-up state (see BACKUP_FIELDS),
 * exactly like `routines`/`rules`, so they participate in cloud sync and
 * backup/restore like every other setting. This context just reads them
 * from useScheduler() and exposes the same play* / setSoundEnabled API
 * consumers already use, so nothing else in the app needs to change.
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useScheduler } from './SchedulerContext';
import {
  playAddSound,
  playCompleteSound,
  playUncompleteSound,
  playDeleteSound,
} from '../services/soundService';

const SoundContext = createContext(null);

export function SoundProvider({ children }) {
  const { soundEnabled, setSoundEnabled, soundVolume, setSoundVolume } = useScheduler();

  const playAdd = useCallback(() => { if (soundEnabled) playAddSound(soundVolume); }, [soundEnabled, soundVolume]);
  const playComplete = useCallback(() => { if (soundEnabled) playCompleteSound(soundVolume); }, [soundEnabled, soundVolume]);
  const playUncomplete = useCallback(() => { if (soundEnabled) playUncompleteSound(soundVolume); }, [soundEnabled, soundVolume]);
  const playDelete = useCallback(() => { if (soundEnabled) playDeleteSound(soundVolume); }, [soundEnabled, soundVolume]);

  const value = useMemo(
    () => ({
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      playAdd,
      playComplete,
      playUncomplete,
      playDelete,
    }),
    [soundEnabled, setSoundEnabled, soundVolume, setSoundVolume, playAdd, playComplete, playUncomplete, playDelete]
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound() {
  const ctx = useContext(SoundContext);
  if (!ctx) throw new Error('useSound must be used within a SoundProvider');
  return ctx;
}

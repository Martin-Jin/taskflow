/**
 * ThemeContext — light/dark appearance toggle. Persisted via
 * usePersistedState (same pattern as tutorial-seen/settings state), and
 * synced to the signed-in user's Firestore doc so the choice follows them
 * to other devices — see the same pull-once-per-sign-in/push-on-change
 * pattern documented in SchedulerContext's "Cloud sync" section.
 * Defaults to 'dark' since that's the app's original/only look; sets
 * data-theme on <html> so CSS in global.css can key off it.
 */

import React, { createContext, useContext, useEffect } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAuth } from './AuthContext';
import { pullUserData, pushUserData } from '../services/firestoreSync';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = usePersistedState('theme', 'dark');
  const { user } = useAuth();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    pullUserData(user.uid).then((remote) => {
      if (!cancelled && remote && 'theme' in remote) setTheme(remote.theme);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!user) return;
    pushUserData(user.uid, { theme }).catch((err) => console.error('[ThemeContext] Cloud sync failed to save', err));
  }, [user, theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

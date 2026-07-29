/**
 * ThemeContext — light/dark appearance toggle. Persisted via
 * usePersistedState (same pattern as tutorial-seen/settings state), and
 * synced to the signed-in user's Firestore doc so the choice follows them
 * to other devices — see the same pull-once-per-sign-in/push-on-change
 * pattern documented in SchedulerContext's "Cloud sync" section.
 * Defaults to 'dark' since that's the app's original/only look; sets
 * data-theme on <html> so CSS in global.css can key off it.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAuth } from './AuthContext';
import { pullUserData, pushUserData, subscribeUserData } from '../services/firestoreSync';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = usePersistedState('theme', 'dark');
  const { user } = useAuth();

  // Guards the push effect below against racing the initial pull-on-sign-in
  // — without it, a device reloading with a stale local theme pushes that
  // value up (with no debounce, so nothing slows it down) before the pull
  // has had a chance to apply whatever another device most recently set,
  // silently reverting the other device's choice with older data. State
  // (not a ref) so flipping it back to true always re-runs the push effect
  // below even when the pull didn't itself change `theme` (e.g. a brand
  // new account with no `theme` field synced yet) — same fix as
  // SchedulerContext's `initialPullDoneRef`, see its comment there.
  const [initialPullDone, setInitialPullDone] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setInitialPullDone(false);
    pullUserData(user.uid)
      .then((remote) => {
        if (!cancelled && remote && 'theme' in remote) setTheme(remote.theme);
      })
      .finally(() => {
        if (!cancelled) setInitialPullDone(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Live convergence, same idea as SchedulerContext's own listener on this
  // same users/{uid} doc — picks up a theme change made on another
  // signed-in device within moments instead of only on next sign-in/reload.
  useEffect(() => {
    if (!user) return undefined;
    const unsubscribe = subscribeUserData(
      user.uid,
      (remote) => {
        if ('theme' in remote) setTheme(remote.theme);
      },
      (err) => console.error('[ThemeContext] Live sync listener failed', err)
    );
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (!initialPullDone) return; // wait for this sign-in's pull to settle first — see initialPullDone's comment
    pushUserData(user.uid, { theme }).catch((err) => console.error('[ThemeContext] Cloud sync failed to save', err));
  }, [user, theme, initialPullDone]);

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
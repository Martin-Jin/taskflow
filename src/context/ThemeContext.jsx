/**
 * ThemeContext — light/dark appearance toggle, plus an optional custom accent
 * color (a preset or a user-picked hex — see utils/themePresets.js). Both are
 * persisted via usePersistedState and synced to the signed-in user's
 * Firestore doc so the choice follows them to other devices — see the same
 * pull-once-per-sign-in/push-on-change pattern documented in
 * SchedulerContext's "Cloud sync" section. Defaults to 'dark'/no accent
 * override since that's the app's original/only look; sets data-theme on
 * <html> so CSS in global.css can key off it, and (when an accent is set)
 * writes the derived ramp as inline custom properties on <html> too, which
 * win over global.css's shipped values for free.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAuth } from './AuthContext';
import { pullUserData, pushUserData, subscribeUserData } from '../services/firestoreSync';
import { buildAccentRamp, isValidHexColor, THEME_PRESETS } from '../utils/themePresets';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = usePersistedState('theme', 'dark');
  // The accent seed color a preset or custom pick derives its ramp from.
  // `null` means "use the shipped default teal" — deliberately not stored as
  // the teal hex itself, so a future change to the shipped default doesn't
  // require migrating everyone's persisted 'no preference' state into a
  // literal color. See utils/themePresets.js for what this becomes.
  const [accentSeed, setAccentSeedRaw] = usePersistedState('accentSeed', null);
  // Anonymous share-link visitors (Collaborative Projects, Phase 2) are not a
  // sync account — same reasoning, and the same one-line interception, as
  // useCloudSync.js's own `authUser?.isAnonymous` guard; see the long comment
  // there. Theme is the one piece of synced state living outside
  // SchedulerContext (noted in CLAUDE.md), so it needs the guard separately or
  // an anonymous visitor's `users/{anonUid}` doc gets created just to hold a
  // theme they never chose to sync. Their theme still persists locally via
  // usePersistedState, exactly as it does for a signed-out visitor.
  const { user: authUser } = useAuth();
  const user = authUser?.isAnonymous ? null : authUser;

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
    // Keep the mobile status-bar/home-indicator color (index.html's
    // <meta name="theme-color">) in sync with --color-bg-page — otherwise
    // it stays pinned to whichever value was in the static HTML and clashes
    // with the theme the user actually has active.
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', theme === 'dark' ? '#1c1b17' : '#fafaf9');
    }
  }, [theme]);

  // Applies the derived accent ramp as inline custom properties on <html>,
  // which win over global.css's own :root rules for free (inline style beats
  // any stylesheet rule at equal specificity) — no new stylesheet, no
  // !important, no touching global.css at runtime. Only the CURRENTLY ACTIVE
  // theme's tokens are written, re-run whenever either the seed or the
  // light/dark choice changes: global.css picks its light vs. dark values via
  // `[data-theme]`, and this has to follow the same switch rather than trying
  // to override both blocks at once from one effect.
  useEffect(() => {
    const root = document.documentElement;
    if (!accentSeed || !isValidHexColor(accentSeed)) {
      // No override: remove anything a previous custom color left behind, so
      // global.css's own shipped teal values apply again.
      const ramp = buildAccentRamp(THEME_PRESETS[0].seed);
      for (const key of Object.keys(ramp.light)) root.style.removeProperty(key);
      return;
    }
    const ramp = buildAccentRamp(accentSeed);
    const tokens = theme === 'dark' ? ramp.dark : ramp.light;
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  }, [accentSeed, theme]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setInitialPullDone(false);
    pullUserData(user.uid)
      .then((remote) => {
        if (!cancelled && remote) {
          if ('theme' in remote) setTheme(remote.theme);
        if ('accentSeed' in remote) setAccentSeedRaw(remote.accentSeed);
          if ('accentSeed' in remote) setAccentSeedRaw(remote.accentSeed);
        }
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

  // Deliberately NOT routed through useCloudSync's single-flight push guard,
  // unlike the two paths that write the full state document (runPushNow and
  // pushToCloud, which share that guard so two full-document setDocs are never
  // on the wire at once). This write is a different shape: a `merge: true`
  // write naming exactly one field, which no other writer touches and which
  // computeFingerprint/planRemoteDataMerge never read — so it can't conflict
  // with or be clobbered by a state push, and vice versa. It also fires only
  // when `theme` actually changes, i.e. on a deliberate user toggle, so it
  // can't produce the repeated bursts that make concurrent writes a problem.
  // Coordinating it with the state-push guard would add cross-hook plumbing
  // for a write that has nothing to contend with.
  useEffect(() => {
    if (!user) return;
    if (!initialPullDone) return; // wait for this sign-in's pull to settle first — see initialPullDone's comment
    pushUserData(user.uid, { theme, accentSeed })
      .catch((err) => console.error('[ThemeContext] Cloud sync failed to save', err));
  }, [user, theme, accentSeed, initialPullDone]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  /** Sets the seed color directly (the custom color picker); rejects anything malformed rather than applying it. */
  function setAccentSeed(hex) {
    if (hex !== null && !isValidHexColor(hex)) return;
    setAccentSeedRaw(hex);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, accentSeed, setAccentSeed }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
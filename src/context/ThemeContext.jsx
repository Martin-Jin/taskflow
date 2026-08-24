/**
 * ThemeContext — light/dark appearance toggle, plus an optional custom
 * accent seed color (theme presets/custom accent, see themePresets.js).
 * Both are persisted via usePersistedState (same pattern as tutorial-seen/
 * settings state), and synced to the signed-in user's Firestore doc so the
 * choice follows them to other devices — see the same pull-once-per-sign-in/
 * push-on-change pattern documented in SchedulerContext's "Cloud sync"
 * section. `theme` defaults to 'dark' since that's the app's original/only
 * look; sets data-theme on <html> so CSS in global.css can key off it.
 *
 * `accentSeed` defaults to `null`, meaning "use global.css's shipped teal
 * ramp as-is" — deliberately NOT the literal teal hex, so a future change to
 * the shipped default doesn't get silently pinned to today's teal for every
 * existing user (see the apply-ramp effect below). When set, its derived
 * light+dark accent ramp (buildAccentRamp, themePresets.js) is applied as
 * INLINE custom properties on <html>, which win over global.css's `:root`
 * values at equal specificity — so this never touches global.css itself,
 * matching CLAUDE.md's "extend the token system, don't replace it".
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAuth } from './AuthContext';
import { pullUserData, pushUserData, subscribeUserData } from '../services/firestoreSync';
import { buildAccentRamp, buildSecondaryAccentRamp, isValidHexColor } from '../utils/themePresets';
import { generateFaviconDataUri, applyFaviconDataUri } from '../utils/generateFaviconDataUri';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = usePersistedState('theme', 'dark');
  const [accentSeed, setAccentSeedRaw] = usePersistedState('accentSeed', null);
  // Anonymous share-link visitors (Collaborative Projects, Phase 2) are not a
  // sync account — same reasoning, and the same one-line interception, as
  // useCloudSync.js's own `authUser?.isAnonymous` guard; see the long comment
  // there. Theme (and accentSeed, which rides the same path) is synced state
  // living outside SchedulerContext (noted in CLAUDE.md), so it needs the
  // guard separately or an anonymous visitor's `users/{anonUid}` doc gets
  // created just to hold a theme/accent they never chose to sync. Their
  // choice still persists locally via usePersistedState, exactly as it does
  // for a signed-out visitor.
  const { user: authUser } = useAuth();
  const user = authUser?.isAnonymous ? null : authUser;

  // Guards the push effect below against racing the initial pull-on-sign-in
  // — without it, a device reloading with a stale local theme pushes that
  // value up (with no debounce, so nothing slows it down) before the pull
  // has had a chance to apply whatever another device most recently set,
  // silently reverting the other device's choice with older data. State
  // (not a ref) so flipping it back to true always re-runs the push effect
  // below even when the pull didn't itself change `theme`/`accentSeed` (e.g.
  // a brand new account with no such field synced yet) — same fix as
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

  // Applies (or clears) the custom accent ramp as inline custom properties on
  // <html>. Inline style wins over a stylesheet rule at equal specificity, so
  // this overrides global.css's shipped :root/:root[data-theme='dark'] accent
  // values without editing global.css itself — the mechanism that keeps this
  // an extension of the token system rather than a second one. Keyed on
  // [accentSeed, theme] so switching light/dark while a custom accent is
  // active re-applies the ramp half that matches the new mode.
  useEffect(() => {
    const el = document.documentElement;
    const ACCENT_PROPERTIES = [
      '--color-accent-50',
      '--color-accent-100',
      '--color-accent-200',
      '--color-accent-400',
      '--color-accent-600',
      '--color-accent-800',
      '--color-accent-900',
      '--color-accent',
      '--color-accent-hover',
      '--color-accent-border',
      '--color-accent-solid-bg',
      '--color-accent-solid-bg-hover',
      '--color-accent-solid-text',
      '--color-accent-soft',
      '--color-accent-secondary',
    ];
    const mode = theme === 'dark' ? 'dark' : 'light';
    if (!accentSeed || !isValidHexColor(accentSeed)) {
      // null/invalid means "use the shipped default" — remove any inline
      // override so global.css's own :root values show through again.
      ACCENT_PROPERTIES.forEach((prop) => el.style.removeProperty(prop));
      // Shipped default teal's own solid-bg per theme (global.css) — the
      // favicon still needs a value to draw even with no custom accent, so
      // it can reflect a plain light/dark switch too, not just a custom pick.
      applyFaviconDataUri(generateFaviconDataUri(mode === 'dark' ? '#1d9e75' : '#0f6e56'));
      return;
    }
    const ramp = { ...buildAccentRamp(accentSeed)[mode], ...buildSecondaryAccentRamp(accentSeed)[mode] };
    Object.entries(ramp).forEach(([prop, value]) => el.style.setProperty(prop, value));
    applyFaviconDataUri(generateFaviconDataUri(ramp['--color-accent-solid-bg']));
  }, [accentSeed, theme]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setInitialPullDone(false);
    pullUserData(user.uid)
      .then((remote) => {
        if (cancelled || !remote) return;
        if ('theme' in remote) setTheme(remote.theme);
        if ('accentSeed' in remote) setAccentSeedRaw(remote.accentSeed);
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
  // same users/{uid} doc — picks up a theme/accent change made on another
  // signed-in device within moments instead of only on next sign-in/reload.
  useEffect(() => {
    if (!user) return undefined;
    const unsubscribe = subscribeUserData(
      user.uid,
      (remote) => {
        if ('theme' in remote) setTheme(remote.theme);
        if ('accentSeed' in remote) setAccentSeedRaw(remote.accentSeed);
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
  // write naming exactly these two fields, which no other writer touches and
  // which computeFingerprint/planRemoteDataMerge never read — so it can't
  // conflict with or be clobbered by a state push, and vice versa. It also
  // fires only when `theme`/`accentSeed` actually change, i.e. on a
  // deliberate user action, so it can't produce the repeated bursts that make
  // concurrent writes a problem. Coordinating it with the state-push guard
  // would add cross-hook plumbing for a write that has nothing to contend with.
  useEffect(() => {
    if (!user) return;
    if (!initialPullDone) return; // wait for this sign-in's pull to settle first — see initialPullDone's comment
    pushUserData(user.uid, { theme, accentSeed }).catch((err) => console.error('[ThemeContext] Cloud sync failed to save', err));
  }, [user, theme, accentSeed, initialPullDone]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  // Validates before ever storing/applying a seed — rejects a malformed hex
  // so a bad value can't get in from a JS caller, on top of the UI's own
  // <input type="color"> which already constrains what a user can type.
  // `null` is always allowed through (it's the explicit "use the default"
  // value, not something to validate as a color).
  function setAccentSeed(hex) {
    if (hex === null || isValidHexColor(hex)) setAccentSeedRaw(hex);
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

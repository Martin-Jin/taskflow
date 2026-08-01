/**
 * ============================================================================
 * AuthContext
 * ============================================================================
 * Sign-in identity used to sync TaskFlow's data (tasks/boards/settings)
 * across devices via Firestore — see services/firestoreSync.js and the
 * cloud-sync effects in SchedulerContext/ThemeContext for the actual sync.
 * This context only owns "who is signed in", not the app data itself.
 *
 * SIGN-IN FLOW: renders Google's own "Sign in with Google" button via
 * Identity Services' (GIS) *identity* API (`google.accounts.id`), not its
 * OAuth *authorization* API (`google.accounts.oauth2`, still used as-is by
 * googleCalendarService.js for actual Calendar API access — different
 * problem, different tool). That distinction matters here: both Firebase's
 * signInWithPopup/signInWithRedirect AND google.accounts.oauth2's token popup
 * rely on window.open() producing a genuine second browsing context. On some
 * mobile browsers (confirmed on Firefox for Android) window.open() instead
 * just navigates the *current* tab to the target URL — so every popup-based
 * attempt degraded into the same failure: the user's only tab gets yanked to
 * an external page with no way back, whether that page was Firebase's own
 * intermediate OAuth handler (missing-initial-state error) or Google's own
 * accounts.google.com (blank page, no popup to report a result back to).
 *
 * google.accounts.id sidesteps window.open() entirely for the base case —
 * it resolves via an iframe/overlay in the same page, delivering a Google ID
 * token to a JS callback, which is exchanged for a Firebase credential via
 * signInWithCredential(). Same VITE_GOOGLE_CLIENT_ID, no extra setup.
 *
 * This still doesn't work when TaskFlow is launched from an iOS/Android
 * home-screen icon (standalone display mode) — that isolated context breaks
 * it the same way it breaks everything else OAuth-related. GoogleSignInButton
 * checks standalone mode (utils/installPrompt.js's isRunningStandalone) and
 * renders a plain button calling login() instead of Google's widget there,
 * prompting the user to continue in their regular browser.
 * ============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { GoogleAuthProvider, signInWithCredential, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';
import { clearAllPersisted } from '../utils/persistence';
import { loadScript } from '../utils/loadScript';
import { isRunningStandalone } from '../utils/installPrompt';

const AuthContext = createContext(null);

let identityInited = false;
let identityInitPromise = null;

/**
 * Loads GIS and calls google.accounts.id.initialize() exactly once — safe to
 * call from multiple mounted buttons (AccountButton + SettingsPanel both
 * render one). `onCredential` is re-pointed to the latest caller on every
 * call so whichever AuthProvider instance is current handles the result
 * (there's only ever one in practice, but this avoids a stale-closure trap).
 */
let latestOnCredential = null;
async function ensureGisIdentity(onCredential) {
  latestOnCredential = onCredential;
  if (identityInited) return;
  if (!identityInitPromise) {
    identityInitPromise = (async () => {
      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
      if (!clientId) throw new Error('Google sign-in requires VITE_GOOGLE_CLIENT_ID to be configured — see README.md.');
      await loadScript('https://accounts.google.com/gsi/client');
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp) => latestOnCredential?.(resp),
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      identityInited = true;
    })();
  }
  await identityInitPromise;
}

/**
 * Mounts Google's own rendered "Sign in with Google" button into `container`
 * — the actual click target; our own UI just provides the container div and
 * an `onCredential(idToken)` callback for when the user completes sign-in.
 */
export async function renderGoogleSignInButton(container, onCredential, options = {}) {
  await ensureGisIdentity((resp) => onCredential(resp.credential));
  window.google.accounts.id.renderButton(container, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    ...options,
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [needsBrowserSignIn, setNeedsBrowserSignIn] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  // Only used by the standalone-mode fallback button (a plain button we
  // control, not Google's rendered widget — see needsBrowserSignIn/
  // BrowserSignInPromptModal). The normal sign-in path never calls this;
  // Google's own button (rendered via renderGoogleSignInButton) handles the
  // click itself and reports straight to handleGoogleCredential below.
  function login() {
    setAuthError(null);
    setNeedsBrowserSignIn(true);
  }

  async function handleGoogleCredential(idToken) {
    setAuthError(null);
    try {
      const credential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(auth, credential);
    } catch (err) {
      console.error('[AuthContext] Sign-in failed', err);
      setAuthError(err?.message || String(err));
    }
  }

  function dismissBrowserSignInPrompt() {
    setNeedsBrowserSignIn(false);
  }

  function clearAuthError() {
    setAuthError(null);
  }

  async function logout() {
    try {
      await firebaseSignOut(auth);
      // Local state/localStorage are keyed globally, not per-account (see
      // persistence.js) — wipe them so the next sign-in doesn't inherit this
      // account's tasks. A reload is needed since SchedulerContext seeds its
      // state from localStorage only on mount.
      clearAllPersisted();
      window.location.reload();
    } catch (err) {
      console.error('[AuthContext] Sign-out failed', err);
      setAuthError(err?.message || String(err));
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        authLoading,
        authError,
        login,
        logout,
        needsBrowserSignIn,
        dismissBrowserSignInPrompt,
        clearAuthError,
        handleGoogleCredential,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

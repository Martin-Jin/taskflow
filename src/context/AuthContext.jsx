/**
 * ============================================================================
 * AuthContext
 * ============================================================================
 * Sign-in identity used to sync TaskFlow's data (tasks/boards/settings)
 * across devices via Firestore — see services/firestoreSync.js and the
 * cloud-sync effects in SchedulerContext/ThemeContext for the actual sync.
 * This context only owns "who is signed in", not the app data itself.
 *
 * SIGN-IN FLOW: tries a popup first (no full-page navigation, feels
 * instant on desktop). Popups are blocked or unreliable in some mobile
 * browser contexts, so on popup-specific failures we transparently fall
 * back to a full-page redirect instead — completed via getRedirectResult()
 * in the effect below when the user lands back on the app.
 *
 * Neither popup nor redirect works when TaskFlow is launched from an iOS/
 * Android home-screen icon (standalone display mode): that context's storage
 * is isolated from the regular browser, so the sessionStorage marker Firebase
 * writes before redirecting is gone by the time the user lands back (surfaces
 * as `auth/missing-initial-state`). login() detects standalone mode up front
 * and skips straight to prompting the user to continue in their browser,
 * rather than attempting a flow that's known to fail there.
 * ============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { clearAllPersisted } from '../utils/persistence';

const AuthContext = createContext(null);

// Popup failures worth silently retrying as a redirect instead of surfacing
// as an error — anything else (e.g. the user just closing the popup) should
// stay a no-op rather than bouncing them through a full navigation too.
const POPUP_FALLBACK_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/cancelled-popup-request',
]);

export function isStandaloneDisplayMode() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone === true;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [needsBrowserSignIn, setNeedsBrowserSignIn] = useState(false);

  useEffect(() => {
    // Completes a sign-in that fell back to signInWithRedirect() below, once
    // Firebase redirects the user back to the app. A no-op if this load
    // wasn't the result of a redirect.
    getRedirectResult(auth).catch((err) => {
      if (err?.code === 'auth/missing-initial-state') {
        setAuthError(
          "Sign-in didn't complete because the browser lost track of the sign-in session — this happens when opening TaskFlow from a home-screen icon. Open TaskFlow in your browser (not the installed icon) to sign in."
        );
        return;
      }
      console.error('[AuthContext] Redirect sign-in failed', err);
      setAuthError(err?.message || String(err));
    });

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  async function login() {
    setAuthError(null);
    if (isStandaloneDisplayMode()) {
      setNeedsBrowserSignIn(true);
      return;
    }
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      if (POPUP_FALLBACK_CODES.has(err?.code)) {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      // "closed-by-user"/"cancelled" — the user changed their mind, not an error to surface.
      if (err?.code === 'auth/popup-closed-by-user') return;
      console.error('[AuthContext] Sign-in failed', err);
      setAuthError(err?.message || String(err));
    }
  }

  function dismissBrowserSignInPrompt() {
    setNeedsBrowserSignIn(false);
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
      value={{ user, authLoading, authError, login, logout, needsBrowserSignIn, dismissBrowserSignInPrompt }}
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

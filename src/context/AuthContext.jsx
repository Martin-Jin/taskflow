/**
 * ============================================================================
 * AuthContext
 * ============================================================================
 * Sign-in identity used to sync TaskFlow's data (tasks/boards/settings)
 * across devices via Firestore — see services/firestoreSync.js and the
 * cloud-sync effects in SchedulerContext/ThemeContext for the actual sync.
 * This context only owns "who is signed in", not the app data itself.
 *
 * SIGN-IN FLOW: popup only, deliberately — no signInWithRedirect fallback.
 * Redirect sends the user through Firebase's own intermediate OAuth handler
 * page (`<project>.firebaseapp.com/__/auth/handler`) and back, which depends
 * on a sessionStorage marker surviving that whole round-trip. That's broken
 * in more places than just iOS home-screen apps: e.g. Firefox for Android's
 * tab/storage handling can drop it too, in which case the user gets stranded
 * on Firebase's own error page ("missing initial state") *outside* our app —
 * a page we have no code running on and can't catch or redirect past. Popup
 * failures are surfaced as a clear in-app message instead, so the user never
 * leaves the app to a page we can't recover from.
 *
 * Popup itself doesn't work when TaskFlow is launched from an iOS/Android
 * home-screen icon (standalone display mode) either — window.open there
 * typically just kicks the user out to the regular browser mid-flow. login()
 * detects standalone mode up front and skips straight to prompting the user
 * to continue in their regular browser instead of attempting popup there.
 * ============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { signInWithPopup, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { clearAllPersisted } from '../utils/persistence';

const AuthContext = createContext(null);

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
      // "closed-by-user"/"cancelled" — the user changed their mind, not an error to surface.
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
        setAuthError(
          "Google sign-in couldn't open a pop-up in this browser. Allow pop-ups for this site (check your address bar for a blocked pop-up icon) and try again, or use a different browser."
        );
        return;
      }
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

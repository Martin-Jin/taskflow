/**
 * ============================================================================
 * AuthContext
 * ============================================================================
 * Sign-in identity used to sync TaskFlow's data (tasks/boards/settings)
 * across devices via Firestore — see services/firestoreSync.js and the
 * cloud-sync effects in SchedulerContext/ThemeContext for the actual sync.
 * This context only owns "who is signed in", not the app data itself.
 *
 * SIGN-IN FLOW: uses Google Identity Services' (GIS) OAuth token popup —
 * the same mechanism googleCalendarService.js already uses for Calendar
 * access (same VITE_GOOGLE_CLIENT_ID, no extra setup needed) — rather than
 * Firebase's own signInWithPopup/signInWithRedirect. Both of Firebase's own
 * methods route through its intermediate OAuth handler page
 * (`<project>.firebaseapp.com/__/auth/handler`), which depends on a
 * sessionStorage marker surviving the whole round-trip; on some mobile
 * browsers (confirmed on Firefox for Android — window.open() there just
 * navigates the current tab instead of opening a real popup, so
 * signInWithPopup degrades to the same failure mode as signInWithRedirect)
 * that marker gets lost, stranding the user on Firebase's own raw error page
 * ("missing initial state") *outside* our app, which we have no code running
 * on and can't recover from. GIS's popup is Google's own accounts.google.com
 * page, with no Firebase-hosted intermediate step — it resolves with an
 * access token, which is exchanged for a Firebase credential via
 * signInWithCredential() instead.
 *
 * GIS's popup also doesn't work when TaskFlow is launched from an iOS/
 * Android home-screen icon (standalone display mode) — window.open there
 * typically just kicks the user out to the regular browser mid-flow. login()
 * detects standalone mode up front and skips straight to prompting the user
 * to continue in their regular browser instead of attempting it there.
 * ============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { GoogleAuthProvider, signInWithCredential, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';
import { clearAllPersisted } from '../utils/persistence';
import { loadScript } from '../utils/loadScript';

const AuthContext = createContext(null);

// Just enough to identify the user — no Calendar/offline scopes needed here
// (see googleCalendarService.js for that separate, heavier flow).
const IDENTITY_SCOPES = 'openid email profile';

let tokenClient = null;
let gisInited = false;

async function ensureGisClient() {
  if (gisInited) return;
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google sign-in requires VITE_GOOGLE_CLIENT_ID to be configured — see README.md.');

  await loadScript('https://accounts.google.com/gsi/client');
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: IDENTITY_SCOPES,
    // Always show the account chooser rather than silently reusing whichever
    // Google account last signed into any app on this device (matches the
    // previous Firebase-popup flow's setCustomParameters({ prompt: ... })).
    prompt: 'select_account',
    callback: '', // set dynamically per-request in requestGoogleAccessToken()
  });
  gisInited = true;
}

/** Opens the GIS popup and resolves with a Google access token once the user approves. */
function requestGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(Object.assign(new Error(resp.error_description || resp.error), { gisCode: resp.error }));
      resolve(resp.access_token);
    };
    tokenClient.error_callback = (err) => reject(Object.assign(new Error(err?.message || 'Google sign-in failed'), { gisCode: err?.type }));
    tokenClient.requestAccessToken();
  });
}

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
      await ensureGisClient();
      const accessToken = await requestGoogleAccessToken();
      const credential = GoogleAuthProvider.credential(null, accessToken);
      await signInWithCredential(auth, credential);
    } catch (err) {
      // The user closed the pop-up or declined consent — not an error to surface.
      if (err?.gisCode === 'popup_closed' || err?.gisCode === 'access_denied') return;
      if (err?.gisCode === 'popup_failed_to_open') {
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

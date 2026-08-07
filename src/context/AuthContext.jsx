/**
 * ============================================================================
 * AuthContext
 * ============================================================================
 * Sign-in identity used to sync TaskFlow's data (tasks/boards/settings)
 * across devices via Firestore — see services/firestoreSync.js and the
 * cloud-sync effects in SchedulerContext/ThemeContext for the actual sync.
 * This context only owns "who is signed in", not the app data itself.
 *
 * SIGN-IN FLOW: triggers Google's Identity Services (GIS) *identity* API
 * (`google.accounts.id`) One Tap prompt from our own fully-stylable button,
 * not its OAuth *authorization* API (`google.accounts.oauth2`, still used
 * as-is by googleCalendarService.js for actual Calendar API access —
 * different problem, different tool). That distinction matters here: both
 * Firebase's signInWithPopup/signInWithRedirect AND google.accounts.oauth2's
 * token popup rely on window.open() producing a genuine second browsing
 * context. On some mobile browsers (confirmed on Firefox for Android)
 * window.open() instead just navigates the *current* tab to the target URL —
 * so every popup-based attempt degraded into the same failure: the user's
 * only tab gets yanked to an external page with no way back, whether that
 * page was Firebase's own intermediate OAuth handler (missing-initial-state
 * error) or Google's own accounts.google.com (blank page, no popup to report
 * a result back to).
 *
 * google.accounts.id sidesteps window.open() entirely for the base case —
 * prompt() resolves via an iframe/overlay in the same page, delivering a
 * Google ID token to a JS callback, which is exchanged for a Firebase
 * credential via signInWithCredential(). Same VITE_GOOGLE_CLIENT_ID, no extra
 * setup. (Google's own *rendered* button — renderButton() — was used here
 * previously, but its icon-only variant always draws on a fixed white square
 * inside a cross-origin iframe we can't restyle; prompt() gets the same
 * flow without that visual artifact.)
 *
 * This still doesn't work when TaskFlow is launched from an iOS/Android
 * home-screen icon (standalone display mode) — that isolated context breaks
 * it the same way it breaks everything else OAuth-related. GoogleSignInButton
 * checks standalone mode (utils/installPrompt.js's isRunningStandalone) and
 * shows a prompt to continue in a regular browser instead of Google's widget
 * there (see BrowserSignInPromptModal).
 * ============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  linkWithCredential,
  signInWithCredential,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth } from '../firebase';
import { clearAllPersisted } from '../utils/persistence';
import { loadScript } from '../utils/loadScript';
import { isRunningStandalone } from '../utils/installPrompt';
import { isGuestUser } from '../utils/sharedProjectAccess';
import { migrateGuestIdentity } from '../services/shareLinkService';
import { setGuestUid } from '../utils/guestIdentity';

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
        use_fedcm_for_prompt: false,
      });
      identityInited = true;
    })();
  }
  await identityInitPromise;
}

/**
 * Triggers Google's One Tap sign-in prompt — call this from our own button's
 * onClick. `onCredential(idToken)` fires when the user completes sign-in.
 */
export async function promptGoogleSignIn(onCredential) {
  await ensureGisIdentity((resp) => onCredential(resp.credential));
  window.google.accounts.id.prompt();
}

// GUEST IDENTITY BY DEFAULT: every signed-out visitor is treated as a guest
// (see isGuestUser/AccountButton/SettingsPanel), but a Firebase Anonymous
// Auth session is deliberately NOT minted proactively on every load —
// unlike the earlier version of this change, which called signInAnonymously
// unconditionally the moment no session was observed. That version was
// reverted after live testing showed it firing a real network request (and,
// in any environment whose Firebase Auth authorized-domains list doesn't
// include the current host — confirmed against this app's own dev/E2E
// setup — a genuine, console-logged failure) on EVERY single page load,
// even for a visitor who never touches sharing at all. This app has always
// worked fully offline off localStorage (see docs/DEVELOPMENT.md); a guest
// identity must stay additive on top of that, not a new hard dependency on
// reaching Firebase before the UI can settle.
//
// So a Firebase uid is only minted the moment something actually needs one:
// opening a share link (useJoinFlow.js's own signInAnonymously call, unchanged)
// or renaming from Settings while already a member of at least one shared
// project (renameAnonymousSelf in SchedulerContext.jsx — see its own comment).
// Until then, `user` stays null and the local guestIdentity record simply has
// `uid: null` — resolveGuestDisplayName/setGuestDisplayName work with no uid
// at all, so a guest's chosen name is fully available before any Firebase
// session exists. AccountButton/SettingsPanel show guest UI based on "no real
// signed-in account" (missing OR anonymous), not on isGuestUser(user) alone,
// precisely to cover this uid-less state.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      // Only a guest's uid belongs in the local guest-identity record — a
      // real Google account's uid must never end up there (see
      // guestIdentity.js's header on why this record is guest-only).
      if (isGuestUser(firebaseUser)) setGuestUid(firebaseUser.uid);
      setUser(firebaseUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  /**
   * @param {string} idToken - The Google ID token from GIS's One Tap prompt.
   * @param {{projectIds?: string[]}} [guestMigration] - Only meaningful when
   *   the CURRENT user is a share-link guest (see isGuestUser) — the ids of
   *   shared projects to attempt migrating to the new account if linking
   *   turns out to be impossible (see below). The caller (GoogleSignInButton)
   *   supplies this because AuthContext sits ABOVE SchedulerContext in the
   *   provider tree and has no access to `sharedProjects` itself. Omitted (or
   *   empty) for a guest with nothing to migrate, or for a non-guest sign-in,
   *   where it's simply unused.
   */
  async function handleGoogleCredential(idToken, guestMigration) {
    setAuthError(null);
    const credential = GoogleAuthProvider.credential(idToken);
    const currentUser = auth.currentUser;

    // GUESTS: upgrade the anonymous account IN PLACE via linkWithCredential
    // rather than signInWithCredential, which would REPLACE the session with
    // a brand-new uid — orphaning this guest's `collaborators` entry on every
    // shared project they've joined (see this file's header comment for the
    // full bug). `isGuestUser`, not `user.isAnonymous`: a guest who has
    // already joined a project via a link is re-authenticated via
    // signInWithCustomToken and reports isAnonymous === false despite having
    // no durable account — see that function's own doc comment for why.
    //
    // linkWithCredential keeps the uid unchanged, so every `collaborators`
    // entry, comment authorship, and presence doc referencing it stays valid
    // with ZERO migration required — this is overwhelmingly the common and
    // best-case outcome, and the only path taken for a guest with no shared
    // projects at all (nothing to migrate either way).
    if (isGuestUser(currentUser)) {
      try {
        await linkWithCredential(currentUser, credential);
        return;
      } catch (err) {
        if (err?.code !== 'auth/credential-already-in-use') {
          console.error('[AuthContext] Linking guest account failed', err);
          setAuthError(err?.message || String(err));
          return;
        }
        // Fall through to the migration fallback below — this Google account
        // already exists as a distinct Firebase user, so it cannot be linked
        // onto the current anonymous uid.
      }

      // FALLBACK: the Google account already exists. Capture everything
      // needed to migrate BEFORE signing in — the old session (and the
      // ability to read its own id token) is gone the instant the credential
      // swap below completes.
      const oldIdToken = await currentUser.getIdToken().catch(() => null);
      const projectIds = Array.isArray(guestMigration?.projectIds) ? guestMigration.projectIds : [];

      try {
        await signInWithCredential(auth, credential);
      } catch (err) {
        console.error('[AuthContext] Sign-in failed', err);
        setAuthError(err?.message || String(err));
        return;
      }

      if (!oldIdToken || projectIds.length === 0) return; // Nothing to migrate (or couldn't capture the old token — the new sign-in still succeeded).

      try {
        const newIdToken = await auth.currentUser.getIdToken();
        const result = await migrateGuestIdentity(oldIdToken, newIdToken, projectIds);
        if (result.failed?.length) {
          console.error('[AuthContext] Some shared projects failed to migrate', result.failed);
          setAuthError(
            "Signed in, but some of your shared projects couldn't be transferred to this account. Try reopening their share links."
          );
        }
      } catch (err) {
        // The sign-in itself already succeeded — a failed migration leaves
        // the OLD guest entries in place (see handleMigrateGuest's ordering
        // guarantee) rather than losing access outright, so this is
        // surfaced as a clear, specific error rather than a silent failure.
        console.error('[AuthContext] Guest project migration failed', err);
        setAuthError("Signed in, but couldn't transfer your shared projects to this account. Try reopening their share links.");
      }
      return;
    }

    // NON-GUEST: ordinary sign-in (or re-sign-in), completely unaffected by
    // any of the above.
    try {
      await signInWithCredential(auth, credential);
    } catch (err) {
      console.error('[AuthContext] Sign-in failed', err);
      setAuthError(err?.message || String(err));
    }
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
        logout,
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

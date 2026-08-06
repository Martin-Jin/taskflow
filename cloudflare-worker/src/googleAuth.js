/**
 * ============================================================================
 * FIREBASE ID TOKEN VERIFICATION
 * ============================================================================
 * Verifies a Firebase Auth ID token sent by the client (see
 * src/services/googleCalendarService.js) so the calendar-auth routes in
 * googleCalendarAuthRoutes.js know which uid's Firestore doc to read/write,
 * without trusting a client-supplied uid directly.
 *
 * Verification is via `jose`'s `createRemoteJWKSet` against Google's
 * Firebase JWKS endpoint — the same public keys Firebase Admin SDKs use to
 * verify these tokens, just done by hand here since Admin SDKs aren't
 * available in the Workers runtime. `jwtVerify` checks the signature, `exp`,
 * `iss`, and `aud` in one call; the verified token's `sub` claim is the
 * Firebase uid.
 * ============================================================================
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// Cached for the Worker isolate's lifetime — createRemoteJWKSet itself
// already caches the fetched keys internally, but this avoids even
// re-constructing the JWKSet wrapper on every request.
let jwks = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  return jwks;
}

export class AuthError extends Error {}

/**
 * Verifies `idToken` was issued by this Firebase project for a real signed-in
 * user, and returns their uid. Throws `AuthError` (safe to surface to the
 * client as a 401) on any failure — missing/malformed token, bad signature,
 * expired, or wrong issuer/audience.
 * @param {string} idToken
 * @param {{FIREBASE_PROJECT_ID: string}} env
 * @returns {Promise<string>} uid
 */
export async function verifyFirebaseIdToken(idToken, env) {
  if (!idToken || typeof idToken !== 'string') throw new AuthError('Missing ID token.');
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new AuthError('Worker misconfigured: FIREBASE_PROJECT_ID is not set.');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(), {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    }));
  } catch (err) {
    throw new AuthError(`Invalid Firebase ID token: ${err.message}`);
  }

  if (!payload.sub) throw new AuthError('ID token missing subject claim.');
  return payload.sub;
}

/**
 * Like `verifyFirebaseIdToken`, but also returns HOW the caller signed in.
 *
 * WHY THIS EXISTS: `signInWithCustomToken` (used by the share-link join flow,
 * see shareLinkRoutes.js) REPLACES the caller's session, and every token
 * minted that way reports `sign_in_provider === 'custom'` — the underlying
 * account's real provider is not recoverable from the resulting token, and
 * `isAnonymous` flips to false on the client. So the fact of "this account is
 * an ephemeral anonymous identity" has to be captured from the ORIGINAL,
 * pre-join ID token (which this reads) and carried forward deliberately as a
 * custom claim, or it is lost for good.
 *
 * That matters because firestore.rules refuses to transfer ownership of a
 * project to an anonymous collaborator — an identity that vanishes when the
 * visitor clears storage would leave the project permanently unowned, with
 * nobody able to delete it, rotate its links, or manage its members.
 *
 * The provider is read from the token's own `firebase.sign_in_provider`
 * claim, which Firebase's own signing key vouches for — it is verified data,
 * not a client assertion, and is exactly what firestore.rules would have seen
 * had the request come directly from this session.
 * @param {string} idToken
 * @param {{FIREBASE_PROJECT_ID: string}} env
 * @returns {Promise<{uid: string, signInProvider: string|null, isAnonymous: boolean}>}
 */
export async function verifyFirebaseIdTokenWithProvider(idToken, env) {
  if (!idToken || typeof idToken !== 'string') throw new AuthError('Missing ID token.');
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new AuthError('Worker misconfigured: FIREBASE_PROJECT_ID is not set.');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(), {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    }));
  } catch (err) {
    throw new AuthError(`Invalid Firebase ID token: ${err.message}`);
  }

  if (!payload.sub) throw new AuthError('ID token missing subject claim.');

  const signInProvider = payload.firebase?.sign_in_provider ?? null;
  return {
    uid: payload.sub,
    signInProvider,
    // A caller who ALREADY holds a custom-token session (e.g. they joined one
    // project and are now opening a second link) reports 'custom', so their
    // real provider is no longer visible here. Their previously-minted token
    // carried the truth forward as a claim, so trust that when present rather
    // than silently downgrading them to "not anonymous" — otherwise a second
    // join would launder an anonymous identity into a real-looking one.
    isAnonymous:
      signInProvider === 'anonymous' ||
      (signInProvider === 'custom' && payload.wasAnonymous === true),
  };
}

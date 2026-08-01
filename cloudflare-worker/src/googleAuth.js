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

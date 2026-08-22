/**
 * ============================================================================
 * FIREBASE CUSTOM TOKEN MINTING (self-signed)
 * ============================================================================
 * Mints a Firebase Auth "custom token" that the join-by-link route
 * (shareLinkRoutes.js's handleResolveLink) hands back to a visitor after
 * validating their presented share-link token server-side. The client signs
 * in with this token (`signInWithCustomToken`), which puts a `joinToken`
 * custom claim into `request.auth.token` for every subsequent Firestore
 * request that session makes — the exact claim firestore.rules'
 * `presentedTokenMatches()` compares against the stored link token to
 * authorize the visitor's own `collaborators` self-join write. See
 * firestore.rules' header comment ("WHY TOKENS ARE CHECKED ON A WRITE, NEVER
 * A READ") for why the claim has to arrive this way rather than as a document
 * field.
 *
 * WHY SELF-SIGNED, NOT THE FIREBASE ADMIN SDK
 * --------------------------------------------
 * The Admin SDK isn't available in the Workers runtime (same constraint
 * already noted in firestoreClient.js's header for the Firestore REST calls).
 * Firebase's custom-token format is a plain JWT with a documented shape
 * (firebase.google.com/docs/auth/admin/create-custom-tokens#create_custom_tokens_using_a_third-party_jwt_library),
 * so it can be hand-signed with `jose`'s `SignJWT` — same library and same
 * general approach `firestoreClient.js` already uses to mint this Worker's
 * OWN service-account access token, just a different JWT shape/audience.
 *
 * REQUIRED ONE-TIME IAM SETUP — SEE README.md
 * --------------------------------------------
 * Firebase only accepts a self-signed custom token if it's signed by a
 * service account that holds the "Service Account Token Creator"
 * (`roles/iam.serviceAccountTokenCreator`) role **on itself** — i.e. the same
 * service account used elsewhere in this Worker (`GOOGLE_SERVICE_ACCOUNT_EMAIL`
 * / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, see firestoreClient.js) must be
 * granted that role, with itself as the resource. Without this grant Firebase
 * rejects the token at sign-in time with an "invalid signature"/permission
 * error even though the JWT is otherwise well-formed — see README.md's exact
 * `gcloud` command for granting it.
 *
 * TOKEN LIFETIME
 * --------------
 * Firebase custom tokens are capped at 1 hour (`exp - iat <= 3600s`) by
 * Firebase itself; this mints one valid for only ~5 minutes, since it's
 * consumed immediately by the client's `signInWithCustomToken` call right
 * after minting — there's no legitimate reason for a join token to outlive
 * that single redemption, and a shorter window limits the blast radius if one
 * were ever intercepted in transit.
 * ============================================================================
 */

import { SignJWT, importPKCS8 } from 'jose';

const IDENTITY_TOOLKIT_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const CUSTOM_TOKEN_TTL_SECONDS = 5 * 60; // 5 minutes — see header comment.

/**
 * Mints a Firebase custom token for `uid`, carrying `claims` (e.g.
 * `{joinToken: '<presented token>'}`) as the token's custom claims.
 * @param {{GOOGLE_SERVICE_ACCOUNT_EMAIL: string, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string}} env
 * @param {string} uid - The target Firebase uid this token signs in as (the caller's own verified uid — see shareLinkRoutes.js).
 * @param {Record<string, unknown>} claims - Custom claims to attach, merged into the token's `claims` field per Firebase's custom-token JWT shape.
 * @returns {Promise<string>} the signed JWT (the "custom token" the client passes to `signInWithCustomToken`).
 */
export async function mintFirebaseCustomToken(env, uid, claims) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error('Worker misconfigured: GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set.');
  }
  if (!uid || typeof uid !== 'string') {
    throw new Error('mintFirebaseCustomToken: uid is required.');
  }

  // Same PEM-normalization as firestoreClient.js's mintServiceAccountToken —
  // `wrangler secret put` stores exactly what's piped in, so a key pasted
  // with literal "\n" escapes needs converting to real newlines for
  // importPKCS8 to accept it.
  const pem = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.includes('\\n')
    ? env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n')
    : env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const privateKey = await importPKCS8(pem, 'RS256');

  const now = Math.floor(Date.now() / 1000);
  const serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

  // Shape per Firebase's documented custom-token format: iss/sub are the
  // service account's own email, aud is the fixed Identity Toolkit audience
  // string above (NOT this Worker's own audience/project), uid is the target
  // user, and `claims` carries whatever custom claims the caller wants
  // exposed on `request.auth.token` client-side.
  return new SignJWT({ uid, claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(serviceAccountEmail)
    .setSubject(serviceAccountEmail)
    .setAudience(IDENTITY_TOOLKIT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + CUSTOM_TOKEN_TTL_SECONDS)
    .sign(privateKey);
}

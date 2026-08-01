/**
 * ============================================================================
 * GOOGLE CALENDAR PERSISTENT-AUTH ROUTES
 * ============================================================================
 * Three routes that let src/services/googleCalendarService.js get a
 * persistent (refresh-token-backed) Google Calendar connection without ever
 * holding the OAuth client secret or a Google refresh token client-side:
 *
 *   - POST /calendar/exchange-code — one-time: redeems the authorization
 *     `code` from GIS's initCodeClient popup for an access + refresh token,
 *     persists the refresh token in Firestore keyed by the caller's verified
 *     Firebase uid, and returns ONLY the access token to the client.
 *   - POST /calendar/refresh-token — the repeat "silent" path: looks up the
 *     stored refresh token and exchanges it for a fresh access token.
 *   - POST /calendar/disconnect — user-initiated: revokes the stored
 *     refresh token at Google and deletes it from Firestore.
 *
 * All three routes authenticate the caller via their Firebase ID token (see
 * googleAuth.js) rather than trusting a client-supplied uid, and both talk
 * to Firestore via firestoreClient.js's service-account REST helpers (IAM-
 * authorized, not governed by firestore.rules — see that file's rule
 * comment for `googleCalendarAuth`).
 * ============================================================================
 */

import { verifyFirebaseIdToken, AuthError } from './googleAuth.js';
import { getDoc, setDoc, deleteDoc } from './firestoreClient.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Fallback only — see the Origin-header-based redirectUri computed in
// handleExchangeCode below, which is what actually gets used per Google's
// documented popup-mode convention (the calling page's own origin).
const POPUP_CODE_REDIRECT_URI = '';

function tokenDocPath(uid) {
  return `users/${uid}/googleCalendarAuth/token`;
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Runs `verifyFirebaseIdToken`, translating an AuthError into a ready-to-return 401 Response so both routes below can share the same one-liner. */
async function requireUid(idToken, env, headers) {
  try {
    return { uid: await verifyFirebaseIdToken(idToken, env) };
  } catch (err) {
    if (err instanceof AuthError) return { response: jsonResponse({ error: err.message }, 401, headers) };
    throw err;
  }
}

/**
 * POST /calendar/exchange-code — body: { code, idToken }
 * Redeems the one-time authorization code, stores the refresh token, and
 * returns { access_token, expires_in } (never the refresh token itself).
 */
export async function handleExchangeCode(request, env, headers) {
  const body = await parseJsonBody(request);
  if (!body || typeof body.code !== 'string' || !body.code) {
    return jsonResponse({ error: 'Missing `code`.' }, 400, headers);
  }

  const { uid, response } = await requireUid(body.idToken, env, headers);
  if (response) return response;

  // Per Google's own docs (developers.google.com/identity/oauth2/web/guides/
  // use-code-model), initCodeClient's popup mode uses the calling page's own
  // *origin* as redirect_uri — not "postmessage" (that's the older gapi.auth2
  // convention) and not an empty string. The Origin header is exactly that,
  // and is already what CORS validates against for this same request.
  const redirectUri = request.headers.get('Origin') || POPUP_CODE_REDIRECT_URI;

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: body.code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return jsonResponse({ error: `Failed to exchange authorization code with Google: ${(await tokenRes.text()).slice(0, 500)}` }, 502, headers);
  }
  const tokenData = await tokenRes.json();

  if (!tokenData.refresh_token) {
    // The client always requests prompt:'consent' + access_type:'offline'
    // (see googleCalendarService.js), so Google should issue a refresh token
    // on every one-time-grant exchange — this is a defensive guard, not an
    // expected path, so it's surfaced rather than silently storing nothing.
    return jsonResponse({ error: 'Google did not return a refresh token — try disconnecting and reconnecting.' }, 502, headers);
  }

  await setDoc(env, tokenDocPath(uid), { refreshToken: tokenData.refresh_token, updatedAt: Date.now() });

  return jsonResponse({ access_token: tokenData.access_token, expires_in: tokenData.expires_in }, 200, headers);
}

/**
 * POST /calendar/refresh-token — body: { idToken }
 * Mints a fresh access token from the stored refresh token. Returns 404
 * `{error:'not_connected'}` if there's no stored refresh token yet, or 409
 * `{error:'revoked'}` (after deleting the now-dead stored doc) if Google
 * reports the refresh token itself was revoked — both are what the client
 * treats as `needsReconnect` (see googleCalendarService.js).
 */
export async function handleRefreshToken(request, env, headers) {
  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: 'Invalid JSON body.' }, 400, headers);

  const { uid, response } = await requireUid(body.idToken, env, headers);
  if (response) return response;

  const stored = await getDoc(env, tokenDocPath(uid));
  if (!stored?.refreshToken) {
    return jsonResponse({ error: 'not_connected' }, 404, headers);
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: stored.refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    if (text.includes('invalid_grant')) {
      // Refresh token was revoked (e.g. at myaccount.google.com/permissions)
      // — delete the stale doc so future polls fail fast with 404 instead of
      // repeatedly retrying a token Google will never honor again.
      await deleteDoc(env, tokenDocPath(uid));
      return jsonResponse({ error: 'revoked' }, 409, headers);
    }
    return jsonResponse({ error: `Failed to refresh access token: ${text.slice(0, 500)}` }, 502, headers);
  }

  const tokenData = await tokenRes.json();
  return jsonResponse({ access_token: tokenData.access_token, expires_in: tokenData.expires_in }, 200, headers);
}

/**
 * POST /calendar/disconnect — body: { idToken }
 * A genuine user-initiated disconnect, not just clearing client-side state:
 * revokes the stored refresh token at Google (so the grant also disappears
 * from myaccount.google.com/permissions, not just from our own records) and
 * deletes the stored Firestore doc either way. Always succeeds even if there
 * was nothing stored (idempotent — matches deleteDoc's own no-op-on-404
 * behavior) or if Google's revoke call fails (a token already-revoked one
 * way is still successfully "disconnected" from the app's point of view).
 */
export async function handleDisconnect(request, env, headers) {
  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: 'Invalid JSON body.' }, 400, headers);

  const { uid, response } = await requireUid(body.idToken, env, headers);
  if (response) return response;

  const stored = await getDoc(env, tokenDocPath(uid));
  if (stored?.refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refreshToken)}`, { method: 'POST' });
    } catch (err) {
      // Best-effort — Google being unreachable shouldn't block disconnecting
      // locally; the stored doc is deleted below regardless.
      console.error('Failed to revoke refresh token with Google', err);
    }
  }
  await deleteDoc(env, tokenDocPath(uid));

  return jsonResponse({ success: true }, 200, headers);
}

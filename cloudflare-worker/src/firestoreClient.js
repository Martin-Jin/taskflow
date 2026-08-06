/**
 * ============================================================================
 * FIRESTORE REST CLIENT (service-account authenticated)
 * ============================================================================
 * Minimal get/set/delete helpers against the Firestore REST API, authorized
 * as a Google service account rather than as the end user — this is what
 * lets the Worker read/write `users/{uid}/googleCalendarAuth/token` even
 * though `firestore.rules` denies that subcollection to every client-side
 * Firebase SDK call (see firestore.rules; the isolation boundary there is
 * enforced by IAM on this service account's role, not by security rules).
 *
 * The service account's bearer token is minted here via a hand-signed RS256
 * JWT (using `jose`'s `SignJWT`/`importPKCS8`) exchanged at Google's OAuth
 * token endpoint for a `datastore`-scoped access token — the standard
 * "self-signed JWT" / service-account flow, done by hand since the Google
 * Cloud Node client libraries aren't available in the Workers runtime.
 * Cached for the Worker isolate's lifetime (until it naturally recycles).
 * ============================================================================
 */

import { SignJWT, importPKCS8 } from 'jose';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

let cachedToken = null; // { accessToken, expiresAt } — expiresAt in epoch seconds

async function mintServiceAccountToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error('Worker misconfigured: GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set.');
  }

  // `wrangler secret put` stores exactly what's piped in — if the PEM was
  // pasted with literal "\n" escapes rather than real newlines, normalize
  // it here so importPKCS8 (which needs real line breaks) still works.
  const pem = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.includes('\\n')
    ? env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n')
    : env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const privateKey = await importPKCS8(pem, 'RS256');

  const jwt = await new SignJWT({ scope: FIRESTORE_SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
    .setSubject(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Failed to mint service-account token: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.accessToken;
}

function documentUrl(env, path) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

// Firestore REST documents use a typed-value wire format ({stringValue: ...}
// etc.) rather than plain JSON. Originally only string/number/boolean/null
// were needed (the calendar-auth routes above are all flat docs); the
// share-link routes (shareLinkRoutes.js) added nested maps
// (`private/links: {view: {...}, edit: {...}}`) and a real Firestore
// TIMESTAMP (`expiresAt` — firestore.rules' `linkUsable` compares it against
// `request.time` and has no ISO-8601 parser, so it MUST be a timestampValue,
// never a string). Both conversions are written generically/recursively so
// they handle arbitrary nesting, not just the one level share-links happens
// to use.
//
// Wire shapes added:
//   - mapValue:       { mapValue: { fields: { <key>: <TypedValue>, ... } } }
//   - timestampValue: { timestampValue: '<RFC3339 string>' }, e.g.
//     '2026-08-06T12:00:00.000Z' — Firestore accepts and returns RFC3339,
//     which is exactly what `new Date(millis).toISOString()` produces.
//
// A plain JS object is always encoded as a mapValue (never re-checked for
// "is this actually meant to be a map" — every caller in this module already
// only ever passes objects that are meant to round-trip as nested maps).
// `Date` instances are encoded as timestampValue so callers can pass a JS
// Date directly instead of pre-converting to a string.
function toFirestoreValue(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return { integerValue: String(Math.trunc(value)) };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  throw new Error(`toFirestoreValue: unsupported value type for ${JSON.stringify(value)}`);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function fromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  // Kept as an ISO string rather than parsed to a Date/millis here — callers
  // that need millis (e.g. shareLinkLogic.js's ported expiry check) convert
  // explicitly, same as the rest of this app's date handling elsewhere.
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields);
  return undefined;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) {
    obj[key] = fromFirestoreValue(value);
  }
  return obj;
}

/** Reads one document, or null if it doesn't exist. @returns {Promise<Object|null>} */
export async function getDoc(env, path) {
  const token = await mintServiceAccountToken(env);
  const res = await fetch(documentUrl(env, path), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore getDoc(${path}) failed: ${await res.text()}`);
  const data = await res.json();
  return fromFirestoreFields(data.fields);
}

/** Creates/overwrites a document's fields entirely (no partial update mask needed — every doc this module manages is exclusively owned by this Worker). */
export async function setDoc(env, path, data) {
  const token = await mintServiceAccountToken(env);
  const res = await fetch(documentUrl(env, path), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore setDoc(${path}) failed: ${await res.text()}`);
}

/** Deletes a document. No-ops (doesn't throw) if it's already gone. */
export async function deleteDoc(env, path) {
  const token = await mintServiceAccountToken(env);
  const res = await fetch(documentUrl(env, path), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore deleteDoc(${path}) failed: ${await res.text()}`);
}

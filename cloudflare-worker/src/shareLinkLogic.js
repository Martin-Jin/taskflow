/**
 * ============================================================================
 * SHARE-LINK LOGIC — hand-synced duplicate of src/utils/sharedProjectAccess.js
 * ============================================================================
 * This Worker is a separate deployable from the main app and cannot `import`
 * from `src/` — the same constraint documented for `src/services/aiModels.js`
 * vs. this Worker's own `MODEL_CATALOG` in `index.js`. Rather than re-derive
 * the token-validation logic from scratch (and risk it drifting from what
 * `firestore.rules` actually enforces), this file PORTS a deliberately small
 * subset of `src/utils/sharedProjectAccess.js`, kept behavior-identical:
 *
 *   - `isPresentableToken`  (private helper)
 *   - `timingSafeEqual`     (private helper)
 *   - `expiresAtMillis`     (private helper)
 *   - `isLinkExpired`       (private helper)
 *   - `evaluateLink`        (private helper) — returns 'ok'|'link_disabled'|'link_expired'|'invalid_token'
 *   - `resolveTokenRole`    (exported) — the public "does this token grant a role" check
 *
 * Everything else in the source file (computeEffectiveRole, planCollaboratorJoin,
 * ownership transfer, generateShareToken, etc.) is NOT needed server-side by
 * the routes in shareLinkRoutes.js and is deliberately not duplicated here —
 * `generateShareToken` in particular is reimplemented locally below using
 * Workers' own `crypto.getRandomValues` (same algorithm, so tokens from either
 * codepath are indistinguishable), rather than imported, since the source
 * file's version is trivial and re-typing it avoids a same-name-different-file
 * import confusion.
 *
 * KEEP THIS FILE IN SYNC BY HAND with src/utils/sharedProjectAccess.js. If you
 * change the token-validation rules there (e.g. what counts as "expired", what
 * shapes of `expiresAt` are tolerated), mirror the change here too — and vice
 * versa. Do not fix a discrepancy by silently picking one side; if the two
 * files disagree, that's a bug to report and reconcile deliberately, not
 * something to paper over in only one of them.
 * ============================================================================
 */

/** Same as sharedProjectAccess.js's isPresentableToken. */
function isPresentableToken(token) {
  return typeof token === 'string' && token.length > 0;
}

/** Same as sharedProjectAccess.js's timingSafeEqual — see that file's comment for why. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Same as sharedProjectAccess.js's expiresAtMillis, EXCEPT this Worker reads
 * `expiresAt` back from Firestore's own REST wire format via
 * `firestoreClient.js`'s `fromFirestoreValue`, which decodes a timestampValue
 * to an ISO string (not a Timestamp-like object) — so an ISO string is the
 * one extra shape tolerated here relative to the source file. Every other
 * shape (number/Date/{toMillis}/{toDate}/{seconds}) is kept for parity in
 * case a caller ever hands this a differently-shaped value (e.g. a test
 * fixture), same as the source file.
 */
function expiresAtMillis(expiresAt) {
  if (expiresAt == null) return null;
  if (typeof expiresAt === 'number') return expiresAt;
  if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (expiresAt instanceof Date) return expiresAt.getTime();
  if (typeof expiresAt.toMillis === 'function') return expiresAt.toMillis();
  if (typeof expiresAt.toDate === 'function') return expiresAt.toDate().getTime();
  if (typeof expiresAt.seconds === 'number') {
    return expiresAt.seconds * 1000 + Math.floor((expiresAt.nanoseconds || 0) / 1e6);
  }
  return null;
}

/** Same as sharedProjectAccess.js's isLinkExpired. */
function isLinkExpired(link, now) {
  const expiry = expiresAtMillis(link?.expiresAt);
  return expiry != null && now >= expiry;
}

/**
 * Same as sharedProjectAccess.js's evaluateLink — resolves a single link
 * entry (view or edit) against a presented token, distinguishing WHY it
 * failed so the join route can return a specific, friendly reason.
 * @returns {'ok'|'link_disabled'|'link_expired'|'invalid_token'}
 */
function evaluateLink(link, token, now) {
  if (!link || typeof link !== 'object') return 'invalid_token';
  if (!isPresentableToken(link.token) || !timingSafeEqual(link.token, token)) return 'invalid_token';
  if (link.enabled !== true) return 'link_disabled';
  if (isLinkExpired(link, now)) return 'link_expired';
  return 'ok';
}

/**
 * Same as sharedProjectAccess.js's resolveTokenRole, but ALSO returns the
 * specific failure reason instead of collapsing to `null` — the join route
 * needs to tell the client "invalid_token" vs "link_expired" vs
 * "link_disabled" (see firestore.rules' own linkUsable, which enforces the
 * same three conditions at write time; this is the pre-check that lets the
 * route fail fast with a friendly reason before ever attempting that write).
 *
 * CALLER CONTRACT (same as the source function): `links` must come from this
 * Worker's own privileged, service-account read of
 * `sharedProjects/{projectId}/private/links` — never from a client-supplied
 * value, which this route never accepts anyway (see shareLinkRoutes.js).
 * @param {{view?: object, edit?: object}|null|undefined} links
 * @param {string} token
 * @param {number} [now]
 * @returns {{role: 'editor'|'viewer'|null, reason: 'ok'|'link_disabled'|'link_expired'|'invalid_token'}}
 */
export function resolveTokenRole(links, token, now = Date.now()) {
  if (!isPresentableToken(token)) return { role: null, reason: 'invalid_token' };
  if (!links || typeof links !== 'object') return { role: null, reason: 'invalid_token' };

  // Editor link checked first, same precedence as the source file (an edit
  // token should never be down-graded to viewer even if a view link also
  // happens to share... it can't share a token, but the check order is kept
  // identical to the source for parity).
  const editResult = evaluateLink(links.edit, token, now);
  if (editResult === 'ok') return { role: 'editor', reason: 'ok' };

  const viewResult = evaluateLink(links.view, token, now);
  if (viewResult === 'ok') return { role: 'viewer', reason: 'ok' };

  // Neither link matched-and-passed. Prefer whichever result isn't a generic
  // "invalid_token" (i.e. the token DID match one link's stored token, but
  // that link is disabled/expired) so the failure reason is specific rather
  // than defaulting to "wrong token" when the token was actually right.
  if (editResult !== 'invalid_token') return { role: null, reason: editResult };
  if (viewResult !== 'invalid_token') return { role: null, reason: viewResult };
  return { role: null, reason: 'invalid_token' };
}

/**
 * Generate an unguessable share-link token — same algorithm as
 * sharedProjectAccess.js's `generateShareToken` (22 URL-safe base64
 * characters from 16 cryptographically random bytes), reimplemented here
 * rather than imported (see header comment) using the Workers runtime's own
 * `crypto.getRandomValues`, which is available globally same as in the
 * browser.
 * @returns {string}
 */
export function generateShareToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

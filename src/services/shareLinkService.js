/**
 * ============================================================================
 * SHARE LINK SERVICE — client half of the Phase 2 join/link endpoints
 * ============================================================================
 * Thin fetch wrapper around the Cloudflare Worker's `/share/*` routes (see
 * cloudflare-worker/src/shareLinkRoutes.js). There is deliberately NO logic
 * here beyond request/response shaping and error translation — every access
 * DECISION is made either by the Worker (which alone can read the link
 * tokens) or by firestore.rules (the actual boundary).
 *
 * WHY EVERY ONE OF THESE IS A SERVER CALL
 * ---------------------------------------
 * Share tokens live in `sharedProjects/{id}/private/links`, locked with
 * `allow read, write: if false` for EVERY client — including the project's
 * own owner. That isn't an oversight: Firestore's read granularity is one
 * whole document, so a token sitting on any document a collaborator can read
 * is a token that collaborator can steal and re-present to escalate their own
 * role (this happened — see firestore.rules' header). So even "show me my own
 * share link" has to be a privileged server read. Nothing here can be
 * shortcut into a direct Firestore call later; don't try.
 *
 * WHAT STILL GOES DIRECT TO FIRESTORE (and why that's correct)
 * -----------------------------------------------------------
 * Collaborator removal, role changes and ownership transfer are NOT here.
 * They're ordinary writes to `sharedProjects/{id}.collaborators`, which the
 * rules already authorize for the owner (`isOwner() && ownerFieldsUnchanged()`,
 * and `isTransferringOwnership()` for the transfer). They touch no secret, so
 * routing them through the Worker would add a hop and a second place to get
 * authorization wrong, for nothing. See sharedProjectService.js for those.
 *
 * The caller's identity is always a freshly-minted Firebase ID token, never a
 * client-supplied uid — the Worker verifies it against Google's JWKS and
 * derives the uid itself (see cloudflare-worker/src/googleAuth.js).
 * ============================================================================
 */

import { signInWithCustomToken } from 'firebase/auth';
import { auth } from '../firebase';

/**
 * Reuses the AI Quick Add / Google Calendar Worker deployment — it's one
 * Worker with several route groups (see cloudflare-worker/src/index.js), not
 * three deployments, so there's deliberately no separate env var to configure
 * and get out of sync.
 */
function workerUrl() {
  return import.meta.env.VITE_AI_QUICKADD_WORKER_URL;
}

/** Whether sharing-by-link can work at all in this deployment. */
export function isShareLinkConfigured() {
  return !!workerUrl();
}

/**
 * Thrown by every function here. `kind` is a stable machine-readable code so
 * callers can branch (e.g. render "this link expired" rather than a generic
 * failure) without string-matching a human-facing message.
 */
export class ShareLinkError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'ShareLinkError';
    this.kind = kind || 'unknown';
  }
}

/** The current user's Firebase ID token, or throw a typed error if nobody's signed in. */
async function currentIdToken() {
  const user = auth.currentUser;
  if (!user) throw new ShareLinkError('Sign in to manage sharing.', 'not_signed_in');
  return user.getIdToken();
}

/**
 * POSTs to a `/share/*` route and returns the parsed body.
 *
 * Network failures are translated rather than surfaced raw: a bare
 * `TypeError: Failed to fetch` is what a browser reports for offline, DNS
 * failure AND a CORS rejection alike, none of which mean anything to a user.
 */
async function postShare(path, body) {
  const base = workerUrl();
  if (!base) throw new ShareLinkError('Sharing is not configured for this deployment.', 'not_configured');

  let res;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ShareLinkError("Couldn't reach the sharing service. Check your connection and try again.", 'network');
  }

  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // Fall through — a non-JSON body is only meaningful via the status below.
  }

  if (!res.ok) {
    if (res.status === 401) throw new ShareLinkError('Your sign-in has expired — sign in again.', 'unauthorized');
    if (res.status === 403) throw new ShareLinkError('Only the project owner can manage its share links.', 'forbidden');
    throw new ShareLinkError(parsed?.error || `Sharing request failed (HTTP ${res.status}).`, 'server');
  }
  return parsed || {};
}

/**
 * The owner's current view/edit link state for a project.
 * @param {string} projectId - The SHARED project id (`project.sharedProjectId`), not the local project id.
 * @returns {Promise<{view: {token: string, enabled: boolean, expiresAt: number|null}|null, edit: {...}|null}>}
 */
export async function fetchShareLinks(projectId) {
  return postShare('/share/links', { idToken: await currentIdToken(), projectId });
}

/**
 * Create / rotate / revoke / re-enable / delete one of a project's two links.
 *
 * `rotate` and `delete` invalidate the previously-issued URL — that's the
 * point of them, and the UI is responsible for saying so before calling.
 * @param {string} projectId - The shared project id.
 * @param {'view'|'edit'} linkType
 * @param {'create'|'rotate'|'revoke'|'enable'|'delete'} action
 * @param {number|null} [expiresAt] - Millis since epoch, or null/omitted for "never expires".
 * @returns {Promise<{view: object|null, edit: object|null}>} the resulting state, same shape as fetchShareLinks.
 */
export async function setShareLink(projectId, linkType, action, expiresAt) {
  return postShare('/share/links/set', {
    idToken: await currentIdToken(),
    projectId,
    linkType,
    action,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

/**
 * Resolve a presented share token into a joinable project, and sign in with
 * the returned custom token so subsequent Firestore writes carry the
 * `joinToken` claim `firestore.rules` checks.
 *
 * The sign-in is done HERE rather than left to the caller because the custom
 * token is short-lived (~5 minutes) and useless for anything else — handing it
 * back up the stack would just create an opportunity to hold it too long or
 * log it. What the caller gets is the outcome, never the credential.
 *
 * A rejected link resolves NORMALLY with `{ok: false, reason}` rather than
 * throwing: an expired or revoked link is an expected outcome the UI renders
 * a specific message for, not an exceptional one. Exceptions are reserved for
 * "we couldn't complete the request at all".
 * @param {string} token - The raw token from the `?join=` param.
 * @returns {Promise<{ok: true, projectId: string, role: 'editor'|'viewer', projectName: string}|{ok: false, reason: string}>}
 */
export async function resolveShareToken(token) {
  const result = await postShare('/share/resolve', { idToken: await currentIdToken(), token });

  if (!result?.ok) {
    return { ok: false, reason: result?.reason || 'invalid_token' };
  }
  if (typeof result.customToken !== 'string' || !result.customToken) {
    throw new ShareLinkError('The sharing service returned an unusable response.', 'server');
  }

  // Signing in with the custom token REPLACES the current auth session with
  // one carrying the joinToken claim. For an anonymous visitor that's the same
  // uid they already had (the Worker mints it for their own verified uid), so
  // nothing they've done is lost; for a signed-in user it re-authenticates the
  // same account with the extra claim attached.
  const credential = await signInWithCustomToken(auth, result.customToken);

  // Force-refresh the ID token before returning. signInWithCustomToken
  // resolves once the SESSION exists, but the ID token carrying the new
  // claims is minted lazily — so the join write that runs straight after this
  // could otherwise go out with the PREVIOUS token, which has no `joinToken`
  // and no `wasAnonymous`. firestore.rules needs both: `presentedTokenMatches`
  // compares joinToken against the stored one, and `joinEntryWellFormed`
  // requires the written `isAnonymous` to equal the `wasAnonymous` claim.
  // Without this the rules deny every join with a bare permission-denied,
  // identically for view and edit links, which reads as "the link is broken"
  // rather than "the token hadn't propagated yet".
  const tokenResult = await credential.user.getIdTokenResult(true);

  return {
    ok: true,
    projectId: result.projectId,
    role: result.role,
    projectName: typeof result.projectName === 'string' ? result.projectName : '',
    // The joiner's REAL identity kind, from the refreshed claim rather than
    // `user.isAnonymous`. After a custom-token sign-in `user.isAnonymous` is
    // false for everyone — including genuinely anonymous visitors — so using
    // it would write an `isAnonymous` the rules reject, and (if it ever got
    // through) would let a project be transferred to an ephemeral identity.
    // See firestore.rules' joinerIsAnonymous / recipientIsRealAccount.
    wasAnonymous: tokenResult.claims.wasAnonymous === true,
  };
}

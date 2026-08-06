/**
 * ============================================================================
 * SHARE-LINK ROUTES (Collaborative Projects, Phase 2 — server side)
 * ============================================================================
 * This is the ONLY code in the whole feature that ever reads
 * `sharedProjects/{projectId}/private/links` (view/edit link tokens +
 * enabled/expiry state) — that document is locked with
 * `allow read, write: if false` in firestore.rules for every client-side
 * Firebase SDK call, not even the owner's, per the escalation bug documented
 * in that file's header. These routes reach it via `firestoreClient.js`'s
 * service-account REST calls (IAM-authorized, same pattern as the Google
 * Calendar auth routes in googleCalendarAuthRoutes.js), which bypass
 * firestore.rules entirely.
 *
 * Three routes:
 *   - POST /share/links       — owner reads their own current link state.
 *   - POST /share/links/set   — owner creates/rotates/revokes/enables/deletes
 *                                one link.
 *   - POST /share/resolve     — the JOIN endpoint: any caller (incl.
 *                                anonymous) presents a token, gets back a
 *                                Firebase custom token carrying a `joinToken`
 *                                claim if the token is valid.
 *
 * No route for collaborator removal/role-change: the owner can already do
 * that directly via the client SDK (`isOwner() && ownerFieldsUnchanged()` in
 * firestore.rules permits any owner write to `collaborators` that doesn't
 * touch `ownerId`/`links`/collaborator-map-shape) — see this file's own
 * final comment block for the full reasoning. Nothing here needs to proxy
 * that.
 *
 * THE REVERSE INDEX (`shareTokens/{token}`)
 * ------------------------------------------
 * A visitor who clicks a share link has only the token, not the project id,
 * and Firestore has no "query a subcollection across all documents by field
 * value" primitive reachable here (and even if it did, `private/links` is
 * locked to `if false` for every client and this Worker's own reads are
 * point `getDoc`s, not queries). So every link-token write here also
 * maintains `shareTokens/{token} -> {projectId, linkType}`, keyed BY the
 * token itself, letting /share/resolve go straight from "here's a token" to
 * "here's the project" with one point read.
 *
 * Is that safe? A doc keyed by the secret token is only reachable by whoever
 * already HAS the token (nobody can list this collection, and its own
 * `firestore.rules` match below is `allow read, write: if false` for every
 * client anyway — this Worker touches it only via the service account). The
 * token is exactly as secret sitting in this index as it is sitting in
 * `private/links` — knowing a project's id and this collection's existence
 * gets you nothing without the token string itself, since the doc ID *is*
 * the token. So this index doesn't create a new way to guess or enumerate
 * tokens; it only lets someone who already holds a valid token resolve it
 * faster. Confirmed: no client can read this collection (see firestore.rules
 * change below), and even if it could, doc IDs aren't listable without the
 * (never-granted) `list` permission on `sharedProjects` having an analogue
 * for this collection, which also isn't granted.
 *
 * REQUIRED firestore.rules CHANGE (see PR description / report):
 *   match /shareTokens/{token} { allow read, write: if false; }
 * This must be deployed (`firebase deploy --only firestore:rules`) and
 * `npm run test:rules` re-run before this feature can work end-to-end.
 *
 * ORPHAN INDEX ENTRIES ON PROJECT DELETE — FLAGGED, NOT HANDLED HERE
 * --------------------------------------------------------------------
 * When an owner deletes a `sharedProjects/{id}` document (client-side,
 * `allow delete: if isOwner()`), any `shareTokens/{token}` entries pointing
 * at that project become orphaned — they still resolve (this route doesn't
 * re-verify the project document exists before minting a custom token... see
 * handleResolveLink, which DOES re-fetch the project and would 404/fail
 * there) but linger as dead index rows forever, since nothing currently
 * deletes them when a project goes away. This is a **known gap**: the client
 * has no way to enumerate a project's own token entries to clean them up
 * without also holding the tokens (this Worker deliberately never returns a
 * bare project→token reverse lookup to the client, only the routes below).
 * The cleanest fix is for the client's project-delete path to first call
 * /share/links (to learn the current tokens, which the owner IS allowed to
 * see) and pass them to a small cleanup call here — deliberately NOT built
 * in this pass since it's out of scope for Phase 2's spec; report this to
 * whichever session owns delete-project so it can decide whether to wire it
 * up now or accept the orphan as a (harmless, since resolution still checks
 * the live project) cleanup debt.
 * ============================================================================
 */

import { verifyFirebaseIdToken, verifyFirebaseIdTokenWithProvider, AuthError } from './googleAuth.js';
import { getDoc, setDoc, deleteDoc } from './firestoreClient.js';
import { resolveTokenRole, generateShareToken, isSafeFirestoreId } from './shareLinkLogic.js';
import { mintFirebaseCustomToken } from './firebaseCustomToken.js';

const LINK_TYPES = new Set(['view', 'edit']);
const SET_ACTIONS = new Set(['create', 'rotate', 'revoke', 'enable', 'delete']);

// Every path builder re-checks its own input rather than trusting the caller
// to have validated. These strings are interpolated into Firestore REST URLs
// where `..` resolves before the request is sent, and the Worker reads with a
// service account that bypasses firestore.rules — so a miss here reads an
// arbitrary document. Throwing (rather than returning a bad path) means a
// future call site that forgets to validate fails loudly instead of silently
// traversing; the route handlers below still validate up front so real
// requests get a 400 rather than a 500.
function assertSafeId(value, label) {
  if (!isSafeFirestoreId(value)) {
    throw new Error(`Unsafe ${label} rejected before Firestore path use.`);
  }
  return value;
}
function projectDocPath(projectId) {
  return `sharedProjects/${assertSafeId(projectId, 'projectId')}`;
}
function linksDocPath(projectId) {
  return `sharedProjects/${assertSafeId(projectId, 'projectId')}/private/links`;
}
function tokenIndexPath(token) {
  return `shareTokens/${assertSafeId(token, 'token')}`;
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

/** Same pattern as googleCalendarAuthRoutes.js's requireUid. */
async function requireUid(idToken, env, headers) {
  try {
    return { uid: await verifyFirebaseIdToken(idToken, env) };
  } catch (err) {
    if (err instanceof AuthError) return { response: jsonResponse({ error: err.message }, 401, headers) };
    throw err;
  }
}

/**
 * Shapes the `{view, edit}` response common to /share/links and
 * /share/links/set — never includes anything beyond token/enabled/expiresAt,
 * and only ever returned to a verified owner.
 */
function publicLinkShape(link) {
  if (!link) return null;
  return {
    token: link.token,
    enabled: link.enabled === true,
    expiresAt: typeof link.expiresAt === 'string' ? Date.parse(link.expiresAt) || null : null,
  };
}

/**
 * Fetches `private/links` and confirms the caller owns `projectId`, without
 * ever revealing to a non-owner whether the project exists at all — every
 * failure path here collapses to the same 403 `forbidden`, and a missing
 * project ALSO reports 403 rather than 404 (see handler doc comments for
 * why: distinguishing "doesn't exist" from "exists but isn't yours" would
 * let a caller enumerate valid project ids by probing).
 * @returns {Promise<{project: object}|{errorResponse: Response}>}
 */
async function requireOwnedProject(env, projectId, uid, headers) {
  const project = await getDoc(env, projectDocPath(projectId));
  if (!project || project.ownerId !== uid) {
    return { errorResponse: jsonResponse({ error: 'forbidden' }, 403, headers) };
  }
  return { project };
}

/**
 * POST /share/links — body: { idToken, projectId }
 * Owner-only. Returns the project's current link state:
 *   200 { view: {token, enabled, expiresAt}|null, edit: {...}|null }
 * If no `private/links` doc exists yet (nobody has ever generated a link),
 * both are `null` rather than a 404 — an owner asking "what are my current
 * links" before ever creating one is not an error.
 */
export async function handleGetLinks(request, env, headers) {
  const body = await parseJsonBody(request);
  if (!body || !isSafeFirestoreId(body.projectId)) {
    return jsonResponse({ error: 'Missing/invalid `projectId`.' }, 400, headers);
  }

  const { uid, response } = await requireUid(body.idToken, env, headers);
  if (response) return response;

  const owned = await requireOwnedProject(env, body.projectId, uid, headers);
  if (owned.errorResponse) return owned.errorResponse;

  const links = await getDoc(env, linksDocPath(body.projectId));
  return jsonResponse(
    { view: publicLinkShape(links?.view), edit: publicLinkShape(links?.edit) },
    200,
    headers
  );
}

/**
 * POST /share/links/set — body: { idToken, projectId, linkType, action, expiresAt? }
 * Owner-only. `linkType`: 'view'|'edit'. `action`: 'create'|'rotate'|
 * 'revoke'|'enable'|'delete'. `expiresAt`: optional millis-since-epoch,
 * written as a real Firestore timestamp — see firestoreClient.js's
 * toFirestoreValue. Returns the resulting link state in the same shape as
 * handleGetLinks: 200 { view, edit }.
 *
 * The reverse index (`shareTokens/{token}`) is kept in lockstep here: a
 * fresh token gets its own index entry; `rotate`/`delete` remove the OLD
 * token's entry (never leaving a stale token resolvable after it's no
 * longer the live one for that link).
 */
export async function handleSetLink(request, env, headers) {
  const body = await parseJsonBody(request);
  if (
    !body ||
    !isSafeFirestoreId(body.projectId) ||
    !LINK_TYPES.has(body.linkType) ||
    !SET_ACTIONS.has(body.action)
  ) {
    return jsonResponse({ error: 'Missing/invalid `projectId`, `linkType` ("view"|"edit"), or `action`.' }, 400, headers);
  }
  let expiresAtMillis = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
      return jsonResponse({ error: '`expiresAt` must be a millis-since-epoch number, or null/omitted.' }, 400, headers);
    }
    expiresAtMillis = body.expiresAt;
  }

  const { uid, response } = await requireUid(body.idToken, env, headers);
  if (response) return response;

  const owned = await requireOwnedProject(env, body.projectId, uid, headers);
  if (owned.errorResponse) return owned.errorResponse;

  const existingLinks = (await getDoc(env, linksDocPath(body.projectId))) || {};
  const existingLink = existingLinks[body.linkType] || null;

  let nextLink = existingLink;
  let oldTokenToRemoveFromIndex = null;
  let newTokenToIndex = null;

  switch (body.action) {
    case 'create':
      // No-op returning the existing link if one already exists — do NOT
      // silently rotate on create (a caller re-requesting "create" for a
      // link that already exists must not invalidate URLs already handed out).
      if (existingLink) {
        nextLink = existingLink;
        break;
      }
      newTokenToIndex = generateShareToken();
      nextLink = { token: newTokenToIndex, enabled: true, ...(expiresAtMillis != null ? { expiresAt: new Date(expiresAtMillis) } : {}) };
      break;

    case 'rotate': {
      const wasEnabled = existingLink ? existingLink.enabled === true : true;
      if (existingLink?.token) oldTokenToRemoveFromIndex = existingLink.token;
      newTokenToIndex = generateShareToken();
      nextLink = {
        token: newTokenToIndex,
        enabled: wasEnabled,
        ...(expiresAtMillis != null
          ? { expiresAt: new Date(expiresAtMillis) }
          : existingLink?.expiresAt
            ? { expiresAt: existingLink.expiresAt }
            : {}),
      };
      break;
    }

    case 'revoke':
      if (!existingLink) return jsonResponse({ error: 'No link exists to revoke.' }, 400, headers);
      nextLink = { ...existingLink, enabled: false };
      break;

    case 'enable':
      if (!existingLink) return jsonResponse({ error: 'No link exists to enable.' }, 400, headers);
      nextLink = { ...existingLink, enabled: true };
      break;

    case 'delete':
      if (existingLink?.token) oldTokenToRemoveFromIndex = existingLink.token;
      nextLink = null;
      break;
  }

  // Spreading `existingLinks` already carries the OTHER link type's entry
  // through untouched, which matters because setDoc overwrites the whole
  // document (see firestoreClient.js) rather than merging one key.
  const nextLinksDoc = { ...existingLinks };
  if (nextLink) nextLinksDoc[body.linkType] = nextLink;
  else delete nextLinksDoc[body.linkType];

  // ORDER MATTERS, and it is deliberately index-first.
  //
  // These are separate documents with no transaction spanning them (they're
  // service-account REST calls, not a client batch), so a failure between the
  // two writes leaves them inconsistent. Both inconsistent states are
  // survivable, but they are not equally bad:
  //
  //   index first  — an index entry exists for a token that isn't live in
  //                  `private/links` yet. Resolving it reads the links doc,
  //                  finds no matching token, and returns `invalid_token`.
  //                  The link simply doesn't work yet; nothing is exposed.
  //   links first  — the link is LIVE and handed to the owner to share, but
  //                  has no index entry, so /share/resolve can never find its
  //                  project and every recipient gets "invalid link" for a
  //                  URL the owner is being told is valid, with no way to
  //                  repair it short of rotating.
  //
  // So write the index first and let the links doc be the commit point: a
  // token is only ever REAL once it appears in `private/links`, which is also
  // the only document `resolveTokenRole` actually trusts. A stale index entry
  // is inert by construction — it's a lookup hint, never an authority: a
  // rotated-away token still sitting in the index resolves to its project,
  // then fails the token comparison against the live links doc and is
  // rejected. That's why the OLD token's index row is removed last of all,
  // after the new state is safely committed.
  if (newTokenToIndex) {
    await setDoc(env, tokenIndexPath(newTokenToIndex), { projectId: body.projectId, linkType: body.linkType });
  }

  if (Object.keys(nextLinksDoc).length === 0) {
    await deleteDoc(env, linksDocPath(body.projectId));
  } else {
    await setDoc(env, linksDocPath(body.projectId), nextLinksDoc);
  }

  if (oldTokenToRemoveFromIndex) await deleteDoc(env, tokenIndexPath(oldTokenToRemoveFromIndex));

  return jsonResponse(
    { view: publicLinkShape(nextLinksDoc.view), edit: publicLinkShape(nextLinksDoc.edit) },
    200,
    headers
  );
}

/**
 * POST /share/resolve — body: { idToken, token }
 * The JOIN endpoint. The caller MAY be anonymous (unlike project creation,
 * which firestore.rules refuses for anonymous sign-in providers) — an
 * anonymous visitor clicking a share link is exactly who this route exists
 * for. `idToken` still must be a valid Firebase ID token (anonymous auth
 * issues real ID tokens, same verification path either way).
 *
 * Success: 200 { ok: true, customToken, projectId, role, projectName }
 *   The client signs in with `customToken` (`signInWithCustomToken`), which
 *   attaches the `joinToken` claim `firestore.rules`' `presentedTokenMatches`
 *   checks, then writes its own `collaborators` entry directly (ordinary
 *   client Firestore write, authorized by that claim + `joiningWithToken`).
 *   This route never performs that collaborators write itself — minting the
 *   claim and handing back enough display info (`projectName`) is its whole
 *   job.
 * Failure: 200 { ok: false, reason: 'invalid_token'|'link_expired'|'link_disabled' }
 *   Deliberately 200, not 4xx — an invalid/expired/disabled link is an
 *   ordinary, expected outcome for a UI to render specifically (not a
 *   protocol-level error), matching the "no partial/fallback access, ever"
 *   rule: every failure is fully rejected with a reason for a friendly
 *   message, never partially honored.
 * Auth failure (bad/missing idToken): 401 { error }
 * Malformed body: 400 { error }
 *
 * The token itself, and the private `links` document, are NEVER included in
 * the response — only what's needed to complete the join.
 */
export async function handleResolveLink(request, env, headers) {
  const body = await parseJsonBody(request);
  if (!body || typeof body.token !== 'string' || !body.token) {
    return jsonResponse({ error: 'Missing `token`.' }, 400, headers);
  }
  // A malformed token is answered with the SAME generic `invalid_token` as a
  // token that simply doesn't exist. Distinguishing them would hand an
  // attacker a response oracle for probing what the path validator accepts —
  // the uniform failure shape is what keeps this route non-informative.
  if (!isSafeFirestoreId(body.token)) {
    return jsonResponse({ ok: false, reason: 'invalid_token' }, 200, headers);
  }

  // Unlike the owner-only routes above, this one needs the caller's real
  // sign-in provider, not just their uid — see verifyFirebaseIdTokenWithProvider
  // for why it can only be captured here, before the custom-token sign-in
  // overwrites it.
  let caller;
  try {
    caller = await verifyFirebaseIdTokenWithProvider(body.idToken, env);
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ error: err.message }, 401, headers);
    throw err;
  }
  const { uid, isAnonymous } = caller;

  const indexEntry = await getDoc(env, tokenIndexPath(body.token));
  // The stored projectId is validated as strictly as a client-supplied one:
  // it's about to be interpolated into a service-account Firestore path, and
  // "it came from our own database" is an assumption about every past and
  // future writer, not a property this route can verify.
  if (!indexEntry || !isSafeFirestoreId(indexEntry.projectId)) {
    // Never log body.token — see this file's header / README constraints.
    return jsonResponse({ ok: false, reason: 'invalid_token' }, 200, headers);
  }

  const [project, links] = await Promise.all([
    getDoc(env, projectDocPath(indexEntry.projectId)),
    getDoc(env, linksDocPath(indexEntry.projectId)),
  ]);
  // The project itself may have been deleted after the index entry was
  // written (see this file's header "ORPHAN INDEX ENTRIES" note) — treat
  // that identically to an invalid token rather than leaking that the index
  // entry existed.
  if (!project) {
    return jsonResponse({ ok: false, reason: 'invalid_token' }, 200, headers);
  }

  const { role, reason } = resolveTokenRole(links, body.token);
  if (!role) {
    return jsonResponse({ ok: false, reason }, 200, headers);
  }

  // `wasAnonymous` carries the caller's REAL identity kind across the
  // custom-token sign-in that is about to replace their session. Without it
  // the fact is destroyed: every custom-token session reports
  // `sign_in_provider === 'custom'`, so firestore.rules could no longer tell
  // an ephemeral anonymous visitor from a real account, and would happily
  // record an anonymous joiner as a real one — defeating the guard that stops
  // a project being handed to an identity that disappears when the visitor
  // clears their storage. The rules read this claim instead of
  // `sign_in_provider` when validating a join entry's `isAnonymous` (see
  // firestore.rules' joinEntryWellFormed).
  //
  // It is derived from Firebase's own verified token, never from the request
  // body, so a client cannot assert it — the whole point is that this is the
  // one place the truth is still available.
  const customToken = await mintFirebaseCustomToken(env, uid, {
    joinToken: body.token,
    wasAnonymous: isAnonymous,
  });

  return jsonResponse(
    { ok: true, customToken, projectId: indexEntry.projectId, role, projectName: typeof project.name === 'string' ? project.name : '' },
    200,
    headers
  );
}

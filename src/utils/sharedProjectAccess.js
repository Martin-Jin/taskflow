/**
 * ============================================================================
 * SHARED PROJECT ACCESS — pure decision logic (Phase 0, Collaborative Projects)
 * ============================================================================
 * Every function here is pure and side-effect-free (no Firebase imports, no
 * randomness) EXCEPT `generateShareToken`, which is kept isolated at the
 * bottom so the actual access decisions remain deterministically unit
 * testable. The eventual Firestore rules/writes should be a dumb application
 * of what `computeEffectiveRole`/`planCollaboratorJoin` decide here — see
 * TODO.md's "Collaborative Projects" spec, Phase 0, and its non-negotiable
 * security requirement: there is no partial/fallback access, ever. A
 * malformed/missing field is always treated as "no access" rather than
 * guessed at.
 *
 * SERVER-SIDE / JOIN-PATH ONLY — DO NOT FEED THESE A CLIENT READ OF THE
 * PROJECT DOCUMENT.
 * ----------------------------------------------------------------------
 * Every function below that takes a `links`-bearing object (`resolveTokenRole`,
 * `computeEffectiveRole`, `planCollaboratorJoin`) expects that object's
 * `links` to have come from a PRIVILEGED, SERVER-SIDE read of
 * `sharedProjects/{projectId}/private/links` — the join endpoint's own read,
 * made with credentials that bypass `firestore.rules` (same pattern as the
 * Google Calendar auth Worker route). That private doc is exactly what its
 * name says: `firestore.rules` locks it with `allow read, write: if false`,
 * so NO client-side Firebase SDK call — not the owner's, not a
 * collaborator's, nobody's — can ever read it. A client fetching the
 * `SharedProject` document itself (`sharedProjects/{projectId}`) will simply
 * never see a `links` field there (see its typedef in `src/types/index.js`
 * for why tokens don't live on that document at all) — passing that
 * client-shaped object into these functions is correct-by-construction, not
 * a bug: `links` will be absent, so every function here degrades to "no
 * token-derived access," which is the right answer for a client that has no
 * business resolving tokens itself.
 *
 * These helpers exist to mirror `firestore.rules`' own token-checking logic
 * (see its `linkUsable`/`presentedTokenMatches`) so the SERVER-SIDE join
 * endpoint can pre-validate a presented token and return a specific, friendly
 * failure reason before ever attempting the Firestore write that rules
 * actually enforce. They are not meant to be called from browser code with
 * a client-obtained `sharedProject` object as a way to "check my own access"
 * — for that, read `computeEffectiveRole`'s uid/ownerId/collaborators
 * handling in isolation from its token argument, or just attempt the write
 * and let rules answer.
 * ============================================================================
 */

/** The two roles a share link (or an explicit collaborator entry) can carry. */
export const SHARE_ROLES = {
  VIEWER: 'viewer',
  EDITOR: 'editor',
};

/** Not a "share role" (no link ever grants it) — the project creator only. */
export const OWNER = 'owner';

/**
 * True if `token` is a non-empty string. Every resolver below must gate on
 * this first — an empty/absent/non-string token must never be treated as
 * "matches an empty stored token" (e.g. a link doc that happens to have
 * `token: ''` because it was never generated).
 */
function isPresentableToken(token) {
  return typeof token === 'string' && token.length > 0;
}

/**
 * Constant-time-ish string comparison, to avoid a naive `===` short-circuit
 * leaking timing information about how many leading characters of a guessed
 * token were correct. Not a hardened crypto primitive (this is a client-side
 * JS decision helper, not a server signing check), but cheap insurance since
 * both strings are already in hand and the comparison is trivial to write
 * this way — walks the full length of the longer string regardless of where
 * a mismatch occurs.
 */
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
 * Convert a link's `expiresAt` into millis-since-epoch, or `null` if it
 * doesn't expire. Tolerant of every shape a caller might hand in, since
 * Firestore itself stores this as a Timestamp (not the ISO strings this
 * module's other dates use — rules have no ISO-8601 parser, see
 * firestore.rules' `linkUsable`), while a plain restored-from-JSON object
 * (e.g. a backup, or a test fixture) might carry a `Date`, a millis number,
 * or a `{seconds, nanoseconds}`/`{toMillis()}`/`{toDate()}` Timestamp-like
 * object instead. Deliberately does NOT import firebase — duck-types
 * whatever shape shows up.
 * @param {*} expiresAt
 * @returns {number|null}
 */
function expiresAtMillis(expiresAt) {
  if (expiresAt == null) return null;
  if (typeof expiresAt === 'number') return expiresAt;
  if (expiresAt instanceof Date) return expiresAt.getTime();
  if (typeof expiresAt.toMillis === 'function') return expiresAt.toMillis();
  if (typeof expiresAt.toDate === 'function') return expiresAt.toDate().getTime();
  if (typeof expiresAt.seconds === 'number') {
    return expiresAt.seconds * 1000 + Math.floor((expiresAt.nanoseconds || 0) / 1e6);
  }
  return null; // Unrecognized shape — treat as "no usable expiry" rather than guess/throw.
}

/** True if a link's `expiresAt` (any tolerated shape) is in the past relative to `now` (millis). */
function isLinkExpired(link, now) {
  const expiry = expiresAtMillis(link?.expiresAt);
  return expiry != null && now >= expiry;
}

/**
 * Resolve a single link entry (view or edit) against a presented token,
 * distinguishing WHY it failed — used internally so `planCollaboratorJoin`
 * can surface a friendly reason, while `resolveTokenRole` (the public API)
 * collapses all failure modes to `null` per the "no partial/fallback access"
 * rule: a caller must never be able to branch on "well it was ALMOST valid".
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
 * Resolve a presented link token against a shared project's `links` map into
 * the role it grants, or `null` if it grants nothing. Never falls back to
 * partial access — any of the following is an unconditional `null`:
 * - the token is empty/absent/not a string
 * - `sharedProject`/`sharedProject.links` is missing or malformed
 * - the matching link entry is disabled (`enabled !== true`)
 * - the matching link entry has expired (`expiresAt` in the past — see
 *   `expiresAtMillis` for the tolerated input shapes)
 * - the token doesn't match either link's stored token
 *
 * CALLER CONTRACT: `sharedProject.links` must come from a SERVER-SIDE,
 * privileged read of `sharedProjects/{projectId}/private/links` (the join
 * endpoint's own read) — never from a client read of the `sharedProjects/
 * {projectId}` document itself, which cannot contain a `links` field at all
 * (`firestore.rules` rejects one being written there, and locks the private
 * doc with `allow read, write: if false`). Called with a client-shaped
 * project object, `sharedProject.links` will simply be `undefined` and this
 * correctly returns `null` — see this file's header comment.
 * @param {{links?: {view?: {token?: string, enabled?: boolean, expiresAt?: *}, edit?: {token?: string, enabled?: boolean, expiresAt?: *}}}} sharedProject
 * @param {string} token
 * @param {number} [now] - Millis-since-epoch "current time" for expiry comparison; defaults to `Date.now()`.
 *   Callers doing deterministic decisions (tests, `planCollaboratorJoin`) should pass this explicitly.
 * @returns {'viewer'|'editor'|null}
 */
export function resolveTokenRole(sharedProject, token, now = Date.now()) {
  if (!isPresentableToken(token)) return null;
  const links = sharedProject?.links;
  if (!links || typeof links !== 'object') return null;

  if (evaluateLink(links.edit, token, now) === 'ok') return SHARE_ROLES.EDITOR;
  if (evaluateLink(links.view, token, now) === 'ok') return SHARE_ROLES.VIEWER;

  return null;
}

/** Role rank used to compare/merge roles — higher number wins. */
const ROLE_RANK = { [SHARE_ROLES.VIEWER]: 1, [SHARE_ROLES.EDITOR]: 2, [OWNER]: 3 };

/** Highest-ranked of two roles (nullable inputs allowed); `null` if both are `null`. */
function strongerRole(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * Full precedence decision for what a given (uid, presented token) pair may
 * do on a shared project: owner beats collaborator beats token.
 *
 * Upgrade/downgrade rule: an existing collaborator's STORED role is a floor,
 * never a ceiling — presenting a weaker link (e.g. an existing editor
 * clicking a view-only link) must not silently downgrade them, but
 * presenting a STRONGER link (e.g. an existing viewer clicking an edit link)
 * SHOULD upgrade the effective role for this resolution. Persisting that
 * upgrade into the stored collaborator entry is a separate write decision
 * (see `planCollaboratorJoin`) — this function only computes the read-time
 * effective role.
 * IMPORTANT: link expiry only gates picking up a NEW/upgraded role via the
 * token — it never retroactively evicts someone already sitting in
 * `collaborators`. If the link they originally joined through has since
 * expired, `tokenRole` below simply resolves to `null` for this call, but
 * `strongerRole` still has their untouched `normalizedStoredRole` to fall
 * back to, so their existing access is completely unaffected.
 *
 * CALLER CONTRACT (same as `resolveTokenRole`): `sharedProject.links`, if
 * present, must have come from the SERVER-SIDE join endpoint's own
 * privileged read of `sharedProjects/{projectId}/private/links` — never from
 * a client read of the project document, which never carries `links`. The
 * `ownerId`/`collaborators`-based part of this decision (owner and existing-
 * collaborator checks) is unaffected either way and safe to evaluate against
 * an ordinary client-read project object; it's only the `presentedToken`
 * resolution that needs the privileged `links` source.
 * @param {{ownerId?: string, collaborators?: Record<string, {role?: string}>, links?: object}} sharedProject
 * @param {string} [uid] - The requester's (possibly anonymous) auth uid.
 * @param {string} [presentedToken] - A link token presented alongside the request, if any.
 * @param {number} [now] - Millis-since-epoch, forwarded to `resolveTokenRole` for expiry comparison. Defaults to `Date.now()`.
 * @returns {'owner'|'editor'|'viewer'|null}
 */
export function computeEffectiveRole(sharedProject, uid, presentedToken, now = Date.now()) {
  if (!sharedProject || typeof sharedProject !== 'object') return null;

  if (uid && sharedProject.ownerId && uid === sharedProject.ownerId) {
    return OWNER;
  }

  const collaborators = sharedProject.collaborators;
  const storedRole =
    uid && collaborators && typeof collaborators === 'object' && collaborators[uid]
      ? collaborators[uid].role
      : null;
  const normalizedStoredRole =
    storedRole === SHARE_ROLES.EDITOR || storedRole === SHARE_ROLES.VIEWER ? storedRole : null;

  const tokenRole = presentedToken != null ? resolveTokenRole(sharedProject, presentedToken, now) : null;

  const role = strongerRole(normalizedStoredRole, tokenRole);
  return role || null;
}

/** True if `role` may edit the project's tasks/sections/comments. */
export function canEdit(role) {
  return role === OWNER || role === SHARE_ROLES.EDITOR;
}

/** True if `role` may view the project at all (any resolved role can). */
export function canView(role) {
  return role === OWNER || role === SHARE_ROLES.EDITOR || role === SHARE_ROLES.VIEWER;
}

/** True if `role` may manage sharing (generate/revoke links, change/remove collaborators) — owner only. */
export function canManageSharing(role) {
  return role === OWNER;
}

/**
 * Which specific link (if any) `token` targets, for diagnostics only — used
 * so `planCollaboratorJoin` can tell a UI "this link expired" apart from
 * "this token has never been valid." Not exported: `resolveTokenRole` stays
 * the one source of truth for the actual access decision, per the "no
 * partial/fallback access" rule — a caller could otherwise be tempted to
 * treat "matched but disabled" as some lesser form of access.
 */
function diagnoseTokenFailure(sharedProject, token, now) {
  const links = sharedProject?.links;
  if (!links || typeof links !== 'object' || !isPresentableToken(token)) return 'invalid_token';

  const editResult = evaluateLink(links.edit, token, now);
  if (editResult !== 'invalid_token') return editResult === 'ok' ? null : editResult;

  const viewResult = evaluateLink(links.view, token, now);
  if (viewResult !== 'invalid_token') return viewResult === 'ok' ? null : viewResult;

  return 'invalid_token';
}

/**
 * Decide the write a client should perform when a visitor "joins" a shared
 * project via a link — a pure descriptor so the actual Firestore write is a
 * dumb application of an already-tested decision, per Phase 0's security
 * requirement of no partial/fallback access. Rejects outright (does not
 * return a collaboratorEntry) when the token resolves to no role, with a
 * `reason` distinguishing WHY (`'link_expired'` vs `'link_disabled'` vs
 * `'invalid_token'`) so the UI can render a specific, friendly state (e.g.
 * "this link has expired") instead of a generic failure.
 *
 * Note: this only ever computes a role to WRITE into `collaborators`; it does
 * not itself decide precedence against an existing stored role beyond what
 * `computeEffectiveRole` already encodes (join is always "at least as strong
 * as before") — critically, an EXISTING collaborator is unaffected by their
 * originally-used link later expiring (see `computeEffectiveRole`'s doc
 * comment); expiry only blocks a NEW join or role upgrade via that token.
 *
 * THIS IS THE JOIN ENDPOINT'S OWN FUNCTION, NOT SOMETHING TO CALL FROM
 * BROWSER CODE WITH A CLIENT-READ PROJECT: `sharedProject.links` must be the
 * server-side join endpoint's privileged read of `sharedProjects/
 * {projectId}/private/links` (see this file's header comment). The endpoint
 * calls this to decide whether to mint the `joinToken` auth claim and write
 * a `collaborators` entry; a client never has (or needs) direct access to
 * `links` to make this decision itself.
 * @param {{ownerId?: string, collaborators?: Record<string, {role?: string}>, links?: object}} sharedProject
 * @param {string} uid
 * @param {string} [displayName]
 * @param {string|null} [photoURL]
 * @param {string} presentedToken
 * @param {string} [now] - ISO datetime for `joinedAt`; caller-supplied so this stays deterministic/testable.
 *   Also used (parsed to millis) for link-expiry comparison, so a single injected "now" drives both.
 * @returns {{allowed: boolean, reason?: string, role: string|null, collaboratorEntry?: {role: string, displayName: string, photoURL: string|null, joinedAt: string}}}
 */
export function planCollaboratorJoin({ sharedProject, uid, displayName, photoURL, presentedToken, now }) {
  if (!uid || typeof uid !== 'string') {
    return { allowed: false, reason: 'missing_uid', role: null };
  }

  const nowIso = now || new Date().toISOString();
  const nowMillis = now ? new Date(now).getTime() : Date.now();

  const role = computeEffectiveRole(sharedProject, uid, presentedToken, nowMillis);
  if (!canView(role)) {
    const reason = diagnoseTokenFailure(sharedProject, presentedToken, nowMillis) || 'invalid_token';
    return { allowed: false, reason, role: null };
  }
  // Owner never needs (or gets) a collaborator entry written for themselves.
  if (role === OWNER) {
    return { allowed: false, reason: 'already_owner', role };
  }

  return {
    allowed: true,
    role,
    collaboratorEntry: {
      role,
      displayName: displayName || 'Anonymous',
      photoURL: photoURL || null,
      joinedAt: nowIso,
    },
  };
}

/**
 * Decide whether an ownership-transfer write is allowed, mirroring
 * firestore.rules' `isTransferringOwnership()` (see firestore.rules) so the
 * client can pre-validate and show a clear reason before ever attempting the
 * write. Rules remain the actual enforcement boundary; this exists so a bad
 * attempt fails fast with a specific `reason` instead of a generic
 * permission-denied.
 *
 * Rules mirrored here:
 * - Only the current owner may initiate a transfer.
 * - The recipient must ALREADY be a collaborator on this project — ownership
 *   can never be pushed onto an arbitrary uid who never joined.
 * - The recipient must not be anonymous — an anonymous visitor has no durable
 *   identity to own a project with (it vanishes when they clear storage,
 *   leaving the project unowned: nobody able to delete it, rotate its links,
 *   or manage collaborators). This is read from `isAnonymous` on the
 *   recipient's collaborator entry, which `firestore.rules` sets at join time
 *   from the joiner's own verified `sign_in_provider` claim and rejects if
 *   self-declared wrongly — so it's trustworthy rather than client-asserted.
 *   An `isAnonymousUid(uid)` predicate may be injected to override that lookup
 *   (e.g. backed by Firebase's own `providerData`). If the entry has no
 *   `isAnonymous` field at all — only possible for a pre-hardening record —
 *   the recipient is treated as non-anonymous, matching the rules' own
 *   `!= true` comparison so client and server agree.
 *
 *   NOTE: this restriction was, for a while, enforced ONLY here while
 *   `firestore.rules` merely claimed it in a comment — a security review
 *   caught that gap. It's now enforced in the rules too (see their
 *   `recipientIsRealAccount`), which is the actual boundary; this function
 *   exists to fail fast with a specific reason, not to be the guard.
 * - Transferring to yourself is rejected as a no-op, not silently allowed.
 * - The outgoing owner is retained as an `editor`, never dropped entirely.
 * @param {{ownerId?: string, collaborators?: Record<string, {role?: string, isAnonymous?: boolean}>}} sharedProject
 * @param {string} actingUid - The uid attempting to initiate the transfer.
 * @param {string} recipientUid - The uid to become the new owner.
 * @param {(uid: string) => boolean} [isAnonymousUid] - Optional predicate; falls back to the recipient's
 *   own `collaborators[recipientUid].isAnonymous` flag if omitted.
 * @returns {{allowed: boolean, reason?: string, newOwnerId?: string, collaboratorUpdates?: Record<string, {role: string}>}}
 */
export function planOwnershipTransfer({ sharedProject, actingUid, recipientUid, isAnonymousUid }) {
  if (!sharedProject || typeof sharedProject !== 'object') {
    return { allowed: false, reason: 'invalid_project' };
  }
  if (!actingUid || typeof actingUid !== 'string') {
    return { allowed: false, reason: 'missing_acting_uid' };
  }
  if (!recipientUid || typeof recipientUid !== 'string') {
    return { allowed: false, reason: 'missing_recipient_uid' };
  }
  if (sharedProject.ownerId !== actingUid) {
    return { allowed: false, reason: 'not_owner' };
  }
  if (recipientUid === actingUid) {
    return { allowed: false, reason: 'self_transfer' };
  }

  const collaborators = sharedProject.collaborators;
  const recipientEntry =
    collaborators && typeof collaborators === 'object' ? collaborators[recipientUid] : null;
  if (!recipientEntry) {
    return { allowed: false, reason: 'recipient_not_collaborator' };
  }

  const recipientIsAnonymous =
    typeof isAnonymousUid === 'function' ? isAnonymousUid(recipientUid) : !!recipientEntry.isAnonymous;
  if (recipientIsAnonymous) {
    return { allowed: false, reason: 'recipient_anonymous' };
  }

  // The recipient's own collaborator entry must be REMOVED as part of the same
  // write: once they're `ownerId`, `collaborators[them]` is a stale duplicate
  // of their access, and `Collaborator`/`SharedProject` document the owner as
  // deliberately absent from the map (see src/types/index.js). Leaving it
  // behind is invisible day-to-day — `computeEffectiveRole` checks `ownerId`
  // first and returns early — but would make a LATER transfer away from this
  // owner see them as "already a collaborator" and mis-authorize it, so the
  // removal is returned explicitly rather than left implied.
  //
  // firestore.rules' `isTransferringOwnership` permits this: it checks
  // `incoming().ownerId in existing().collaborators` — the PRE-write map — so
  // dropping the recipient's entry in the same write still satisfies the
  // "recipient must already be a collaborator" requirement.
  const nextCollaborators = { ...collaborators };
  delete nextCollaborators[recipientUid];
  nextCollaborators[actingUid] = { ...collaborators[actingUid], role: SHARE_ROLES.EDITOR };

  return {
    allowed: true,
    newOwnerId: recipientUid,
    // The complete intended `collaborators` map after the transfer — apply as
    // a whole-field write, not a merge (a merge can't express the removal).
    collaborators: nextCollaborators,
    // Retained for callers that only need the changed entry; does NOT express
    // the recipient's removal, so prefer `collaborators` above.
    collaboratorUpdates: {
      [actingUid]: { ...collaborators[actingUid], role: SHARE_ROLES.EDITOR },
    },
  };
}

/**
 * True if `project` (the app-local Project shape, src/types/index.js) points
 * at a shared-project doc rather than living purely in the personal
 * `users/{uid}` store. More than a one-line field check would suggest: kept
 * as its own function (rather than inlined `!!project.sharedProjectId`
 * everywhere) so every list/badge surface that needs "is this shared" agrees
 * on the same definition even as the underlying field/shape evolves (e.g. if
 * a legacy/partially-migrated project ever has a stale `sharedProjectId`
 * without `ownerId`, this is the one place that'd need updating).
 * @param {{ownerId?: string, sharedProjectId?: string}} project
 * @returns {boolean}
 */
export function isSharedProject(project) {
  return !!project && typeof project === 'object' && typeof project.sharedProjectId === 'string' && project.sharedProjectId.length > 0;
}

/**
 * The three mutually-exclusive sharing states a project can be in, as far as
 * ANY project-listing surface (sidebar, List header, ManageProjectsModal,
 * search dropdown, etc.) needs to render — see this module's `isSharedProject`
 * and the `Project` typedef in `src/types/index.js` for the full writeup of
 * why this is a 3-way discriminant and not a boolean `isShared` flag: a
 * boolean can't tell "you own this and shared it" apart from "someone else
 * shared it with you", which is exactly the direction users need to see.
 * @typedef {'personal'|'shared-by-me'|'shared-with-me'} ProjectShareState
 */

/**
 * Decide which of the three sharing states a project is in, and return just
 * enough detail for a badge/list row to render itself without re-deriving
 * the same fields — this is the one place every surface should call rather
 * than re-comparing `ownerId`/`uid` inline (see this file's `isSharedProject`
 * for the same reasoning applied to a simpler yes/no question).
 *
 * Pure and side-effect-free, like the rest of this module. Safe to call with
 * an ordinary CLIENT-read `sharedProject` (unlike `resolveTokenRole`/
 * `computeEffectiveRole`'s `links`-bearing callers) — this only ever reads
 * `ownerId`/`collaborators`, both of which ARE present on the client-readable
 * `sharedProjects/{id}` document (see its typedef's "DELIBERATELY DOES NOT
 * HAVE a `links` FIELD" note — everything else on that doc is fine to read).
 *
 * Edge cases, all treated as "no crash, no false badge":
 * - No uid (signed out): a shared project can't resolve a role for nobody,
 *   so this degrades to `'personal'` — there is no meaningful "shared with
 *   you" without an identity to check membership against, and showing
 *   'shared-by-me' would be actively wrong (we don't know that either).
 * - `project` isn't shared at all (`isSharedProject` false): always
 *   `'personal'`, regardless of whether a `sharedProject`/`uid` was passed.
 * - Shared, but the live `sharedProjects` doc hasn't loaded yet (`onSnapshot`
 *   hasn't delivered its first snapshot) or a stale `sharedProjectId` points
 *   at nothing (deleted, or never existed): `sharedProject` is
 *   null/undefined here, so this returns `'personal'` rather than guessing a
 *   direction — a badge that can't say WHO owns it or what role you have is
 *   worse than temporarily no badge, and the real state reappears the
 *   instant the snapshot arrives.
 * - Anonymous collaborator (`isAnonymous: true` on their own entry): resolves
 *   exactly like any other collaborator — `isAnonymous` only matters to
 *   `planOwnershipTransfer`, not to which of the three states applies here.
 * @param {{sharedProjectId?: string}} project - The app-local Project (src/types/index.js).
 * @param {{ownerId?: string, collaborators?: Record<string, {role?: string, displayName?: string, photoURL?: string|null}>}|null|undefined} sharedProject
 *   The live `sharedProjects/{id}` doc for `project.sharedProjectId` (e.g. `sharedProjects[project.sharedProjectId]`
 *   from `useScheduler()`), or null/undefined if not yet loaded / not found.
 * @param {string|null|undefined} uid - The current user's Firebase uid, or null/undefined if signed out.
 * @returns {
 *   {state: 'personal'}
 *   | {state: 'shared-by-me', collaboratorCount: number, collaborators: Array<{uid: string, displayName: string, photoURL: string|null, role: string}>}
 *   | {state: 'shared-with-me', ownerId: string, role: 'editor'|'viewer'}
 * }
 */
export function getProjectShareState(project, sharedProject, uid) {
  if (!isSharedProject(project) || !sharedProject || typeof sharedProject !== 'object') {
    return { state: 'personal' };
  }

  const ownerId = sharedProject.ownerId;
  if (!uid || !ownerId) {
    return { state: 'personal' };
  }

  const collaboratorsMap =
    sharedProject.collaborators && typeof sharedProject.collaborators === 'object' ? sharedProject.collaborators : {};

  if (uid === ownerId) {
    const collaborators = Object.entries(collaboratorsMap).map(([collabUid, entry]) => ({
      uid: collabUid,
      displayName: entry?.displayName || 'Anonymous',
      photoURL: entry?.photoURL ?? null,
      role: entry?.role,
    }));
    return { state: 'shared-by-me', collaboratorCount: collaborators.length, collaborators };
  }

  const myEntry = collaboratorsMap[uid];
  const role = myEntry?.role === SHARE_ROLES.EDITOR || myEntry?.role === SHARE_ROLES.VIEWER ? myEntry.role : SHARE_ROLES.VIEWER;
  return { state: 'shared-with-me', ownerId, role };
}

/**
 * Resolve the best available display name/photo for a shared project's
 * OWNER, in priority order:
 *   1. The denormalized `ownerDisplayName`/`ownerPhotoURL` on the
 *      `sharedProjects/{id}` doc itself (written at create time by
 *      `createSharedProject`, and kept current across an ownership transfer
 *      by `transferSharedProjectOwnership` — see both in
 *      sharedProjectService.js). Durable: available whether or not the owner
 *      is currently online.
 *   2. Live presence (`viewersByProject`/`activeViewers`-shaped list) — only
 *      populated while the owner has the project open, kept as a fallback
 *      for shared-project docs that predate this field (no migration; an old
 *      doc simply lacks it and this falls through).
 *   3. A generic label, so callers never render nothing.
 *
 * Pure — takes plain data, no Firebase/React imports — so every surface that
 * shows "shared by <name>" (SharedProjectBadge, the comment @-mention list)
 * agrees on one fallback chain instead of three slightly different ones.
 * @param {{ownerDisplayName?: string, ownerPhotoURL?: string|null}|null|undefined} sharedProject
 * @param {Array<{uid: string, displayName?: string, photoURL?: string|null}>|null|undefined} viewers -
 *   The live presence list for this project (e.g. `viewersByProject[projectId]`), if available.
 * @param {string|undefined} ownerId - Needed to pick the owner out of `viewers`.
 * @returns {{displayName: string, photoURL: string|null}}
 */
export function resolveOwnerProfile(sharedProject, viewers, ownerId) {
  if (sharedProject?.ownerDisplayName) {
    return { displayName: sharedProject.ownerDisplayName, photoURL: sharedProject.ownerPhotoURL ?? null };
  }
  const ownerViewer = Array.isArray(viewers) ? viewers.find((v) => v.uid === ownerId) : null;
  if (ownerViewer?.displayName) {
    return { displayName: ownerViewer.displayName, photoURL: ownerViewer.photoURL ?? null };
  }
  return { displayName: 'Project owner', photoURL: null };
}

/**
 * Generate an unguessable share-link token: 22 URL-safe base64 characters
 * from 16 cryptographically random bytes (128 bits of entropy) — long enough
 * that brute-forcing a link is infeasible, short enough to fit cleanly in a
 * `?join=` query param. Uses `crypto.getRandomValues`, NOT `Math.random`
 * (which is not cryptographically secure and must never back an access
 * token). This is the one function in this module with a side effect
 * (randomness) — kept isolated here so every decision function above stays
 * pure and deterministically testable.
 * @returns {string}
 */
export function generateShareToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa -> URL-safe base64 (RFC 4648 §5), trailing '=' padding stripped since
  // 16 bytes never needs it to round-trip losslessly as an opaque token.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

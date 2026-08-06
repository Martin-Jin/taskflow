/**
 * ============================================================================
 * JOIN FLOW — pure logic for the `?join=<token>` share-link landing
 * ============================================================================
 * Collaborative Projects, Phase 2. Everything here is pure and side-effect
 * free EXCEPT the two localStorage helpers at the bottom (kept together, and
 * apart from the decisions, for the same reason `generateShareToken` is
 * isolated in sharedProjectAccess.js: the decisions stay deterministically
 * unit-testable).
 *
 * WHY A QUERY PARAM AND NOT A ROUTE
 * ---------------------------------
 * This app deliberately has no router — App.jsx is a `useState` tab switch
 * (see its header comment). Share links are therefore `?join=<token>` on the
 * existing single page, read once on mount and stripped with
 * `history.replaceState` immediately afterwards. Stripping matters for more
 * than tidiness:
 *   - the token is a SECRET, and a URL bar is the most over-the-shoulder-
 *     readable, most-likely-to-be-screenshotted, most-likely-to-be-pasted-
 *     into-a-chat surface in the browser;
 *   - a lingering param re-triggers the whole join on every reload, and
 *     survives being bookmarked;
 *   - `Referer` headers leak query strings to third parties on outbound
 *     navigation.
 * Stripping is `replaceState`, not `pushState`, so the token isn't left
 * sitting one Back-button press away in session history either.
 *
 * WHY THE DISPLAY NAME IS CACHED PER TOKEN, NOT GLOBALLY
 * -----------------------------------------------------
 * An anonymous visitor is prompted once for a display name (Phase 0/2 spec).
 * That name is cached against the specific link they used rather than as one
 * global "your name", because one browser can hold several unrelated
 * anonymous memberships — a name chosen for a work board is not necessarily
 * the name to reuse on an unrelated one, and silently reusing it across
 * projects would disclose to project B what someone called themselves in
 * project A. Per CLAUDE.md's backup rules this is deliberately device-local
 * and NOT in BACKUP_FIELDS: an anonymous identity is tied to one browser's
 * Firebase Anonymous Auth uid and cannot meaningfully be restored elsewhere.
 * ============================================================================
 */

import { loadPersisted, savePersisted } from './persistence';

/** The query parameter a share link carries. */
export const JOIN_PARAM = 'join';

/**
 * Every distinct outcome the join flow can reach, so callers switch on a
 * known set rather than string-matching messages. The `*_link` reasons come
 * straight from the server's resolve endpoint (which mirrors
 * sharedProjectAccess.js's `planCollaboratorJoin` reasons) — they're
 * deliberately distinguishable so the UI can say "this link expired" rather
 * than an opaque failure, which is the difference between a user re-asking
 * the owner for a fresh link and assuming the app is broken.
 */
export const JOIN_STATUS = {
  IDLE: 'idle',
  RESOLVING: 'resolving',
  NEEDS_NAME: 'needs_name',
  JOINING: 'joining',
  SUCCESS: 'success',
  ALREADY_MEMBER: 'already_member',
  INVALID_TOKEN: 'invalid_token',
  LINK_EXPIRED: 'link_expired',
  LINK_DISABLED: 'link_disabled',
  ERROR: 'error',
};

/**
 * Extract the join token from a URL's query string.
 *
 * Returns null rather than an empty string for anything unusable, so callers
 * have exactly one falsy case to test. Length is sanity-capped: a real token
 * is 22 URL-safe base64 chars (see `generateShareToken`), so anything wildly
 * longer is a malformed or hand-crafted URL and is rejected before it reaches
 * the network — there's no point sending a megabyte of query string to the
 * resolve endpoint to be told no.
 * @param {string} [search] - A location.search-style string ('?join=abc'). Defaults to window.location.search.
 * @returns {string|null}
 */
export function readJoinToken(search) {
  const raw = search != null ? search : typeof window !== 'undefined' ? window.location.search : '';
  if (!raw || typeof raw !== 'string') return null;
  let token;
  try {
    token = new URLSearchParams(raw).get(JOIN_PARAM);
  } catch {
    return null; // Malformed query string — not worth distinguishing from absent.
  }
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

/**
 * The current URL with the join param removed, preserving every other param
 * and the hash. Returned as a string for `history.replaceState` rather than
 * applied here, so this stays pure and the caller owns the one side effect.
 *
 * Note the path is kept exactly as-is: this app is served from a project
 * subpath on GitHub Pages, so reconstructing from '/' would navigate away.
 * @param {string} [href] - Defaults to window.location.href.
 * @returns {string}
 */
export function urlWithoutJoinParam(href) {
  const raw = href != null ? href : typeof window !== 'undefined' ? window.location.href : '';
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has(JOIN_PARAM)) return raw;
    url.searchParams.delete(JOIN_PARAM);
    // URL#search keeps a lone '?' when the last param is removed; drop it so
    // the cleaned URL is byte-identical to one that never carried a token.
    return url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
  } catch {
    return raw;
  }
}

/**
 * Build the shareable URL for a token, from the app's current location.
 *
 * Deliberately drops any existing query string and hash: a share link is
 * pasted into chats and emails, so it must be the clean canonical entry point
 * to the app, not a snapshot of whatever transient view state the owner
 * happened to have open when they clicked "copy link".
 * @param {string} token
 * @param {string} [origin] - Defaults to window.location.origin.
 * @param {string} [pathname] - Defaults to window.location.pathname.
 * @returns {string}
 */
export function buildShareUrl(token, origin, pathname) {
  const base = origin != null ? origin : typeof window !== 'undefined' ? window.location.origin : '';
  const path = pathname != null ? pathname : typeof window !== 'undefined' ? window.location.pathname : '/';
  return `${base}${path}?${JOIN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Decide what the join flow should do next, given who's signed in and what
 * the server said about the token. Pure, so the (fiddly, several-branched)
 * sequencing is testable without a browser or Firebase.
 *
 * The ordering encodes two rules worth stating explicitly:
 *
 * 1. AN ALREADY-JOINED PROJECT IS A SUCCESS, NOT A RE-JOIN. Re-opening a link
 *    you've already used is the common case (people re-click the link in the
 *    chat rather than finding the project in their sidebar), and it must not
 *    rewrite the collaborator entry — a re-join write would reset `joinedAt`
 *    and, worse, could DOWNGRADE an editor who was later promoted, or one who
 *    joined by the edit link but clicked a view link this time. Existing
 *    membership is a floor (see `computeEffectiveRole`'s upgrade/downgrade
 *    rule), so "already a member at a role at least this strong" short-
 *    circuits to just opening the project.
 * 2. A NAME IS ONLY ASKED OF ANONYMOUS VISITORS WHO DON'T HAVE ONE CACHED.
 *    A signed-in user already has a real displayName; prompting them for
 *    another would be noise, and would let them present a name that doesn't
 *    match the identity their edits are attributed to.
 *
 * @param {object} params
 * @param {{role?: string, projectId?: string}|null} params.resolution - The resolve endpoint's success payload.
 * @param {{uid?: string, isAnonymous?: boolean, displayName?: string}|null} params.user - Current Firebase user, if any.
 * @param {string|null} [params.cachedName] - Previously cached anonymous name for this token.
 * @param {{ownerId?: string, collaborators?: Record<string, {role?: string}>}|null} [params.sharedProject] - The project doc, if already known.
 * @returns {{action: 'prompt_name'|'write_membership'|'open_project', displayName?: string}}
 */
export function planJoinStep({ resolution, user, cachedName, sharedProject }) {
  const uid = user?.uid;

  // Rule 1 — already in (or the owner of) this project.
  if (uid && sharedProject) {
    if (sharedProject.ownerId === uid) return { action: 'open_project' };
    const existing = sharedProject.collaborators?.[uid];
    // Only short-circuit when the stored role is at least as strong as the
    // one this link grants; a viewer clicking an EDIT link is a legitimate
    // upgrade and must still write.
    if (existing?.role === 'editor' || (existing?.role === 'viewer' && resolution?.role !== 'editor')) {
      return { action: 'open_project' };
    }
  }

  // Rule 2 — anonymous visitors need a name before they can be written into
  // `collaborators` (the rules require a non-empty displayName on the entry).
  if (user?.isAnonymous) {
    const name = (cachedName || '').trim();
    if (!name) return { action: 'prompt_name' };
    return { action: 'write_membership', displayName: name };
  }

  return {
    action: 'write_membership',
    displayName: (user?.displayName || '').trim() || 'Someone',
  };
}

/**
 * Map a resolve-endpoint failure reason onto a JOIN_STATUS. Anything
 * unrecognized collapses to INVALID_TOKEN rather than ERROR: from the
 * visitor's point of view an unusable link is an unusable link, and inventing
 * a distinction the server didn't make would be guessing. ERROR is reserved
 * for the request itself failing (offline, 500), which IS worth telling them
 * apart because retrying might work.
 * @param {string} [reason]
 * @returns {string} a JOIN_STATUS value
 */
export function joinStatusForReason(reason) {
  switch (reason) {
    case 'link_expired':
      return JOIN_STATUS.LINK_EXPIRED;
    case 'link_disabled':
      return JOIN_STATUS.LINK_DISABLED;
    case 'already_owner':
      return JOIN_STATUS.ALREADY_MEMBER;
    default:
      return JOIN_STATUS.INVALID_TOKEN;
  }
}

// ---------------------------------------------------------------------------
// Device-local cache of an anonymous visitor's chosen display name.
// The only impure functions in this module (see the header).
// ---------------------------------------------------------------------------

/**
 * Keyed by token so unrelated memberships don't share a name — see the header
 * comment. One flat object under a single persistence key rather than a key
 * per token, so it's inspectable and clearable as a unit.
 */
const ANON_NAMES_KEY = 'anonJoinNames';

/**
 * Both helpers below take an optional `storage` pair, defaulting to the real
 * persistence layer. That's not speculative indirection: the unit suite runs
 * in Vitest's `node` environment (vitest.config.js), where there is no
 * `window.localStorage` at all, and these two functions are the only reason
 * this module would otherwise need jsdom pulled in as a dependency. Injecting
 * the two calls keeps the tests honest about behaviour (they exercise the
 * real merge/trim logic against a plain object) without the whole suite
 * paying for a DOM.
 * @typedef {{load: (key: string, fallback: *) => *, save: (key: string, value: *) => void}} JoinNameStorage
 */
const defaultStorage = { load: loadPersisted, save: savePersisted };

/**
 * The cached display name this browser used for `token`, or null.
 * @param {string} token
 * @param {JoinNameStorage} [storage]
 */
export function loadCachedJoinName(token, storage = defaultStorage) {
  if (!token) return null;
  const all = storage.load(ANON_NAMES_KEY, null);
  if (!all || typeof all !== 'object') return null;
  const name = all[token];
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Remember `displayName` for `token` so a return visit skips the prompt.
 * @param {string} token
 * @param {string} displayName
 * @param {JoinNameStorage} [storage]
 */
export function saveCachedJoinName(token, displayName, storage = defaultStorage) {
  if (!token || typeof displayName !== 'string' || !displayName.trim()) return;
  const all = storage.load(ANON_NAMES_KEY, null);
  const next = all && typeof all === 'object' ? { ...all } : {};
  next[token] = displayName.trim();
  storage.save(ANON_NAMES_KEY, next);
}

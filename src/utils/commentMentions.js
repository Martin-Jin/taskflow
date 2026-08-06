/**
 * ============================================================================
 * COMMENT MENTIONS — pure logic for @-mentioning collaborators in a shared
 * task's comment thread (Collaborative Projects, Phase 3).
 * ============================================================================
 * Deliberately separate from useMentionAutocomplete.js/findActiveSpan, which
 * drives the TITLE field's "@label" / "#project" shorthand: that inserts the
 * literal label/project NAME as plain text (there's nothing else a label
 * could stably reference), whereas a comment mention must insert a STABLE
 * uid reference so a later display-name change doesn't retroactively break
 * or silently re-target it. Stored comment text therefore holds a mention as
 * `@[Display Name](uid)` — parseable back into segments for rendering
 * (parseCommentBody) without needing a second, separate "mentions map" field
 * alongside `text` just to know which uid a rendered "@Name" refers to.
 * `Comment.mentions` (types/index.js) is still stored alongside this,
 * derived by extractMentionUids — it exists purely to drive the Phase 4
 * notification fan-out cheaply (a flat uid list), not to help render.
 *
 * No React, no Firebase — see fuzzyKeyword.js/nameSearch.js for the sibling
 * pure modules this mirrors.
 * ============================================================================
 */

/**
 * Matches one stored mention token: `@[Name with any chars but ']'](uid)`.
 * `uid`s are Firebase uids (alphanumerics), so excluding ')' from that group
 * is enough to keep this unambiguous.
 */
const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Find the "@query" span the caret currently sits at the end of while
 * composing a NEW comment, e.g. typing "cc @mar|" (caret at the end) ->
 * `{ start: 3, query: 'mar' }`. Mirrors useMentionAutocomplete's
 * findActiveSpan, scoped down to just "@" (a comment body has no
 * "#project" shorthand). Whitespace after the "@" means that span already
 * closed (the user moved on), matching the same rule there.
 * @param {string} text
 * @param {number} caret
 * @returns {{start: number, query: string}|null}
 */
export function findActiveMentionSpan(text, caret) {
  if (caret == null) return null;
  const upToCaret = text.slice(0, caret);
  const lastAt = upToCaret.lastIndexOf('@');
  if (lastAt === -1) return null;
  const query = upToCaret.slice(lastAt + 1);
  if (/\s/.test(query)) return null;
  return { start: lastAt, query };
}

/**
 * Mentionable candidates for a shared task: every collaborator plus the
 * project owner, EXCLUDING anonymous participants (they have no durable
 * identity for a mention to resolve to, or for Phase 4's notification
 * fan-out to reach — see this feature's brief) and the current viewer
 * themselves (mentioning your own comment is never useful).
 *
 * The owner isn't a `collaborators` entry (see SharedProject typedef), so
 * their display name/photo has to be passed in separately — callers should
 * source it from `sharedProjectAccess.js`'s `resolveOwnerProfile` (the
 * denormalized `ownerDisplayName`/`ownerPhotoURL` on the project doc itself,
 * falling back to live presence, then a generic label) rather than
 * re-deriving the same fallback chain here.
 *
 * @param {object} params
 * @param {string} params.ownerId
 * @param {Record<string, {role?: string, displayName?: string, photoURL?: string|null, isAnonymous?: boolean}>} [params.collaborators]
 * @param {string} [params.currentUid] - excluded from the result
 * @param {string} [params.ownerDisplayName] - falls back to 'Project owner'
 * @param {string|null} [params.ownerPhotoURL]
 * @returns {Array<{uid: string, displayName: string, photoURL: string|null}>}
 */
export function getMentionCandidates({ ownerId, collaborators, currentUid, ownerDisplayName, ownerPhotoURL }) {
  const out = [];
  if (ownerId && ownerId !== currentUid) {
    out.push({ uid: ownerId, displayName: ownerDisplayName || 'Project owner', photoURL: ownerPhotoURL || null });
  }
  for (const [uid, entry] of Object.entries(collaborators || {})) {
    if (!uid || uid === currentUid || entry?.isAnonymous) continue;
    out.push({ uid, displayName: entry?.displayName || 'Someone', photoURL: entry?.photoURL || null });
  }
  return out;
}

/** Case-insensitive prefix/substring filter over candidates by displayName — mirrors the simple substring tier of nameSearch's ranking without pulling in its fuzzy tiers, since a mention list is small enough that typo-tolerance isn't worth the surprise of matching the wrong person. */
export function filterMentionCandidates(query, candidates) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return candidates;
  return candidates.filter((c) => c.displayName.toLowerCase().includes(q));
}

/**
 * Splice a chosen candidate into `text` in place of the active "@query"
 * span, producing the stable `@[Name](uid)` token plus a trailing space.
 * Returns the new text and where the caret should land, mirroring
 * useCaretActiveSpan's spliceTextAndMoveCaret contract but as a pure
 * function (no DOM) so it's unit-testable and the caller owns the actual
 * textarea/caret side effects.
 * @param {string} text
 * @param {{start: number, query: string}} span
 * @param {{uid: string, displayName: string}} candidate
 * @param {number} caret - current caret position (end of the query)
 * @returns {{text: string, caret: number}}
 */
export function insertMention(text, span, candidate, caret) {
  const before = text.slice(0, span.start);
  const after = text.slice(caret);
  // displayName is attacker-controlled (Firestore rules cap its length but not
  // its characters) and the token format is purely positional — `]`/`)` closes
  // a segment early and `[`/`(` opens a bogus one, letting a crafted name splice
  // in a fake "](some-other-uid)" and attribute the mention to the wrong person.
  // Strip those 4 characters rather than escaping them, so existing stored
  // tokens and MENTION_TOKEN_RE/parseCommentBody/extractMentionUids don't change.
  const safeName = candidate.displayName.replace(/[[\]()]/g, '');
  const token = `@[${safeName}](${candidate.uid})`;
  const needsTrailingSpace = !/^\s/.test(after);
  const insertion = `${token}${needsTrailingSpace ? ' ' : ''}`;
  return { text: `${before}${insertion}${after}`, caret: before.length + insertion.length };
}

/**
 * Every uid mentioned in a comment body — what gets stored on
 * `Comment.mentions` (types/index.js) to drive Phase 4's notification
 * fan-out without re-parsing the body text later.
 * @param {string} text
 * @returns {string[]} deduplicated, in first-appearance order
 */
export function extractMentionUids(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const uid = match[2];
    if (!seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

/**
 * Narrow a body's raw mention uids to the ones that actually belong to this
 * project's mentionable people. The `@[Name](uid)` token is plain text a user
 * can simply TYPE, so an author could otherwise hand-write a token naming any
 * uid — spoofing a mention of someone who was never mentionable, and (once
 * Phase 4 delivers on `Comment.mentions`) pushing a notification at them.
 * Validating at post time keeps the stored `mentions` list trustworthy for
 * every later reader, rather than making each consumer re-check it.
 *
 * Rendering deliberately does NOT filter: a mention of a since-removed
 * collaborator should still render as the name it was posted with (see
 * parseCommentBody) — this only governs what lands in `Comment.mentions`.
 * @param {string} text
 * @param {Array<{uid: string}>} candidates - from getMentionCandidates
 * @returns {string[]}
 */
export function extractValidMentionUids(text, candidates) {
  const allowed = new Set((candidates || []).map((c) => c.uid));
  return extractMentionUids(text).filter((uid) => allowed.has(uid));
}

/**
 * Parse a stored comment body into renderable segments — plain text runs
 * and mention runs — so the thread can render "@Name" visibly distinct from
 * surrounding text. A mention whose uid no longer resolves to anyone (the
 * collaborator was removed since) still renders using its DENORMALIZED name
 * baked into the token at post time; that's the whole reason the name is
 * embedded in the token rather than looked up live (same "denormalize at
 * post time" reasoning as Comment.authorDisplayName).
 * @param {string} text
 * @returns {Array<{type: 'text', value: string}|{type: 'mention', uid: string, displayName: string}>}
 */
export function parseCommentBody(text) {
  if (!text) return [];
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'mention', uid: match[2], displayName: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

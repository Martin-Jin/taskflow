/**
 * Unit tests for src/utils/commentMentions.js — the pure @-mention logic
 * behind Collaborative Projects Phase 3 (task comments). Covers span
 * detection, candidate filtering (including anonymous exclusion), insertion,
 * and round-tripping a stored body back into renderable segments.
 */

import { describe, expect, it } from 'vitest';
import {
  extractMentionUids,
  extractValidMentionUids,
  filterMentionCandidates,
  findActiveMentionSpan,
  getMentionCandidates,
  insertMention,
  parseCommentBody,
} from '../../src/utils/commentMentions';

describe('findActiveMentionSpan', () => {
  it('finds an in-progress "@query" at the caret', () => {
    const text = 'cc @mar';
    expect(findActiveMentionSpan(text, text.length)).toEqual({ start: 3, query: 'mar' });
  });

  it('detects a bare "@" at the very start of the text', () => {
    const text = '@';
    expect(findActiveMentionSpan(text, 1)).toEqual({ start: 0, query: '' });
  });

  it('detects a mention span that ends the text (caret at end, no trailing space)', () => {
    const text = 'thanks @ali';
    expect(findActiveMentionSpan(text, text.length)).toEqual({ start: 7, query: 'ali' });
  });

  it('returns null once whitespace closes the span', () => {
    // Caret at 7 sits right after the space that closed "@al" — the mention
    // was already finished as its own token, so this is no longer active.
    expect(findActiveMentionSpan('hi @al ready sent', 7)).toBeNull();
  });

  it('returns null when there is no "@" at all', () => {
    expect(findActiveMentionSpan('no mentions here', 5)).toBeNull();
  });

  it('returns null when caret is null/undefined', () => {
    expect(findActiveMentionSpan('@abc', null)).toBeNull();
    expect(findActiveMentionSpan('@abc', undefined)).toBeNull();
  });

  it('uses the LAST "@" before the caret when there are multiple', () => {
    const text = '@alice and @bob';
    expect(findActiveMentionSpan(text, text.length)).toEqual({ start: 11, query: 'bob' });
  });

  it('is anchored to the caret position, not the end of the string', () => {
    // Caret sits right after "@al", even though more text follows.
    const text = '@alice hello';
    expect(findActiveMentionSpan(text, 3)).toEqual({ start: 0, query: 'al' });
  });
});

describe('getMentionCandidates', () => {
  const collaborators = {
    editorUid: { role: 'editor', displayName: 'Edie Editor', photoURL: 'https://x/e.png' },
    viewerUid: { role: 'viewer', displayName: 'Vic Viewer', photoURL: null },
    anonUid: { role: 'viewer', displayName: 'Guest123', isAnonymous: true },
  };

  it('includes the owner plus every non-anonymous collaborator', () => {
    const candidates = getMentionCandidates({ ownerId: 'ownerUid', collaborators, currentUid: 'someoneElse' });
    const uids = candidates.map((c) => c.uid);
    expect(uids).toContain('ownerUid');
    expect(uids).toContain('editorUid');
    expect(uids).toContain('viewerUid');
  });

  it('excludes anonymous collaborators — they have no durable identity to notify', () => {
    const candidates = getMentionCandidates({ ownerId: 'ownerUid', collaborators, currentUid: 'someoneElse' });
    expect(candidates.some((c) => c.uid === 'anonUid')).toBe(false);
  });

  it('excludes the current viewer from their own candidate list', () => {
    const candidates = getMentionCandidates({ ownerId: 'ownerUid', collaborators, currentUid: 'editorUid' });
    expect(candidates.some((c) => c.uid === 'editorUid')).toBe(false);
  });

  it('excludes the owner from their own list when they are the current viewer', () => {
    const candidates = getMentionCandidates({ ownerId: 'ownerUid', collaborators, currentUid: 'ownerUid' });
    expect(candidates.some((c) => c.uid === 'ownerUid')).toBe(false);
  });

  it('falls back to a generic owner label when no display name is supplied', () => {
    const candidates = getMentionCandidates({ ownerId: 'ownerUid', collaborators: {}, currentUid: 'x' });
    expect(candidates).toEqual([{ uid: 'ownerUid', displayName: 'Project owner', photoURL: null }]);
  });

  it('uses a supplied owner display name/photo (e.g. from presence) when given', () => {
    const candidates = getMentionCandidates({
      ownerId: 'ownerUid',
      collaborators: {},
      currentUid: 'x',
      ownerDisplayName: 'Olivia Owner',
      ownerPhotoURL: 'https://x/o.png',
    });
    expect(candidates[0]).toEqual({ uid: 'ownerUid', displayName: 'Olivia Owner', photoURL: 'https://x/o.png' });
  });

  it('handles a missing/empty collaborators map', () => {
    expect(getMentionCandidates({ ownerId: 'ownerUid', collaborators: undefined, currentUid: 'x' })).toHaveLength(1);
  });
});

describe('filterMentionCandidates', () => {
  const candidates = [
    { uid: '1', displayName: 'Alice', photoURL: null },
    { uid: '2', displayName: 'Bob', photoURL: null },
    { uid: '3', displayName: 'Alicia', photoURL: null },
  ];

  it('returns everyone for an empty query', () => {
    expect(filterMentionCandidates('', candidates)).toEqual(candidates);
  });

  it('filters case-insensitively by substring', () => {
    expect(filterMentionCandidates('ali', candidates).map((c) => c.uid)).toEqual(['1', '3']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterMentionCandidates('zzz', candidates)).toEqual([]);
  });
});

describe('insertMention', () => {
  it('splices the stable-uid token in place of the active span, with a trailing space', () => {
    const text = 'cc @mar';
    const span = { start: 3, query: 'mar' };
    const candidate = { uid: 'uid123', displayName: 'Marta' };
    const result = insertMention(text, span, candidate, text.length);
    expect(result.text).toBe('cc @[Marta](uid123) ');
    expect(result.caret).toBe(result.text.length);
  });

  it('does not add a second space if one already follows the span', () => {
    const text = '@mar already has a space after';
    const span = { start: 0, query: 'mar' };
    const caret = 4; // right after "mar"
    const candidate = { uid: 'uid1', displayName: 'Marcus' };
    const result = insertMention(text, span, candidate, caret);
    expect(result.text).toBe('@[Marcus](uid1) already has a space after');
  });

  it('preserves text before and after the span', () => {
    const text = 'hello @bo world';
    const span = { start: 6, query: 'bo' };
    const caret = 9;
    const result = insertMention(text, span, { uid: 'u', displayName: 'Bob' }, caret);
    expect(result.text).toBe('hello @[Bob](u) world');
  });

  // A displayName is attacker-controlled (Firestore rules cap its length but
  // not its characters), and the token format is purely positional — a `]`
  // or `)` in the name can close the name/uid segment early, and a `[` or `(`
  // can open a bogus new one, splicing in a fake uid that isn't the mentioned
  // candidate's. These assert the token always parses back to exactly one
  // mention, attributed to the real candidate uid, no matter what's in the name.
  it('strips "]" from a display name so it cannot close the name segment early', () => {
    const text = '@x';
    const span = { start: 0, query: 'x' };
    const candidate = { uid: 'attacker-uid', displayName: 'Evil](victim-uid)x' };
    const result = insertMention(text, span, candidate, text.length);
    expect(extractMentionUids(result.text)).toEqual(['attacker-uid']);
    expect(parseCommentBody(result.text).filter((s) => s.type === 'mention')).toEqual([
      { type: 'mention', uid: 'attacker-uid', displayName: 'Evilvictim-uidx' },
    ]);
  });

  it('strips "(" and ")" from a display name so it cannot open/close a bogus uid segment', () => {
    const text = '@x';
    const span = { start: 0, query: 'x' };
    const candidate = { uid: 'attacker-uid', displayName: 'Name(victim-uid)' };
    const result = insertMention(text, span, candidate, text.length);
    expect(extractMentionUids(result.text)).toEqual(['attacker-uid']);
    expect(parseCommentBody(result.text).filter((s) => s.type === 'mention')).toEqual([
      { type: 'mention', uid: 'attacker-uid', displayName: 'Namevictim-uid' },
    ]);
  });

  it('strips all of "[]()" together — the proven exploit payload', () => {
    const text = '@x';
    const span = { start: 0, query: 'x' };
    const candidate = { uid: 'attacker-uid', displayName: 'Evil](victim-uid-999)x [Innocent' };
    const result = insertMention(text, span, candidate, text.length);
    expect(extractMentionUids(result.text)).toEqual(['attacker-uid']);
    const mentions = parseCommentBody(result.text).filter((s) => s.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toEqual({ type: 'mention', uid: 'attacker-uid', displayName: 'Evilvictim-uid-999x Innocent' });
  });
});

describe('extractValidMentionUids', () => {
  const candidates = [
    { uid: 'owner1', displayName: 'Owner' },
    { uid: 'editor1', displayName: 'Editor' },
  ];

  it('keeps mentions of real project members', () => {
    expect(extractValidMentionUids('hi @[Owner](owner1)', candidates)).toEqual(['owner1']);
  });

  // The token is plain text, so an author can type one naming any uid at all.
  // Without this filter that uid would land in Comment.mentions and (Phase 4)
  // get notified, despite never being mentionable in this project.
  it('drops a hand-typed mention naming a uid that is not a member', () => {
    expect(extractValidMentionUids('hi @[Admin](stranger-uid)', candidates)).toEqual([]);
  });

  it('keeps only the valid uids from a mix', () => {
    const text = '@[Owner](owner1) and @[Ghost](nope) and @[Editor](editor1)';
    expect(extractValidMentionUids(text, candidates)).toEqual(['owner1', 'editor1']);
  });

  it('returns an empty array when there are no candidates', () => {
    expect(extractValidMentionUids('@[Owner](owner1)', [])).toEqual([]);
    expect(extractValidMentionUids('@[Owner](owner1)', undefined)).toEqual([]);
  });
});

describe('extractMentionUids', () => {
  it('returns an empty array for text with no mentions', () => {
    expect(extractMentionUids('just a normal comment')).toEqual([]);
  });

  it('extracts a single mention uid', () => {
    expect(extractMentionUids('hey @[Marta](uid123) check this out')).toEqual(['uid123']);
  });

  it('extracts multiple mentions in order, deduplicated', () => {
    const text = '@[Alice](a1) and @[Bob](b1) and @[Alice](a1) again';
    expect(extractMentionUids(text)).toEqual(['a1', 'b1']);
  });

  it('handles empty/null input', () => {
    expect(extractMentionUids('')).toEqual([]);
    expect(extractMentionUids(null)).toEqual([]);
    expect(extractMentionUids(undefined)).toEqual([]);
  });
});

describe('parseCommentBody', () => {
  it('returns a single text segment when there are no mentions', () => {
    expect(parseCommentBody('plain text')).toEqual([{ type: 'text', value: 'plain text' }]);
  });

  it('splits text around a single mention', () => {
    const segments = parseCommentBody('hey @[Marta](uid123) thanks!');
    expect(segments).toEqual([
      { type: 'text', value: 'hey ' },
      { type: 'mention', uid: 'uid123', displayName: 'Marta' },
      { type: 'text', value: ' thanks!' },
    ]);
  });

  it('handles a mention at the very start of the body (no leading text segment)', () => {
    const segments = parseCommentBody('@[Marta](uid123) hi there');
    expect(segments[0]).toEqual({ type: 'mention', uid: 'uid123', displayName: 'Marta' });
    expect(segments).toHaveLength(2);
  });

  it('handles a mention at the very end of the body (no trailing text segment)', () => {
    const segments = parseCommentBody('thanks @[Marta](uid123)');
    expect(segments[segments.length - 1]).toEqual({ type: 'mention', uid: 'uid123', displayName: 'Marta' });
    expect(segments).toHaveLength(2);
  });

  it('handles multiple mentions', () => {
    const segments = parseCommentBody('@[Alice](a1) and @[Bob](b1)!');
    expect(segments).toEqual([
      { type: 'mention', uid: 'a1', displayName: 'Alice' },
      { type: 'text', value: ' and ' },
      { type: 'mention', uid: 'b1', displayName: 'Bob' },
      { type: 'text', value: '!' },
    ]);
  });

  it('renders a mention whose user was since removed using its denormalized name — the token has no live lookup', () => {
    // The whole point of embedding the display name in the token: parsing
    // never needs (or has) access to a live collaborators map.
    const segments = parseCommentBody('bye @[Former Member](removedUid)');
    expect(segments).toEqual([
      { type: 'text', value: 'bye ' },
      { type: 'mention', uid: 'removedUid', displayName: 'Former Member' },
    ]);
  });

  it('handles empty/null input', () => {
    expect(parseCommentBody('')).toEqual([]);
    expect(parseCommentBody(null)).toEqual([]);
  });

  it('round-trips insertMention output back into a mention segment', () => {
    const span = { start: 0, query: 'mar' };
    const { text } = insertMention('@mar', span, { uid: 'u1', displayName: 'Marta' }, 4);
    const segments = parseCommentBody(text);
    expect(segments[0]).toEqual({ type: 'mention', uid: 'u1', displayName: 'Marta' });
  });
});

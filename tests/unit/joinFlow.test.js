/**
 * Unit tests for src/utils/joinFlow.js — the pure logic behind the
 * `?join=<token>` share-link landing (Collaborative Projects, Phase 2).
 *
 * The sequencing decisions in `planJoinStep` are the reason this module was
 * extracted: they're several-branched, security-relevant (a wrong branch can
 * DOWNGRADE an existing editor), and awkward to exercise through the UI since
 * doing so needs a second identity and a live Firestore.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  JOIN_PARAM,
  JOIN_STATUS,
  buildShareUrl,
  joinStatusForReason,
  loadCachedJoinName,
  planJoinStep,
  readJoinToken,
  saveCachedJoinName,
  urlWithoutJoinParam,
} from '../../src/utils/joinFlow';

describe('readJoinToken', () => {
  it('reads the token from a query string', () => {
    expect(readJoinToken('?join=abc123')).toBe('abc123');
  });

  it('reads it alongside other params, in any position', () => {
    expect(readJoinToken('?tab=tasks&join=abc123&x=1')).toBe('abc123');
  });

  it('returns null when absent, empty, or whitespace-only', () => {
    expect(readJoinToken('?tab=tasks')).toBeNull();
    expect(readJoinToken('')).toBeNull();
    expect(readJoinToken('?join=')).toBeNull();
    expect(readJoinToken('?join=%20%20')).toBeNull();
  });

  it('trims surrounding whitespace (links get mangled by chat clients)', () => {
    expect(readJoinToken('?join=%20abc123%20')).toBe('abc123');
  });

  it('rejects an absurdly long value rather than sending it to the server', () => {
    expect(readJoinToken(`?join=${'a'.repeat(500)}`)).toBeNull();
  });

  it('decodes percent-encoding', () => {
    expect(readJoinToken('?join=a-b_c')).toBe('a-b_c');
  });

  it('returns null for a non-string input', () => {
    expect(readJoinToken(null)).toBeNull();
  });
});

describe('urlWithoutJoinParam', () => {
  it('strips the join param and leaves nothing behind', () => {
    expect(urlWithoutJoinParam('https://example.com/app/?join=abc')).toBe('/app/');
  });

  it('preserves other params and the hash', () => {
    expect(urlWithoutJoinParam('https://example.com/app/?tab=tasks&join=abc#x')).toBe('/app/?tab=tasks#x');
  });

  it('preserves a subpath (the app is served from a GitHub Pages project path)', () => {
    expect(urlWithoutJoinParam('https://user.github.io/taskflow/?join=abc')).toBe('/taskflow/');
  });

  it('is a no-op when there is no join param', () => {
    const href = 'https://example.com/app/?tab=tasks';
    expect(urlWithoutJoinParam(href)).toBe(href);
  });

  it('returns the input unchanged when it is not a parseable URL', () => {
    expect(urlWithoutJoinParam('not a url')).toBe('not a url');
  });
});

describe('buildShareUrl', () => {
  it('builds a clean link from origin and path', () => {
    expect(buildShareUrl('tok', 'https://example.com', '/app/')).toBe(`https://example.com/app/?${JOIN_PARAM}=tok`);
  });

  it('percent-encodes the token', () => {
    expect(buildShareUrl('a+b/c', 'https://example.com', '/')).toContain('a%2Bb%2Fc');
  });

  it('round-trips through readJoinToken', () => {
    const url = buildShareUrl('a-b_c', 'https://example.com', '/app/');
    expect(readJoinToken(new URL(url).search)).toBe('a-b_c');
  });
});

describe('planJoinStep', () => {
  const editLink = { role: 'editor', projectId: 'p1' };
  const viewLink = { role: 'viewer', projectId: 'p1' };

  it('opens the project without writing when the visitor is the owner', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'u1' }, sharedProject: { ownerId: 'u1' } })
    ).toEqual({ action: 'open_project' });
  });

  it('opens without re-writing when already a collaborator at the same role', () => {
    expect(
      planJoinStep({
        resolution: viewLink,
        user: { uid: 'u2' },
        sharedProject: { ownerId: 'u1', collaborators: { u2: { role: 'viewer' } } },
      })
    ).toEqual({ action: 'open_project' });
  });

  it('does NOT downgrade an existing editor who opens a view-only link', () => {
    expect(
      planJoinStep({
        resolution: viewLink,
        user: { uid: 'u2' },
        sharedProject: { ownerId: 'u1', collaborators: { u2: { role: 'editor' } } },
      })
    ).toEqual({ action: 'open_project' });
  });

  it('DOES write to upgrade an existing viewer who opens an edit link', () => {
    expect(
      planJoinStep({
        resolution: editLink,
        user: { uid: 'u2', displayName: 'Ada' },
        sharedProject: { ownerId: 'u1', collaborators: { u2: { role: 'viewer' } } },
      })
    ).toEqual({ action: 'write_membership', displayName: 'Ada' });
  });

  it('writes membership for a signed-in non-member, using their real name', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'u3', displayName: 'Grace' }, sharedProject: null })
    ).toEqual({ action: 'write_membership', displayName: 'Grace' });
  });

  it('falls back to a placeholder when a signed-in user has no displayName', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'u3', displayName: '' }, sharedProject: null }).displayName
    ).toBe('Someone');
  });

  it('prompts an anonymous visitor with no cached name', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'a1', isAnonymous: true }, cachedName: null })
    ).toEqual({ action: 'prompt_name' });
  });

  it('skips the prompt when a name is cached for this token', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'a1', isAnonymous: true }, cachedName: 'Zed' })
    ).toEqual({ action: 'write_membership', displayName: 'Zed' });
  });

  it('treats a whitespace-only cached name as absent', () => {
    expect(
      planJoinStep({ resolution: editLink, user: { uid: 'a1', isAnonymous: true }, cachedName: '   ' }).action
    ).toBe('prompt_name');
  });

  it('still short-circuits an anonymous visitor who is already a member', () => {
    expect(
      planJoinStep({
        resolution: viewLink,
        user: { uid: 'a1', isAnonymous: true },
        cachedName: null,
        sharedProject: { ownerId: 'u1', collaborators: { a1: { role: 'viewer' } } },
      })
    ).toEqual({ action: 'open_project' });
  });
});

describe('joinStatusForReason', () => {
  it('maps the reasons the resolve endpoint distinguishes', () => {
    expect(joinStatusForReason('link_expired')).toBe(JOIN_STATUS.LINK_EXPIRED);
    expect(joinStatusForReason('link_disabled')).toBe(JOIN_STATUS.LINK_DISABLED);
    expect(joinStatusForReason('already_owner')).toBe(JOIN_STATUS.ALREADY_MEMBER);
  });

  it('collapses anything unrecognized to invalid rather than inventing a distinction', () => {
    expect(joinStatusForReason('invalid_token')).toBe(JOIN_STATUS.INVALID_TOKEN);
    expect(joinStatusForReason('something_new')).toBe(JOIN_STATUS.INVALID_TOKEN);
    expect(joinStatusForReason(undefined)).toBe(JOIN_STATUS.INVALID_TOKEN);
  });
});

describe('cached anonymous display names', () => {
  // The unit suite runs in Vitest's `node` environment (vitest.config.js), so
  // there is no window.localStorage — these two functions take an injectable
  // storage pair precisely so this module doesn't drag jsdom into the whole
  // suite. See joinFlow.js's own comment on `defaultStorage`.
  let store;
  let storage;
  beforeEach(() => {
    store = {};
    storage = {
      load: (key, fallback) => (key in store ? store[key] : fallback),
      save: (key, value) => {
        store[key] = value;
      },
    };
  });

  it('round-trips a name for a token', () => {
    saveCachedJoinName('tok1', 'Ada', storage);
    expect(loadCachedJoinName('tok1', storage)).toBe('Ada');
  });

  it('keeps names for different tokens separate, so one link cannot disclose the name used on another', () => {
    saveCachedJoinName('tok1', 'Ada', storage);
    saveCachedJoinName('tok2', 'Grace', storage);
    expect(loadCachedJoinName('tok1', storage)).toBe('Ada');
    expect(loadCachedJoinName('tok2', storage)).toBe('Grace');
  });

  it('returns null for an unknown token', () => {
    expect(loadCachedJoinName('nope', storage)).toBeNull();
  });

  it('trims on both save and load', () => {
    saveCachedJoinName('tok1', '  Ada  ', storage);
    expect(loadCachedJoinName('tok1', storage)).toBe('Ada');
  });

  it('ignores empty/whitespace names rather than caching a blank the rules would reject', () => {
    saveCachedJoinName('tok1', '   ', storage);
    expect(loadCachedJoinName('tok1', storage)).toBeNull();
  });

  it('overwrites the name for a token when it changes', () => {
    saveCachedJoinName('tok1', 'Ada', storage);
    saveCachedJoinName('tok1', 'Grace', storage);
    expect(loadCachedJoinName('tok1', storage)).toBe('Grace');
  });

  it('returns null for a missing token argument', () => {
    expect(loadCachedJoinName(null, storage)).toBeNull();
  });

  it('survives a corrupt stored value instead of throwing', () => {
    store.anonJoinNames = 'not an object';
    expect(loadCachedJoinName('tok1', storage)).toBeNull();
    saveCachedJoinName('tok1', 'Ada', storage);
    expect(loadCachedJoinName('tok1', storage)).toBe('Ada');
  });
});

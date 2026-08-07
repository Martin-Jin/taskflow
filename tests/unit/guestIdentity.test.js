/**
 * Unit tests for src/utils/guestIdentity.js — the unified local guest
 * identity (uid + chosen display name) shared between the plain "just opened
 * the app" signed-out path and the share-link join flow. See that module's
 * header for the full design; this suite mainly covers:
 *   - the record surviving independent of any shared project (the bug this
 *     module was written to fix: a guest's name used to live ONLY on
 *     `collaborators[uid].displayName`, and vanished if they were removed
 *     from every project that had one),
 *   - the `sharedProjects` fallback/backfill path for a guest whose name
 *     predates this module,
 *   - tolerance of a missing/corrupt stored record.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { loadGuestIdentity, resolveGuestDisplayName, setGuestDisplayName, setGuestUid } from '../../src/utils/guestIdentity';

describe('guestIdentity', () => {
  // The unit suite runs in Vitest's `node` environment (vitest.config.js), so
  // there is no window.localStorage — every function here takes an
  // injectable storage pair for the same reason joinFlow.js's old cache did.
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

  describe('loadGuestIdentity', () => {
    it('returns nulls for both fields when nothing is stored yet', () => {
      expect(loadGuestIdentity(storage)).toEqual({ uid: null, displayName: null });
    });

    it('tolerates a corrupt stored value instead of throwing', () => {
      store.guestIdentity = 'not an object';
      expect(loadGuestIdentity(storage)).toEqual({ uid: null, displayName: null });
    });
  });

  describe('setGuestUid', () => {
    it('records a uid', () => {
      setGuestUid('anon1', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: null });
    });

    it('ignores an empty/non-string uid', () => {
      setGuestUid('', storage);
      setGuestUid(null, storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: null, displayName: null });
    });

    it('preserves an already-set display name when the uid is (re)recorded', () => {
      setGuestDisplayName('Ada', storage);
      setGuestUid('anon1', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: 'Ada' });
    });

    it('carries the display name forward if the uid changes (e.g. storage was cleared and a new anonymous session was minted)', () => {
      setGuestUid('anon1', storage);
      setGuestDisplayName('Ada', storage);
      setGuestUid('anon2', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon2', displayName: 'Ada' });
    });

    it('is a no-op when the uid has not changed', () => {
      setGuestUid('anon1', storage);
      setGuestDisplayName('Ada', storage);
      setGuestUid('anon1', storage); // Same uid again — must not disturb the name.
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: 'Ada' });
    });
  });

  describe('setGuestDisplayName', () => {
    it('records a display name', () => {
      setGuestDisplayName('Ada', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: null, displayName: 'Ada' });
    });

    it('trims the name', () => {
      setGuestDisplayName('  Ada  ', storage);
      expect(loadGuestIdentity(storage).displayName).toBe('Ada');
    });

    it('ignores an empty/whitespace name', () => {
      setGuestUid('anon1', storage);
      setGuestDisplayName('   ', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: null });
    });

    it('overwrites a previously-set name', () => {
      setGuestDisplayName('Ada', storage);
      setGuestDisplayName('Grace', storage);
      expect(loadGuestIdentity(storage).displayName).toBe('Grace');
    });

    it('preserves an already-recorded uid', () => {
      setGuestUid('anon1', storage);
      setGuestDisplayName('Ada', storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: 'Ada' });
    });
  });

  describe('resolveGuestDisplayName', () => {
    it('returns null with no uid and nothing stored locally', () => {
      expect(resolveGuestDisplayName(null, {}, storage)).toBeNull();
    });

    it('resolves the local record even with no uid at all — the lazy-sign-in case: a guest who renamed themselves before any Firebase session existed', () => {
      setGuestDisplayName('Pure Local Guest', storage);
      expect(resolveGuestDisplayName(null, null, storage)).toBe('Pure Local Guest');
      expect(resolveGuestDisplayName(undefined, undefined, storage)).toBe('Pure Local Guest');
    });

    it('prefers the local record over any collaborator entry', () => {
      setGuestDisplayName('Local Name', storage);
      const sharedProjects = { p1: { collaborators: { u1: { displayName: 'Project Name' } } } };
      expect(resolveGuestDisplayName('u1', sharedProjects, storage)).toBe('Local Name');
    });

    it("survives being removed from every shared project — the bug this module fixes", () => {
      // Simulates: guest joined a project, was written into the local
      // record (as the real join flow does via setGuestDisplayName), then
      // was removed as a collaborator from every project they'd joined.
      setGuestDisplayName('Ada', storage);
      expect(resolveGuestDisplayName('u1', {}, storage)).toBe('Ada'); // No shared projects left at all.
      expect(resolveGuestDisplayName('u1', undefined, storage)).toBe('Ada'); // Not even loaded yet.
    });

    it('falls back to scanning collaborators when nothing is stored locally yet (pre-existing guest)', () => {
      const sharedProjects = { p1: { collaborators: { u1: { displayName: 'Grace' } } } };
      expect(resolveGuestDisplayName('u1', sharedProjects, storage)).toBe('Grace');
    });

    it('backfills a name found via the collaborator-scan fallback into the local record', () => {
      const sharedProjects = { p1: { collaborators: { u1: { displayName: 'Grace' } } } };
      resolveGuestDisplayName('u1', sharedProjects, storage);
      // A second call with NO sharedProjects at all should still resolve —
      // proof the first call persisted it locally rather than just returning it.
      expect(resolveGuestDisplayName('u1', undefined, storage)).toBe('Grace');
    });

    it('backfill preserves an already-recorded uid rather than overwriting it with the lookup uid', () => {
      setGuestUid('anon1', storage);
      const sharedProjects = { p1: { collaborators: { anon1: { displayName: 'Grace' } } } };
      resolveGuestDisplayName('anon1', sharedProjects, storage);
      expect(loadGuestIdentity(storage)).toEqual({ uid: 'anon1', displayName: 'Grace' });
    });

    it('returns null when the uid has no name anywhere', () => {
      const sharedProjects = { p1: { collaborators: { other: { displayName: 'Someone Else' } } } };
      expect(resolveGuestDisplayName('u1', sharedProjects, storage)).toBeNull();
    });

    it('skips a collaborator entry with a blank displayName and keeps scanning', () => {
      const sharedProjects = {
        p1: { collaborators: { u1: { displayName: '   ' } } },
        p2: { collaborators: { u1: { displayName: 'Grace' } } },
      };
      expect(resolveGuestDisplayName('u1', sharedProjects, storage)).toBe('Grace');
    });
  });
});

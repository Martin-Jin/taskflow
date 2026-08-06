/**
 * Unit tests for isSafeFirestoreId (cloudflare-worker/src/shareLinkLogic.js).
 *
 * This guard is the fix for a path-traversal finding: projectId/token were
 * validated only as non-empty strings, then interpolated into Firestore REST
 * URLs. `fetch`'s URL parser resolves `..` before the request leaves the
 * Worker, and those reads use a service account that bypasses
 * firestore.rules — so a crafted id read an arbitrary document.
 *
 * The traversal cases below are the actual payloads from the review, kept as
 * regression tests rather than paraphrased: each one is verified to both fail
 * the guard AND to genuinely escape the intended path prefix, so the test
 * can't silently degrade into asserting a cosmetic format rule.
 */

import { describe, expect, it } from 'vitest';
import { isSafeFirestoreId, generateShareToken } from '../../cloudflare-worker/src/shareLinkLogic.js';

const BASE = 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/';

/** Where a given id actually lands once the URL parser has resolved it. */
function resolvedPath(id) {
  return new URL(`${BASE}sharedProjects/${id}`).pathname;
}

describe('isSafeFirestoreId', () => {
  it('accepts the tokens this codebase actually generates', () => {
    for (let i = 0; i < 50; i++) {
      expect(isSafeFirestoreId(generateShareToken())).toBe(true);
    }
  });

  it('accepts ordinary Firestore-style document ids', () => {
    expect(isSafeFirestoreId('abc123')).toBe(true);
    expect(isSafeFirestoreId('AbC-123_xyz')).toBe(true);
    expect(isSafeFirestoreId('a'.repeat(128))).toBe(true);
  });

  it('rejects non-strings and empties', () => {
    for (const v of [null, undefined, '', 0, 42, {}, [], true]) {
      expect(isSafeFirestoreId(v)).toBe(false);
    }
  });

  it('rejects ids longer than the cap', () => {
    expect(isSafeFirestoreId('a'.repeat(129))).toBe(false);
  });

  describe('path traversal', () => {
    // Each payload is asserted twice: rejected by the guard, and (without the
    // guard) genuinely escaping `documents/sharedProjects/`. The second
    // assertion is what stops this becoming a vacuous format test.
    const traversals = [
      '../../users/victim',
      'a/../../b',
      '../private/links',
      '../../../v1/projects/other',
    ];

    for (const payload of traversals) {
      it(`rejects ${JSON.stringify(payload)}`, () => {
        expect(isSafeFirestoreId(payload)).toBe(false);
        expect(resolvedPath(payload)).not.toContain('documents/sharedProjects/');
      });
    }

    it('rejects a plain slash, which would silently change the document depth', () => {
      // No `..` needed: an extra segment turns a document path into a
      // different one (or an invalid odd-depth path) without traversing up.
      expect(isSafeFirestoreId('proj/private/links')).toBe(false);
    });

    it('rejects encoded and whitespace variants', () => {
      for (const v of ['%2e%2e%2fusers', 'a b', 'a\nb', 'a\tb', '.', '..']) {
        expect(isSafeFirestoreId(v)).toBe(false);
      }
    });
  });
});

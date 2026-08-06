/**
 * Unit tests for src/utils/avatarDisplay.js — extracted after `initialsOf`/
 * `isSafePhotoURL` were duplicated verbatim across PresenceAvatars,
 * SharedProjectBadge and ShareProjectModal. `isSafePhotoURL` is the one
 * security-relevant bit (guards against a `javascript:`/`data:` URL reaching
 * an <img src>), so it's worth pinning even though both are otherwise simple.
 */

import { describe, expect, it } from 'vitest';
import { initialsOf, isSafePhotoURL } from '../../src/utils/avatarDisplay';

describe('initialsOf', () => {
  it('returns first+last initial for a full name', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
  });

  it('returns a single initial for a one-word name', () => {
    expect(initialsOf('Ada')).toBe('A');
  });

  it('collapses extra whitespace between name parts', () => {
    expect(initialsOf('  Ada   Lovelace  ')).toBe('AL');
  });

  it('uses the first and last of 3+ parts, ignoring the middle', () => {
    expect(initialsOf('Ada Marie Lovelace')).toBe('AL');
  });

  it("falls back to '?' for empty/missing names", () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf(undefined)).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('isSafePhotoURL', () => {
  it('accepts http and https URLs', () => {
    expect(isSafePhotoURL('https://example.com/a.png')).toBe(true);
    expect(isSafePhotoURL('http://example.com/a.png')).toBe(true);
    expect(isSafePhotoURL('HTTPS://example.com/a.png')).toBe(true);
  });

  it('rejects a javascript: URL', () => {
    expect(isSafePhotoURL('javascript:alert(1)')).toBe(false);
  });

  it('rejects a data: URL', () => {
    expect(isSafePhotoURL('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isSafePhotoURL(null)).toBe(false);
    expect(isSafePhotoURL(undefined)).toBe(false);
    expect(isSafePhotoURL(42)).toBe(false);
  });
});

/**
 * ============================================================================
 * useGoogleCalendarSync.js — retry-schedule coverage
 * ============================================================================
 * The hook itself is mostly effects/callbacks over the live Google Calendar
 * API, which isn't practical to unit test here (see googleCalendarService's
 * own coverage notes for the same reasoning). The mount-time silent re-auth's
 * backoff schedule is the one piece of pure logic worth pinning down: it
 * decides how many times a cold-start fetch retries before the app gives up
 * for that mount pass and flags the sync stale, so an off-by-one here means
 * either a missing retry (the original bug) or a retry loop that never ends.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { getSilentReauthRetryDelay, SILENT_REAUTH_MAX_ATTEMPTS } from '../../src/hooks/useGoogleCalendarSync.js';

describe('getSilentReauthRetryDelay', () => {
  it('runs the first attempt immediately', () => {
    expect(getSilentReauthRetryDelay(0)).toBe(0);
  });

  it('backs off on subsequent attempts', () => {
    expect(getSilentReauthRetryDelay(1)).toBe(2000);
    expect(getSilentReauthRetryDelay(2)).toBe(5000);
  });

  it('increases monotonically across the whole schedule', () => {
    for (let i = 1; i < SILENT_REAUTH_MAX_ATTEMPTS; i += 1) {
      expect(getSilentReauthRetryDelay(i)).toBeGreaterThan(getSilentReauthRetryDelay(i - 1));
    }
  });

  it('allows exactly SILENT_REAUTH_MAX_ATTEMPTS attempts', () => {
    expect(SILENT_REAUTH_MAX_ATTEMPTS).toBe(3);
    expect(getSilentReauthRetryDelay(SILENT_REAUTH_MAX_ATTEMPTS - 1)).not.toBeNull();
  });

  it('returns null past the last attempt, so the caller stops retrying', () => {
    expect(getSilentReauthRetryDelay(SILENT_REAUTH_MAX_ATTEMPTS)).toBeNull();
    expect(getSilentReauthRetryDelay(99)).toBeNull();
  });

  it('returns null for invalid indices rather than retrying forever', () => {
    expect(getSilentReauthRetryDelay(-1)).toBeNull();
    expect(getSilentReauthRetryDelay(1.5)).toBeNull();
    expect(getSilentReauthRetryDelay(undefined)).toBeNull();
  });
});

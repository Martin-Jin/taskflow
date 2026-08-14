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
 *
 * Also covered here are the pure decision helpers behind two duplicate/
 * reliability fixes in the same hook:
 *   - `isBlockSourcedEvent` / `dedupeAuthoritativeItems` — recognizing (and,
 *     as a backstop, collapsing) the block-mirror events that made every
 *     "Rewrite Google Calendar" run re-create a second copy of every synced
 *     block.
 *   - `isUnsyncedPushableEvent` — which events the periodic/manual push sweep
 *     should retry, closing the gap where an event whose one-shot push failed
 *     was stranded unsynced forever while blocks were retried every tick.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  getSilentReauthRetryDelay,
  SILENT_REAUTH_MAX_ATTEMPTS,
  isUnsyncedPushableEvent,
  dedupeAuthoritativeItems,
} from '../../src/hooks/useGoogleCalendarSync.js';
import { isBlockSourcedEvent } from '../../src/services/googleCalendarService.js';

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

describe('isBlockSourcedEvent — recognizing TaskFlow own block mirrors', () => {
  // THE push-side duplicate root cause. TaskFlow pushes a ScheduledBlock to
  // Google; the next poll pulls that same event back as an ordinary
  // `source: 'google'` CalendarEvent. Local state then holds BOTH the block
  // and a mirror event of it. "Rewrite Google Calendar to match TaskFlow"
  // treats blocks and events as authoritative and pushes both — creating a
  // second real Google event for every synced block, on every run. That is
  // why duplicates appeared DURING the push phase even when the delete phase
  // had correctly cleared the calendar first.

  it('recognizes a mirror by its private extended property', () => {
    expect(isBlockSourcedEvent({ title: 'Anything', taskflowBlockId: 'blk_1' })).toBe(true);
  });

  it('recognizes a legacy mirror pushed before the marker existed, by its title prefix', () => {
    // Events pushed by older builds carry no extended property at all, so the
    // "📋 " prefix this app has always written is the only signal available.
    expect(isBlockSourcedEvent({ title: '📋 Write report', source: 'google' })).toBe(true);
  });

  it('does NOT treat an ordinary user event as a mirror', () => {
    expect(isBlockSourcedEvent({ title: 'Dentist', source: 'google' })).toBe(false);
  });

  it('does NOT treat a same-titled user event without the prefix as a mirror', () => {
    expect(isBlockSourcedEvent({ title: 'Write report', source: 'google' })).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isBlockSourcedEvent(null)).toBe(false);
    expect(isBlockSourcedEvent(undefined)).toBe(false);
  });
});

describe('isUnsyncedPushableEvent — the retry sweep for events', () => {
  // Events had no retry path at all: addManualEvent/updateEvent each fire ONE
  // best-effort push and only log/toast on failure, so an event whose push
  // failed (offline, not yet connected, tab closed mid-flight) was stranded
  // with googleEventId: null forever. Blocks were swept every poll tick;
  // events simply weren't. This predicate is what makes the sweep symmetric.
  const base = { id: 'e1', title: 'Coffee', date: '2026-08-20', startTime: '09:00', endTime: '10:00' };

  it('selects a manual event that has never been pushed', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'manual', googleEventId: null })).toBe(true);
  });

  it('skips an event that already has a googleEventId', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', googleEventId: 'gcal_1' })).toBe(false);
  });

  it('CRITICAL SAFETY: never pushes a copy of a subscribed/foreign-calendar event', () => {
    // Pushing this would duplicate someone else's event onto the user's own
    // primary calendar — the same boundary the rewrite's authoritative set
    // enforces.
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', calendarId: 'team@example.com', googleEventId: null })).toBe(false);
  });

  it('allows an unsynced event sourced from the user own primary calendar', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', calendarId: 'primary', googleEventId: null })).toBe(true);
  });

  it('skips a block-mirror row, since the block itself is what gets pushed', () => {
    expect(isUnsyncedPushableEvent({ ...base, title: '📋 Write report', source: 'manual', googleEventId: null })).toBe(false);
  });

  it('skips an event missing date/time, which could not build a valid resource', () => {
    expect(isUnsyncedPushableEvent({ id: 'e2', title: 'Broken', source: 'manual', googleEventId: null })).toBe(false);
    expect(isUnsyncedPushableEvent({ ...base, startTime: undefined, source: 'manual', googleEventId: null })).toBe(false);
  });
});

describe('dedupeAuthoritativeItems — last-resort guard against pushing duplicates', () => {
  // Defence in depth for the one place in the app that can mint permanent
  // duplicates on a real calendar. A duplicate that reaches Google survives
  // every later sync, so this collapses anything that would render as the
  // same event at the same time regardless of how local state got that way.
  const block = (taskTitle, date, startTime, id = `${taskTitle}-${startTime}`) => ({
    kind: 'block',
    block: { id, date, startTime, endTime: '10:00' },
    task: { title: taskTitle },
  });
  const event = (title, date, startTime, id = `${title}-${startTime}`) => ({
    kind: 'event',
    event: { id, title, date, startTime, endTime: '10:00' },
  });

  it('keeps a single copy when two rows would create the same Google event', () => {
    const items = [block('Piano', '2026-08-20', '09:00', 'a'), block('Piano', '2026-08-20', '09:00', 'b')];
    const { items: kept, duplicates } = dedupeAuthoritativeItems(items);
    expect(kept).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it('reports the duplicates it dropped, so local-state corruption can be surfaced rather than hidden', () => {
    const items = [event('Copilot', '2026-08-21', '14:00', 'x'), event('Copilot', '2026-08-21', '14:00', 'y')];
    const { duplicates } = dedupeAuthoritativeItems(items);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].event.id).toBe('y'); // first occurrence wins, later ones reported
  });

  it('keeps genuinely different placements of the same task', () => {
    const items = [block('Piano', '2026-08-20', '09:00'), block('Piano', '2026-08-21', '09:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('keeps same-titled items at different times on the same day', () => {
    const items = [block('Piano', '2026-08-20', '09:00'), block('Piano', '2026-08-20', '15:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('does not collapse a block and an event that merely share a title', () => {
    // Different kinds produce different Google events (a block is pushed with
    // the "📋 " prefix and its own resource shape), so they are not duplicates.
    const items = [block('Piano', '2026-08-20', '09:00'), event('Piano', '2026-08-20', '09:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('treats differing recurrence rules as distinct events', () => {
    const weekly = { kind: 'event', event: { id: 'w', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00', recurrenceRule: 'FREQ=WEEKLY' } };
    const oneOff = { kind: 'event', event: { id: 'o', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00' } };
    expect(dedupeAuthoritativeItems([weekly, oneOff]).items).toHaveLength(2);
  });

  it('is a no-op on already-clean input', () => {
    const items = [block('A', '2026-08-20', '09:00'), event('B', '2026-08-20', '11:00')];
    const { items: kept, duplicates } = dedupeAuthoritativeItems(items);
    expect(kept).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('handles an empty list', () => {
    expect(dedupeAuthoritativeItems([])).toEqual({ items: [], duplicates: [] });
  });
});

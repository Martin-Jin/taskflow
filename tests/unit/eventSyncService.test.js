/**
 * ============================================================================
 * mergePulledGoogleEvents — coverage notes
 * ============================================================================
 * eventSyncService.js is the one place that decides how a freshly-pulled
 * batch of Google Calendar events gets folded into the app's local `events`
 * array ("Google always wins" — see the file's own doc comment). This suite
 * covers both the pre-existing merge policy and the recently-deleted
 * suppression added to close a resurrection race: deleting a Google-synced
 * event is optimistic (removed from local state immediately) while the
 * actual Google delete call is fire-and-forget, so a poll/pull landing
 * before Google's own delete has propagated would otherwise still see the
 * event as live and merge it right back in. `recentlyDeletedGoogleEventIds`
 * (a plain Map passed in by the caller, see useGoogleCalendarSync.js) plus
 * `nowMs` make that suppression a pure, deterministic decision here.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { mergePulledGoogleEvents, hardResetEventsFromGoogle, RECENTLY_DELETED_TTL_MS } from '../../src/services/eventSyncService.js';

function googleEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt1',
    source: 'google',
    googleEventId: overrides.googleEventId || 'g1',
    date: overrides.date || '2026-08-05',
    title: overrides.title || 'Event',
    ...overrides,
  };
}

describe('mergePulledGoogleEvents — base merge policy (no suppression)', () => {
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('keeps manual (non-google) events untouched', () => {
    const manual = { id: 'm1', source: 'manual', date: '2026-08-05', title: 'Manual' };
    const result = mergePulledGoogleEvents([manual], [], rangeStart, rangeEnd);
    expect(result).toEqual([manual]);
  });

  it('replaces a local google event with the pulled version when ids match', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'g1', title: 'Old title' });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', title: 'New title' });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([pulled]);
  });

  it('drops a local google event that is in-range but absent from the pull (Google-side delete)', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'gone', date: '2026-08-10' });
    const result = mergePulledGoogleEvents([local], [], rangeStart, rangeEnd);
    expect(result).toEqual([]);
  });

  it('leaves a local google event PAST the pull range untouched even if absent from the pull (future out-of-scope)', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'faraway', date: '2026-09-15' });
    const result = mergePulledGoogleEvents([local], [], rangeStart, rangeEnd);
    expect(result).toEqual([local]);
  });

  it('purges a local non-recurring google event OLDER than the retention window (rangeStart), unlike the future out-of-scope case above', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'ancient', date: '2026-07-20' });
    const result = mergePulledGoogleEvents([local], [], rangeStart, rangeEnd);
    expect(result).toEqual([]);
  });

  it('does NOT purge a recurring master whose DTSTART predates the retention window — it stays in scope as long as Google keeps returning it', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'g1', date: '2026-01-01', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-01-01', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', title: 'Updated' });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([pulled]);
  });

  it('adds a brand-new pulled event with no local match', () => {
    const pulled = googleEvent({ id: 'g2', googleEventId: 'g2' });
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([pulled]);
  });
});

describe('mergePulledGoogleEvents — manual-event echo suppression', () => {
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('does not duplicate a manual event when the pull echoes back the copy it was pushed as', () => {
    // Reproduces the "add an event, refresh, get two" bug: addManualEvent
    // fire-and-forget pushes to Google then patches googleEventId onto the
    // still-source:'manual' row, so the very next pull sees that same event
    // come back from Google with no local GOOGLE-sourced row claiming its id.
    const manual = { id: 'm1', source: 'manual', googleEventId: 'g1', date: '2026-08-05', title: 'Dentist' };
    const echoed = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-05', title: 'Dentist' });
    const result = mergePulledGoogleEvents([manual], [echoed], rangeStart, rangeEnd);
    expect(result).toEqual([manual]);
  });

  it('still adds an unrelated brand-new pulled event alongside an untouched manual event', () => {
    const manual = { id: 'm1', source: 'manual', googleEventId: 'g1', date: '2026-08-05', title: 'Dentist' };
    const other = googleEvent({ id: 'g2', googleEventId: 'g2', date: '2026-08-06', title: 'Meeting' });
    const result = mergePulledGoogleEvents([manual], [other], rangeStart, rangeEnd);
    expect(result).toEqual([manual, other]);
  });

  it('does not suppress a pulled event merely because a DIFFERENT manual event exists', () => {
    const manual = { id: 'm1', source: 'manual', googleEventId: null, date: '2026-08-05', title: 'Blocked time' };
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-06' });
    const result = mergePulledGoogleEvents([manual], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([manual, pulled]);
  });
});

describe('hardResetEventsFromGoogle — one-time full wipe-and-rebuild', () => {
  it('returns exactly the pulled batch, discarding anything existing was never even passed', () => {
    // Unlike mergePulledGoogleEvents, this takes NO existingEvents argument
    // at all — it is an unconditional wipe, explicitly authorized as a
    // one-time recovery for accumulated duplicate/orphaned local state that
    // a partial reconcile couldn't reliably chase down (see the file's own
    // doc comment). Any local-only manual event with no Google counterpart
    // is gone after this runs; that's the deliberate, disclosed tradeoff.
    const pulled = [googleEvent({ id: 'g1', googleEventId: 'g1' }), googleEvent({ id: 'g2', googleEventId: 'g2' })];
    expect(hardResetEventsFromGoogle(pulled)).toEqual(pulled);
  });

  it('returns an empty array for an empty pull', () => {
    expect(hardResetEventsFromGoogle([])).toEqual([]);
  });

  it('still applies recently-deleted suppression to the pulled batch', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1' });
    const recentlyDeleted = new Map([['g1', now - 1000]]);
    expect(hardResetEventsFromGoogle([pulled], recentlyDeleted, new Map(), now)).toEqual([]);
  });

  it('also applies recently instance-deleted suppression, forcing overrides.deleted=true for that occurrence', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', recurrenceRule: 'FREQ=WEEKLY' });
    const recentlyDeletedInstances = new Map([[`g1::2026-08-10`, now - 5000]]);
    const result = hardResetEventsFromGoogle([pulled], new Map(), recentlyDeletedInstances, now);
    expect(result).toEqual([{ ...pulled, overrides: { '2026-08-10': { deleted: true } } }]);
  });
});

describe('mergePulledGoogleEvents — recently-deleted suppression', () => {
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('drops a pulled event whose id was deleted moments ago, instead of resurrecting it', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-10' });
    const recentlyDeleted = new Map([['g1', now - 5000]]); // deleted 5s ago
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, recentlyDeleted, new Map(), now);
    expect(result).toEqual([]);
  });

  it('stops suppressing once the TTL has elapsed (a genuine re-creation merges normally)', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-10' });
    const recentlyDeleted = new Map([['g1', now - RECENTLY_DELETED_TTL_MS - 1]]); // just past TTL
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, recentlyDeleted, new Map(), now);
    expect(result).toEqual([pulled]);
  });

  it('only suppresses the specific id just deleted — a different event in the same pull still merges', () => {
    const now = 1_000_000;
    const deletedEvent = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-10' });
    const otherEvent = googleEvent({ id: 'g2', googleEventId: 'g2', date: '2026-08-11', title: 'Unrelated' });
    const recentlyDeleted = new Map([['g1', now - 1000]]);
    const result = mergePulledGoogleEvents([], [deletedEvent, otherEvent], rangeStart, rangeEnd, recentlyDeleted, new Map(), now);
    expect(result).toEqual([otherEvent]);
  });

  it('does not suppress anything when no recently-deleted map is passed (default behavior unchanged)', () => {
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2026-08-10' });
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([pulled]);
  });
});

describe('mergePulledGoogleEvents — recently instance-deleted suppression (single occurrence of a series)', () => {
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('forces a recently-deleted occurrence to overrides.deleted=true even if the pull\'s own EXDATE has not caught up yet', () => {
    const now = 1_000_000;
    // Pulled master has no override for this date yet — Google hasn't
    // propagated the EXDATE for the deleteCalendarEventInstance call.
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', recurrenceRule: 'FREQ=WEEKLY' });
    const recentlyDeletedInstances = new Map([[`g1::2026-08-10`, now - 5000]]);
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, new Map(), recentlyDeletedInstances, now);
    expect(result).toEqual([{ ...pulled, overrides: { '2026-08-10': { deleted: true } } }]);
  });

  it('preserves the pull\'s other override entries while forcing the suppressed date', () => {
    const now = 1_000_000;
    const pulled = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-03': { deleted: true } },
    });
    const recentlyDeletedInstances = new Map([[`g1::2026-08-10`, now - 5000]]);
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, new Map(), recentlyDeletedInstances, now);
    expect(result[0].overrides).toEqual({
      '2026-08-03': { deleted: true },
      '2026-08-10': { deleted: true },
    });
  });

  it('stops forcing an occurrence once the TTL has elapsed (Google\'s own EXDATE state wins outright)', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', recurrenceRule: 'FREQ=WEEKLY' });
    const recentlyDeletedInstances = new Map([[`g1::2026-08-10`, now - RECENTLY_DELETED_TTL_MS - 1]]);
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, new Map(), recentlyDeletedInstances, now);
    expect(result).toEqual([pulled]);
  });

  it('only forces the specific master+date pair, leaving an unrelated master/date untouched', () => {
    const now = 1_000_000;
    const pulled = googleEvent({ id: 'g2', googleEventId: 'g2', recurrenceRule: 'FREQ=WEEKLY' });
    const recentlyDeletedInstances = new Map([[`g1::2026-08-10`, now - 5000]]);
    const result = mergePulledGoogleEvents([], [pulled], rangeStart, rangeEnd, new Map(), recentlyDeletedInstances, now);
    expect(result).toEqual([pulled]);
  });
});

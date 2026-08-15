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
import {
  mergePulledGoogleEvents,
  hardResetEventsFromGoogle,
  expandSyncedBounds,
  computeOnDemandFetchRange,
  computeEffectivePurgeBoundary,
  RECENTLY_DELETED_TTL_MS,
} from '../../src/services/eventSyncService.js';

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

describe('mergePulledGoogleEvents — restored/unconfirmed events are re-pushed, not deleted', () => {
  // The bug: restoring a backup taken before the user cleared their Google
  // Calendar brings back events whose `source: 'google'` + `googleEventId`
  // describe a calendar state that no longer exists. The very next pull can't
  // echo those ids back (Google has never heard of them), so the "in scope but
  // absent -> Google deleted it" rule silently wiped the entire restore.
  // `confirmedGoogleEventIds` — the ids this instance has actually seen live —
  // separates that case from a real Google-side delete.
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('keeps a restored in-scope event whose id was never confirmed live, clearing the stale id so it gets pushed', () => {
    const restored = googleEvent({
      id: 'local1',
      googleEventId: 'stale-from-backup',
      date: '2026-08-20',
      title: 'Shopping',
      googleUpdatedAt: '2026-07-01T00:00:00Z',
    });
    const result = mergePulledGoogleEvents([restored], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set(['some-other-live-id']));

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Shopping');
    // Cleared, which is what makes isUnsyncedPushableEvent pick it up.
    expect(result[0].googleEventId).toBeNull();
    expect(result[0].googleUpdatedAt).toBeUndefined();
    // Still google-sourced, so it re-pushes to the calendar it came from.
    expect(result[0].source).toBe('google');
  });

  it('still deletes a genuinely Google-deleted event — one whose id WAS confirmed live and is now absent', () => {
    const live = googleEvent({ id: 'local1', googleEventId: 'was-live', date: '2026-08-20' });
    const result = mergePulledGoogleEvents([live], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set(['was-live']));
    expect(result).toEqual([]);
  });

  it('leaves an unconfirmed event that is OUT of scope completely untouched (the pull says nothing about it)', () => {
    const restored = googleEvent({ id: 'local1', googleEventId: 'stale', date: '2026-09-15' });
    const result = mergePulledGoogleEvents([restored], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set(['other']));
    expect(result).toEqual([restored]);
  });

  it('still purges an unconfirmed event that has aged out of the retention window entirely', () => {
    // Retention beats the re-push rule — an event too old to keep should not be
    // resurrected onto Google just because it was never confirmed.
    const ancient = googleEvent({ id: 'local1', googleEventId: 'stale', date: '2026-07-20' });
    const result = mergePulledGoogleEvents([ancient], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set(['other']));
    expect(result).toEqual([]);
  });

  it('confirms an id the pull itself returned, so it is replaced rather than demoted', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'g1', title: 'Old' });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', title: 'New' });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set(['g1']));
    expect(result).toEqual([pulled]);
  });

  it('falls back to the original trust-the-pull policy when no confirmation set is supplied at all', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'gone', date: '2026-08-10' });
    expect(mergePulledGoogleEvents([local], [], rangeStart, rangeEnd)).toEqual([]);
    expect(mergePulledGoogleEvents([local], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, null)).toEqual([]);
  });

  it('treats an EMPTY confirmation set as "nothing confirmed yet", not as "no tracking" — the first pull after a restore', () => {
    // The highest-stakes case: the user restores a backup and the very first
    // sync of the session runs with nothing confirmed yet. Treating an empty
    // set as "trust the pull" would delete the entire restore on that first
    // tick, which is the exact bug being fixed.
    const restored = googleEvent({ id: 'local1', googleEventId: 'stale-from-backup', date: '2026-08-20' });
    const result = mergePulledGoogleEvents([restored], [], rangeStart, rangeEnd, new Map(), new Map(), Date.now(), rangeStart, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].googleEventId).toBeNull();
  });
});

describe('mergePulledGoogleEvents — preserving the local-only "ignore from scheduler" flag across a sync', () => {
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('carries forward isFreeTime onto the pulled replacement when the local event was marked ignored', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'g1', title: 'Old title', isFreeTime: true });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', title: 'New title' });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([{ ...pulled, isFreeTime: true }]);
  });

  it('does not add isFreeTime when the local event was never marked ignored', () => {
    const local = googleEvent({ id: 'local1', googleEventId: 'g1', title: 'Old title' });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', title: 'New title' });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result).toEqual([pulled]);
  });

  it('carries forward a per-occurrence overrides[date].isFreeTime on a recurring master, alongside the pull\'s own overrides', () => {
    const local = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-10': { isFreeTime: true } },
    });
    const pulled = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-03': { deleted: true } },
    });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result[0].overrides).toEqual({
      '2026-08-03': { deleted: true },
      '2026-08-10': { isFreeTime: true },
    });
  });

  it('merges isFreeTime into the pull\'s own override entry for a date it already has one for, rather than replacing it', () => {
    const local = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-10': { isFreeTime: true } },
    });
    const pulled = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-10': { deleted: true } },
    });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result[0].overrides).toEqual({ '2026-08-10': { deleted: true, isFreeTime: true } });
  });

  it('leaves an already-ignored pull override untouched instead of double-applying it', () => {
    const local = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-10': { isFreeTime: true } },
    });
    const pulled = googleEvent({
      id: 'g1',
      googleEventId: 'g1',
      recurrenceRule: 'FREQ=WEEKLY',
      overrides: { '2026-08-10': { isFreeTime: true } },
    });
    const result = mergePulledGoogleEvents([local], [pulled], rangeStart, rangeEnd);
    expect(result[0].overrides).toEqual({ '2026-08-10': { isFreeTime: true } });
  });

  it('does not affect a manual event or a brand-new pulled event with no local counterpart', () => {
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

describe('mergePulledGoogleEvents — purgeBoundaryIso (on-demand-fetched-old-event retention fix)', () => {
  // Reproduces the bug the "routine 30/30 window + on-demand widening" model
  // introduced: an on-demand fetch pulls in an event far older than the
  // routine window, then the VERY NEXT routine poll runs with its own
  // narrower rangeStartIso. Without a separate purgeBoundaryIso tracking the
  // union of every range ever synced, that poll would see the on-demand
  // event as "older than THIS pull's rangeStartIso" and purge it right back
  // out — silently undoing the on-demand fetch.
  const routineRangeStart = '2026-08-01'; // this narrow routine poll's own range
  const routineRangeEnd = '2026-08-31';

  it('does NOT purge an old non-recurring event when purgeBoundaryIso (the wider synced union) still covers it', () => {
    const oldEvent = googleEvent({ id: 'local1', googleEventId: 'ancient', date: '2026-02-01' }); // 6 months before routineRangeStart
    const purgeBoundaryIso = '2026-01-01'; // union includes an on-demand fetch that reached back this far
    const result = mergePulledGoogleEvents([oldEvent], [], routineRangeStart, routineRangeEnd, new Map(), new Map(), Date.now(), purgeBoundaryIso);
    expect(result).toEqual([oldEvent]);
  });

  it('still purges an event older than purgeBoundaryIso itself, even though it is within this pull\'s own out-of-scope future side', () => {
    const oldEvent = googleEvent({ id: 'local1', googleEventId: 'ancient', date: '2025-12-01' }); // before purgeBoundaryIso
    const purgeBoundaryIso = '2026-01-01';
    const result = mergePulledGoogleEvents([oldEvent], [], routineRangeStart, routineRangeEnd, new Map(), new Map(), Date.now(), purgeBoundaryIso);
    expect(result).toEqual([]);
  });

  it('defaults purgeBoundaryIso to rangeStartIso when omitted, preserving the original (pre-on-demand-sync) purge behavior', () => {
    const oldEvent = googleEvent({ id: 'local1', googleEventId: 'ancient', date: '2026-07-20' }); // before routineRangeStart, no purgeBoundaryIso passed
    const result = mergePulledGoogleEvents([oldEvent], [], routineRangeStart, routineRangeEnd);
    expect(result).toEqual([]);
  });

  it('never purges a recurring master regardless of purgeBoundaryIso — recurring masters are always in scope', () => {
    const oldMaster = googleEvent({ id: 'local1', googleEventId: 'g1', date: '2020-01-01', recurrenceRule: 'FREQ=WEEKLY' });
    const pulled = googleEvent({ id: 'g1', googleEventId: 'g1', date: '2020-01-01', recurrenceRule: 'FREQ=WEEKLY', title: 'Updated' });
    const result = mergePulledGoogleEvents([oldMaster], [pulled], routineRangeStart, routineRangeEnd, new Map(), new Map(), Date.now(), '2026-08-01');
    expect(result).toEqual([pulled]);
  });
});

describe('expandSyncedBounds — union of every range ever synced', () => {
  it('starts from null bounds by adopting the first fetched range as-is', () => {
    expect(expandSyncedBounds(null, '2026-08-01', '2026-08-31')).toEqual({ startIso: '2026-08-01', endIso: '2026-08-31' });
  });

  it('grows the start edge backward when a new fetch reaches further into the past', () => {
    const bounds = { startIso: '2026-08-01', endIso: '2026-08-31' };
    expect(expandSyncedBounds(bounds, '2026-01-01', '2026-08-31')).toEqual({ startIso: '2026-01-01', endIso: '2026-08-31' });
  });

  it('grows the end edge forward when a new fetch reaches further into the future', () => {
    const bounds = { startIso: '2026-08-01', endIso: '2026-08-31' };
    expect(expandSyncedBounds(bounds, '2026-08-01', '2026-12-31')).toEqual({ startIso: '2026-08-01', endIso: '2026-12-31' });
  });

  it('never shrinks — a narrower routine-poll range leaves existing wider bounds untouched', () => {
    const bounds = { startIso: '2026-01-01', endIso: '2026-12-31' };
    expect(expandSyncedBounds(bounds, '2026-08-01', '2026-08-31')).toEqual(bounds);
  });
});

describe('computeOnDemandFetchRange — deciding what (if anything) a calendar-view navigation needs to fetch', () => {
  it('fetches the full view range when nothing has been synced yet', () => {
    expect(computeOnDemandFetchRange(null, '2026-08-01', '2026-08-31')).toEqual({ startIso: '2026-08-01', endIso: '2026-08-31' });
  });

  it('returns null when the viewed range is already fully covered by synced bounds', () => {
    const bounds = { startIso: '2026-01-01', endIso: '2026-12-31' };
    expect(computeOnDemandFetchRange(bounds, '2026-08-01', '2026-08-31')).toBeNull();
  });

  it('extends only the back edge when the view scrolls before the synced start, leaving the front edge alone', () => {
    const bounds = { startIso: '2026-08-01', endIso: '2026-08-31' };
    expect(computeOnDemandFetchRange(bounds, '2026-06-01', '2026-08-15')).toEqual({ startIso: '2026-06-01', endIso: '2026-08-31' });
  });

  it('extends only the forward edge when the view scrolls past the synced end, leaving the back edge alone', () => {
    const bounds = { startIso: '2026-08-01', endIso: '2026-08-31' };
    expect(computeOnDemandFetchRange(bounds, '2026-08-15', '2026-10-01')).toEqual({ startIso: '2026-08-01', endIso: '2026-10-01' });
  });

  it('extends both edges at once when the view is wider on both sides than synced bounds', () => {
    const bounds = { startIso: '2026-08-01', endIso: '2026-08-31' };
    expect(computeOnDemandFetchRange(bounds, '2026-01-01', '2026-12-31')).toEqual({ startIso: '2026-01-01', endIso: '2026-12-31' });
  });
});

describe('computeEffectivePurgeBoundary — capping retention at a rolling maxRetentionDays regardless of synced bounds', () => {
  const nowMs = new Date(2026, 7, 1).getTime(); // 2026-08-01 local

  it('falls back to the retention floor when nothing has been synced yet', () => {
    expect(computeEffectivePurgeBoundary(null, 365, nowMs)).toBe('2025-08-01');
  });

  it('uses the synced-bounds edge when it is within the retention ceiling (e.g. the routine 30-day window)', () => {
    expect(computeEffectivePurgeBoundary('2026-07-02', 365, nowMs)).toBe('2026-07-02');
  });

  it('caps retention at the ceiling even when an on-demand fetch reached further back than a year', () => {
    // Regression case: a single on-demand view from 500 days back must not
    // pin retention there forever — the ceiling still wins.
    expect(computeEffectivePurgeBoundary('2025-03-19', 365, nowMs)).toBe('2025-08-01');
  });

  it('rolls forward with real time — the same synced bound eventually falls outside a LATER retention ceiling', () => {
    const oneYearLaterMs = new Date(2027, 7, 1).getTime(); // 2027-08-01
    expect(computeEffectivePurgeBoundary('2026-07-02', 365, oneYearLaterMs)).toBe('2026-08-01');
  });
});


describe('mergePulledGoogleEvents — block-mirror suppression during ORDINARY pulls', () => {
  // The gap that let duplicates come back between rewrites. Every ScheduledBlock
  // TaskFlow pushes returns on the very next poll as an ordinary
  // `source: 'google'` event carrying TaskFlow's own private extended property
  // (surfaced as `taskflowBlockId`). The rewrite path filtered those mirror rows
  // out from the start; the ordinary merge did not — so ~60 seconds after any
  // push, local `events` held both the block and a mirror row of it. That row
  // renders on top of its own block and, once its googleEventId is cleared (a
  // rewrite nulls every id by construction), becomes a live push candidate that
  // inserts a REAL duplicate on the user's calendar.

  const mirror = (overrides = {}) =>
    googleEvent({ googleEventId: 'g_mirror', taskflowBlockId: 'blk_t1_2026-08-05_09:00', title: '📋 Piano', ...overrides });

  it('CRITICAL: does not add a pulled block mirror to local events', () => {
    const merged = mergePulledGoogleEvents([], [mirror()], '2026-08-01', '2026-08-31');
    expect(merged).toEqual([]);
  });

  it('recognizes a legacy mirror by its title prefix when the marker is absent', () => {
    // Events pushed before the extended-property marker existed carry only the
    // "📋 " prefix this app has always written.
    const legacy = googleEvent({ googleEventId: 'g_legacy', title: '📋 Write report' });
    const merged = mergePulledGoogleEvents([], [legacy], '2026-08-01', '2026-08-31');
    expect(merged).toEqual([]);
  });

  it('drops a mirror row an older build already merged into local state', () => {
    // Without this, existing users stay broken: the row is already in `events`,
    // and suppressing only the incoming pull would leave it there indefinitely.
    const existing = [mirror()];
    const merged = mergePulledGoogleEvents(existing, [mirror()], '2026-08-01', '2026-08-31');
    expect(merged).toEqual([]);
  });

  it('still merges ordinary Google events normally alongside a mirror', () => {
    const real = googleEvent({ id: 'e_real', googleEventId: 'g_real', title: 'Dentist' });
    const merged = mergePulledGoogleEvents([], [mirror(), real], '2026-08-01', '2026-08-31');
    expect(merged.map((e) => e.googleEventId)).toEqual(['g_real']);
  });

  it('never mistakes an ordinary user event for a mirror', () => {
    const userEvent = googleEvent({ googleEventId: 'g_user', title: 'Piano' });
    const merged = mergePulledGoogleEvents([], [userEvent], '2026-08-01', '2026-08-31');
    expect(merged.map((e) => e.googleEventId)).toEqual(['g_user']);
  });

  it('leaves manual (never-pushed) events untouched', () => {
    const manual = { id: 'm1', source: 'manual', googleEventId: null, date: '2026-08-05', title: 'Lunch' };
    const merged = mergePulledGoogleEvents([manual], [mirror()], '2026-08-01', '2026-08-31');
    expect(merged).toEqual([manual]);
  });
});

describe('hardResetEventsFromGoogle — mirror suppression', () => {
  it('excludes block mirrors from the rebuilt event set', () => {
    const real = googleEvent({ googleEventId: 'g_real', title: 'Dentist' });
    const mirrorRow = googleEvent({ googleEventId: 'g_mirror', taskflowBlockId: 'blk_1' });
    expect(hardResetEventsFromGoogle([real, mirrorRow]).map((e) => e.googleEventId)).toEqual(['g_real']);
  });
});

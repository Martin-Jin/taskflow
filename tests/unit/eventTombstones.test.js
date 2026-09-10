/**
 * ============================================================================
 * eventTombstones — pure tombstoning + retention-sweep decision coverage
 * ============================================================================
 * The CalendarEvent counterpart to taskTombstones.test.js. `deleteEvent`
 * itself lives inside SchedulerContext.jsx (a hook, not renderable here), so
 * the state-shape decision it delegates to was extracted into
 * utils/eventTombstones.js specifically so it could be tested directly, same
 * precedent as taskTombstones.js.
 */
import { describe, it, expect } from 'vitest';
import { tombstoneEvents, isStaleEventTombstone } from '../../src/utils/eventTombstones.js';

describe('tombstoneEvents', () => {
  it('tombstones the target event: stamps deletedAt/localUpdatedAt and clears heavy content fields', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const events = [
      {
        id: 'e1',
        title: 'Team sync',
        description: 'Weekly planning notes',
        location: 'Room 4B',
      },
    ];
    const result = tombstoneEvents(events, new Set(['e1']), now);
    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.deletedAt).toBe(now);
    expect(e.localUpdatedAt).toBe(now);
    // Heavy/private content cleared.
    expect(e.description).toBeNull();
    expect(e.location).toBeNull();
    // Harmless fields kept — id/title survive so the undo toast can still
    // display the event's name.
    expect(e.id).toBe('e1');
    expect(e.title).toBe('Team sync');
  });

  it('tombstones every id in the delete set (e.g. a synthetic-series fan-out), leaving unrelated events untouched', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const events = [
      { id: 'occ1', title: 'Series occurrence 1', seriesId: 'series-a' },
      { id: 'occ2', title: 'Series occurrence 2', seriesId: 'series-a' },
      { id: 'unrelated', title: 'Unrelated event' },
    ];
    const result = tombstoneEvents(events, new Set(['occ1', 'occ2']), now);
    const byId = new Map(result.map((e) => [e.id, e]));
    expect(byId.get('occ1').deletedAt).toBe(now);
    expect(byId.get('occ2').deletedAt).toBe(now);
    expect(byId.get('unrelated').deletedAt).toBeUndefined();
  });

  it('accepts a plain array as well as a Set for idsToDelete', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const events = [{ id: 'e1' }];
    const result = tombstoneEvents(events, ['e1'], now);
    expect(result[0].deletedAt).toBe(now);
  });

  it('is a no-op pass-through for an event not in the delete set', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const event = { id: 'e1', title: 'Untouched' };
    const result = tombstoneEvents([event], new Set(['other']), now);
    expect(result[0]).toBe(event); // same reference — no unnecessary spread
  });

  it('preserves other fields untouched — googleEventId, date/times, source, etc. stay for debugging/sync', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const events = [
      {
        id: 'e1',
        title: 'Standup',
        date: '2026-08-12',
        startTime: '09:00',
        endTime: '09:15',
        source: 'google',
        googleEventId: 'g123',
      },
    ];
    const result = tombstoneEvents(events, new Set(['e1']), now);
    expect(result[0].date).toBe('2026-08-12');
    expect(result[0].startTime).toBe('09:00');
    expect(result[0].endTime).toBe('09:15');
    expect(result[0].source).toBe('google');
    expect(result[0].googleEventId).toBe('g123');
  });
});

describe('isStaleEventTombstone', () => {
  const RETENTION_DAYS = 30;
  const nowMs = new Date('2026-08-12T00:00:00.000Z').getTime();

  it('is false for an event with no deletedAt', () => {
    expect(isStaleEventTombstone({ id: 'e1' }, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is false for a tombstone younger than the retention window', () => {
    const recentlyDeleted = { id: 'e1', deletedAt: new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEventTombstone(recentlyDeleted, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is true for a tombstone older than the retention window', () => {
    const longDeleted = { id: 'e1', deletedAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEventTombstone(longDeleted, RETENTION_DAYS, nowMs)).toBe(true);
  });

  it('treats exactly the retention boundary as not-yet-stale (strict less-than, matching computeCutoffMs)', () => {
    const exactlyAtCutoff = { id: 'e1', deletedAt: new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEventTombstone(exactlyAtCutoff, RETENTION_DAYS, nowMs)).toBe(false);
  });
});

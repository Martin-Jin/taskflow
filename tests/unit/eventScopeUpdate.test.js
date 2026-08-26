/**
 * ============================================================================
 * eventScopeUpdate — 'this'/'following'/'all' scope fan-out coverage
 * ============================================================================
 * applyEventScopeUpdate/splitSeriesAtOccurrence power updateEvent/
 * setEventIgnored/deleteEvent's scope semantics (see SchedulerContext.jsx).
 * The focus here is a specific regression: a 'this'-scope edit on a
 * true-RRULE occurrence only ever folds `stamped` into the master row's
 * per-occurrence `overrides` entry — never onto the master's own top-level
 * fields, since the edit only concerns that one date. But
 * mergeEventsByUpdatedAt (see eventMerge.js) decides which device's copy of
 * the WHOLE ROW wins a cross-device merge purely by comparing the master's
 * own top-level `localUpdatedAt` — it has no visibility into the nested
 * `overrides` map. Without the master's top-level `localUpdatedAt` also
 * moving on a 'this'-scope edit, that edit would be structurally invisible
 * to the merge: a genuinely fresh occurrence-level edit could lose to (or be
 * silently outranked by) an unrelated, actually-older edit on another device
 * that happens to carry a newer top-level stamp.
 */
import { describe, it, expect } from 'vitest';
import { applyEventScopeUpdate, splitSeriesAtOccurrence } from '../../src/utils/eventScopeUpdate.js';
import { mergeEventsByUpdatedAt } from '../../src/utils/eventMerge.js';

const trueRruleMaster = (overrides = {}) => ({
  id: 'series-master',
  title: 'Standup',
  date: '2026-08-01',
  startTime: '09:00',
  endTime: '09:15',
  isRecurring: true,
  seriesId: 'series-master',
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
  localUpdatedAt: '2026-08-01T00:00:00.000Z',
  overrides: {},
  ...overrides,
});

describe("applyEventScopeUpdate: scope 'this' on a true-RRULE occurrence", () => {
  it('folds stamped fields into the per-occurrence override', () => {
    const master = trueRruleMaster();
    const stamped = { title: 'Standup (moved)', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const { events } = applyEventScopeUpdate([master], `${master.id}::2026-08-10`, stamped, 'this');
    const updated = events.find((e) => e.id === master.id);
    expect(updated.overrides['2026-08-10']).toMatchObject({ title: 'Standup (moved)', localUpdatedAt: '2026-08-10T00:00:00.000Z' });
    // The master's own top-level title is untouched — only this one date changed.
    expect(updated.title).toBe('Standup');
  });

  it("also bumps the master row's own top-level localUpdatedAt, not just the override's", () => {
    const master = trueRruleMaster({ localUpdatedAt: '2026-08-01T00:00:00.000Z' });
    const stamped = { deleted: true, localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const { events } = applyEventScopeUpdate([master], `${master.id}::2026-08-10`, stamped, 'this');
    const updated = events.find((e) => e.id === master.id);
    expect(updated.localUpdatedAt).toBe('2026-08-10T00:00:00.000Z');
  });

  it('never touches pushTargets — a this-scope true-RRULE edit is local-only', () => {
    const master = trueRruleMaster();
    const { pushTargets } = applyEventScopeUpdate([master], `${master.id}::2026-08-10`, { localUpdatedAt: '2026-08-10T00:00:00.000Z' }, 'this');
    expect(pushTargets).toEqual([]);
  });

  it('REGRESSION: without the top-level stamp, a this-scope edit would be invisible to the cross-device merge and could be lost', () => {
    // This test demonstrates the bug this fix closes, by simulating what
    // would happen if applyEventScopeUpdate did NOT bump the master's own
    // top-level localUpdatedAt (i.e. only the override carried it).
    const staleMasterMissingTopLevelStamp = {
      ...trueRruleMaster(),
      // Simulates the pre-fix shape: the override has the fresh edit, but
      // the row's own top-level localUpdatedAt is still the OLD value.
      localUpdatedAt: '2026-08-01T00:00:00.000Z',
      overrides: { '2026-08-10': { title: 'Edited locally', localUpdatedAt: '2026-08-10T00:00:00.000Z' } },
    };
    // A remote copy with an unrelated, genuinely OLDER edit, but a top-level
    // stamp that's newer than the local row's stale top-level stamp above.
    const remoteWithNewerTopLevelStamp = {
      ...trueRruleMaster(),
      title: 'Standup (renamed elsewhere, actually older in wall-clock terms)',
      localUpdatedAt: '2026-08-05T00:00:00.000Z',
    };
    const merged = mergeEventsByUpdatedAt([staleMasterMissingTopLevelStamp], [remoteWithNewerTopLevelStamp]);
    // Without the fix, the remote row wins the whole-row comparison (its
    // 08-05 stamp beats local's stale 08-01 stamp) and the 'this'-scope
    // edit's override is silently discarded — even though the override
    // itself carries a fresher 08-10 timestamp than the winning row's 08-05.
    expect(merged[0]).toBe(remoteWithNewerTopLevelStamp);
    expect(merged[0].overrides?.['2026-08-10']).toBeUndefined();

    // Now confirm the ACTUAL applyEventScopeUpdate output (which DOES bump
    // the top-level stamp) doesn't have this problem: the same merge against
    // the same remote row correctly keeps the local edit, because the local
    // row's top-level stamp now genuinely reflects when it was last touched.
    const { events } = applyEventScopeUpdate(
      [trueRruleMaster({ localUpdatedAt: '2026-08-01T00:00:00.000Z' })],
      'series-master::2026-08-10',
      { title: 'Edited locally', localUpdatedAt: '2026-08-10T00:00:00.000Z' },
      'this'
    );
    const fixedLocal = events[0];
    const mergedFixed = mergeEventsByUpdatedAt([fixedLocal], [remoteWithNewerTopLevelStamp]);
    expect(mergedFixed[0]).toBe(fixedLocal);
    expect(mergedFixed[0].overrides['2026-08-10'].title).toBe('Edited locally');
  });
});

describe("applyEventScopeUpdate: scope 'all'/'following' on a true-RRULE series", () => {
  // resolveEventId is what determines "is this id a true-RRULE occurrence at
  // all" — it only inspects the id's own shape (a `${masterId}::${date}`
  // virtual id vs. a bare row id), not the scope. So even an 'all'/'following'
  // edit on a true-RRULE series must be called with a virtual id, exactly
  // like a 'this'-scope edit — the caller always passes the SAME eventId
  // regardless of scope (see updateEvent's own single call site).
  it("scope 'all' stamps the master's top-level fields directly and pushes it", () => {
    const master = trueRruleMaster();
    const stamped = { title: 'Renamed', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const { events, pushTargets } = applyEventScopeUpdate([master], `${master.id}::2026-08-10`, stamped, 'all');
    expect(events.find((e) => e.id === master.id)).toMatchObject({ title: 'Renamed', localUpdatedAt: '2026-08-10T00:00:00.000Z' });
    expect(pushTargets).toHaveLength(1);
    expect(pushTargets[0].title).toBe('Renamed');
  });

  it("scope 'following' splits the series and stamps both resulting rows via splitSeriesAtOccurrence", () => {
    const master = trueRruleMaster();
    const stamped = { isFreeTime: true, localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const { events, pushTargets } = applyEventScopeUpdate([master], `${master.id}::2026-08-10`, stamped, 'following', 'new-master-id');
    expect(events).toHaveLength(2);
    const newMaster = events.find((e) => e.id === 'new-master-id');
    expect(newMaster.isFreeTime).toBe(true);
    expect(newMaster.localUpdatedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(pushTargets).toHaveLength(2);
  });
});

describe('applyEventScopeUpdate: non-recurring / synthetic-series events', () => {
  it('a plain non-recurring event is stamped directly', () => {
    const event = { id: 'manual-1', title: 'One-off', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const { events, pushTargets } = applyEventScopeUpdate([event], 'manual-1', { title: 'Renamed', localUpdatedAt: '2026-08-10T00:00:00.000Z' }, 'this');
    expect(events[0].title).toBe('Renamed');
    expect(pushTargets).toHaveLength(1);
  });

  it("a synthetic series' 'all' scope fans out across every row sharing seriesId", () => {
    const occ1 = { id: 'occ1', seriesId: 'synthetic-a', date: '2026-08-01', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const occ2 = { id: 'occ2', seriesId: 'synthetic-a', date: '2026-08-08', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const stamped = { isFreeTime: true, localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const { events, pushTargets } = applyEventScopeUpdate([occ1, occ2], 'occ1', stamped, 'all');
    expect(events.every((e) => e.isFreeTime === true)).toBe(true);
    // A synthetic series has no single master row to push — each row pushes
    // independently elsewhere in the caller, not via this function's own
    // pushTargets.
    expect(pushTargets).toEqual([]);
  });
});

describe('splitSeriesAtOccurrence', () => {
  it('truncates the old master and carries only >= occurrenceDate overrides onto the new one', () => {
    const master = trueRruleMaster({
      overrides: {
        '2026-07-15': { title: 'Before split' },
        '2026-08-15': { title: 'After split' },
      },
    });
    const { newMaster, updatedOldMaster } = splitSeriesAtOccurrence([master], master, '2026-08-10', { title: 'New title' }, 'new-id');
    expect(updatedOldMaster.recurrenceRule).toContain('UNTIL');
    expect(newMaster.id).toBe('new-id');
    expect(newMaster.seriesId).toBe('new-id');
    expect(newMaster.overrides['2026-07-15']).toBeUndefined();
    expect(newMaster.overrides['2026-08-15']).toEqual({ title: 'After split' });
  });
});

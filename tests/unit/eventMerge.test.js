/**
 * ============================================================================
 * eventMerge — per-event cross-device merge decision coverage
 * ============================================================================
 * mergeEventsByUpdatedAt is the CalendarEvent counterpart to
 * mergeTasksByUpdatedAt (taskMerge.test.js) — see useCloudSync.test.js for
 * coverage of how this plugs into planRemoteDataMerge itself.
 */
import { describe, it, expect } from 'vitest';
import { mergeEventsByUpdatedAt } from '../../src/utils/eventMerge.js';

describe('mergeEventsByUpdatedAt', () => {
  it('both sides agree (identical event): no-op, returns an equivalent event', () => {
    const event = { id: 'e1', title: 'Standup', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([event], [{ ...event }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(event);
  });

  it('local newer wins', () => {
    const local = { id: 'e1', title: 'Local edit', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const remote = { id: 'e1', title: 'Remote edit', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('remote newer wins', () => {
    const local = { id: 'e1', title: 'Local edit', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const remote = { id: 'e1', title: 'Remote edit', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([local], [remote]);
    expect(result).toEqual([remote]);
  });

  it('an event only on the local side is kept (union) — e.g. a brand new event not yet pulled by the other device', () => {
    const onlyLocal = { id: 'e-new', title: 'Just created here', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([onlyLocal], []);
    expect(result).toEqual([onlyLocal]);
  });

  it('an event only on the remote side is kept (union) — e.g. a brand new event not yet pushed by this device', () => {
    const onlyRemote = { id: 'e-new', title: 'Just created elsewhere', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([], [onlyRemote]);
    expect(result).toEqual([onlyRemote]);
  });

  it('a tombstone with a newer localUpdatedAt than a live edit: deletion wins', () => {
    const localTombstone = {
      id: 'e1',
      title: 'Deleted event',
      deletedAt: '2026-08-12T00:00:00.000Z',
      localUpdatedAt: '2026-08-12T00:00:00.000Z',
      description: null,
    };
    // A stale remote copy from a device that never saw the delete — an older
    // edit to content that has since been deleted locally.
    const staleRemoteEdit = { id: 'e1', title: 'Moved before deletion', localUpdatedAt: '2026-08-11T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([localTombstone], [staleRemoteEdit]);
    // No special-case branching needed: the tombstone's localUpdatedAt is
    // simply newer, so the plain comparison already produces the right answer.
    expect(result).toEqual([localTombstone]);
    expect(result[0].deletedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('a live edit with a newer localUpdatedAt than a tombstone: the edit wins and the event "un-deletes" — CORRECT behavior', () => {
    // Not a bug: mirrors mergeTasksByUpdatedAt's identical precedent — this is
    // what should happen when the user undoes the delete, or deliberately
    // recreates similar content after deleting it with a later edit timestamp.
    const oldTombstone = { id: 'e1', title: 'Deleted event', deletedAt: '2026-08-10T00:00:00.000Z', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const laterUndo = { id: 'e1', title: 'Restored event', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([oldTombstone], [laterUndo]);
    expect(result).toEqual([laterUndo]);
    expect(result[0].deletedAt).toBeUndefined();
  });

  it('missing localUpdatedAt on the remote side only: local (the side with a valid timestamp) counts as newer', () => {
    const local = { id: 'e1', title: 'Local', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const remoteMissingTimestamp = { id: 'e1', title: 'Remote, no localUpdatedAt' };
    const result = mergeEventsByUpdatedAt([local], [remoteMissingTimestamp]);
    expect(result).toEqual([local]);
  });

  it('missing localUpdatedAt on the local side only: remote (the side with a valid timestamp) counts as newer', () => {
    const localMissingTimestamp = { id: 'e1', title: 'Local, no localUpdatedAt' };
    const remote = { id: 'e1', title: 'Remote', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([localMissingTimestamp], [remote]);
    expect(result).toEqual([remote]);
  });

  it('unparseable localUpdatedAt string is treated the same as missing', () => {
    const local = { id: 'e1', title: 'Local', localUpdatedAt: 'not-a-date' };
    const remote = { id: 'e1', title: 'Remote', localUpdatedAt: '2026-08-01T00:00:00.000Z' };
    const result = mergeEventsByUpdatedAt([local], [remote]);
    expect(result).toEqual([remote]);
  });

  it('both sides missing/invalid localUpdatedAt: defensive fallback keeps local without crashing', () => {
    const local = { id: 'e1', title: 'Local, no timestamp' };
    const remote = { id: 'e1', title: 'Remote, no timestamp' };
    expect(() => mergeEventsByUpdatedAt([local], [remote])).not.toThrow();
    const result = mergeEventsByUpdatedAt([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('both arrays empty: returns an empty array', () => {
    expect(mergeEventsByUpdatedAt([], [])).toEqual([]);
  });

  it('local empty, remote populated: returns remote events as-is (union)', () => {
    const remote = [{ id: 'e1', localUpdatedAt: '2026-08-01T00:00:00.000Z' }];
    expect(mergeEventsByUpdatedAt([], remote)).toEqual(remote);
  });

  it('remote empty, local populated: returns local events as-is (union)', () => {
    const local = [{ id: 'e1', localUpdatedAt: '2026-08-01T00:00:00.000Z' }];
    expect(mergeEventsByUpdatedAt(local, [])).toEqual(local);
  });

  it('null/undefined inputs are treated as empty arrays, not a crash', () => {
    expect(mergeEventsByUpdatedAt(null, undefined)).toEqual([]);
  });

  it('does not mutate either input array', () => {
    const local = [{ id: 'e1', title: 'Local', localUpdatedAt: '2026-08-10T00:00:00.000Z' }];
    const remote = [{ id: 'e1', title: 'Remote', localUpdatedAt: '2026-08-12T00:00:00.000Z' }];
    const localCopy = JSON.parse(JSON.stringify(local));
    const remoteCopy = JSON.parse(JSON.stringify(remote));
    mergeEventsByUpdatedAt(local, remote);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
  });

  it('returns a NEW array, not a reference to either input', () => {
    const local = [{ id: 'e1', localUpdatedAt: '2026-08-10T00:00:00.000Z' }];
    const remote = [{ id: 'e1', localUpdatedAt: '2026-08-12T00:00:00.000Z' }];
    const result = mergeEventsByUpdatedAt(local, remote);
    expect(result).not.toBe(local);
    expect(result).not.toBe(remote);
  });

  it('handles a mix: some ids agree, some local-newer, some remote-newer, some union-only, in one call', () => {
    const local = [
      { id: 'agree', title: 'same', localUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-wins', title: 'local newer', localUpdatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'remote-wins', title: 'local older', localUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-only', title: 'new on local', localUpdatedAt: '2026-08-12T00:00:00.000Z' },
    ];
    const remote = [
      { id: 'agree', title: 'same', localUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-wins', title: 'remote older', localUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'remote-wins', title: 'remote newer', localUpdatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'remote-only', title: 'new on remote', localUpdatedAt: '2026-08-12T00:00:00.000Z' },
    ];
    const result = mergeEventsByUpdatedAt(local, remote);
    const byId = new Map(result.map((e) => [e.id, e]));
    expect(result).toHaveLength(5);
    expect(byId.get('agree').title).toBe('same');
    expect(byId.get('local-wins').title).toBe('local newer');
    expect(byId.get('remote-wins').title).toBe('remote newer');
    expect(byId.get('local-only').title).toBe('new on local');
    expect(byId.get('remote-only').title).toBe('new on remote');
  });
});

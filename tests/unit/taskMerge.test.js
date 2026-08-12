/**
 * ============================================================================
 * taskMerge — per-task cross-device merge decision coverage
 * ============================================================================
 * mergeTasksByUpdatedAt is the fix for a real data-loss bug: planRemoteDataMerge
 * used to treat `tasks` as one atomic value (take one side's whole array), so a
 * device waking up with a stale local copy could push it AFTER a genuinely
 * newer edit from another device and silently overwrite it, purely because its
 * write arrived last. See useCloudSync.test.js for coverage of how this plugs
 * into planRemoteDataMerge itself.
 */
import { describe, it, expect } from 'vitest';
import { mergeTasksByUpdatedAt } from '../../src/utils/taskMerge.js';

describe('mergeTasksByUpdatedAt', () => {
  it('both sides agree (identical task): no-op, returns an equivalent task', () => {
    const task = { id: 't1', title: 'Buy milk', updatedAt: '2026-08-10T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([task], [{ ...task }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(task);
  });

  it('local newer wins', () => {
    const local = { id: 't1', title: 'Local edit', updatedAt: '2026-08-12T00:00:00.000Z' };
    const remote = { id: 't1', title: 'Remote edit', updatedAt: '2026-08-10T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('remote newer wins', () => {
    const local = { id: 't1', title: 'Local edit', updatedAt: '2026-08-10T00:00:00.000Z' };
    const remote = { id: 't1', title: 'Remote edit', updatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([local], [remote]);
    expect(result).toEqual([remote]);
  });

  it('a task only on the local side is kept (union) — e.g. a brand new task not yet pulled by the other device', () => {
    const onlyLocal = { id: 't-new', title: 'Just created here', updatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([onlyLocal], []);
    expect(result).toEqual([onlyLocal]);
  });

  it('a task only on the remote side is kept (union) — e.g. a brand new task not yet pushed by this device', () => {
    const onlyRemote = { id: 't-new', title: 'Just created elsewhere', updatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([], [onlyRemote]);
    expect(result).toEqual([onlyRemote]);
  });

  it('a tombstone with a newer updatedAt than a live edit: deletion wins (the failure mode this fix targets)', () => {
    const localTombstone = {
      id: 't1',
      title: 'Deleted task',
      deletedAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      notes: null,
    };
    // A stale remote copy from a device that never saw the delete — an older
    // edit to content that has since been deleted locally.
    const staleRemoteEdit = { id: 't1', title: 'Reparented before deletion', updatedAt: '2026-08-11T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([localTombstone], [staleRemoteEdit]);
    // No special-case branching needed: the tombstone's updatedAt is simply
    // newer, so the plain comparison already produces the correct outcome.
    expect(result).toEqual([localTombstone]);
    expect(result[0].deletedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('a live edit with a newer updatedAt than a tombstone: the edit wins and the task "un-deletes" — CORRECT behavior', () => {
    // This is not a bug: it's what should happen when the user undoes the
    // delete, or deliberately recreates/restores similar content after
    // deleting it, producing a later edit timestamp than the tombstone's
    // deletedAt/updatedAt. The merge function has no way (and no need) to
    // distinguish this from any other "newer edit wins" case.
    const oldTombstone = { id: 't1', title: 'Deleted task', deletedAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' };
    const laterUndo = { id: 't1', title: 'Restored task', updatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([oldTombstone], [laterUndo]);
    expect(result).toEqual([laterUndo]);
    expect(result[0].deletedAt).toBeUndefined();
  });

  it('missing updatedAt on the remote side only: local (the side with a valid timestamp) counts as newer', () => {
    const local = { id: 't1', title: 'Local', updatedAt: '2026-08-01T00:00:00.000Z' };
    const remoteMissingTimestamp = { id: 't1', title: 'Remote, no updatedAt' };
    const result = mergeTasksByUpdatedAt([local], [remoteMissingTimestamp]);
    expect(result).toEqual([local]);
  });

  it('missing updatedAt on the local side only: remote (the side with a valid timestamp) counts as newer', () => {
    const localMissingTimestamp = { id: 't1', title: 'Local, no updatedAt' };
    const remote = { id: 't1', title: 'Remote', updatedAt: '2026-08-01T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([localMissingTimestamp], [remote]);
    expect(result).toEqual([remote]);
  });

  it('unparseable updatedAt string is treated the same as missing', () => {
    const local = { id: 't1', title: 'Local', updatedAt: 'not-a-date' };
    const remote = { id: 't1', title: 'Remote', updatedAt: '2026-08-01T00:00:00.000Z' };
    const result = mergeTasksByUpdatedAt([local], [remote]);
    expect(result).toEqual([remote]);
  });

  it('both sides missing/invalid updatedAt: defensive fallback keeps local without crashing', () => {
    const local = { id: 't1', title: 'Local, no timestamp' };
    const remote = { id: 't1', title: 'Remote, no timestamp' };
    expect(() => mergeTasksByUpdatedAt([local], [remote])).not.toThrow();
    const result = mergeTasksByUpdatedAt([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('both arrays empty: returns an empty array', () => {
    expect(mergeTasksByUpdatedAt([], [])).toEqual([]);
  });

  it('local empty, remote populated: returns remote tasks as-is (union)', () => {
    const remote = [{ id: 't1', updatedAt: '2026-08-01T00:00:00.000Z' }];
    expect(mergeTasksByUpdatedAt([], remote)).toEqual(remote);
  });

  it('remote empty, local populated: returns local tasks as-is (union)', () => {
    const local = [{ id: 't1', updatedAt: '2026-08-01T00:00:00.000Z' }];
    expect(mergeTasksByUpdatedAt(local, [])).toEqual(local);
  });

  it('null/undefined inputs are treated as empty arrays, not a crash', () => {
    expect(mergeTasksByUpdatedAt(null, undefined)).toEqual([]);
  });

  it('does not mutate either input array', () => {
    const local = [{ id: 't1', title: 'Local', updatedAt: '2026-08-10T00:00:00.000Z' }];
    const remote = [{ id: 't1', title: 'Remote', updatedAt: '2026-08-12T00:00:00.000Z' }];
    const localCopy = JSON.parse(JSON.stringify(local));
    const remoteCopy = JSON.parse(JSON.stringify(remote));
    mergeTasksByUpdatedAt(local, remote);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
  });

  it('returns a NEW array, not a reference to either input', () => {
    const local = [{ id: 't1', updatedAt: '2026-08-10T00:00:00.000Z' }];
    const remote = [{ id: 't1', updatedAt: '2026-08-12T00:00:00.000Z' }];
    const result = mergeTasksByUpdatedAt(local, remote);
    expect(result).not.toBe(local);
    expect(result).not.toBe(remote);
  });

  it('handles a mix: some ids agree, some local-newer, some remote-newer, some union-only, in one call', () => {
    const local = [
      { id: 'agree', title: 'same', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-wins', title: 'local newer', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'remote-wins', title: 'local older', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-only', title: 'new on local', updatedAt: '2026-08-12T00:00:00.000Z' },
    ];
    const remote = [
      { id: 'agree', title: 'same', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'local-wins', title: 'remote older', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'remote-wins', title: 'remote newer', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'remote-only', title: 'new on remote', updatedAt: '2026-08-12T00:00:00.000Z' },
    ];
    const result = mergeTasksByUpdatedAt(local, remote);
    const byId = new Map(result.map((t) => [t.id, t]));
    expect(result).toHaveLength(5);
    expect(byId.get('agree').title).toBe('same');
    expect(byId.get('local-wins').title).toBe('local newer');
    expect(byId.get('remote-wins').title).toBe('remote newer');
    expect(byId.get('local-only').title).toBe('new on local');
    expect(byId.get('remote-only').title).toBe('new on remote');
  });
});

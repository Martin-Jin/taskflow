/**
 * ============================================================================
 * entityMerge — shared per-entity merge helper coverage
 * ============================================================================
 * mergeEntitiesByTimestamp is the generic form of taskMerge.js's
 * mergeTasksByUpdatedAt and eventMerge.js's mergeEventsByUpdatedAt (both now
 * thin wrappers over it — see this suite plus taskMerge.test.js/
 * eventMerge.test.js, all three of which must keep passing). pickNewerScalar
 * is the companion rule for whole-value fields (settings, small arrays with
 * no per-item identity) compared via a separate sidecar timestamp instead of
 * a timestamp living on the value itself — see useCloudSync.js's
 * `fieldUpdatedAt` map.
 */
import { describe, it, expect } from 'vitest';
import { mergeEntitiesByTimestamp, pickNewerScalar } from '../../src/utils/entityMerge.js';

describe('mergeEntitiesByTimestamp', () => {
  it('defaults to `updatedAt` as the timestamp field', () => {
    const local = { id: 's1', name: 'Local', updatedAt: '2026-08-12T00:00:00.000Z' };
    const remote = { id: 's1', name: 'Remote', updatedAt: '2026-08-10T00:00:00.000Z' };
    const result = mergeEntitiesByTimestamp([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('uses a custom timestamp field when given one', () => {
    const local = { id: 'e1', name: 'Local', localUpdatedAt: '2026-08-10T00:00:00.000Z' };
    const remote = { id: 'e1', name: 'Remote', localUpdatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEntitiesByTimestamp([local], [remote], { timestampField: 'localUpdatedAt' });
    expect(result).toEqual([remote]);
  });

  it('keeps a row present on only one side (union)', () => {
    const onlyLocal = { id: 'p-new', name: 'New project', updatedAt: '2026-08-12T00:00:00.000Z' };
    const onlyRemote = { id: 'p-other', name: 'Other project', updatedAt: '2026-08-11T00:00:00.000Z' };
    const result = mergeEntitiesByTimestamp([onlyLocal], [onlyRemote]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([onlyLocal, onlyRemote]));
  });

  it('a tie keeps local', () => {
    const local = { id: 'l1', name: 'Local', updatedAt: '2026-08-12T00:00:00.000Z' };
    const remote = { id: 'l1', name: 'Remote', updatedAt: '2026-08-12T00:00:00.000Z' };
    const result = mergeEntitiesByTimestamp([local], [remote]);
    expect(result).toEqual([local]);
  });

  it('missing timestamp on one side only: the side with a valid timestamp counts as newer', () => {
    const local = { id: 'l1', name: 'Local', updatedAt: '2026-08-12T00:00:00.000Z' };
    const remoteNoStamp = { id: 'l1', name: 'Remote' };
    expect(mergeEntitiesByTimestamp([local], [remoteNoStamp])).toEqual([local]);

    const localNoStamp = { id: 'l1', name: 'Local' };
    const remote = { id: 'l1', name: 'Remote', updatedAt: '2026-08-12T00:00:00.000Z' };
    expect(mergeEntitiesByTimestamp([localNoStamp], [remote])).toEqual([remote]);
  });

  it('both sides missing/invalid timestamp: keeps local without crashing', () => {
    const local = { id: 'l1', name: 'Local' };
    const remote = { id: 'l1', name: 'Remote', updatedAt: 'not-a-date' };
    expect(mergeEntitiesByTimestamp([local], [remote])).toEqual([local]);
  });

  it('null/undefined inputs are treated as empty arrays', () => {
    expect(mergeEntitiesByTimestamp(null, undefined)).toEqual([]);
  });

  it('does not mutate either input array and returns a new array', () => {
    const local = [{ id: 'a', updatedAt: '2026-08-10T00:00:00.000Z' }];
    const remote = [{ id: 'a', updatedAt: '2026-08-11T00:00:00.000Z' }];
    const localCopy = JSON.parse(JSON.stringify(local));
    const remoteCopy = JSON.parse(JSON.stringify(remote));
    const result = mergeEntitiesByTimestamp(local, remote);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
    expect(result).not.toBe(local);
    expect(result).not.toBe(remote);
  });
});

describe('pickNewerScalar', () => {
  it('newer timestamp wins', () => {
    expect(pickNewerScalar('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z')).toBe('remote');
    expect(pickNewerScalar('2026-08-12T00:00:00.000Z', '2026-08-10T00:00:00.000Z')).toBe('local');
  });

  it('a tie keeps local', () => {
    expect(pickNewerScalar('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')).toBe('local');
  });

  it('only one side has a valid timestamp: that side wins', () => {
    expect(pickNewerScalar(null, '2026-08-12T00:00:00.000Z')).toBe('remote');
    expect(pickNewerScalar('2026-08-12T00:00:00.000Z', null)).toBe('local');
    expect(pickNewerScalar(undefined, '2026-08-12T00:00:00.000Z')).toBe('remote');
  });

  it('neither side has a valid timestamp: remote wins (matches pre-sidecar pickValid behavior)', () => {
    expect(pickNewerScalar(null, null)).toBe('remote');
    expect(pickNewerScalar(undefined, undefined)).toBe('remote');
    expect(pickNewerScalar('not-a-date', 'also-not-a-date')).toBe('remote');
  });
});

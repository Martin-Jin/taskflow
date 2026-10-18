/**
 * Two-device edit conflicts (src/utils/editConflicts.js) and the sync-merge
 * paths that build on it: the losing edit lands in Trash, and saved views,
 * templates and trash entries merge item by item instead of whole-list.
 */

import { describe, it, expect, vi } from 'vitest';
import { findOverwrittenEdits, syncBaseFromRows, advanceSyncBaseAfterMerge } from '../../src/utils/editConflicts.js';
import { mergeTasksByUpdatedAt } from '../../src/utils/taskMerge.js';
import { planRemoteDataMerge } from '../../src/hooks/useCloudSync.js';
import { stampChangedEntitiesAndSet } from '../../src/hooks/usePersistedState.js';
import {
  buildOverwrittenEditTrashEntry,
  planTrashRestore,
  pruneTrash,
  dropTrashTombstones,
  describeTrashEntry,
  TRASH_RETENTION_DAYS,
} from '../../src/utils/trash.js';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-03T00:00:00.000Z';
const task = (overrides) => ({ id: 't1', title: 'Write report', updatedAt: T0, ...overrides });

function conflicts(local, remote, base) {
  const merged = mergeTasksByUpdatedAt([local], [remote]);
  return findOverwrittenEdits({ localRows: [local], remoteRows: [remote], mergedRows: merged, base, timestampField: 'updatedAt' });
}

describe('findOverwrittenEdits', () => {
  it('both devices edited since they last agreed: the older edit is the loser', () => {
    const local = task({ title: 'Edited here', updatedAt: T1 });
    const remote = task({ title: 'Edited there', updatedAt: T2 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([local]);
  });

  it('the remote loses when the local edit is newer', () => {
    const local = task({ title: 'Edited here', updatedAt: T2 });
    const remote = task({ title: 'Edited there', updatedAt: T1 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([remote]);
  });

  it('a pull carrying the version this device edited FROM is not a conflict', () => {
    const local = task({ title: 'Edited here', updatedAt: T1 });
    const remote = task({ updatedAt: T0 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([]);
  });

  it('only the other device edited: ordinary sync, not a conflict', () => {
    const local = task({ updatedAt: T0 });
    const remote = task({ title: 'Edited there', updatedAt: T1 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([]);
  });

  it('the same change on both devices is not a conflict, whatever the edit times', () => {
    expect(conflicts(task({ title: 'Same', updatedAt: T1 }), task({ title: 'Same', updatedAt: T2 }), { t1: T0 })).toEqual([]);
  });

  it('no base yet (first sync on this device): never a conflict', () => {
    expect(conflicts(task({ title: 'A', updatedAt: T1 }), task({ title: 'B', updatedAt: T2 }), {})).toEqual([]);
  });

  it('a delete that loses is not kept — there is no edit to restore', () => {
    const local = task({ deletedAt: T1, updatedAt: T1 });
    const remote = task({ title: 'Edited there', updatedAt: T2 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([]);
  });

  it('an edit that loses to a delete is kept, so the item can be brought back', () => {
    const local = task({ title: 'Edited here', updatedAt: T1 });
    const remote = task({ deletedAt: T2, updatedAt: T2 });
    expect(conflicts(local, remote, { t1: T0 })).toEqual([local]);
  });
});

describe('sync base', () => {
  it('after a push, every pushed row is the agreed version', () => {
    expect(syncBaseFromRows([task({ updatedAt: T1 }), { id: 'x' }], 'updatedAt')).toEqual({ t1: T1 });
  });

  it('after a pull, only rows that took the cloud version advance', () => {
    const remote = [task({ updatedAt: T2 }), { id: 't2', updatedAt: T1 }];
    const merged = [task({ updatedAt: T2 }), { id: 't2', updatedAt: T2 }];
    expect(advanceSyncBaseAfterMerge({ t1: T0, t2: T0 }, remote, merged, 'updatedAt')).toEqual({ t1: T2, t2: T0 });
  });
});

describe('planRemoteDataMerge — conflicts and per-item lists', () => {
  it('reports the losing side of a two-device task edit', () => {
    const local = task({ title: 'Edited here', updatedAt: T1 });
    const remote = task({ title: 'Edited there', updatedAt: T2 });
    const plan = planRemoteDataMerge({ tasks: [remote], blocks: [] }, { tasks: [local], blocks: [] }, { syncBase: { tasks: { t1: T0 }, events: {} } });
    expect(plan.overwrittenEdits).toEqual([{ entity: 'task', row: local }]);
  });

  it('reports a losing event edit too', () => {
    const ev = (o) => ({ id: 'e1', title: 'Meeting', localUpdatedAt: T0, ...o });
    const local = ev({ title: 'Moved here', localUpdatedAt: T1 });
    const remote = ev({ title: 'Moved there', localUpdatedAt: T2 });
    const plan = planRemoteDataMerge({ events: [remote] }, { events: [local] }, { syncBase: { tasks: {}, events: { e1: T0 } } });
    expect(plan.overwrittenEdits).toEqual([{ entity: 'event', row: local }]);
  });

  it('a template added on each device before they synced keeps both', () => {
    const mine = { id: 'tpl_a', name: 'Mine', updatedAt: T1 };
    const theirs = { id: 'tpl_b', name: 'Theirs', updatedAt: T2 };
    const plan = planRemoteDataMerge({ taskTemplates: [theirs] }, { taskTemplates: [mine] });
    expect(plan.taskTemplates.map((t) => t.id).sort()).toEqual(['tpl_a', 'tpl_b']);
  });

  it('a removed saved view stays removed when another device still has it', () => {
    const tombstone = { id: 'v1', name: 'Overdue', deletedAt: T2, updatedAt: T2 };
    const stale = { id: 'v1', name: 'Overdue', updatedAt: T0 };
    const plan = planRemoteDataMerge({ savedViews: [stale] }, { savedViews: [tombstone] });
    expect(plan.savedViews).toEqual([tombstone]);
  });

  it('trash entries from each device are kept together', () => {
    const a = { id: 'tr_a', kind: 'label', deletedAt: 1, updatedAt: T1 };
    const b = { id: 'tr_b', kind: 'label', deletedAt: 2, updatedAt: T2 };
    const plan = planRemoteDataMerge({ trash: [b] }, { trash: [a] });
    expect(plan.trash).toHaveLength(2);
  });
});

describe('stampChangedEntitiesAndSet — removals become tombstones', () => {
  it('a removed row is kept as a stamped tombstone', () => {
    const ref = { current: [{ id: 'a', name: 'A', updatedAt: T0 }, { id: 'b', name: 'B', updatedAt: T0 }] };
    const set = vi.fn();
    stampChangedEntitiesAndSet(ref, set, (prev) => prev.filter((r) => r.id !== 'a'), { tombstoneField: 'deletedAt' });
    const [result] = set.mock.calls[0];
    const a = result.find((r) => r.id === 'a');
    expect(a.deletedAt).toBeTruthy();
    expect(a.updatedAt).toBe(a.deletedAt);
    expect(result.find((r) => r.id === 'b')).toEqual({ id: 'b', name: 'B', updatedAt: T0 });
  });

  it('an existing tombstone missing from the new list is carried forward unchanged', () => {
    const tomb = { id: 'a', name: 'A', deletedAt: T1, updatedAt: T1 };
    const ref = { current: [tomb, { id: 'b', name: 'B', updatedAt: T0 }] };
    const set = vi.fn();
    stampChangedEntitiesAndSet(ref, set, [{ id: 'b', name: 'B', updatedAt: T0 }], { tombstoneField: 'deletedAt' });
    expect(set.mock.calls[0][0]).toContainEqual(tomb);
  });

  it('without the option, a removal is still a plain removal (sections/projects/labels)', () => {
    const ref = { current: [{ id: 'a', updatedAt: T0 }] };
    const set = vi.fn();
    stampChangedEntitiesAndSet(ref, set, []);
    expect(set.mock.calls[0][0]).toEqual([]);
  });
});

describe('trash — overwritten edits and removal tombstones', () => {
  const NOW = Date.parse('2026-10-18T00:00:00.000Z');

  it('builds an edit entry holding the whole losing row', () => {
    const row = task({ title: 'Edited here' });
    const entry = buildOverwrittenEditTrashEntry({ entity: 'task', row, nowMs: NOW, makeId: () => 'tr1' });
    expect(entry).toEqual({ id: 'tr1', kind: 'edit', entity: 'task', name: 'Edited here', deletedAt: NOW, row });
    expect(describeTrashEntry(entry)).toMatch(/^Task · /);
  });

  it('restoring an edit hands back the saved version', () => {
    const row = task({ title: 'Edited here' });
    const plan = planTrashRestore({ kind: 'edit', entity: 'task', row }, { tasks: [], projects: [], sections: [], labels: [] });
    expect(plan.ok).toBe(true);
    expect(plan.taskReplacements).toEqual([row]);
  });

  it('pruneTrash leaves removal tombstones alone and out of the cap', () => {
    const live = { id: 'a', deletedAt: NOW - 1000 };
    const removed = { id: 'b', deletedAt: NOW - 2000, removedAt: '2026-10-17T00:00:00.000Z' };
    expect(pruneTrash([removed, live], NOW)).toEqual([live, removed]);
  });

  it('removal tombstones are dropped once past the retention window', () => {
    const old = { id: 'a', removedAt: new Date(NOW - (TRASH_RETENTION_DAYS + 1) * 86400000).toISOString() };
    const recent = { id: 'b', removedAt: new Date(NOW - 86400000).toISOString() };
    expect(dropTrashTombstones([old, recent, { id: 'c' }], NOW)).toEqual([recent, { id: 'c' }]);
  });
});

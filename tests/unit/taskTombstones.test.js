/**
 * ============================================================================
 * taskTombstones — pure tombstoning + retention-sweep decision coverage
 * ============================================================================
 * Deletion foundation for the (later) per-task cross-device merge. `deleteTask`
 * itself lives inside SchedulerContext.jsx (a hook, not renderable here — see
 * useHistoryState.test.js/useCloudSync.test.js for the same rationale), so the
 * state-shape decision it delegates to was extracted into utils/taskTombstones.js
 * specifically so it could be tested directly, same precedent as
 * useCloudSync.js's computeFingerprint/race-guard functions.
 */
import { describe, it, expect } from 'vitest';
import { tombstoneTasks, isStaleTombstone } from '../../src/utils/taskTombstones.js';

describe('tombstoneTasks', () => {
  it('tombstones the target task: stamps deletedAt/updatedAt and clears heavy content fields', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const tasks = [
      {
        id: 't1',
        title: 'Buy milk',
        notes: 'from the good store',
        noteLinks: [{ url: 'https://example.com', matchedText: 'example.com' }],
        comments: [{ id: 'c1', text: 'hi' }],
        deletedCommentIds: ['c0'],
      },
    ];
    const result = tombstoneTasks(tasks, new Set(['t1']), now);
    expect(result).toHaveLength(1);
    const t = result[0];
    expect(t.deletedAt).toBe(now);
    expect(t.updatedAt).toBe(now);
    // Heavy/private content cleared.
    expect(t.notes).toBeNull();
    expect(t.noteLinks).toEqual([]);
    expect(t.comments).toEqual([]);
    expect(t.deletedCommentIds).toEqual([]);
    // Harmless fields kept — id/title survive for debugging, matching spec.
    expect(t.id).toBe('t1');
    expect(t.title).toBe('Buy milk');
  });

  it('tombstones every id in the cascade set (task + descendants), leaving unrelated tasks untouched', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const tasks = [
      { id: 'parent', title: 'Parent' },
      { id: 'child', title: 'Child', parentId: 'parent' },
      { id: 'unrelated', title: 'Unrelated' },
    ];
    const result = tombstoneTasks(tasks, new Set(['parent', 'child']), now);
    const byId = new Map(result.map((t) => [t.id, t]));
    expect(byId.get('parent').deletedAt).toBe(now);
    expect(byId.get('child').deletedAt).toBe(now);
    expect(byId.get('unrelated').deletedAt).toBeUndefined();
  });

  it('scrubs the deleted ids out of every other task\'s dependsOn and stamps updatedAt on those tasks too', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const tasks = [
      { id: 't1', title: 'Deleted', updatedAt: '2020-01-01T00:00:00.000Z' },
      {
        id: 't2',
        title: 'Depends on t1 and t3',
        dependsOn: ['t1', 't3'],
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
      { id: 't3', title: 'Kept, unrelated dependsOn', dependsOn: [], updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    const result = tombstoneTasks(tasks, new Set(['t1']), now);
    const byId = new Map(result.map((t) => [t.id, t]));
    expect(byId.get('t2').dependsOn).toEqual(['t3']);
    expect(byId.get('t2').updatedAt).toBe(now);
    // Untouched task (no reference to a deleted id, not itself deleted) keeps its own updatedAt.
    expect(byId.get('t3').updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('accepts a plain array as well as a Set for idsToDelete', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const tasks = [{ id: 't1' }];
    const result = tombstoneTasks(tasks, ['t1'], now);
    expect(result[0].deletedAt).toBe(now);
  });

  it('is a no-op pass-through for a task neither deleted nor dependent on anything deleted', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const task = { id: 't1', title: 'Untouched' };
    const result = tombstoneTasks([task], new Set(['other']), now);
    expect(result[0]).toBe(task); // same reference — no unnecessary spread
  });
});

describe('isStaleTombstone', () => {
  const RETENTION_DAYS = 30;
  const nowMs = new Date('2026-08-12T00:00:00.000Z').getTime();

  it('is false for a task with no deletedAt', () => {
    expect(isStaleTombstone({ id: 't1' }, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is false for a tombstone younger than the retention window', () => {
    const recentlyDeleted = { id: 't1', deletedAt: new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleTombstone(recentlyDeleted, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is true for a tombstone older than the retention window', () => {
    const longDeleted = { id: 't1', deletedAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleTombstone(longDeleted, RETENTION_DAYS, nowMs)).toBe(true);
  });

  it('is false for a stale-looking tombstone on a SHARED task — exempt from personal housekeeping', () => {
    const longDeletedShared = {
      id: 't1',
      deletedAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
      sharedProjectId: 'shared_123',
    };
    expect(isStaleTombstone(longDeletedShared, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('treats exactly the retention boundary as not-yet-stale (strict less-than, matching computeCutoffMs)', () => {
    const exactlyAtCutoff = { id: 't1', deletedAt: new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleTombstone(exactlyAtCutoff, RETENTION_DAYS, nowMs)).toBe(false);
  });
});

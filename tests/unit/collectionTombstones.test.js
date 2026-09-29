/**
 * ============================================================================
 * collectionTombstones — pure tombstoning + retention-sweep decision coverage
 * ============================================================================
 * The sections/projects/labels counterpart to taskTombstones.test.js/
 * eventTombstones.test.js. deleteProject/deleteSection/deleteLabel
 * themselves live inside SchedulerContext.jsx (a hook, not renderable here),
 * so the state-shape decision they delegate to was extracted into
 * utils/collectionTombstones.js specifically so it could be tested directly,
 * same precedent as the task/event tombstone files. Only PERSONAL rows ever
 * reach this helper — see collectionTombstones.js's own module doc comment
 * for why a shared project/section is never tombstoned.
 */
import { describe, it, expect } from 'vitest';
import { tombstoneEntities, isStaleEntityTombstone } from '../../src/utils/collectionTombstones.js';

describe('tombstoneEntities', () => {
  it('tombstones the target row: stamps deletedAt/updatedAt, keeps every other field untouched', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const projects = [{ id: 'p1', name: 'Taskflow', order: 1, isPinned: true }];
    const result = tombstoneEntities(projects, new Set(['p1']), now);
    expect(result).toHaveLength(1);
    const p = result[0];
    expect(p.deletedAt).toBe(now);
    expect(p.updatedAt).toBe(now);
    // No content fields cleared — unlike a task/event, a project/section/
    // label has nothing heavy/private worth stripping early.
    expect(p.name).toBe('Taskflow');
    expect(p.order).toBe(1);
    expect(p.isPinned).toBe(true);
  });

  it('tombstones every id in the delete set, leaving unrelated rows untouched', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const sections = [
      { id: 's1', name: 'To Do' },
      { id: 's2', name: 'In Progress' },
      { id: 's3', name: 'Unrelated' },
    ];
    const result = tombstoneEntities(sections, new Set(['s1', 's2']), now);
    const byId = new Map(result.map((s) => [s.id, s]));
    expect(byId.get('s1').deletedAt).toBe(now);
    expect(byId.get('s2').deletedAt).toBe(now);
    expect(byId.get('s3').deletedAt).toBeUndefined();
  });

  it('accepts a plain array as well as a Set for idsToDelete', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const labels = [{ id: 'l1', name: 'urgent' }];
    const result = tombstoneEntities(labels, ['l1'], now);
    expect(result[0].deletedAt).toBe(now);
  });

  it('is a no-op pass-through (same reference) for a row not in the delete set', () => {
    const now = '2026-08-12T00:00:00.000Z';
    const label = { id: 'l1', name: 'Untouched' };
    const result = tombstoneEntities([label], new Set(['other']), now);
    expect(result[0]).toBe(label); // same reference — no unnecessary spread
  });

  it('null/undefined rows are treated as an empty array, not a crash', () => {
    expect(tombstoneEntities(null, new Set(['x']), '2026-08-12T00:00:00.000Z')).toEqual([]);
    expect(tombstoneEntities(undefined, new Set(['x']), '2026-08-12T00:00:00.000Z')).toEqual([]);
  });
});

describe('isStaleEntityTombstone', () => {
  const RETENTION_DAYS = 30;
  const nowMs = new Date('2026-08-12T00:00:00.000Z').getTime();

  it('is false for a row with no deletedAt', () => {
    expect(isStaleEntityTombstone({ id: 'p1' }, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is false for a tombstone younger than the retention window', () => {
    const recentlyDeleted = { id: 'p1', deletedAt: new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEntityTombstone(recentlyDeleted, RETENTION_DAYS, nowMs)).toBe(false);
  });

  it('is true for a tombstone older than the retention window', () => {
    const longDeleted = { id: 'p1', deletedAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEntityTombstone(longDeleted, RETENTION_DAYS, nowMs)).toBe(true);
  });

  it('treats exactly the retention boundary as not-yet-stale (strict less-than, matching computeCutoffMs)', () => {
    const exactlyAtCutoff = { id: 'p1', deletedAt: new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString() };
    expect(isStaleEntityTombstone(exactlyAtCutoff, RETENTION_DAYS, nowMs)).toBe(false);
  });
});

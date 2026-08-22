/**
 * Coverage for saved-view validation. The rejections matter more than the happy
 * path here — each one prevents a view that would be actively unhelpful (a
 * nameless entry, a duplicate name, or an empty query that matches everything
 * the unfiltered list already shows).
 */

import { describe, it, expect } from 'vitest';
import { buildSavedView, sortSavedViews, MAX_SAVED_VIEWS, MAX_SAVED_VIEW_NAME_LENGTH } from '../../src/utils/savedViews';

const existing = (n) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `View ${i}`, query: 'p1' }));

describe('buildSavedView — accepting', () => {
  it('builds a view with a generated id and a timestamp', () => {
    const out = buildSavedView({ name: 'Overdue urgent', query: 'is:overdue p1' });
    expect(out.ok).toBe(true);
    expect(out.view.name).toBe('Overdue urgent');
    expect(out.view.query).toBe('is:overdue p1');
    expect(out.view.id).toBeTruthy();
    expect(typeof out.view.createdAt).toBe('number');
  });

  it('trims surrounding whitespace from both fields', () => {
    const out = buildSavedView({ name: '  Today  ', query: '  due:today  ' });
    expect(out.view.name).toBe('Today');
    expect(out.view.query).toBe('due:today');
  });
});

describe('buildSavedView — rejecting', () => {
  it('refuses a nameless view', () => {
    expect(buildSavedView({ name: '', query: 'p1' }).ok).toBe(false);
    expect(buildSavedView({ name: '   ', query: 'p1' }).error).toMatch(/name/i);
  });

  it('refuses an empty query, which would match everything', () => {
    // A view matching everything is just the unfiltered list.
    const out = buildSavedView({ name: 'Everything', query: '   ' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/search or filter/i);
  });

  it('refuses a duplicate name, case-insensitively', () => {
    const views = [{ id: 'v1', name: 'Overdue', query: 'is:overdue' }];
    expect(buildSavedView({ name: 'Overdue', query: 'p1' }, views).ok).toBe(false);
    expect(buildSavedView({ name: 'overdue', query: 'p1' }, views).ok).toBe(false);
    expect(buildSavedView({ name: 'Overdue p1', query: 'p1' }, views).ok).toBe(true);
  });

  it('refuses an over-long name', () => {
    const out = buildSavedView({ name: 'x'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1), query: 'p1' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(String(MAX_SAVED_VIEW_NAME_LENGTH)));
  });

  it('refuses once the cap is reached, and says how to make room', () => {
    const out = buildSavedView({ name: 'One more', query: 'p1' }, existing(MAX_SAVED_VIEWS));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/delete one/i);
  });

  it('still accepts at one below the cap', () => {
    expect(buildSavedView({ name: 'Fits', query: 'p1' }, existing(MAX_SAVED_VIEWS - 1)).ok).toBe(true);
  });
});

describe('sortSavedViews', () => {
  it('orders alphabetically by name', () => {
    const out = sortSavedViews([
      { id: '1', name: 'Zebra' },
      { id: '2', name: 'apple' },
      { id: '3', name: 'Mango' },
    ]);
    expect(out.map((v) => v.name)).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('does not reorder by recency, so a view keeps its position', () => {
    // A list that rearranges itself as you use it is one you re-read every time.
    const views = [
      { id: '1', name: 'Bravo', createdAt: 1 },
      { id: '2', name: 'Alpha', createdAt: 999 },
    ];
    expect(sortSavedViews(views).map((v) => v.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('does not mutate its input, and tolerates nothing', () => {
    const input = [{ id: '1', name: 'B' }, { id: '2', name: 'A' }];
    sortSavedViews(input);
    expect(input.map((v) => v.name)).toEqual(['B', 'A']);
    expect(sortSavedViews(undefined)).toEqual([]);
  });
});

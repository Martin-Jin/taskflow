import { describe, it, expect } from 'vitest';
import { makeSelectionKey, parseSelectionKey } from '../../src/hooks/useMultiSelect';

describe('makeSelectionKey / parseSelectionKey', () => {
  it('round-trips a plain id', () => {
    const key = makeSelectionKey('block', 'block_123');
    expect(key).toBe('block:block_123');
    expect(parseSelectionKey(key)).toEqual({ kind: 'block', id: 'block_123' });
  });

  it('round-trips an event id that itself contains a colon-free uuid', () => {
    const key = makeSelectionKey('event', 'evt_abc-123');
    expect(parseSelectionKey(key)).toEqual({ kind: 'event', id: 'evt_abc-123' });
  });

  it('correctly splits a VIRTUAL Google event id (masterId::date), which contains its own double-colon', () => {
    // See recurrenceExpansion.resolveEventId — a recurring event's displayed
    // per-occurrence id is `${masterId}::${date}`. The composite selection
    // key wraps that whole virtual id as the "id" half, so parsing must only
    // ever split on the FIRST colon (kind:id), not naively on every colon.
    const virtualEventId = 'evt_master1::2026-08-20';
    const key = makeSelectionKey('event', virtualEventId);
    expect(key).toBe('event:evt_master1::2026-08-20');
    const parsed = parseSelectionKey(key);
    expect(parsed.kind).toBe('event');
    expect(parsed.id).toBe(virtualEventId);
  });

  it('parseSelectionKey handles a bare id with no kind prefix gracefully', () => {
    const parsed = parseSelectionKey('bare-id-no-colon');
    expect(parsed.kind).toBeNull();
    expect(parsed.id).toBe('bare-id-no-colon');
  });
});

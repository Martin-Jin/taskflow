/**
 * ============================================================================
 * firestoreSync — stripUndefined coverage notes
 * ============================================================================
 * `stripUndefined` (src/services/firestoreSync.js) is the defense-in-depth
 * guard `pushUserData` runs every outgoing payload through before writing to
 * Firestore. The Firestore SDK throws synchronously on ANY `undefined` value
 * anywhere in a write payload (including nested in arrays) — this was hit in
 * practice by AI-created tasks missing an optional `priority` field, which
 * TaskDetailModal's edit flow then spread verbatim into an update payload as
 * an explicit `priority: undefined` key. This suite covers the pure helper
 * directly rather than exercising the whole push path (which needs a live
 * Firestore doc reference).
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { stripUndefined } from '../../src/services/firestoreSync.js';

describe('stripUndefined', () => {
  it('omits a top-level key whose value is undefined', () => {
    expect(stripUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('omits an undefined value nested inside an object', () => {
    expect(stripUndefined({ task: { title: 'X', priority: undefined } })).toEqual({ task: { title: 'X' } });
  });

  it('strips undefined out of objects nested inside arrays (e.g. a tasks array)', () => {
    const input = { tasks: [{ id: '1', priority: undefined }, { id: '2', priority: 'high' }] };
    expect(stripUndefined(input)).toEqual({ tasks: [{ id: '1' }, { id: '2', priority: 'high' }] });
  });

  it('keeps null values as-is (only undefined is stripped, not other falsy values)', () => {
    expect(stripUndefined({ a: null, b: 0, c: false, d: '' })).toEqual({ a: null, b: 0, c: false, d: '' });
  });

  it('leaves a payload with no undefined values completely unchanged in shape', () => {
    const input = { tasks: [{ id: '1', title: 'A' }], blocks: [], rules: { autoRescheduleEnabled: true } };
    expect(stripUndefined(input)).toEqual(input);
  });

  it('handles deeply nested undefined values several levels down', () => {
    const input = { a: { b: { c: [{ d: undefined, e: 'kept' }] } } };
    expect(stripUndefined(input)).toEqual({ a: { b: { c: [{ e: 'kept' }] } } });
  });
});

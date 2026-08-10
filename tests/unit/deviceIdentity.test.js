/**
 * Unit tests for src/utils/deviceIdentity.js — the local-only, unsynced
 * per-browser id used to tell "this device's own write to the shared
 * Firestore googleCalendarStatus field" apart from "a different device's
 * write" (see useCloudSync.js's detectGoogleCalendarStatusMismatch).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { getDeviceId } from '../../src/utils/deviceIdentity';

describe('getDeviceId', () => {
  // Same injectable-storage pattern as guestIdentity.js, for the same reason
  // (no window.localStorage in Vitest's `node` environment).
  let store;
  let storage;
  beforeEach(() => {
    store = {};
    storage = {
      load: (key, fallback) => (key in store ? store[key] : fallback),
      save: (key, value) => {
        store[key] = value;
      },
    };
  });

  it('generates and persists a fresh id on first call', () => {
    const id = getDeviceId(storage, () => 'generated-id-1');
    expect(id).toBe('generated-id-1');
    expect(store.deviceId).toBe('generated-id-1');
  });

  it('returns the same stored id on subsequent calls without regenerating', () => {
    let calls = 0;
    const generateId = () => {
      calls += 1;
      return `generated-id-${calls}`;
    };
    const first = getDeviceId(storage, generateId);
    const second = getDeviceId(storage, generateId);
    expect(first).toBe(second);
    expect(calls).toBe(1); // generateId only invoked once
  });

  it('treats a missing/empty stored value as "none yet" and generates one', () => {
    store.deviceId = '';
    const id = getDeviceId(storage, () => 'generated-id-2');
    expect(id).toBe('generated-id-2');
  });

  it('treats a non-string stored value as corrupt and regenerates', () => {
    store.deviceId = { not: 'a string' };
    const id = getDeviceId(storage, () => 'generated-id-3');
    expect(id).toBe('generated-id-3');
  });
});

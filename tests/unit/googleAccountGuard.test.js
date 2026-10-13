/**
 * ============================================================================
 * googleAccountGuard — coverage notes
 * ============================================================================
 * The pure decisions behind "one Google account per TaskFlow account":
 *   - which fetched account counts as a change (isGoogleAccountChange)
 *   - when a device should react to another device's disconnect marker
 *     (decideRemoteGoogleDisconnect)
 *   - what a disconnect does to the events array (planGoogleDisconnectEvents),
 *     including the regression that matters most: reconnecting the SAME account
 *     afterwards must neither resurrect the old rows nor flag anything to be
 *     deleted on Google.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  isRealGoogleAccountId,
  isGoogleAccountChange,
  decideRemoteGoogleDisconnect,
  planGoogleDisconnectEvents,
} from '../../src/utils/googleAccountGuard.js';
import { mergePulledGoogleEvents } from '../../src/services/eventSyncService.js';

const NOW = '2026-10-13T10:00:00.000Z';

describe('isGoogleAccountChange', () => {
  it('is false when either side is unknown', () => {
    expect(isGoogleAccountChange(null, 'a@x.com')).toBe(false);
    expect(isGoogleAccountChange('a@x.com', undefined)).toBe(false);
    expect(isGoogleAccountChange('primary', 'a@x.com')).toBe(false);
  });

  it('is false for the same account, ignoring case and whitespace', () => {
    expect(isGoogleAccountChange('a@x.com', ' A@X.com ')).toBe(false);
  });

  it('is true for a different account', () => {
    expect(isGoogleAccountChange('a@x.com', 'b@x.com')).toBe(true);
  });

  it("treats the literal 'primary' placeholder as not a real account", () => {
    expect(isRealGoogleAccountId('primary')).toBe(false);
    expect(isRealGoogleAccountId('')).toBe(false);
    expect(isRealGoogleAccountId('a@x.com')).toBe(true);
  });
});

describe('decideRemoteGoogleDisconnect', () => {
  const me = 'device-me';
  const marker = { id: 'm2', deviceId: 'device-other' };

  it('only records the marker the first time (never reacts when nothing was recorded before)', () => {
    expect(decideRemoteGoogleDisconnect({ remoteMarker: marker, seenMarkerId: null, localDeviceId: me })).toEqual({
      action: 'record',
      seenMarkerId: 'm2',
    });
    expect(decideRemoteGoogleDisconnect({ remoteMarker: null, seenMarkerId: undefined, localDeviceId: me })).toEqual({
      action: 'record',
      seenMarkerId: '',
    });
  });

  it('does nothing when the marker was already seen', () => {
    expect(decideRemoteGoogleDisconnect({ remoteMarker: marker, seenMarkerId: 'm2', localDeviceId: me })).toEqual({ action: 'none' });
  });

  it('does nothing when there is no marker at all', () => {
    expect(decideRemoteGoogleDisconnect({ remoteMarker: null, seenMarkerId: '', localDeviceId: me })).toEqual({ action: 'none' });
    expect(decideRemoteGoogleDisconnect({ remoteMarker: null, seenMarkerId: 'm1', localDeviceId: me })).toEqual({ action: 'none' });
  });

  it("disconnects on another device's newer marker", () => {
    expect(decideRemoteGoogleDisconnect({ remoteMarker: marker, seenMarkerId: 'm1', localDeviceId: me })).toEqual({
      action: 'disconnect',
      seenMarkerId: 'm2',
    });
    // A device that connected when no marker existed ('') must still react to the first one.
    expect(decideRemoteGoogleDisconnect({ remoteMarker: marker, seenMarkerId: '', localDeviceId: me })).toEqual({
      action: 'disconnect',
      seenMarkerId: 'm2',
    });
  });

  it('records, without disconnecting, its own marker echoing back', () => {
    expect(
      decideRemoteGoogleDisconnect({ remoteMarker: { id: 'm3', deviceId: me }, seenMarkerId: 'm2', localDeviceId: me })
    ).toEqual({ action: 'record', seenMarkerId: 'm3' });
  });
});

describe('planGoogleDisconnectEvents', () => {
  const googleEvt = (o = {}) => ({
    id: 'e1',
    source: 'google',
    googleEventId: 'g1',
    googleUpdatedAt: '2026-10-01T00:00:00.000Z',
    date: '2026-10-20',
    title: 'From Google',
    description: 'secret',
    ...o,
  });

  it('tombstones a Google-sourced event and clears its Google link', () => {
    const [out] = planGoogleDisconnectEvents([googleEvt()], NOW);
    expect(out.deletedAt).toBe(NOW);
    expect(out.localUpdatedAt).toBe(NOW);
    expect(out.googleEventId).toBeNull();
    expect(out.googleUpdatedAt).toBeUndefined();
    expect(out.description).toBeNull();
    expect(out.title).toBe('From Google');
  });

  it('keeps a manual event but strips a leftover Google link and stamps it so the change syncs', () => {
    const manual = { id: 'm1', source: 'manual', googleEventId: 'g9', pendingGooglePush: true, date: '2026-10-20', title: 'Mine' };
    const [out] = planGoogleDisconnectEvents([manual], NOW);
    expect(out.deletedAt).toBeUndefined();
    expect(out.googleEventId).toBeNull();
    expect(out.pendingGooglePush).toBeUndefined();
    expect(out.localUpdatedAt).toBe(NOW);
  });

  it('returns the very same object for an event with nothing Google-related', () => {
    const manual = { id: 'm1', source: 'manual', date: '2026-10-20', title: 'Mine' };
    const [out] = planGoogleDisconnectEvents([manual], NOW);
    expect(out).toBe(manual);
  });

  it('leaves an already-inert tombstone untouched, but clears the link on one that still has it', () => {
    const inert = googleEvt({ id: 'e2', googleEventId: null, googleUpdatedAt: undefined, deletedAt: '2026-10-01T00:00:00.000Z' });
    const [same] = planGoogleDisconnectEvents([inert], NOW);
    expect(same).toBe(inert);

    const linked = googleEvt({ id: 'e3', deletedAt: '2026-10-01T00:00:00.000Z', pendingGooglePush: true });
    const [cleared] = planGoogleDisconnectEvents([linked], NOW);
    expect(cleared.googleEventId).toBeNull();
    expect(cleared.pendingGooglePush).toBeUndefined();
    expect(cleared.deletedAt).toBe('2026-10-01T00:00:00.000Z'); // keeps the original delete time
    expect(cleared.localUpdatedAt).toBe(NOW);
  });

  it('is idempotent', () => {
    const once = planGoogleDisconnectEvents([googleEvt()], NOW);
    const twice = planGoogleDisconnectEvents(once, '2026-10-13T11:00:00.000Z');
    expect(twice[0]).toBe(once[0]);
  });
});

describe('reconnecting the same account after a disconnect', () => {
  it('adds the pulled copy as a fresh row and never flags the old tombstone to be deleted on Google', () => {
    const original = {
      id: 'e1',
      source: 'google',
      googleEventId: 'g1',
      googleUpdatedAt: '2026-10-01T00:00:00.000Z',
      date: '2026-10-20',
      title: 'Standup',
    };
    const afterDisconnect = planGoogleDisconnectEvents([original], NOW);
    const pulled = { ...original, id: 'g1', googleUpdatedAt: '2026-10-01T00:00:00.000Z' };

    const merged = mergePulledGoogleEvents(afterDisconnect, [pulled], '2026-10-01', '2026-10-31');

    // The pulled event is back and alive...
    expect(merged.find((e) => e.googleEventId === 'g1' && !e.deletedAt)).toBeTruthy();
    // ...and nothing was queued for deletion on Google's side.
    expect(merged.some((e) => e.pendingGooglePush)).toBe(false);
  });
});

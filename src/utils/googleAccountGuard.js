/**
 * ============================================================================
 * GOOGLE ACCOUNT GUARD — one Google account per TaskFlow account
 * ============================================================================
 * Pure decisions behind "disconnecting Google Calendar is the only way to
 * change which Google account TaskFlow syncs with, and it is a clean break on
 * every device." Wired up in useGoogleCalendarSync.js and useCloudSync.js.
 *
 * WHY IT EXISTS
 *   The Google login (a "refresh token") is stored ONCE per TaskFlow account
 *   by the Cloudflare Worker, not once per device — every device mints its
 *   access tokens from the same stored login. If the login is replaced by a
 *   different Google account (disconnect, then reconnect as someone else), the
 *   events that came from the old account are still sitting in every device's
 *   synced `events`. The next pull then either drops them ("Google deleted
 *   them") or demotes them and pushes copies into the NEW account's calendar.
 *
 * WHAT IT DOES
 *   - Disconnect wipes the old account's events everywhere: Google-sourced
 *     events become tombstones (see eventTombstones.js — a kept row stamped
 *     `deletedAt`, so the deletion syncs instead of being resurrected by a
 *     device that never saw it). planGoogleDisconnectEvents builds that list.
 *   - Disconnect also writes a small "disconnect marker" on the synced user
 *     doc. Other devices notice it and disconnect themselves
 *     (decideRemoteGoogleDisconnect).
 *   - If a device ever sees a different Google account than the one it last
 *     synced with, it treats that as a forced disconnect (isGoogleAccountChange).
 *
 * WHY THIS APPROACH
 *   Forcing a TaskFlow sign-out on every device was rejected: sign-out does not
 *   touch the Google login, would surprise people, and cannot work offline.
 *   A per-event "which account" stamp was rejected as far bigger than needed
 *   — wiping on disconnect gives the same safety with no new event field.
 *
 * LIMITATIONS
 *   - A device that is offline while another device disconnects only finds out
 *     when it next reconnects to Firestore; until then it keeps its old state.
 *   - Events the user created in TaskFlow and pushed to Google are stored as
 *     Google-sourced, so they are cleared by a disconnect too (they stay in
 *     Google itself). Events never pushed (still "manual") are kept.
 * ============================================================================
 */

import { tombstoneEvents } from './eventTombstones';

/**
 * The raw id Google reports for the user's own calendar is their account email
 * address; before any fetch has resolved it, callers hold the placeholder
 * 'primary'. Only a real id says anything about WHICH account is connected.
 * @param {*} id
 * @returns {boolean}
 */
export function isRealGoogleAccountId(id) {
  return typeof id === 'string' && id.trim() !== '' && id !== 'primary';
}

/**
 * True if `fetchedAccountId` is a different Google account from the one this
 * device last synced with (`storedAccountId`). Never true when either side is
 * unknown (nothing to compare — the caller just records the fetched id), and
 * email comparison ignores case.
 * @param {string|null|undefined} storedAccountId
 * @param {string|null|undefined} fetchedAccountId
 * @returns {boolean}
 */
export function isGoogleAccountChange(storedAccountId, fetchedAccountId) {
  if (!isRealGoogleAccountId(storedAccountId) || !isRealGoogleAccountId(fetchedAccountId)) return false;
  return storedAccountId.trim().toLowerCase() !== fetchedAccountId.trim().toLowerCase();
}

/**
 * What a device should do on seeing the synced disconnect marker
 * (`{ id, deviceId }`, or null if nobody has ever disconnected).
 *
 * `seenMarkerId` is the last marker id this device has dealt with:
 *   - `null`/`undefined` — never recorded (first run of this feature, or a
 *     fresh browser): just record the current marker without reacting, since
 *     we can't tell whether it is older or newer than this device's connection.
 *   - `''` — recorded, and at that time no marker existed.
 *
 * Connecting Google Calendar records the marker currently on the doc, so a
 * device never reacts to a disconnect that happened before it connected.
 *
 * @param {{ remoteMarker: ({id?: string, deviceId?: string}|null|undefined), seenMarkerId: (string|null|undefined), localDeviceId: string }} args
 * @returns {{ action: 'none' } | { action: 'record', seenMarkerId: string } | { action: 'disconnect', seenMarkerId: string }}
 */
export function decideRemoteGoogleDisconnect({ remoteMarker, seenMarkerId, localDeviceId }) {
  const remoteId = remoteMarker?.id || '';
  if (seenMarkerId === null || seenMarkerId === undefined) return { action: 'record', seenMarkerId: remoteId };
  if (!remoteId || remoteId === seenMarkerId) return { action: 'none' };
  // Our own disconnect echoing back through Firestore — nothing to do.
  if (remoteMarker.deviceId === localDeviceId) return { action: 'record', seenMarkerId: remoteId };
  return { action: 'disconnect', seenMarkerId: remoteId };
}

/**
 * The events array after a Google disconnect.
 *
 * - A Google-sourced event becomes a tombstone, and also loses its
 *   `googleEventId`. That second part matters: if the same account is
 *   reconnected later, a tombstone still carrying the old id would match the
 *   freshly pulled copy, win the "newer local delete" comparison, and get
 *   flagged to be DELETED ON GOOGLE. With the id gone the tombstone is inert.
 * - A manual (never pushed) event is kept, but any leftover Google id is
 *   stripped so it is pushed afresh to whichever account connects next.
 * - Events with nothing Google-related on them are returned untouched (same
 *   object), so the caller can cheaply tell whether anything changed.
 *
 * @param {import('../types').CalendarEvent[]} events
 * @param {string} nowIso
 * @returns {import('../types').CalendarEvent[]}
 */
export function planGoogleDisconnectEvents(events, nowIso) {
  return events.map((e) => {
    const hasGoogleLink = Boolean(e.googleEventId || e.googleUpdatedAt || e.pendingGooglePush);
    if (e.source === 'google') {
      if (e.deletedAt && !hasGoogleLink) return e; // already an inert tombstone
      const { googleEventId, googleUpdatedAt, pendingGooglePush, ...rest } = e;
      const stripped = { ...rest, googleEventId: null };
      if (e.deletedAt) return { ...stripped, localUpdatedAt: nowIso };
      return tombstoneEvents([stripped], [e.id], nowIso)[0];
    }
    if (!hasGoogleLink) return e;
    const { googleEventId, googleUpdatedAt, pendingGooglePush, ...rest } = e;
    return { ...rest, googleEventId: null, localUpdatedAt: nowIso };
  });
}

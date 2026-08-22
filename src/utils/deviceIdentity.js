/**
 * ============================================================================
 * DEVICE IDENTITY — a stable-ish per-browser id, local only
 * ============================================================================
 * Used to tell "this device's own write to the shared Firestore status field"
 * apart from "a different device's write" (see useCloudSync.js's
 * googleCalendarStatus handling). Deliberately NOT a robust device
 * fingerprint — just enough entropy that two browsers/profiles essentially
 * never collide. Generated once with crypto.randomUUID() and persisted to
 * localStorage so it survives reloads; a fresh browser profile/storage wipe
 * simply mints a new one, which is fine since the only thing that breaks is
 * "this device's own echo looks like a different device" for one write cycle.
 *
 * Deliberately NOT in usePersistedState/BACKUP_FIELDS or synced anywhere —
 * syncing a "which physical device is this" id defeats its own purpose, and
 * restoring one from a backup onto a different machine would make that
 * machine misreport its identity to other devices.
 * ============================================================================
 */

import { loadPersisted, savePersisted } from './persistence';

const DEVICE_ID_KEY = 'deviceId';

/**
 * Same optional-storage-pair pattern as guestIdentity.js, so this stays
 * testable under Vitest's `node` environment (no `window.localStorage`, and
 * no `crypto.randomUUID` guaranteed either — callers there should pass an
 * explicit `generateId`).
 * @typedef {{load: (key: string, fallback: *) => *, save: (key: string, value: *) => void}} DeviceIdStorage
 */
const defaultStorage = { load: loadPersisted, save: savePersisted };

/**
 * This browser's stable device id, generating and persisting one on first
 * call if none exists yet. Safe to call as often as needed — subsequent
 * calls just read the same stored value back.
 * @param {DeviceIdStorage} [storage]
 * @param {() => string} [generateId] - defaults to crypto.randomUUID()
 * @returns {string}
 */
export function getDeviceId(storage = defaultStorage, generateId = () => crypto.randomUUID()) {
  const existing = storage.load(DEVICE_ID_KEY, null);
  if (typeof existing === 'string' && existing) return existing;
  const fresh = generateId();
  storage.save(DEVICE_ID_KEY, fresh);
  return fresh;
}

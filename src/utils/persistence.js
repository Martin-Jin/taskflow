/**
 * ============================================================================
 * LOCAL STORAGE PERSISTENCE
 * ============================================================================
 * TaskFlow is a client-only SPA with no backend, so "saving" means
 * localStorage. This is a small, deliberately dumb key/value layer:
 *   - Every key is namespaced under `taskflow:` so it doesn't collide with
 *     anything else that might use localStorage on the same origin.
 *   - Reads are wrapped in try/catch and fall back to `null` on any error
 *     (corrupted JSON, storage disabled/full, private-browsing quirks in
 *     some browsers) rather than throwing and breaking app boot.
 *   - Writes are similarly best-effort: a failed write (e.g. quota
 *     exceeded) is logged but never crashes the app — the in-memory state
 *     is still correct even if it didn't make it to disk this time.
 *   - A `STORAGE_VERSION` prefix lets us bump the schema later (e.g. if a
 *     saved shape needs to change) without writing a migration for old,
 *     incompatible data — we just start fresh under a new version key
 *     rather than risk loading malformed state.
 * ============================================================================
 */

const STORAGE_VERSION = 'v1';
const PREFIX = `taskflow:${STORAGE_VERSION}:`;

function isStorageAvailable() {
  try {
    const testKey = '__taskflow_storage_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

// Computed once; if localStorage is unavailable (disabled, private mode in
// some older browsers, SSR, etc.) every call below silently becomes a no-op
// so the app still runs, just without persistence.
const STORAGE_AVAILABLE = typeof window !== 'undefined' && isStorageAvailable();

/**
 * Read and JSON-parse a persisted value.
 * @param {string} key
 * @param {*} fallback - Returned if the key is missing, storage is
 *   unavailable, or the stored value fails to parse.
 */
export function loadPersisted(key, fallback) {
  if (!STORAGE_AVAILABLE) return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[persistence] Failed to load "${key}", using default.`, err);
    return fallback;
  }
}

/** JSON-stringify and persist a value. No-ops silently if storage is unavailable/full. */
export function savePersisted(key, value) {
  if (!STORAGE_AVAILABLE) return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[persistence] Failed to save "${key}" — changes will be lost on refresh.`, err);
  }
}

/** Remove a persisted key (used by the "Reset local data" settings action). */
export function clearPersisted(key) {
  if (!STORAGE_AVAILABLE) return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Wipe every TaskFlow-namespaced key, for a full local reset. */
export function clearAllPersisted() {
  if (!STORAGE_AVAILABLE) return;
  try {
    const keysToRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keysToRemove.push(k);
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch (err) {
    console.warn('[persistence] Failed to clear local data.', err);
  }
}

export { STORAGE_AVAILABLE };
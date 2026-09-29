/**
 * ============================================================================
 * canonicalStringify — order-independent JSON.stringify substitute
 * ============================================================================
 * Extracted out of useCloudSync.js (which still re-exports it, so existing
 * imports from that file keep working) so utils/entityMerge.js and
 * hooks/usePersistedState.js can use it too without either of them
 * importing FROM useCloudSync.js, which already imports FROM
 * usePersistedState.js — that direction would make a circular import.
 * ============================================================================
 */

/**
 * A JSON.stringify substitute whose output depends only on DATA, never on an
 * object's own key insertion order — plain `JSON.stringify` follows whatever
 * order the object's keys happen to have been set in, and Firestore's SDK
 * does NOT guarantee preserving that order for nested map fields on a
 * round-trip (arrays keep their element order; it's specifically each
 * object/map's OWN key order that can come back reshuffled). Two logically
 * identical objects that merely differ in key order must fingerprint
 * IDENTICALLY, or every echo of this device's own push looks like new remote
 * data forever — see this function's own discovery: a real production
 * account's sync got stuck in a permanent push -> echo -> reapply -> push
 * loop, purely from a task's nested `recurrenceRule`/`subtasks` objects
 * coming back from Firestore with reordered keys (never a real value
 * difference), which none of computeFingerprint's/applyRemoteData's
 * consumers could tell apart from a genuine edit.
 *
 * Recursively sorts each plain object's keys before stringifying; arrays are
 * walked element-by-element in their EXISTING order (array order is
 * semantically meaningful — e.g. subtask ordering — and was confirmed stable
 * across the Firestore round-trip that exposed this bug, unlike object key
 * order). `null`/primitives/Dates pass through JSON.stringify's own handling
 * unchanged.
 */
export function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const sortedKeys = Object.keys(value).sort();
    const entries = sortedKeys
      .filter((key) => value[key] !== undefined) // matches JSON.stringify's own "drop undefined values" behavior
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

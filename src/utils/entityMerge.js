/**
 * ============================================================================
 * PER-ENTITY CROSS-DEVICE MERGE — shared pure decision logic
 * ============================================================================
 * The common merge rule behind taskMerge.js's mergeTasksByUpdatedAt and
 * eventMerge.js's mergeEventsByUpdatedAt, extracted so a third/fourth
 * collection (sections, projects, labels, ...) can reuse it instead of
 * copy-pasting a third near-identical function. Read taskMerge.js's doc
 * comment first — it has the full history of why "take one side's whole
 * array" is a real data-loss bug and why per-item timestamp comparison is
 * the fix; this file only re-states the mechanics, not that history.
 *
 * This extraction is a BEHAVIOR-PRESERVING REFACTOR ONLY: taskMerge.js and
 * eventMerge.js's own test suites must pass unchanged after they're rewired
 * to call this function, with no test edits, as proof nothing shifted.
 *
 * Two shapes of "does this value have a timestamp we can trust" live here:
 *   - mergeEntitiesByTimestamp: an array of objects with a stable `id` and a
 *     timestamp field on each one (per-row comparison, union of ids).
 *   - pickNewerScalar: a single value (a settings object, a boolean, ...)
 *     compared against a single sidecar timestamp for that whole field —
 *     for collections where per-row identity doesn't exist or doesn't matter
 *     (see useCloudSync.js's fieldUpdatedAt sidecar).
 * ============================================================================
 */

/** Epoch millis for an ISO timestamp string, or null if missing/unparseable. */
function timestampMillis(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Per-item merge of two arrays of objects, keyed by `id`, keeping whichever
 * side has the newer value of `timestampField` for each id.
 *
 * Semantics (identical to mergeTasksByUpdatedAt's — see that file's own doc
 * comment for the full reasoning; summarized here):
 *   - Union of ids across both arrays. An id present on only one side is kept
 *     as-is — most commonly a brand new row created locally and not yet
 *     pushed/pulled by the other device.
 *   - An id present on BOTH sides: keep whichever has the newer timestamp.
 *     Ties keep the local copy (arbitrary, but deterministic).
 *   - Missing/unparseable timestamp on one side only: the side WITH a valid
 *     timestamp counts as newer. If BOTH sides are missing/invalid, keep
 *     local — arbitrary, but must never throw.
 *   - A tombstoned row (a `deletedAt` field set, for collections that have
 *     one) participates in the SAME comparison as any live row, with no
 *     special casing — same reasoning as mergeTasksByUpdatedAt's own comment.
 *   - Pure and deterministic: no `Date.now()`, no mutation of either input,
 *     always returns a NEW array.
 *
 * @param {Array<object>} localRows
 * @param {Array<object>} remoteRows
 * @param {{timestampField?: string}} [options] - which field on each row
 *   carries its last-write timestamp (default 'updatedAt').
 * @returns {Array<object>}
 */
export function mergeEntitiesByTimestamp(localRows, remoteRows, { timestampField = 'updatedAt' } = {}) {
  const localById = new Map((localRows || []).map((row) => [row.id, row]));
  const remoteById = new Map((remoteRows || []).map((row) => [row.id, row]));

  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  const merged = [];

  for (const id of ids) {
    const local = localById.get(id);
    const remote = remoteById.get(id);

    if (local && !remote) {
      merged.push(local);
      continue;
    }
    if (remote && !local) {
      merged.push(remote);
      continue;
    }

    // Present on both sides — keep whichever has the newer timestamp.
    const localMs = timestampMillis(local?.[timestampField]);
    const remoteMs = timestampMillis(remote?.[timestampField]);

    if (localMs === null && remoteMs === null) {
      merged.push(local); // both missing/invalid — arbitrary but deterministic
    } else if (remoteMs === null) {
      merged.push(local); // only local has a valid timestamp
    } else if (localMs === null) {
      merged.push(remote); // only remote has a valid timestamp
    } else if (remoteMs > localMs) {
      merged.push(remote);
    } else {
      merged.push(local); // local newer, or a tie
    }
  }

  return merged;
}

/**
 * Picks the newer of two whole-value fields (a settings object, a boolean, a
 * plain array with no per-item identity, ...) using a separate sidecar
 * timestamp for each side, rather than a timestamp living on the value
 * itself. This is the "cheap" counterpart to mergeEntitiesByTimestamp for
 * fields where per-row merging doesn't make sense — see useCloudSync.js's
 * `fieldUpdatedAt` map, which stores exactly these sidecar timestamps
 * alongside the settings/collections that use this function.
 *
 * Deliberately SYMMETRIC (unlike eventSyncService.js's
 * resolvePulledEventConflict, which is asymmetric because a pulled Google
 * event's local timestamp is structurally always absent): either side here
 * can legitimately have no sidecar timestamp yet, most commonly because the
 * fieldUpdatedAt sidecar was only just introduced and older synced data
 * predates it. So:
 *   - Only one side has a valid timestamp — that side wins (its value is
 *     known-fresher than a side with nothing to compare).
 *   - Both sides have a valid timestamp — newer wins, tie keeps local.
 *   - Neither side has a valid timestamp — remote wins. This matches the
 *     behavior every one of these fields already had before sidecar
 *     timestamps existed (planRemoteDataMerge's plain `pickValid`, remote
 *     wins unconditionally), so a device that hasn't stamped anything yet
 *     doesn't change behavior until it does.
 *
 * @param {string|null|undefined} localStampIso
 * @param {string|null|undefined} remoteStampIso
 * @returns {'local'|'remote'}
 */
export function pickNewerScalar(localStampIso, remoteStampIso) {
  const localMs = timestampMillis(localStampIso);
  const remoteMs = timestampMillis(remoteStampIso);

  if (localMs === null && remoteMs === null) return 'remote';
  if (remoteMs === null) return 'local';
  if (localMs === null) return 'remote';
  return remoteMs > localMs ? 'remote' : 'local';
}

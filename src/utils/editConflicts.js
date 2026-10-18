/**
 * ============================================================================
 * EDIT CONFLICTS — keep the losing side of a two-device edit
 * ============================================================================
 *
 * **Why it exists.** Cross-device sync settles a task or event edited on two
 * devices by keeping the newer edit (see entityMerge.js). When both devices
 * edited the same item while out of touch (say, both offline), the older
 * edit used to vanish with no way back.
 *
 * **What it does.**
 *   1. Each device remembers, per task/event, the edit time the cloud and
 *      this device last agreed on — its "sync base". It's updated after
 *      every successful push, and after a pull for each item the pull
 *      settled on the cloud's version.
 *   2. When a pull brings in a different version of an item, both sides are
 *      checked against that base. Only if BOTH changed since the base is it
 *      a real conflict: each device edited it without seeing the other's
 *      edit.
 *   3. The losing version (unless it was a delete) is returned so the caller
 *      can file it in Trash, where it can be restored.
 *
 * **Why this approach.**
 *   - Comparing the two versions alone can't tell a conflict from ordinary
 *     sync: a pull that carries the version this device edited FROM also
 *     differs from the local copy, and would fill Trash with false alarms.
 *     The base is what tells "they edited it too" apart from "that's just
 *     the older version I started from".
 *   - The base is kept per device in local storage, not on the synced rows:
 *     it describes what THIS device last agreed with the cloud, which is
 *     different on every device, and writing it onto rows would trigger
 *     extra sync writes.
 *   - Bookkeeping fields (edit times, Google sync flags) are ignored when
 *     comparing, so two devices making the same automatic change (both
 *     pulling the same Google edit) aren't a conflict.
 *
 * **How it works in code.**
 * ```js
 * conflict = base[id] && local.ts !== base[id] && remote.ts !== base[id]
 *            && content(local) !== content(remote)
 * loser    = merged[id] === local ? remote : local   // skipped if a tombstone
 * ```
 *
 * **Limitations.**
 *   - An item with no base yet (first sync on a device, or created since) is
 *     never treated as a conflict — there's nothing to compare against.
 *   - Both devices can occasionally file the same conflict, giving two Trash
 *     entries for one edit.
 *   - Covers tasks and calendar events, not projects, sections or tags.
 * ============================================================================
 */

import { canonicalStringify } from './canonicalStringify';

/** Fields that record when or how a row synced, not what it says. */
const BOOKKEEPING_FIELDS = ['updatedAt', 'localUpdatedAt', 'googleUpdatedAt', 'pendingGooglePush'];

function contentKey(row) {
  const copy = { ...row };
  for (const field of BOOKKEEPING_FIELDS) delete copy[field];
  return canonicalStringify(copy);
}

/**
 * The losing rows of genuine two-device conflicts in one merge.
 *
 * @param {object} args
 * @param {object[]} args.localRows - this device's rows before the merge
 * @param {object[]} args.remoteRows - the incoming rows
 * @param {object[]} args.mergedRows - mergeEntitiesByTimestamp's result (holds the winning row objects)
 * @param {Record<string, string>} args.base - id -> edit time last agreed with the cloud
 * @param {string} args.timestampField - 'updatedAt' (tasks) or 'localUpdatedAt' (events)
 * @returns {object[]}
 */
export function findOverwrittenEdits({ localRows, remoteRows, mergedRows, base, timestampField }) {
  if (!base) return [];
  const remoteById = new Map((remoteRows || []).map((r) => [r.id, r]));
  const mergedById = new Map((mergedRows || []).map((r) => [r.id, r]));
  const losers = [];
  for (const local of localRows || []) {
    const remote = remoteById.get(local.id);
    const agreed = base[local.id];
    if (!remote || !agreed) continue;
    if (local[timestampField] === agreed || remote[timestampField] === agreed) continue;
    if (contentKey(local) === contentKey(remote)) continue;
    const loser = mergedById.get(local.id) === local ? remote : local;
    if (!loser.deletedAt) losers.push(loser);
  }
  return losers;
}

/**
 * Sync base after a successful push: every pushed row now matches the cloud.
 * @returns {Record<string, string>}
 */
export function syncBaseFromRows(rows, timestampField) {
  const next = {};
  for (const row of rows || []) {
    if (row?.id && row[timestampField]) next[row.id] = row[timestampField];
  }
  return next;
}

/**
 * Sync base after a pull: rows the merge settled on the cloud's version now
 * match it; every other row keeps its previous base.
 * @returns {Record<string, string>}
 */
export function advanceSyncBaseAfterMerge(base, remoteRows, mergedRows, timestampField) {
  const next = { ...(base || {}) };
  const remoteById = new Map((remoteRows || []).map((r) => [r.id, r]));
  for (const row of mergedRows || []) {
    const remote = remoteById.get(row.id);
    if (remote && remote[timestampField] && remote[timestampField] === row[timestampField]) next[row.id] = row[timestampField];
  }
  return next;
}

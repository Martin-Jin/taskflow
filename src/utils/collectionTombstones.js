/**
 * ============================================================================
 * COLLECTION TOMBSTONES — pure decision logic for sections/projects/labels
 * ============================================================================
 * The sections/projects/labels counterpart to taskTombstones.js/
 * eventTombstones.js. Backs the per-entity cross-device merge
 * (mergeEntitiesByTimestamp, see utils/entityMerge.js, wired into
 * useCloudSync.js's planRemoteDataMerge) for the three synced collections
 * that have stable per-row ids AND a real "the user deleted this" action —
 * unlike savedViews/taskTemplates/trash, which get per-entity `updatedAt`
 * timestamps too but no tombstone, since nothing merges two devices'
 * concurrent deletes of those the way a project/section/label delete can
 * race a rename made on another device.
 *
 * Same problem tombstoneTasks/tombstoneEvents solve: a plain array removal
 * can't tell "this project doesn't exist here because it was never created"
 * apart from "it doesn't exist because it was deleted" — so a delete on one
 * device could be silently undone by a stale rename arriving from another
 * device that never saw the delete. Tombstoning (stamping `deletedAt` and
 * keeping the row instead of removing it) fixes that the same way it
 * already does for tasks/events.
 *
 * PERSONAL ROWS ONLY. A SHARED project/section (one with a `sharedProjectId`
 * — see utils/sharedTaskSync.js's isSharedSection/partitionSectionsBySharing)
 * is excluded from this device's personal Firestore sync bundle entirely; its
 * content lives in `sharedProjects/{id}` and its own delete/leave flow already
 * exists (see SchedulerContext's deleteProject/deleteSection —
 * noteSharedProjectDeleted/noteSharedSectionDeleted, deleteSharedProject) and
 * is completely untouched by this file. Calling tombstoneEntities on a shared
 * row would be meaningless — nothing merges that row through
 * mergeEntitiesByTimestamp in the first place — so every call site here is
 * responsible for filtering to personal rows BEFORE calling in, the same way
 * `cloudSyncState` already only pushes `partitionSectionsBySharing(sections)
 * .personalSections`, never the shared half.
 *
 * Labels have no sharing concept at all (see types/index.js's Label typedef),
 * so every label row is, trivially, "personal" — no filtering needed there.
 *
 * Extracted as pure functions (no Firebase/React/Date.now() side effects
 * beyond an explicit `nowIso`/`nowMs` parameter) so they're unit-testable
 * without mounting SchedulerContext — same precedent as taskTombstones.js/
 * eventTombstones.js.
 * ============================================================================
 */

import { computeCutoffMs } from '../services/dataRetention';

/**
 * Transform a collection (sections, projects, or labels) so every id in
 * `idsToDelete` becomes a tombstone (marked `deletedAt`/`updatedAt`) instead
 * of being removed from the array.
 *
 * Unlike tombstoneTasks, no fields are cleared on delete — a section/
 * project/label has no heavy/private content fields the way a task's notes
 * or an event's description do (just a name, an id, and a few small flags),
 * so there's nothing worth stripping early. Also unlike tombstoneTasks,
 * there's no same-collection cross-reference to scrub here (a project
 * doesn't reference another project's id) — a task's `projectId`/
 * `sectionId`/`labelIds` pointing at a since-deleted row is handled
 * separately by each collection's own delete function in SchedulerContext
 * (e.g. deleteProject unparenting affected tasks), which is a cross-
 * COLLECTION concern this single-collection helper has no way to see.
 *
 * Pure: takes the current array, the ids to delete, and the timestamp to
 * stamp — the caller is responsible for everything else a delete does
 * (cascading task/section updates, trash entries, shared-project
 * notifications) since those are side effects and cross-collection
 * decisions, not this collection's own state-shape decision.
 *
 * @param {Array<{id: string}>} rows
 * @param {Set<string>|string[]} idsToDelete
 * @param {string} nowIso
 * @returns {Array<object>}
 */
export function tombstoneEntities(rows, idsToDelete, nowIso) {
  const ids = idsToDelete instanceof Set ? idsToDelete : new Set(idsToDelete);
  return (rows || []).map((row) => {
    if (!ids.has(row.id)) return row;
    return { ...row, deletedAt: nowIso, updatedAt: nowIso };
  });
}

/**
 * True if `row` is a tombstone (see tombstoneEntities above) older than
 * `retentionDays`, and therefore eligible for the retention sweep to
 * permanently remove.
 *
 * No shared-row exemption is needed here the way isStaleTombstone has one
 * for shared tasks: a shared project/section is never tombstoned in the
 * first place (see this file's own module doc comment) — only ever hard-
 * removed by its own existing delete path — so a tombstoned row reaching
 * this check is, by construction, always a personal one.
 *
 * @param {{deletedAt?: string}} row
 * @param {number} retentionDays
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isStaleEntityTombstone(row, retentionDays, nowMs = Date.now()) {
  if (!row?.deletedAt) return false;
  const cutoffMs = computeCutoffMs(retentionDays, nowMs);
  return new Date(row.deletedAt).getTime() < cutoffMs;
}

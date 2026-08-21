/**
 * ============================================================================
 * BACKUP SERVICE
 * ============================================================================
 * Pure, dependency-free helpers for building a backup payload and moving it
 * in/out of a local .json file. No Firestore or context knowledge lives
 * here — SchedulerContext wires these together with firestoreSync.js for
 * the cloud-backup path, and calls them directly for the local file
 * export/import path (which works signed-out too).
 * ============================================================================
 */

import { downloadTextFile } from '../utils/downloadFile';

/**
 * Almost exactly the fields the live cloud sync already pushes (see
 * firestoreSync.js's pushUserData) — a backup is the same shape, just
 * point-in-time. Note: `theme` is an exception — it's synced live by
 * ThemeContext independently (not pushed/pulled here, see SchedulerContext's
 * cloud-sync comments), but is still included here so point-in-time
 * backups/restores capture it too.
 *
 * `events` (CalendarEvents — Google Calendar bookings, plus any manual/
 * blocked-time entries) is the other exception, in the opposite direction:
 * it's included here (point-in-time backups DO capture it) but deliberately
 * excluded from the LIVE cross-device Firestore sync (see useCloudSync.js's
 * computeFingerprint/planRemoteDataMerge/applyRemoteData, none of which
 * mention `events`). The risk that originally got `events` excluded from
 * everything — a stale snapshot silently resurrecting an event the user had
 * already deleted (in TaskFlow or directly in Google Calendar) — is a much
 * bigger deal for live sync, which reconciles automatically and continuously
 * in the background, than for a backup, which only ever gets written back by
 * an explicit, one-directional, user-initiated "restore" action. Google
 * Calendar remains the authoritative store for events day-to-day (see
 * useGoogleCalendarSync.js); this is just a safety net for "I deleted my
 * whole account's data" / "my local storage got wiped" scenarios.
 */
export const BACKUP_FIELDS = [
  'tasks',
  'blocks',
  'sections',
  'projects',
  'labels',
  'routines',
  'rules',
  'soundEnabled',
  'soundVolume',
  'animationsEnabled',
  'notificationSettings',
  'theme',
  'notes',
  'shortcutBindings',
  'events',
  'sharedProjectIds',
];

/**
 * SHARED PROJECTS (collaboration) — what a personal backup does and doesn't
 * capture, and why. Third exception in this file, alongside `theme` and
 * `events` above.
 *
 * `sharedProjectIds` (above) is IN: it's just the list of shared projects
 * you're a member of — a pointer, a few strings, unambiguously your own data.
 * Losing it would mean losing your way back into boards you'd joined, which is
 * exactly the "my localStorage got wiped" case backups exist for. Restoring it
 * re-lists those projects; it doesn't grant access, since membership is
 * enforced by the `collaborators` map in Firestore rules, not by this array.
 *
 * A shared project's CONTENT (its tasks, sections, comments — everything under
 * `sharedProjects/{projectId}/`) is deliberately OUT of every backup payload,
 * and this is the important half:
 *
 *   - It isn't solely yours to snapshot or roll back. Restoring a 3-month-old
 *     backup must not resurrect tasks a collaborator deliberately deleted last
 *     week, or silently revert their edits — a personal, one-directional
 *     restore is the wrong instrument for data several people co-own.
 *   - You may no longer be a member. Re-creating content from a project you
 *     were removed from (or that was deleted) would be both broken and a
 *     privacy problem.
 *   - Firestore is the live source of truth for shared projects, not
 *     localStorage — the opposite of the rest of this app's model (see
 *     firestoreSync.js's header). There's nothing local to back up that isn't
 *     already a cache of the server's copy.
 *
 * So: a restore puts your shared-project MEMBERSHIP back and the live sync
 * re-fetches current content from Firestore. Personal (non-shared) projects
 * are unaffected by any of this — they stay in `projects` and are backed up in
 * full exactly as before.
 */

/**
 * Expected runtime shape per BACKUP_FIELDS entry — used both by
 * isValidBackupPayload (reject a payload outright) and by
 * useCloudSync.js's applyRemoteData/applyBackupPayload (fall back to the
 * current value field-by-field instead of trusting whatever shape a single
 * bad field arrived in). A hand-edited/corrupted backup, tampered Firestore
 * doc, or malformed live sync value with the right keys but wrong value
 * types used to sail through `field in payload` and crash later at render
 * time (e.g. `sections.map` on a string) instead of failing cleanly.
 */
export const FIELD_TYPES = {
  tasks: 'array',
  blocks: 'array',
  sections: 'array',
  projects: 'array',
  labels: 'array',
  routines: 'array',
  rules: 'object',
  soundEnabled: 'boolean',
  soundVolume: 'number',
  animationsEnabled: 'boolean',
  notificationSettings: 'object',
  theme: 'string',
  // { folders: [...], notes: [...] } — see notesModel.js's DEFAULT_NOTES.
  notes: 'object',
  shortcutBindings: 'object',
  events: 'array',
  sharedProjectIds: 'array',
};

/** Does `value` match the runtime shape FIELD_TYPES declares for `field`? */
export function isValidFieldValue(field, value) {
  switch (FIELD_TYPES[field]) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

/** Recurring tasks never reach isCompleted: true (completing one just advances dueDate — see types/index.js), so this only ever drops finished one-off tasks. */
function excludeCompletedTasks(tasks, blocks) {
  const keptTasks = tasks.filter((task) => !task.isCompleted);
  const keptTaskIds = new Set(keptTasks.map((task) => task.id));
  return { tasks: keptTasks, blocks: blocks.filter((block) => keptTaskIds.has(block.taskId)) };
}

/**
 * Deletion tombstones (`task.deletedAt`, see utils/taskTombstones.js) exist
 * purely to let a per-task cross-device merge tell "never existed here"
 * apart from "deleted here" (useCloudSync.js's mergeTasksByUpdatedAt) — a
 * transient signal for live sync to converge on, not content worth
 * preserving in a point-in-time backup. Same reasoning as
 * excludeCompletedTasks just above: there's nothing to restore a tombstone
 * TO, and keeping one around only risks a much-later restore reintroducing a
 * dead entry that every live device already purged via its own retention
 * sweep. Blocks are already dropped at delete time (deleteTask never
 * tombstones blocks), so unlike excludeCompletedTasks there's no companion
 * blocks list to filter here.
 */
function excludeDeletedTasks(tasks) {
  return tasks.filter((task) => !task.deletedAt);
}

/** Assemble a full backup payload from current state, tagged with when it was taken. Completed one-off tasks (and their blocks), and deleted-task tombstones, are left out — there's nothing to restore them to. */
export function buildBackupPayload(state) {
  const payload = { exportedAt: new Date().toISOString() };
  BACKUP_FIELDS.forEach((field) => {
    payload[field] = state[field];
  });
  const { tasks, blocks } = excludeCompletedTasks(payload.tasks, payload.blocks);
  return { ...payload, tasks: excludeDeletedTasks(tasks), blocks };
}

/**
 * True if `payload` has every backupable field — rejects an unrelated JSON
 * file instead of silently restoring mostly-undefined state.
 *
 * ONE-TIME MIGRATION NOTE — safe to delete the `'pinnedLinks' in payload`
 * fallback once old-format backup files (pre-Notes, `notes` field didn't
 * exist yet) are no longer expected to show up in "Restore from file"; see
 * notesModel.js's migrateLinksToNotes, which applyBackupPayload/
 * applyRemoteData call on such a payload.
 *
 * `events` is exempt from the "every field must be present" rule (not a
 * migration, so no cleanup needed later): backups taken before `events`
 * joined BACKUP_FIELDS simply won't have it, and that's a permanently valid
 * shape, not a legacy format to eventually retire — applyBackupPayload
 * treats an absent `events` as "leave whatever's there untouched" like any
 * other missing-from-payload field.
 */
export function isValidBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return BACKUP_FIELDS.every((field) => {
    if (field in payload) return isValidFieldValue(field, payload[field]);
    if (field === 'events') return true;
    // Legacy pre-Notes backup: accept a present-but-differently-shaped
    // `pinnedLinks` in place of `notes` (see the migration note above) — its
    // own shape is checked by migrateLinksToNotes at apply time, not here.
    return field === 'notes' && 'pinnedLinks' in payload;
  });
}

/** Triggers a browser download of `payload` as a formatted .json file. */
export function downloadBackupFile(payload) {
  downloadTextFile(
    `taskflow-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
}

/** Reads a File (from an <input type="file"> picker) and resolves to its parsed JSON contents, or rejects if it isn't valid JSON. */
export function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch {
        reject(new Error('That file is not valid JSON.'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

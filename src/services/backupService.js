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

/**
 * Exactly the fields the live cloud sync already pushes (see firestoreSync.js's
 * pushUserData) — a backup is the same shape, just point-in-time. Note:
 * `theme` is an exception — it's synced live by ThemeContext independently
 * (not pushed/pulled here, see SchedulerContext's cloud-sync comments), but
 * is still included here so point-in-time backups/restores capture it too.
 *
 * Deliberately EXCLUDES `events` (CalendarEvents — Google Calendar bookings,
 * plus any manual/blocked-time entries) even though it's a piece of
 * SchedulerContext state: Google Calendar is the authoritative store for
 * synced events (see useGoogleCalendarSync.js), and round-tripping the same
 * data through Firestore/backups too caused real bugs — a stale cross-device
 * Firestore snapshot or an old backup restore could reintroduce events a
 * user had already deleted (in TaskFlow or directly in Google Calendar),
 * independent of and on top of the Google Calendar sync's own merge policy.
 * `events` is intentionally device-local now: seeded from localStorage on
 * load and kept current purely by polling/pulling Google Calendar.
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
];

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

/** Assemble a full backup payload from current state, tagged with when it was taken. Completed one-off tasks (and their blocks) are left out — there's nothing to restore them to. */
export function buildBackupPayload(state) {
  const payload = { exportedAt: new Date().toISOString() };
  BACKUP_FIELDS.forEach((field) => {
    payload[field] = state[field];
  });
  const { tasks, blocks } = excludeCompletedTasks(payload.tasks, payload.blocks);
  return { ...payload, tasks, blocks };
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
 */
export function isValidBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return BACKUP_FIELDS.every((field) => {
    if (field in payload) return isValidFieldValue(field, payload[field]);
    // Legacy pre-Notes backup: accept a present-but-differently-shaped
    // `pinnedLinks` in place of `notes` (see the migration note above) — its
    // own shape is checked by migrateLinksToNotes at apply time, not here.
    return field === 'notes' && 'pinnedLinks' in payload;
  });
}

/** Triggers a browser download of `payload` as a formatted .json file — an in-memory Blob + a throwaway link, no server round trip. */
export function downloadBackupFile(payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `taskflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

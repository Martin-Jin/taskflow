/**
 * Dashboard widget visibility — lets a user hide sections of the dashboard
 * they don't use (e.g. no bookmarks, so hide Pinned Links). Persisted
 * locally only (usePersistedState, same as taskViewByProject/calendar zoom)
 * rather than through SchedulerContext's cloud sync/backup — this is a
 * per-device layout preference, not app data, so it deliberately isn't in
 * backupService.js's BACKUP_FIELDS.
 */

export const DASHBOARD_WIDGETS = [
  { key: 'stats', label: 'Quick stats' },
  { key: 'nowNext', label: 'Right now / up next' },
  { key: 'todayAgenda', label: "Today's agenda" },
  { key: 'pinnedLinks', label: 'Pinned links' },
  { key: 'progressRings', label: 'Progress rings' },
];

export const DEFAULT_DASHBOARD_WIDGETS = DASHBOARD_WIDGETS.reduce((acc, { key }) => {
  acc[key] = true;
  return acc;
}, {});

/**
 * ============================================================================
 * DATA RETENTION POLICIES
 * ============================================================================
 * Centralized, maintainable data retention constants and utilities for
 * consistent cleanup across the app. All retention durations are defined here.
 *
 * Policy: Most user data is cleaned up N days after its "age marker" (created,
 * completed, last-seen, etc.). Markers and thresholds are listed below.
 * ============================================================================
 */

// ---- Retention Durations (in days) ----------------------------------------
// These are the authoritative retention periods used throughout the app.
// Keep all time-based cleanup windows here for easy adjustment.

/** Personal one-off tasks marked completed — deleted after this many days. */
export const RETENTION_DAYS_COMPLETED_TASKS = 30;

/** Google Calendar events and synced history — kept for rolling window. */
export const RETENTION_DAYS_CALENDAR_EVENTS = 365;

/** Shared project presence docs (viewer avatars) — auto-delete via TTL. */
export const RETENTION_DAYS_PRESENCE = 7;

/** Anonymous user profiles — auto-delete via TTL. */
export const RETENTION_DAYS_ANON_PROFILES = 30;

/** Expired share links — manually cleaned, delete after this many days. */
export const RETENTION_DAYS_EXPIRED_LINKS = 90;

/** Shared project tasks (completed) — no auto-cleanup (co-owned). */
// RETENTION_DAYS_SHARED_TASKS — intentionally no limit (owner must manage)

// ---- Time Unit Constants ---------------------------------------------------
// Avoid scattered "* 24 * 60 * 60 * 1000" calculations. Use these instead.

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ---- Computed Intervals (derived from day counts) -------------------------

/** Auto-backup check interval: once per day. */
export const BACKUP_CHECK_INTERVAL_MS = 24 * MS_PER_HOUR;

/** Presence heartbeat: every 30 seconds (keeps avatar fresh within PRESENCE_STALE_MS). */
export const PRESENCE_HEARTBEAT_MS = 30 * MS_PER_SECOND;

/** Presence staleness threshold: 90 seconds without heartbeat. Checked every PRESENCE_HEARTBEAT_MS / 2. */
export const PRESENCE_STALE_MS = 90 * MS_PER_SECOND;

/** Cloud sync debounce: batch changes into one write. */
export const CLOUD_SYNC_DEBOUNCE_MS = 1500;

/** Shared project sync debounce: same rationale as cloud sync. */
export const SHARED_PROJECT_SYNC_DEBOUNCE_MS = 1500;

// ---- Cutoff Calculations ---------------------------------------------------
// Pure functions for computing age thresholds. Never use raw time math inline.

/**
 * Compute the timestamp (milliseconds) before which data should be deleted.
 * @param {number} retentionDays - How many days to keep data
 * @param {number} [nowMs] - Current time (default: Date.now())
 * @returns {number} Cutoff timestamp in milliseconds
 */
export function computeCutoffMs(retentionDays, nowMs = Date.now()) {
  return nowMs - retentionDays * MS_PER_DAY;
}

/**
 * Compute the ISO date string before which data should be deleted.
 * Uses LOCAL calendar dates (not UTC), matching this app's date model.
 * @param {number} retentionDays - How many days to keep data
 * @param {number} [nowMs] - Current time (default: Date.now())
 * @returns {string} Cutoff date as ISO string (YYYY-MM-DD) in local time
 */
export function computeCutoffIso(retentionDays, nowMs = Date.now()) {
  const cutoffDate = new Date(nowMs - retentionDays * MS_PER_DAY);
  // toISODate would be ideal but not exported from dateUtils; compute it here.
  // Use local date, not UTC (toISOString converts to UTC).
  const year = cutoffDate.getFullYear();
  const month = String(cutoffDate.getMonth() + 1).padStart(2, '0');
  const day = String(cutoffDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a timestamp is stale (older than the retention cutoff).
 * @param {number} timestampMs - Timestamp to check (milliseconds)
 * @param {number} retentionDays - Retention period in days
 * @param {number} [nowMs] - Current time (default: Date.now())
 * @returns {boolean}
 */
export function isStale(timestampMs, retentionDays, nowMs = Date.now()) {
  if (!timestampMs) return false;
  return timestampMs < computeCutoffMs(retentionDays, nowMs);
}

/**
 * Check if a timestamp string (ISO) is stale.
 * @param {string} isoDateString - ISO date string (YYYY-MM-DD)
 * @param {number} retentionDays - Retention period in days
 * @param {number} [nowMs] - Current time (default: Date.now())
 * @returns {boolean}
 */
export function isStaleIso(isoDateString, retentionDays, nowMs = Date.now()) {
  if (!isoDateString) return false;
  return isoDateString < computeCutoffIso(retentionDays, nowMs);
}

/**
 * Compute the effective purge boundary, capping retention at a rolling window.
 * Used when synced bounds may extend further back than desired.
 * Same as eventSyncService's original implementation, now centralized.
 * @param {string} syncedBoundsStartIso - ISO date string from synced data, or null
 * @param {number} maxRetentionDays - Maximum days to retain
 * @param {number} [nowMs] - Current time (default: Date.now())
 * @returns {string} The effective purge boundary (later of bounds or retention floor)
 */
export function computeEffectivePurgeBoundary(syncedBoundsStartIso, maxRetentionDays, nowMs = Date.now()) {
  const retentionFloorIso = computeCutoffIso(maxRetentionDays, nowMs);
  if (!syncedBoundsStartIso) return retentionFloorIso;
  return syncedBoundsStartIso > retentionFloorIso ? syncedBoundsStartIso : retentionFloorIso;
}

// ---- Retention Counts (for count-based cleanup, not time-based) -----------

/** Keep this many automatic cloud backups; delete older ones. */
export const BACKUP_RETENTION_COUNT_AUTOMATIC = 14;

/** Keep this many manual ("Back up now") cloud backups; delete older ones. */
export const BACKUP_RETENTION_COUNT_MANUAL = 14;

/** Keep this many most-recent items when pruning by count. */
export const DEFAULT_RETENTION_COUNT = 14;

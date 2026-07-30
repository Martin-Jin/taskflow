'use strict';

// Shared between computeNotifications.js (trigger rules) and
// notificationState.js (dedupe/throttle). Kept in one place so the two
// files can't quietly drift out of sync on the re-notify cadence.

// High/urgent overdue tasks re-notify at most this often, instead of firing
// on every worker run. Matches the client's Phase 2 cadence exactly (see
// src/hooks/useNotificationChecker.js's OVERDUE_RENOTIFY_MS) — kept the same
// for consistency between the in-app and email channels, and it's easily
// achievable given the worker runs every 5 minutes (see index.js's
// run-frequency comment).
const OVERDUE_RENOTIFY_MS = 60 * 60 * 1000;

module.exports = { OVERDUE_RENOTIFY_MS };

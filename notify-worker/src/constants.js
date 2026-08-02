'use strict';

// Shared between computeNotifications.js (trigger rules) and
// notificationState.js (dedupe/throttle). Currently empty — the overdue
// hourly re-notify constant that used to live here was removed when overdue
// notifications switched to a once-per-calendar-day cadence (matching
// dueToday) instead, to stop urgent/high-priority overdue tasks emailing up
// to ~24x/day. Kept as a module (rather than deleted outright) since these
// two files sharing one constants file is the right shape if a new
// cross-cutting cadence value is ever needed again.
module.exports = {};

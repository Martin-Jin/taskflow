/**
 * formatHours — display helper for a duration expressed in (possibly
 * fractional) hours. Now that the default estimate for un-specified tasks
 * is 5 minutes (see todoistService.DEFAULT_DURATION_HOURS), showing
 * everything as "0.1h" is unreadable — this renders sub-hour durations as
 * minutes and hour-plus durations as hours, matching how a person would
 * actually say it out loud.
 *
 * @param {number} hours
 * @returns {string} e.g. "5m", "45m", "1.5h", "2h"
 */
export function formatHours(hours) {
  const h = Number(hours) || 0;
  if (h <= 0) return '0m';
  if (h < 1) {
    const mins = Math.round(h * 60);
    return `${mins}m`;
  }
  // Trim trailing ".0" for whole hours, keep one decimal otherwise.
  const rounded = Math.round(h * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}h`;
}

/**
 * formatTimeLeft — the task row's short "time left / total estimate" line,
 * e.g. "30min / 4h", "1.5h / 3h", "1min / 5min". Same unit rule as
 * formatHours (under an hour reads in minutes, otherwise hours) but with the
 * unit spelled "min", which reads more clearly than a bare "m" next to a "/".
 *
 * @param {number} remainingHours
 * @param {number} estimatedHours
 * @returns {string}
 */
export function formatTimeLeft(remainingHours, estimatedHours) {
  const short = (hours) => formatHours(hours).replace(/m$/, 'min');
  return `${short(remainingHours)} / ${short(estimatedHours)}`;
}

/**
 * formatHoursLong — same idea as formatHours, but spelled out ("1 hour 30
 * minutes", "20 minutes") instead of abbreviated, for places showing a raw
 * estimatedHours decimal (e.g. 0.0833) would otherwise be unreadable.
 * Rounds to the nearest whole minute.
 *
 * @param {number} hours
 * @returns {string} e.g. "20 minutes", "1 hour", "1 hour 30 minutes"
 */
export function formatHoursLong(hours) {
  const totalMinutes = Math.round((Number(hours) || 0) * 60);
  if (totalMinutes <= 0) return '0 minutes';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(' ');
}

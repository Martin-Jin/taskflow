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

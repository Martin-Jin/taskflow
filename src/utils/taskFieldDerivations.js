/**
 * Small pure derivations that centralize task-field logic which multiple
 * updateTask callers (manual edits, the AI Assistant, future callers) would
 * otherwise each need to replicate.
 */

/**
 * When a task's estimatedHours changes, remainingHours should shift by the
 * same delta rather than staying pinned to its old value — otherwise raising
 * the estimate on an already-fully-scheduled task (remainingHours: 0) would
 * never add any new hours for the scheduler to place, and lowering it could
 * leave remainingHours greater than the new estimate.
 * Clamped to [0, nextEstimatedHours].
 */
export function deriveRemainingHoursOnEstimateChange(currentRemainingHours, currentEstimatedHours, nextEstimatedHours) {
  return Math.min(nextEstimatedHours, Math.max(0, currentRemainingHours + (nextEstimatedHours - currentEstimatedHours)));
}

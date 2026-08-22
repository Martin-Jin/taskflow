/**
 * ============================================================================
 * TIME-OF-DAY PREFERENCE
 * ============================================================================
 * An optional "this kind of work belongs in the morning" hint on a Task.
 *
 * Named periods rather than an arbitrary {start,end} window per task. It's the
 * vocabulary people actually use ("do it in the morning"), it smart-parses from
 * a typed title without inventing a syntax, the AI can set it from one word,
 * and it needs one dropdown instead of two time inputs on both task modals.
 * A bespoke window per task would be more expressive and almost never used.
 *
 * The preference is SOFT — see placementCost.js's timeOfDayCost. It nudges the
 * cost-minimising refinement pass, it does not constrain the allocator. A hard
 * constraint here would make schedules infeasible in ways that are very hard
 * for a user to debug: "why is nothing scheduled?" with no visible reason,
 * because the only free slots were in the wrong half of the day.
 * ============================================================================
 */

/** Minute-of-day ranges, end-exclusive. */
export const TIME_OF_DAY_WINDOWS = {
  morning: { start: 5 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 22 * 60 },
};

export const TIME_OF_DAY_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
};

/** Options for a picker, in day order. */
export const TIME_OF_DAY_OPTIONS = ['morning', 'afternoon', 'evening'];

/** @returns {{start: number, end: number}|null} */
export function resolveTimeOfDayWindow(preference) {
  return TIME_OF_DAY_WINDOWS[preference] || null;
}

/**
 * How many of a block's minutes fall OUTSIDE its task's preferred window.
 *
 * Measured as real overlap rather than "does the block start in the window",
 * so a long block that straddles the boundary is charged only for the part
 * that actually spills — otherwise a 3-hour morning task starting at 11:00
 * would cost the same as one starting at 20:00.
 *
 * @param {{startMinute: number, endMinute: number}} span - minute-of-day span
 * @param {string} preference
 * @returns {number} minutes outside the window (0 when fully inside)
 */
export function minutesOutsidePreference(span, preference) {
  const window = resolveTimeOfDayWindow(preference);
  if (!window || !span) return 0;
  const duration = Math.max(0, span.endMinute - span.startMinute);
  if (duration === 0) return 0;
  const overlapStart = Math.max(span.startMinute, window.start);
  const overlapEnd = Math.min(span.endMinute, window.end);
  const inside = Math.max(0, overlapEnd - overlapStart);
  return duration - inside;
}

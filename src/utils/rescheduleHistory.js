/**
 * rescheduleHistory — "has the user pushed this task's deadline, again?"
 *
 * A task pushed four times is the strongest signal the app has that something
 * is mis-scoped or isn't really going to happen. Nothing recorded that before:
 * the scheduler would quietly re-plan around each slip, so the pattern was
 * invisible precisely when it mattered most.
 *
 * WHAT IS STORED, AND WHY IT'S THIS SMALL. Two fields on Task —
 * `postponeCount` and `lastPostponedAt` — not an audit log. A history array on
 * every task would grow without bound inside a document that's rewritten in
 * full on every cross-device push and every shared-project push, and would
 * need its own retention policy (CLAUDE.md's Firestore rules). A counter plus
 * one timestamp answers the question the badge asks and cannot grow.
 *
 * WHAT COUNTS AS A POSTPONEMENT is the whole design, so each exclusion below
 * is deliberate. The rule is: *the user moved an existing deadline later on a
 * one-off task.* Everything else is either not the user's doing, not later, or
 * not a deadline slipping.
 *
 * Specifically NOT counted:
 *
 *   - **A resubmitted identical date.** TaskDetailModal's `commitChanges`
 *     sends `dueDate` on every save whether or not the user touched that
 *     field, so "the key is present" means nothing — the value has to change.
 *     Miss this and editing a task's title reads as postponing it.
 *   - **Moving a deadline earlier.** Pulling work forward is the opposite of
 *     the behaviour being measured.
 *   - **Giving an undated task its first date**, or clearing a date. That's
 *     scheduling and unscheduling, not slipping.
 *   - **The scheduler moving blocks.** Re-balance re-plans *when you work* on
 *     a task; only the due date is a promise the user made. Dragging a block
 *     to another day likewise rearranges a week without moving a deadline.
 *   - **A recurring task advancing on completion.** That's the recurrence
 *     engine (`completeTask`), and it never routes through the edit path this
 *     hooks — but recurring tasks are excluded outright anyway. Their entire
 *     model is "the date moves", so a count there accumulates forever and
 *     measures how long you've used the task, not whether it's stuck.
 *   - **An explicit complete/uncomplete in the same update.** Reopening a
 *     finished task is its own intent, and the reopen path already moves the
 *     date as a side effect.
 *   - **Descendants of an enforcing ancestor.** One user action must be one
 *     increment. Those cascades are applied in a separate pass in
 *     SchedulerContext's `updateTask`, after the edited task's own merge, so
 *     they never reach this function — see the comment at the call site.
 */

/**
 * How many postponements before the badge appears. Three is the point at which
 * a count stops being noise: everything gets pushed once or twice, so a badge
 * at 1 would sit on half the list and mean nothing (direction rule 3 — never
 * render the absence of information; a badge nobody can act on is the same
 * failure). The badge is meant to be rare enough that seeing one is a prompt
 * to rescope or drop the task.
 */
export const POSTPONE_BADGE_THRESHOLD = 3;

/**
 * Decides whether a task edit is a postponement, and returns the fields to
 * merge if so.
 *
 * Pure and exported separately from the reducer that uses it because every
 * interesting case is an exclusion, and exclusions are near-impossible to
 * verify through the UI — a wrongly-counted resubmission looks identical to a
 * correctly-ignored one until a badge shows up on a task nobody postponed.
 *
 * @param {import('../types').Task} prevTask - the task as it is before the edit
 * @param {object} updates - the partial update being applied
 * @param {string} nowIso - current ISO datetime (injected, so this stays pure)
 * @returns {{postponeCount: number, lastPostponedAt: string}|null} fields to
 *   merge, or null when this edit is not a postponement
 */
export function planPostponeUpdate(prevTask, updates, nowIso) {
  if (!prevTask || !updates) return null;
  if (!('dueDate' in updates)) return null;
  // An explicit completion state change is its own intent, not a slip.
  if ('isCompleted' in updates) return null;
  // See the header: a recurring task's date is designed to move.
  if (prevTask.isRecurring) return null;

  const from = prevTask.dueDate;
  const to = updates.dueDate;
  // Needs a real date on both sides: no first-time scheduling, no unscheduling.
  if (!from || !to) return null;
  // String comparison is correct and intentional here — both are ISO
  // YYYY-MM-DD, which sorts lexicographically, and parsing them into Dates
  // would reintroduce the timezone bugs dateUtils exists to avoid.
  if (to <= from) return null;

  const previous = Number.isFinite(prevTask.postponeCount) ? prevTask.postponeCount : 0;
  return { postponeCount: previous + 1, lastPostponedAt: nowIso };
}

/**
 * Whether a task's slip count has earned a badge.
 *
 * @param {import('../types').Task} task
 * @returns {boolean}
 */
export function shouldShowPostponeBadge(task) {
  return (task?.postponeCount || 0) >= POSTPONE_BADGE_THRESHOLD;
}

/**
 * Badge text. Reads as a count of events, not a score — "pushed 4×" is a fact
 * about what happened, where "4 slips" would editorialise about the user.
 *
 * @param {import('../types').Task} task
 * @returns {string}
 */
export function describePostponeCount(task) {
  return `pushed ${task?.postponeCount || 0}×`;
}

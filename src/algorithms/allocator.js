/**
 * ============================================================================
 * ALLOCATION ENGINE  (the scheduling heuristic)
 * ============================================================================
 * This is the mathematical/logical core of the app. Given:
 *   - a list of Tasks (with estimatedHours / remainingHours, priority, dueDate)
 *   - a Map<date, DayCapacity> describing free hours per day
 *   - SchedulingRules (buffer days, pacing preference, chunk sizes)
 *   - a `taskById` lookup covering the FULL task list (including tasks not
 *     in the eligible list above, e.g. a container parent — see
 *     resolveDueDate below), needed to walk a sub-task's `parentId` chain
 *
 * ...it produces a list of new ScheduledBlocks that place every possible
 * hour of remaining task work into free capacity, respecting:
 *   1. Locked blocks/tasks are never touched (handled by caller — this
 *      module only ever receives *unlocked* remaining work).
 *   2. The 1-day-before-due-date buffer rule.
 *   3. Priority-first ordering when capacity is scarce.
 *   4. Even pacing across the available runway for lower-urgency tasks,
 *      front-loading for urgent/high priority tasks near deadline.
 *   5. A per-task cap on how many chunks it may be split into (no marathon
 *      8-hour blocks courtesy of maxChunkHours; no unbounded fragmentation
 *      courtesy of maxChunksFor), plus a flat 5-minute floor on individual
 *      chunk size (MIN_CHUNK_HOURS) so nothing lands as a sliver.
 *   6. Passive tasks (task.isPassive — e.g. laundry, something baking) are
 *      allowed to overlap other blocks in time, since they don't need
 *      attention. See "PASSIVE TASK PLACEMENT" below.
 *   7. task.fixedTime ("HH:MM"), when set, pins every block placed for that
 *      task to start at that exact time of day instead of wherever first-fit
 *      would land — see placeFixedTimeInDay below. Every non-passive
 *      fixedTime task is placed in a dedicated PRE-PASS before any other task
 *      (fixedTime or not) — see allocateTasks' "FIXED-TIME PRE-PASS" — so a
 *      fixed time commitment always wins its exact slot regardless of a
 *      competing task's priority/urgency score; only a higher-scored
 *      fixedTime task competing for the SAME slot can still take it first.
 *      Exception: when the task's whole window is a single day
 *      (enforceDueDate) and the pinned slot isn't available that day, there's
 *      no OTHER day left to retry on — see placeAndRecordBlocks'
 *      allowSameDayFallback, which lets the leftover hours fall back to
 *      ordinary first-fit placement elsewhere that same day rather than
 *      reporting a visibly free day as out of capacity. Whenever that
 *      fallback engages, the task is flagged as `fixed_time_shifted` in
 *      allocateTasks' returned `timeShifted` list — even when every hour
 *      still gets placed, the task landed at an unrequested time-of-day, and
 *      that's surfaced to the user rather than staying silent. A pinned time
 *      that never falls within a day's working hours at all (as opposed to
 *      being occupied by something) is reported distinctly too, as
 *      `fixed_time_outside_hours`, instead of falling through to a generic
 *      "no capacity" reason.
 *   8. A "blocker" task (one with at least one other incomplete task
 *      depending on it — see computeBlockerIds) skips even-pacing/front-load
 *      entirely and greedily claims as much of each day's capacity as it can,
 *      so it finishes ASAP instead of splitting days evenly with unrelated
 *      work — the whole point of unblocking whatever's waiting on it.
 *
 * --------------------------------------------------------------------------
 * ALGORITHM WALKTHROUGH
 * --------------------------------------------------------------------------
 * Step 1 — SCORE & SORT tasks:
 *   score(task) = priorityWeight(task.priority) * urgencyMultiplier(task)
 *
 *   priorityWeight:  urgent=4, high=3, medium=2, low=1
 *
 *   urgencyMultiplier grows as the "effective deadline" (dueDate - bufferDays)
 *   approaches. We use inverse days-remaining so a task due tomorrow massively
 *   outranks one due in 6 weeks even at equal priority:
 *
 *       urgencyMultiplier = 1 + ( 1 / max(1, daysUntilEffectiveDeadline) ) * 10
 *
 *   Tasks with no due date of their own AND no ancestor due date to borrow
 *   (see resolveDueDate) get a fixed low urgency multiplier (1) so they fill
 *   in the gaps around deadline-driven work rather than crowding it out. A
 *   sub-task with no due date of its own instead borrows the nearest
 *   ancestor's due date — the parent goal's deadline pressures its steps
 *   even when they aren't individually dated — see resolveDueDate.
 *
 *   Final sort: descending score, then (for an exact tie — e.g. two
 *   default-priority, undated sibling sub-tasks with no ancestor deadline
 *   either) ascending `createdAt` as a stable tiebreak, so whichever sibling
 *   was created first schedules first rather than an arbitrary/unstable
 *   ordering. This single score elegantly captures both "priority" and "due
 *   date" as required, instead of a brittle nested if/else cascade.
 *
 *   A task with at least one incomplete dependent (see computeBlockerIds) is
 *   flagged as a "blocker" — it still sorts by the score above, but Steps 3
 *   and 4 below treat it differently once it's up: it skips even-pacing/
 *   front-load and instead greedily consumes each day's capacity in
 *   chronological order until its remaining hours are cleared or its window
 *   runs out, so it clears out of the way as fast as possible for whatever's
 *   waiting on it.
 *
 * Step 2 — DETERMINE EACH TASK'S PLANNING WINDOW:
 *   effectiveDeadline = dueDate - bufferDays   (finish 1 day early, by default)
 *   windowStart = today (or task.earliestDate if later — a user-set "don't
 *                 schedule before this" override)
 *   windowEnd   = effectiveDeadline (or horizon end, if no due date)
 *
 *   task.enforceDueDate overrides all of the above: windowStart and windowEnd
 *   both collapse to dueDate itself (no buffer, no earliestDate) — the task
 *   must be done ON its due date, not paced earlier. See getTaskWindow().
 *
 * Step 3 — PACE HOURS ACROSS THE WINDOW:
 *   daysInWindow = windowEnd - windowStart + 1
 *   idealHoursPerDay = remainingHours / daysInWindow
 *
 *   If frontLoadUrgent is true AND the task is high/urgent priority, we bias
 *   allocation toward the *later* days of the window (still respecting the
 *   buffer) using a weighting curve so more hours land closer to the
 *   deadline — reflecting how urgent work tends to intensify near the wire.
 *   Otherwise, hours are spread as evenly as capacity allows (even pacing
 *   for long-horizon, lower-urgency tasks, per the requirements).
 *
 * Step 4 — GREEDY CAPACITY-AWARE PLACEMENT:
 *   Walk the task's window day-by-day (in bias order), and for each day:
 *     - Determine target hours for that day (from Step 3's distribution) —
 *       except a blocker task (see computeBlockerIds), which targets ALL of
 *       its remaining hours every day instead of an ideal share, so it
 *       greedily consumes whatever capacity that day actually has.
 *     - Clamp to maxChunkHours, the task's remaining chunk budget, and to
 *       remaining day capacity
 *     - Slice from the day's free intervals (first-fit)
 *     - Deduct from both the task's remainingHours and the day's capacity
 *   Continue until remainingHours hits 0 or the window is exhausted (in
 *   which case the task is flagged as "at risk" / overflow for the UI to
 *   surface, rather than silently dropping work).
 *
 * --------------------------------------------------------------------------
 * PASSIVE TASK PLACEMENT
 * --------------------------------------------------------------------------
 * A non-passive task carves its placed hours out of the shared `workingFree`
 * map, so no two non-passive tasks can ever be placed in the same minute —
 * that's the normal "one thing at a time" rule.
 *
 * A passive task (isPassive: true) instead places against a fresh copy of
 * each day's ORIGINAL free intervals (before this run carved anything out of
 * them) every time, and never mutates the shared `workingFree` map. That
 * means:
 *   - A passive task can land on the same time slot as a non-passive task
 *     (laundry running while you're in a meeting).
 *   - Multiple passive tasks can land on the same time slot as each other
 *     (laundry + something baking, simultaneously).
 *   - A passive task never steals capacity a non-passive task needed, and
 *     vice versa — they're on functionally separate tracks.
 * ============================================================================
 */

import { addDays, diffDays, dateRange, timeToMinutes, minutesToTime } from '../utils/dateUtils';
import { getDependentsMap } from '../utils/dependencyUtils';

const PRIORITY_WEIGHT = { urgent: 4, high: 3, medium: 2, low: 1 };
// "Close enough to zero" threshold for hour comparisons below. Placements
// round to the nearest minute (see placeHoursInDay's takeMins), which can
// leave up to half a minute (~0.0083h) of rounding error in `remaining` —
// a threshold tighter than that spuriously carries a fully-schedulable task
// through the sweep/spill passes and into the overflow report.
const EPSILON_HOURS = 1 / 120;
// Absolute floor for any single placed chunk — 5 minutes. A task can still
// be split into many chunks (see maxChunksFor below), but no individual
// placement is ever allowed to be smaller than this, EXCEPT when the task's
// entire remaining duration is itself at or under this floor, in which case
// that shorter amount is placed as one single chunk (see floorHours handling
// in placeHoursInDay/placeFixedTimeInDay).
const MIN_CHUNK_HOURS = 5 / 60;
// Pacing-preference threshold used ONLY by allocateTasks' first (weighted-
// share) pass below — separate from MIN_CHUNK_HOURS, which is the real hard
// floor on any placed chunk's size. A multi-day window's per-day "ideal
// share" (remainingHours split evenly/front-loaded across the window) is
// often a small fraction of the task's total on any single day; without a
// gate here, pass 1 would happily commit a tiny few-minute sliver on each
// day of the window and burn through the task's whole chunk-count budget
// (see maxChunksFor) before the sweep/overflow passes below ever get a
// chance to give it fuller, more useful placements. This purely prevents
// that low-value pacing behavior — it does not participate in the actual
// split-count-cap or minimum-chunk-size rules, and a day skipped here is
// still eligible for placement by the later passes.
const PACING_SHARE_THRESHOLD_HOURS = 0.5;

/**
 * How many separate chunks a task's total duration may ever be split across.
 * This is a CAP on chunk count, not a per-chunk minimum size — chunks can be
 * as small as MIN_CHUNK_HOURS (5 min) as long as the count doesn't exceed
 * this. Computed from the task's estimated (not remaining) duration so a
 * partially-completed task doesn't get a smaller budget just because some of
 * it is already done: round(durationHours * 60 / 30), minimum 1.
 *   - 1h   -> round(60/30)  = 2 max chunks
 *   - 1h20 -> round(80/30)  = 3 max chunks
 *   - 1h10 -> round(70/30)  = 2 max chunks
 */
function maxChunksFor(task) {
  const durationHours = task.estimatedHours ?? task.remainingHours ?? 0;
  return Math.max(1, Math.round((durationHours * 60) / 30));
}

/**
 * Walk up `task.parentId` (arbitrarily deep — nesting is capped at 2 levels
 * by the UI, but this walk stays general/defensive rather than assuming
 * that) to find the nearest ancestor's own `dueDate`. `taskById` must cover
 * the FULL task list (not just the eligible/schedulable subset), since an
 * ancestor — especially a container parent — is often excluded from
 * scheduling entirely and wouldn't be in a filtered list. `visited` guards
 * against a hand-edited/corrupted backup introducing a cycle, mirroring the
 * same defensive pattern used elsewhere for parentId walks (e.g.
 * SchedulerContext's getDescendantIds).
 */
function findAncestorDueDate(task, taskById) {
  if (!taskById || !task.parentId) return null;
  const visited = new Set([task.id]);
  let current = task;
  while (current.parentId) {
    const parent = taskById.get(current.parentId);
    if (!parent || visited.has(parent.id)) return null;
    if (parent.dueDate) return parent.dueDate;
    visited.add(parent.id);
    current = parent;
  }
  return null;
}

/**
 * A task's own `dueDate` if it has one, otherwise the nearest ancestor's
 * `dueDate` it can borrow (see findAncestorDueDate) — the "goal deadline" a
 * sub-task inherits when it has none of its own. Returns null if neither
 * exists (a top-level task with no due date, or a sub-task whose whole
 * ancestor chain is also undated).
 */
export function resolveDueDate(task, taskById) {
  return task.dueDate || findAncestorDueDate(task, taskById);
}

/**
 * The date by which a task's remaining hours must effectively be finished:
 * the buffer-shrunk deadline normally, but the raw due date itself when
 * `enforceDueDate` is set (the buffer doesn't apply — there's no "finish
 * early" cushion once the whole window is collapsed onto the due date).
 * `enforceDueDate` only ever applies against the task's OWN due date (per
 * its typedef) — never against a borrowed ancestor deadline. An ancestor's
 * due date (enforced or not) is always a soft "must finish by" deadline for
 * an undated sub-task — it clamps the LATEST day the sub-task's window can
 * extend to (see getTaskWindow), but never forces the sub-task onto one
 * single day; a "must be done on this day" parent still just means "must be
 * *finished* by this day" for its steps, not "every step happens on this
 * exact day." Returns null if there's no due date to resolve at all (see
 * resolveDueDate).
 */
function getEffectiveDeadline(task, bufferDays, taskById) {
  const dueDate = resolveDueDate(task, taskById);
  if (!dueDate) return null;
  return task.enforceDueDate && task.dueDate ? task.dueDate : addDays(dueDate, -bufferDays);
}

/**
 * Backward urgency propagation: a task's OWN deadline pressure should also
 * fall on whatever it depends on, since a blocker running late makes every
 * task waiting on it late too (transitively — chains can be >1 hop). Returns
 * a Map<taskId, ISODate|null> of each task's "effective" deadline for scoring
 * purposes: the earliest of its own resolved deadline and every (incomplete)
 * direct/indirect dependent's effective deadline.
 *
 * This only propagates the DEADLINE, not the whole priority*urgency score —
 * a blocker still uses its own priority weight in scoreTask, just evaluated
 * against a potentially-tighter borrowed deadline. That keeps "urgent B
 * depends on low-priority A" from making A outrank genuinely urgent
 * unrelated work; it only makes A no longer look falsely non-urgent.
 *
 * Walks the full task list (via `taskById` if given, since a gated-out
 * dependent — one whose own deps aren't met yet — still needs its urgency
 * counted here even though it's excluded from the schedulable list the
 * caller hands to prioritizeTasks/allocateTasks). Defensive against cycles
 * via a per-chain `stack` set (mirrors findAncestorDueDate's pattern above) —
 * a scheduling pass must never hang on bad dependency data, even though the
 * UI (getIneligibleDependencyIds) already stops one from being created.
 */
function computeEffectiveDeadlines(tasks, bufferDays, taskById) {
  const allTasks = taskById ? [...taskById.values()] : tasks;
  const dependentsOf = getDependentsMap(allTasks);
  const cache = new Map();

  function resolve(task, stack) {
    if (cache.has(task.id)) return cache.get(task.id);
    if (stack.has(task.id)) return null; // cycle guard: don't let this chain contribute further

    stack.add(task.id);
    let deadline = getEffectiveDeadline(task, bufferDays, taskById);
    for (const dependentId of dependentsOf.get(task.id) || []) {
      const dependent = taskById ? taskById.get(dependentId) : allTasks.find((t) => t.id === dependentId);
      if (!dependent || dependent.isCompleted) continue; // a finished dependent no longer applies pressure
      const dependentDeadline = resolve(dependent, stack);
      if (dependentDeadline && (!deadline || dependentDeadline < deadline)) deadline = dependentDeadline;
    }
    stack.delete(task.id);

    cache.set(task.id, deadline);
    return deadline;
  }

  const result = new Map();
  for (const task of allTasks) result.set(task.id, resolve(task, new Set()));
  return result;
}

/**
 * IDs of tasks that are "blockers": they have at least one other, still-
 * incomplete task depending on them (directly, via that task's `dependsOn`).
 * A completed dependent doesn't count — nothing is actually waiting on the
 * blocker anymore. Used by allocateTasks to make a blocker greedily consume
 * a day's capacity instead of pacing evenly (see the module doc comment,
 * Step 4) — the goal is to clear the blocker out of the way as fast as
 * possible, not to spread it thin alongside unrelated work. `taskById`, when
 * given, should cover the FULL task graph (not just the eligible/schedulable
 * subset) so a dependent that isn't itself being scheduled this run (e.g.
 * already locked) still counts.
 */
function computeBlockerIds(tasks, taskById) {
  const allTasks = taskById ? [...taskById.values()] : tasks;
  const dependentsOf = getDependentsMap(allTasks);
  const byId = taskById || new Map(allTasks.map((t) => [t.id, t]));
  const blockerIds = new Set();
  for (const task of allTasks) {
    const dependents = dependentsOf.get(task.id) || [];
    const hasIncompleteDependent = dependents.some((depId) => {
      const dep = byId.get(depId);
      return dep && !dep.isCompleted;
    });
    if (hasIncompleteDependent) blockerIds.add(task.id);
  }
  return blockerIds;
}

/**
 * Compute a single sortable urgency+priority score for a task, relative to
 * `today`. `effectiveDeadlines`, if given, is a precomputed
 * computeEffectiveDeadlines() map — pass it from prioritizeTasks so a whole
 * batch of tasks shares one graph walk instead of repeating it per task.
 * Omit it (as any standalone caller may) to fall back to just this task's
 * own resolved deadline, with no backward propagation.
 */
export function scoreTask(task, today, bufferDays, taskById, effectiveDeadlines) {
  const weight = PRIORITY_WEIGHT[task.priority] ?? 1;

  const effectiveDeadline = effectiveDeadlines
    ? effectiveDeadlines.get(task.id) ?? null
    : getEffectiveDeadline(task, bufferDays, taskById);
  if (effectiveDeadline === null) {
    return weight * 1; // no deadline (own or borrowed) -> baseline urgency multiplier of 1
  }

  const daysRemaining = Math.max(1, diffDays(today, effectiveDeadline));
  const urgencyMultiplier = 1 + (1 / daysRemaining) * 10;

  return weight * urgencyMultiplier;
}

/**
 * Sort tasks by descending schedulability score. Pure function, does not
 * mutate input.
 *
 * A sub-task (`parentId` set) competes for capacity exactly like any other
 * task now, dated or not — an undated sub-task scores via the same baseline
 * urgency (or a borrowed ancestor deadline, see getEffectiveDeadline) every
 * other undated task gets, rather than being excluded outright. `taskById`
 * (the full task list, not just this eligible subset) is used both for that
 * ancestor lookup and to walk the full dependency graph for backward urgency
 * propagation (see computeEffectiveDeadlines) — a blocker task's urgency
 * rises to match whatever depends on it, not just its own deadline.
 */
export function prioritizeTasks(tasks, today, bufferDays, taskById) {
  const effectiveDeadlines = computeEffectiveDeadlines(tasks, bufferDays, taskById);
  const scoreCache = new Map();
  const scoreOf = (task) => {
    if (!scoreCache.has(task.id)) scoreCache.set(task.id, scoreTask(task, today, bufferDays, taskById, effectiveDeadlines));
    return scoreCache.get(task.id);
  };
  return [...tasks]
    .filter((t) => !t.isCompleted && t.remainingHours > 0)
    .sort((a, b) => {
      const scoreDiff = scoreOf(b) - scoreOf(a);
      if (scoreDiff !== 0) return scoreDiff;
      // Equal score (e.g. two default-priority, undated sibling sub-tasks) —
      // tiebreak by creation order so whichever was added first schedules
      // first, instead of an arbitrary/unstable ordering.
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
}

/**
 * Compute the [windowStart, windowEnd] ISO date pair a task's remaining
 * hours must be placed within.
 */
function getTaskWindow(task, today, horizonEnd, bufferDays, taskById) {
  // enforceDueDate collapses the ENTIRE window onto the due date itself —
  // more restrictive than (and takes precedence over) earliestDate/
  // bufferDays, which only ever clamp the window's edges. Only meaningful
  // when the task has its OWN due date; otherwise falls through to the
  // normal undated-task handling below. If the due date has already
  // passed, this intentionally leaves the window in the past (outside the
  // capacity map), so the task's hours simply report as overflow like any
  // other task that no longer fits its window — no special catch-up
  // behavior invented here.
  if (task.enforceDueDate && task.dueDate) {
    return { windowStart: task.dueDate, windowEnd: task.dueDate };
  }

  // task.earliestDate is a user-set override ("don't schedule this before
  // day X") — clamp the window start to it when it's later than today, but
  // never let it push the start before today (that would try to schedule
  // into the past).
  const windowStart = task.earliestDate && task.earliestDate > today ? task.earliestDate : today;
  let windowEnd = horizonEnd;
  // A sub-task with no due date of its own uses its nearest ancestor's due
  // date here too (see resolveDueDate) — the parent goal's deadline paces
  // its steps, not just their relative ordering (scoreTask above).
  const dueDate = resolveDueDate(task, taskById);
  if (dueDate) {
    const effectiveDeadline = getEffectiveDeadline(task, bufferDays, taskById);
    // If the buffer pushes the deadline back past windowStart, the buffer
    // can't be honored in full — fall back to the resolved due date
    // (clamped to the horizon) rather than collapsing the window to
    // windowStart alone, which would exclude the due date itself from
    // consideration.
    windowEnd = effectiveDeadline < windowStart ? (dueDate < horizonEnd ? dueDate : horizonEnd) : effectiveDeadline;
    if (windowEnd < windowStart) windowEnd = windowStart;
  }
  return { windowStart, windowEnd };
}

/**
 * Build an ordered list of dates within [start, end] representing the
 * preference order in which a task should attempt to claim hours.
 * - Even pacing: chronological order (spread naturally by the greedy pass).
 * - Front-loaded (urgent near deadline): reverse-weighted so days closer to
 *   the deadline are attempted with a higher target share first.
 */
function buildDayWeights(windowStart, windowEnd, frontLoad) {
  const span = Math.max(1, diffDays(windowStart, windowEnd) + 1);
  const days = dateRange(windowStart, span);

  if (!frontLoad) {
    // Even weight per day.
    return days.map((date) => ({ date, weight: 1 / span }));
  }

  // Linear ramp: later days (closer to deadline) get proportionally more
  // weight. Weights sum to 1. index 0 (earliest) gets the smallest share.
  const weights = days.map((_, i) => i + 1); // 1..span
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  return days.map((date, i) => ({ date, weight: weights[i] / totalWeight }));
}

/**
 * Attempt to carve `hours` worth of time out of a day's free intervals,
 * respecting max chunk size and the task's chunk-count budget. Mutates
 * `dayFreeIntervals` (minute-based, array of {start,end}) in place and
 * returns the number of hours actually placed plus the concrete {start,end}
 * minute ranges used.
 *
 * `chunkState` (`{ used, max }`, mutated in place) tracks how many separate
 * chunks this task has already been split into across the WHOLE allocation
 * run (all passes, all days — see maxChunksFor) versus how many it's allowed.
 * Each placement produced by this call (one per free interval consumed)
 * increments `chunkState.used`. Once `used` reaches `max`, this function
 * still places into the NEXT interval it considers (so the last permitted
 * chunk can still absorb whatever remains — see the loop condition below),
 * but stops after that rather than fragmenting further.
 *
 * Every placed chunk must be at least MIN_CHUNK_HOURS (5 min), EXCEPT when
 * the task's entire remaining duration (`floorHours`) is itself at or under
 * that floor — then that shorter total may be placed as one single chunk.
 *
 * Whole-block lookahead: plain first-fit would always bite into the earliest
 * interval first, even a small one, which can burn the task's LAST available
 * chunk on a partial placement while a later interval that same day is big
 * enough to hold the entire remaining duration as a single continuous block
 * (e.g. a piano task splits into two earlier slivers, then can't fit its
 * final chunk at 09:00 even though 20:00-22:00 is wide open and would've
 * taken the whole thing). So before consuming a chunk on interval `i`, we
 * check: is this the LAST chunk this task gets (`chunkState.used + 1 >=
 * chunkState.max`), does interval `i` fail to cover the FULL remaining
 * `hoursToPlace` on its own, and does some LATER interval in this same day
 * cover it in full? If so, skip ahead and place the whole remainder there
 * instead of fragmenting into a partial chunk here. This only ever changes
 * WHICH interval absorbs the last chunk, never how many chunks get used.
 */
/**
 * Cross-day counterpart to placeHoursInDay's same-day whole-block lookahead
 * (see that function's doc comment) — same idea, one level up. If placing on
 * `date` would spend the task's LAST available chunk (chunkState) and this
 * day's free time can't cover the full remaining amount on its own, but some
 * LATER day in `remainingDates` has a single free interval big enough to take
 * the whole thing, skip `date` for now so that later day gets it as one
 * continuous block instead of fragmenting a sliver here and stranding the
 * rest. Without this, a task whose chunk-count budget rounds down to 1 (any
 * task <=30min, see maxChunksFor) can burn its only chunk on the first day
 * that clears MIN_CHUNK_HOURS at all — even a bare 5-minute gap — and every
 * later pass then finds the budget already exhausted, silently overflowing
 * the rest despite ample free capacity still sitting later in the window.
 * Only ever changes WHICH day absorbs the last chunk, never how many chunks
 * get used or whether a day gets skipped when it isn't the deciding factor.
 */
function hasLaterFullFitDay(hoursNeeded, currentDate, remainingDates, freeForTask) {
  for (const date of remainingDates) {
    if (date <= currentDate) continue;
    const intervals = freeForTask.get(date);
    if (!intervals) continue;
    if (intervals.some((iv) => (iv.end - iv.start) / 60 >= hoursNeeded - EPSILON_HOURS)) return true;
  }
  return false;
}

function placeHoursInDay(hours, dayFreeIntervals, maxChunkHours, chunkState, floorHours = hours) {
  let hoursToPlace = Math.min(hours, maxChunkHours);
  // Normally a placed chunk must clear MIN_CHUNK_HOURS. But a task whose
  // ENTIRE remaining duration is already at or under that floor is allowed
  // to place that shorter total as a single chunk rather than being
  // permanently unplaceable (see MIN_CHUNK_HOURS above).
  const effectiveMinChunk = floorHours <= MIN_CHUNK_HOURS + EPSILON_HOURS ? floorHours : MIN_CHUNK_HOURS;
  const placements = [];

  for (
    let i = 0;
    i < dayFreeIntervals.length && hoursToPlace >= effectiveMinChunk - EPSILON_HOURS && chunkState.used < chunkState.max;
    i++
  ) {
    const interval = dayFreeIntervals[i];
    const availableMins = interval.end - interval.start;
    const availableHours = availableMins / 60;
    if (availableHours < effectiveMinChunk) continue;

    // Last-chunk whole-block lookahead (see doc comment above): if taking a
    // partial bite here would spend the task's final chunk, and this interval
    // can't cover the full remainder on its own, prefer a later interval that
    // CAN take the whole thing in one continuous block over fragmenting here.
    if (chunkState.used + 1 >= chunkState.max && availableHours < hoursToPlace - EPSILON_HOURS) {
      const laterFullFitIdx = dayFreeIntervals.findIndex(
        (later, j) => j > i && (later.end - later.start) / 60 >= hoursToPlace - EPSILON_HOURS
      );
      if (laterFullFitIdx !== -1) continue; // skip this partial slot; the loop will reach the full-fit interval
    }

    const takeHours = Math.min(hoursToPlace, availableHours);
    const takeMins = Math.round(takeHours * 60);
    // A sub-minute-rounding sliver (e.g. leftover floating-point residue from
    // earlier passes) can round down to 0 minutes here. Skip it rather than
    // pushing a zero-duration block — there's nothing meaningful to place.
    if (takeMins <= 0) continue;
    const placementStart = interval.start;
    const placementEnd = interval.start + takeMins;

    placements.push({ start: placementStart, end: placementEnd });
    interval.start = placementEnd; // shrink the free interval from the front
    hoursToPlace -= takeHours;
    chunkState.used += 1;
  }

  // Clean up now-empty intervals.
  for (let i = dayFreeIntervals.length - 1; i >= 0; i--) {
    if (dayFreeIntervals[i].end - dayFreeIntervals[i].start <= 0) dayFreeIntervals.splice(i, 1);
  }

  const placedHours = placements.reduce((sum, p) => sum + (p.end - p.start) / 60, 0);
  return { placedHours, placements };
}

/**
 * When a `fixedTime` placement fails, find which busy interval (if any) is
 * responsible so the caller can report a specific conflict instead of a bare
 * "couldn't schedule". Checks for overlap against each busy interval PADDED
 * by `gapMins` (mirroring capacityEngine's own padding, since a slot can fail
 * to qualify purely due to the minimum-gap-between-blocks rule even when the
 * fixed start time itself isn't literally inside the busy interval), over the
 * minimum span the task would need to occupy starting at `fixedStartMins`.
 * Returns null (falls through to a generic "no capacity" reason) if nothing
 * tagged overlaps — e.g. the fixed time is simply outside the work day.
 */
function findFixedTimeConflict(fixedStartMins, neededMins, busyIntervals, gapMins) {
  const windowEnd = fixedStartMins + neededMins;
  for (const b of busyIntervals || []) {
    const paddedStart = b.start - gapMins;
    const paddedEnd = b.end + gapMins;
    if (paddedEnd > fixedStartMins && paddedStart < windowEnd) {
      return { source: b.source, id: b.id, label: b.label, start: b.start, end: b.end };
    }
  }
  return null;
}

/**
 * True when the fixed time-of-day never fell within the day's working-hours
 * window at all (e.g. a 06:00 fixedTime task when work hours start at 09:00)
 * — as opposed to falling inside working hours but being occupied by
 * something. `workWindow` is capacityEngine's per-day `{start, end}` bounds
 * (minutes-since-midnight, already nowClamp-adjusted for "today" — see
 * computeDayCapacity). Returns false (never reports "outside hours") if
 * `workWindow` wasn't supplied, so callers that don't have it (e.g. a unit
 * test constructing a bare capacityMap) fall back to the old generic
 * `no_capacity` behavior instead of a false positive.
 */
function isOutsideWorkingHours(fixedStartMins, workWindow) {
  if (!workWindow) return false;
  return fixedStartMins < workWindow.start || fixedStartMins >= workWindow.end;
}

/**
 * Like placeHoursInDay, but for a task with `fixedTime` set: the placement
 * MUST start at `fixedStartMins` (the fixed time-of-day, in minutes) rather
 * than wherever first-fit would land. Finds the single free interval that
 * contains that start time and carves forward from it, splitting the
 * interval around the placement (front slice, if any, stays free; back
 * slice, if any, stays free) instead of always shrinking from the front like
 * placeHoursInDay does.
 *
 * If no free interval contains the fixed start time, the task's chunk budget
 * is already exhausted (see `chunkState`/maxChunksFor), or the interval
 * doesn't have enough room from that point to fit at least MIN_CHUNK_HOURS
 * (unless the task's whole remaining duration is itself under that floor —
 * see `floorHours`), this places nothing for the day — consistent with how
 * the rest of the allocator treats a day that can't fit a task's
 * requirements: the hours simply aren't placed there, and the caller's
 * normal overflow reporting picks up any hours that end up unplaceable
 * across the whole window (see allocateTasks). No fallback to a different
 * time is attempted HERE; the whole point of `fixedTime` is that the task is
 * done at that time or not that day — a multi-day window simply retries the
 * same fixed time on the next day. The one exception (a single-day window
 * with nowhere else to retry) is handled one level up, by
 * placeAndRecordBlocks' allowSameDayFallback.
 *
 * On failure, also attempts to identify WHAT occupies the slot (see
 * findFixedTimeConflict) using `dayBusyIntervals`/`gapMins` — surfaced as
 * `conflict` on the returned object (null if nothing tagged overlaps). If
 * nothing occupies it AND the fixed time was never inside the day's
 * working-hours bounds at all (see isOutsideWorkingHours/`workWindow`), that
 * distinction is surfaced separately via `outsideWorkingHours: true` — a
 * bounds issue, not a "something's in the way" conflict — so the caller can
 * report a specific reason rather than falling through to generic
 * `no_capacity`.
 */
function placeFixedTimeInDay(hours, dayFreeIntervals, maxChunkHours, fixedStartMins, chunkState, floorHours = hours, dayBusyIntervals, gapMins = 0, workWindow) {
  const hoursToPlace = Math.min(hours, maxChunkHours);
  const effectiveMinChunk = floorHours <= MIN_CHUNK_HOURS + EPSILON_HOURS ? floorHours : MIN_CHUNK_HOURS;
  const neededMins = Math.round(effectiveMinChunk * 60);

  if (chunkState.used >= chunkState.max) {
    return { placedHours: 0, placements: [], conflict: null, outsideWorkingHours: false };
  }

  const idx = dayFreeIntervals.findIndex((iv) => iv.start <= fixedStartMins && iv.end > fixedStartMins);
  if (idx === -1) {
    const conflict = findFixedTimeConflict(fixedStartMins, neededMins, dayBusyIntervals, gapMins);
    return { placedHours: 0, placements: [], conflict, outsideWorkingHours: !conflict && isOutsideWorkingHours(fixedStartMins, workWindow) };
  }

  const interval = dayFreeIntervals[idx];
  const availableHours = (interval.end - fixedStartMins) / 60;
  if (availableHours < effectiveMinChunk - EPSILON_HOURS) {
    const conflict = findFixedTimeConflict(fixedStartMins, neededMins, dayBusyIntervals, gapMins);
    return { placedHours: 0, placements: [], conflict, outsideWorkingHours: !conflict && isOutsideWorkingHours(fixedStartMins, workWindow) };
  }

  const takeHours = Math.min(hoursToPlace, availableHours);
  const takeMins = Math.round(takeHours * 60);
  const placementStart = fixedStartMins;
  const placementEnd = fixedStartMins + takeMins;

  // Replace the consumed interval with whatever free slivers remain before
  // and/or after the placement (rather than always shrinking from the
  // front, since the fixed start time can sit mid-interval).
  const remainder = [];
  if (placementStart > interval.start) remainder.push({ start: interval.start, end: placementStart });
  if (placementEnd < interval.end) remainder.push({ start: placementEnd, end: interval.end });
  dayFreeIntervals.splice(idx, 1, ...remainder);

  chunkState.used += 1;
  return { placedHours: takeHours, placements: [{ start: placementStart, end: placementEnd }], conflict: null, outsideWorkingHours: false };
}

/**
 * Shared by all three placement passes below: carve `hours` out of a day's
 * free intervals for `task`, push a ScheduledBlock per placement onto
 * `newBlocks` (mutated in place), and return the hours actually placed.
 * `idSuffix` keeps block ids unique/traceable across passes (e.g. "_sweep").
 *
 * `task.fixedTime` ("HH:MM") routes placement through placeFixedTimeInDay
 * instead of the normal first-fit placeHoursInDay — see that function and
 * the Task.fixedTime typedef for the override's semantics. `dayBusyIntervals`/
 * `gapMins`/`workWindow` are only consulted on that path, to identify a
 * conflict (or an outside-working-hours bounds issue) on failure; when found
 * (and this is the first day this task has failed on), it's recorded onto
 * `conflictTracker` (Map<taskId, {type, conflict}>, mutated in place — `type`
 * is `'conflict'` or `'outside_hours'`) for allocateTasks to attach to the
 * task's eventual overflow entry.
 *
 * `allowSameDayFallback`, when true, lets a `fixedTime` task that couldn't
 * fully place at its pinned time-of-day fall back to ordinary first-fit
 * placement for whatever hours are left over, on this SAME day's remaining
 * free intervals — see allocateTasks' `singleDayWindow` for when/why this is
 * enabled (a single-day window, from enforceDueDate, has no
 * other day for the task to retry on, unlike fixedTime's normal multi-day
 * "try again tomorrow" behavior). This fallback runs whether or not something
 * identifiable conflicted with the pinned slot itself — a real event sitting
 * on the fixed time only explains why THAT slot didn't work, it says nothing
 * about whether the rest of the day is free. Splitting the remainder across
 * whatever open intervals are left (this same function's caller already
 * loops this per-day, and placeHoursInDay itself already splits across
 * multiple intervals within a day) is strictly better than reporting the
 * whole task as unschedulable while the calendar visibly shows free time.
 * Whenever this fallback actually engages (whether or not it fully succeeds),
 * `fallbackUsedTracker` (Set<taskId>, mutated in place, first-wins like
 * `conflictTracker`) is marked for this task — even a fully-successful
 * fallback means the task landed at an unrequested time-of-day, which
 * allocateTasks surfaces to the user as a distinct `fixed_time_shifted`
 * conflict entry rather than staying silent just because every hour got
 * placed somewhere.
 *
 * `chunkState` (`{ used, max }`, mutated in place, shared across every call
 * for this task across all passes/days — see maxChunksFor/allocateTasks)
 * caps how many separate chunks the task may ever be split into; individual
 * chunk size is otherwise only bounded below by MIN_CHUNK_HOURS (5 min, with
 * a shorter-total exception — see placeHoursInDay).
 */
function placeAndRecordBlocks(task, date, hours, dayIntervals, newBlocks, idSuffix = '', dayBusyIntervals, gapMins, conflictTracker, chunkState, allowSameDayFallback = false, workWindow, fallbackUsedTracker) {
  const maxChunkHours = task.maxChunkHours ?? 4;
  // Floor the min-chunk check against the task's true total remaining hours,
  // not `hours` (which may already be a shrunk-down leftover from an earlier
  // pass) — see placeHoursInDay's floorHours comment.
  const floorHours = task.remainingHours;
  const result = task.fixedTime
    ? placeFixedTimeInDay(hours, dayIntervals, maxChunkHours, timeToMinutes(task.fixedTime), chunkState, floorHours, dayBusyIntervals, gapMins, workWindow)
    : placeHoursInDay(hours, dayIntervals, maxChunkHours, chunkState, floorHours);
  let { placedHours, placements } = result;
  const { conflict, outsideWorkingHours } = result;
  // Same-day fallback: the fixed slot couldn't take everything (or anything)
  // this task needed today, and there's no other day in its window to retry
  // on — so instead of giving up, try to place whatever's left over into the
  // rest of THIS day's free intervals via ordinary first-fit. This runs
  // regardless of whether a conflict was identified at the pinned slot: a
  // real event/routine/block sitting on the fixed time only explains why
  // THAT slot specifically didn't work, it says nothing about whether the
  // rest of the day is free — and a fixedTime task still has to actually get
  // done somewhere. The conflict (if any) is still recorded below so it can
  // be reported as the reason if the fallback ALSO comes up short.
  if (task.fixedTime && allowSameDayFallback) {
    const leftoverHours = hours - placedHours;
    if (leftoverHours > EPSILON_HOURS) {
      if (fallbackUsedTracker) fallbackUsedTracker.add(task.id);
      const fallback = placeHoursInDay(leftoverHours, dayIntervals, maxChunkHours, chunkState, floorHours - placedHours);
      if (fallback.placedHours > EPSILON_HOURS) {
        placedHours += fallback.placedHours;
        placements = [...placements, ...fallback.placements];
      }
    }
  }
  if (conflictTracker && !conflictTracker.has(task.id)) {
    if (conflict) conflictTracker.set(task.id, { type: 'conflict', conflict });
    else if (outsideWorkingHours) conflictTracker.set(task.id, { type: 'outside_hours' });
  }
  for (const p of placements) {
    newBlocks.push({
      id: `blk_${task.id}_${date}_${p.start}${idSuffix}`,
      taskId: task.id,
      date,
      startTime: minutesToTime(p.start),
      endTime: minutesToTime(p.end),
      durationHours: (p.end - p.start) / 60,
      isLocked: false,
      isAutoScheduled: true,
      status: 'scheduled',
      googleEventId: null,
      isPassive: !!task.isPassive,
    });
  }
  return placedHours;
}

/**
 * Convert a `conflictTracker` entry (see placeAndRecordBlocks) into an
 * overflow-shaped `reason` — `{ type: 'fixed_time_conflict', conflictingItem }`
 * for an identified conflict, `{ type: 'fixed_time_outside_hours' }` for a
 * bounds issue, or `null` if there's no tracked entry at all (falls through
 * to the caller's own default, e.g. generic `no_capacity`).
 */
function trackedEntryToReason(tracked) {
  if (!tracked) return null;
  if (tracked.type === 'conflict') {
    const c = tracked.conflict;
    return { type: 'fixed_time_conflict', conflictingItem: { id: c.id, type: c.source, label: c.label, start: minutesToTime(c.start), end: minutesToTime(c.end) } };
  }
  if (tracked.type === 'outside_hours') return { type: 'fixed_time_outside_hours' };
  return null;
}

/**
 * Main entry point: allocate remaining hours for all eligible tasks across
 * the capacity map, producing new ScheduledBlocks.
 *
 * @param {import('../types').Task[]} tasks - tasks with isLocked=false already filtered by caller for "movable" work; locked tasks are excluded entirely here and preserved by the caller.
 * @param {Map<string, import('../types').DayCapacity>} capacityMap - date -> DayCapacity (freeIntervals in "HH:MM" pairs)
 * @param {import('../types').SchedulingRules} rules
 * @param {string} today - ISO date, the scheduling run's "now".
 * @param {Map<string, import('../types').Task>} [taskById] - FULL task-id lookup (not just `tasks` above), used to
 *   resolve a due-date-less sub-task's nearest ancestor deadline (see resolveDueDate). Omit only if the caller
 *   knows none of `tasks` are ever due-date-less sub-tasks.
 * @returns {{ blocks: import('../types').ScheduledBlock[], overflow: Array<{taskId:string,unplacedHours:number,reason:Object}> }}
 *   Every non-passive `fixedTime` task is placed in a PRE-PASS, before any other task gets a chance to compete for
 *   its pinned slot — see the "FIXED-TIME PRE-PASS" section below. This means a fixedTime task's exact slot always
 *   wins against a higher-scored-but-not-fixedTime task; only another, higher-scored fixedTime task (competing for
 *   the literal same slot) can still take it first. A passive fixedTime task is NOT part of the pre-pass (passive
 *   tasks never compete for shared capacity at all — see PASSIVE TASK PLACEMENT above) and places in the normal pass
 *   exactly as before.
 *
 *   Each overflow entry's `reason` is one of:
 *     - `{ type: 'fixed_time_conflict', conflictingItem: { id, type: 'routine'|'event'|'block', label, start, end } }`
 *       — the task has `fixedTime` set and something identifiable occupies that slot ('block' entries have
 *       `label: null`; the caller resolves it from the owning task, see rebalanceEngine.js).
 *     - `{ type: 'fixed_time_outside_hours' }` — the task has `fixedTime` set and the pinned time never fell within
 *       the day's working-hours bounds at all (nothing occupies it — it's a bounds issue, not a conflict).
 *     - `{ type: 'no_capacity' }` — ran out of free time in the task's window; either it isn't `fixedTime`, or
 *       nothing tagged could be identified as the specific blocker and the pinned time WAS within working hours
 *       (e.g. the chunk budget was already exhausted). Never reported when the task's resolved due date is beyond
 *       `horizonEnd` (the capacityMap's last date): `no_capacity` there would just mean "ran out of visible
 *       horizon," not "no room before the real due date" — the task still has genuine runway past the horizon.
 *       `fixed_time_conflict`/`fixed_time_outside_hours` are unaffected by this (both are real, specific-day issues,
 *       not a horizon artifact), and a task with no resolvable due date at all keeps reporting as before, since
 *       there's nothing to compare against the horizon.
 *   Separately, `timeShifted` lists every `fixedTime` task whose same-day fallback (see placeAndRecordBlocks'
 *   `allowSameDayFallback`) actually engaged — i.e. the pinned slot couldn't take everything, so leftover hours were
 *   placed elsewhere that same day — REGARDLESS of whether the task's hours ended up fully placed. A task can appear
 *   here even when it does NOT appear in `overflow` (full placement, just not at the requested time): entries are
 *   `{ taskId, reason: { type: 'fixed_time_shifted', conflictingItem? }, dueDate }`, mirroring `overflow`'s shape
 *   minus `unplacedHours` (omitted — the hours WERE placed) so callers/UI can reuse the same rendering. `conflictingItem`
 *   is included when something identifiable occupied the pinned slot itself (same shape as `fixed_time_conflict`'s),
 *   omitted otherwise (e.g. the pinned time was simply outside working hours, or was fully consumed by budget/chunk
 *   limits rather than another identifiable item).
 */
export function allocateTasks(tasks, capacityMap, rules, today, taskById) {
  const dates = [...capacityMap.keys()].sort();
  const horizonEnd = dates[dates.length - 1];

  // Convert capacityMap's "HH:MM" free intervals into a mutable minute-based
  // working copy we can carve into as we place blocks, keyed by date. This is
  // the shared track non-passive tasks consume from.
  const workingFree = new Map();
  // Untouched snapshot of the same intervals, re-cloned fresh for every
  // passive task below so passive placements never compete with each other
  // or with non-passive placements for capacity — see PASSIVE TASK PLACEMENT
  // in the module doc comment.
  const passiveTemplate = new Map();
  for (const [date, cap] of capacityMap.entries()) {
    const minuteIntervals = cap.freeIntervals.map((iv) => ({ start: timeToMinutes(iv.start), end: timeToMinutes(iv.end) }));
    workingFree.set(date, minuteIntervals.map((iv) => ({ ...iv })));
    passiveTemplate.set(date, minuteIntervals.map((iv) => ({ ...iv })));
  }

  const prioritized = prioritizeTasks(tasks, today, rules.bufferDays, taskById);
  const blockerIds = computeBlockerIds(tasks, taskById);
  const newBlocks = [];
  const overflow = [];
  // Every fixedTime task whose same-day fallback actually engaged, whether or
  // not it fully succeeded — see placeAndRecordBlocks' fallbackUsedTracker
  // param and this function's own doc comment above (`timeShifted`).
  const timeShifted = [];
  // First conflict found (if any) for each fixedTime task that fails to
  // place — see placeAndRecordBlocks/placeFixedTimeInDay/findFixedTimeConflict.
  // Kept across all three placement passes below so the earliest, most
  // relevant conflict wins rather than being overwritten by a later day.
  // Values are `{ type: 'conflict', conflict } | { type: 'outside_hours' }`.
  const conflictTracker = new Map();
  // First-wins (mirrors conflictTracker) per-task record of whether the
  // same-day fallback ever engaged — see placeAndRecordBlocks.
  const fallbackUsedTracker = new Set();
  const gapMins = rules.minGapBetweenBlocksMins ?? 0;
  // Running per-day deep-work budget (minutes remaining), shared across
  // non-passive tasks only — mirrors workingFree's passive/non-passive split,
  // since a passive task (laundry, something baking) doesn't consume
  // attention and was never meant to be capped by this rule. This is where
  // rules.maxDailyDeepWorkHours is actually enforced: capacityEngine
  // deliberately leaves freeIntervals uncapped now (see its own comment) so
  // every time-of-day slot stays visible to whichever task actually needs
  // it (e.g. a fixedTime bedtime routine late in the day); this budget only
  // holds a day back once ITS hours are genuinely spent by real placements.
  const dailyBudgetMins = new Map([...capacityMap.keys()].map((date) => [date, Math.round(rules.maxDailyDeepWorkHours * 60)]));

  /**
   * Places one task's remaining hours (all five passes: weighted-share,
   * sweep, buffer-overflow, last-resort split, no-enforced-due-date horizon
   * spill) and appends its overflow entry if hours are left unplaced at the
   * end. This is the ENTIRE per-task body
   * `allocateTasks` used to run inline in a single loop over every
   * priority-sorted task; it's now called twice — once for the non-passive
   * `fixedTime` pre-pass, once for everyone else (see the "FIXED-TIME
   * PRE-PASS" section below) — sharing the same `newBlocks`/`overflow`/
   * `timeShifted`/`conflictTracker`/`fallbackUsedTracker`/`workingFree`/
   * `passiveTemplate`/`dailyBudgetMins` across both calls so state carries
   * over correctly between them.
   */
  function processTask(task) {
    const isBlocker = blockerIds.has(task.id);
    const { windowStart, windowEnd } = getTaskWindow(task, today, horizonEnd, rules.bufferDays, taskById);
    const frontLoad = !isBlocker && rules.frontLoadUrgent && (task.priority === 'urgent' || task.priority === 'high');
    const dayWeights = buildDayWeights(windowStart, windowEnd, frontLoad);
    // A single-day window (enforceDueDate collapsing a recurring occurrence
    // onto its one due date) gives a fixedTime task no OTHER day to retry on
    // if its pinned time-of-day slot is unavailable (already passed today
    // per nowClamp, or occupied) — unlike
    // the normal multi-day case, where "just try again tomorrow" is the
    // correct fixedTime behavior (see placeFixedTimeInDay's doc comment).
    // Passed to placeAndRecordBlocks below so it can fall back to ordinary
    // first-fit placement for this day's leftover hours instead of reporting
    // a visibly-free day as `no_capacity`.
    const singleDayWindow = windowStart === windowEnd;

    // Order of attack: front-loaded tasks try deadline-adjacent days FIRST
    // (reverse chronological), even-paced tasks try chronological order.
    const attackOrder = frontLoad ? [...dayWeights].reverse() : dayWeights;

    // Passive tasks draw from a fresh clone of each day's original free
    // capacity instead of the shared `workingFree` map — see PASSIVE TASK
    // PLACEMENT above.
    const freeForTask = task.isPassive
      ? new Map([...passiveTemplate.entries()].map(([date, ivs]) => [date, ivs.map((iv) => ({ ...iv }))]))
      : workingFree;

    let remaining = task.remainingHours;
    const totalWeight = dayWeights.reduce((s, d) => s + d.weight, 0) || 1;
    // Chunk-count budget for this task, shared (and mutated) across every
    // placement pass/day below — see maxChunksFor.
    const chunkState = { used: 0, max: maxChunksFor(task) };

    // Clamps `hours` to the day's remaining deep-work budget (passive tasks
    // are exempt — see dailyBudgetMins' own comment), places into `dayIntervals`,
    // then deducts whatever was actually placed back out of that budget.
    const placeWithinDailyBudget = (date, hours, dayIntervals, idSuffix) => {
      const budget = dailyBudgetMins.get(date);
      const cappedHours = task.isPassive || budget == null ? hours : Math.min(hours, Math.max(0, budget / 60));
      const placedHours = placeAndRecordBlocks(
        task, date, cappedHours, dayIntervals, newBlocks, idSuffix,
        capacityMap.get(date)?.busyIntervals, gapMins, conflictTracker, chunkState, singleDayWindow,
        capacityMap.get(date)?.workWindow, fallbackUsedTracker
      );
      if (!task.isPassive && budget != null) dailyBudgetMins.set(date, budget - Math.round(placedHours * 60));
      return placedHours;
    };

    for (const { date, weight } of attackOrder) {
      if (remaining <= EPSILON_HOURS) break;
      if (!freeForTask.has(date)) continue; // outside computed horizon

      const idealShare = task.remainingHours * (weight / totalWeight);
      const targetHours = isBlocker ? remaining : Math.max(Math.min(idealShare, remaining), 0);
      if (targetHours < PACING_SHARE_THRESHOLD_HOURS - EPSILON_HOURS) continue;

      remaining -= placeWithinDailyBudget(date, targetHours, freeForTask.get(date), '');
    }

    // Second pass: if weighted shares left gaps (common when a day's free
    // time is smaller than its ideal share), sweep remaining hours into any
    // still-open capacity across the window, chronologically, before falling
    // through to the buffer-day overflow pass below. This maximizes
    // utilization without ever exceeding a day's real free time.
    //
    // Cross-day last-chunk lookahead (see hasLaterFullFitDay): if this would
    // be the task's LAST chunk and today's free time can't cover it in full,
    // but a later day in the window can take the whole remainder as one
    // block, skip today rather than stranding the leftover once the chunk
    // budget is spent here.
    if (remaining > EPSILON_HOURS) {
      const sweepDates = dayWeights.map((d) => d.date);
      for (const { date } of dayWeights) {
        if (remaining <= EPSILON_HOURS) break;
        const dayIntervals = freeForTask.get(date);
        if (!dayIntervals || dayIntervals.length === 0) continue;
        if (
          chunkState.used + 1 >= chunkState.max &&
          !dayIntervals.some((iv) => (iv.end - iv.start) / 60 >= remaining - EPSILON_HOURS) &&
          hasLaterFullFitDay(remaining, date, sweepDates, freeForTask)
        ) {
          continue;
        }
        remaining -= placeWithinDailyBudget(date, remaining, dayIntervals, '_sweep');
      }
    }

    // Third pass: the buffer day rule ("finish this many days before due
    // date") is a soft preference for early completion, not a hard cutoff —
    // it must never be the reason a task that could still fit before its
    // real due date gets reported as unschedulable. If hours remain after
    // exhausting the buffer-shrunk window, spill into the days between that
    // window and the actual due date (still never touching the due date's
    // own day past its end, and never past the horizon) before giving up.
    // Uses the resolved due date (own, or a borrowed ancestor deadline — see
    // resolveDueDate) so an undated sub-task gets the same soft-buffer
    // spillover room as a dated task, consistent with how its window was
    // computed above.
    if (remaining > EPSILON_HOURS) {
      const dueDate = resolveDueDate(task, taskById);
      if (dueDate) {
        const dueWindowEnd = dueDate < horizonEnd ? dueDate : horizonEnd;
        if (dueWindowEnd > windowEnd) {
          const extraDays = dateRange(addDays(windowEnd, 1), diffDays(windowEnd, dueWindowEnd));
          for (const date of extraDays) {
            if (remaining <= EPSILON_HOURS) break;
            if (!freeForTask.has(date)) continue;
            remaining -= placeWithinDailyBudget(date, remaining, freeForTask.get(date), '_overflow');
          }
        }
      }
    }

    // Fourth pass, genuinely last resort within the due-date-bounded window:
    // earlier passes above walk the window day-by-day targeting an ideal
    // share/sweep/overflow amount per day, which can leave hours unplaced
    // even though the task's chunk budget (chunkState) isn't exhausted yet —
    // e.g. a day's only remaining free interval is smaller than what an
    // earlier pass was trying to place there in one go. This pass makes a
    // final attempt to place whatever's left into ANY remaining opening
    // across the same window (including the buffer-overflow days above),
    // still governed by the same chunk-count cap and MIN_CHUNK_HOURS floor as
    // every other pass — see maxChunksFor/MIN_CHUNK_HOURS above. It naturally
    // does nothing once the task's chunk budget is used up or no interval
    // clears the 5-minute floor.
    if (remaining > EPSILON_HOURS) {
      const splitDates = dayWeights.map((d) => d.date);
      for (const { date } of dayWeights) {
        if (remaining <= EPSILON_HOURS) break;
        const dayIntervals = freeForTask.get(date);
        if (!dayIntervals || dayIntervals.length === 0) continue;
        if (
          chunkState.used + 1 >= chunkState.max &&
          !dayIntervals.some((iv) => (iv.end - iv.start) / 60 >= remaining - EPSILON_HOURS) &&
          hasLaterFullFitDay(remaining, date, splitDates, freeForTask)
        ) {
          continue;
        }
        remaining -= placeWithinDailyBudget(date, remaining, dayIntervals, '_split');
      }
    }

    // Fifth pass, no-enforced-due-date horizon spill: a due date that ISN'T
    // enforced (task.enforceDueDate falsy) is a soft target, not a hard wall
    // — pass 3 above already treats the buffer as soft and spills up to the
    // due date, but stopped there, leaving days between the due date and the
    // full planning horizon (horizonEnd) permanently out of reach even when
    // they have real free capacity. Only runs when there's no enforced
    // cutoff; an enforceDueDate task (single-day window, or a due date that
    // IS enforced) must never spill past its due date — that boundary is
    // intentional there, see getTaskWindow. A task with no due date at all
    // never reaches this pass with hours left anyway, since its window (and
    // dayWeights) already spans the full horizon via getTaskWindow.
    if (remaining > EPSILON_HOURS && !task.enforceDueDate) {
      const dueDate = resolveDueDate(task, taskById);
      const spillFrom = dueDate && dueDate > windowEnd ? dueDate : windowEnd;
      if (spillFrom < horizonEnd) {
        const extraDays = dateRange(addDays(spillFrom, 1), diffDays(spillFrom, horizonEnd));
        for (const date of extraDays) {
          if (remaining <= EPSILON_HOURS) break;
          if (!freeForTask.has(date)) continue;
          remaining -= placeWithinDailyBudget(date, remaining, freeForTask.get(date), '_horizon');
        }
      }
    }

    if (remaining > EPSILON_HOURS) {
      const tracked = task.fixedTime ? conflictTracker.get(task.id) : null;
      const reason = trackedEntryToReason(tracked) ?? { type: 'no_capacity' };
      // A `no_capacity` reason means "ran out of visible planning horizon,"
      // not "no room before the real due date" — if the task's resolved due
      // date (own, or a borrowed ancestor's — see resolveDueDate) is beyond
      // horizonEnd, it still has genuine runway that just isn't in the
      // current capacity map, so suppress the false report. A
      // fixed_time_conflict/fixed_time_outside_hours is a real, specific-day
      // issue regardless of horizon, so it's still reported. Tasks with no
      // resolvable due date at all have nothing to compare against the
      // horizon, so they keep reporting as before.
      const resolvedDueDate = resolveDueDate(task, taskById);
      const isFalseHorizonOverflow = reason.type === 'no_capacity' && resolvedDueDate && resolvedDueDate > horizonEnd;
      if (!isFalseHorizonOverflow) {
        overflow.push({ taskId: task.id, unplacedHours: Math.round(remaining * 100) / 100, reason, dueDate: task.dueDate ?? null });
      }
    }

    // A fixedTime task whose same-day fallback engaged landed at least some
    // hours at an unrequested time-of-day — surface that even when every hour
    // still ended up placed (remaining <= EPSILON_HOURS above), since full
    // placement doesn't mean the user's requested exact time was honored. See
    // this function's own doc comment (`timeShifted`) and placeAndRecordBlocks'
    // fallbackUsedTracker.
    if (task.fixedTime && fallbackUsedTracker.has(task.id)) {
      const trackedReason = trackedEntryToReason(conflictTracker.get(task.id));
      const shiftedReason = { type: 'fixed_time_shifted', ...(trackedReason?.conflictingItem ? { conflictingItem: trackedReason.conflictingItem } : {}) };
      timeShifted.push({ taskId: task.id, reason: shiftedReason, dueDate: task.dueDate ?? null });
    }
  }

  // ----------------------------------------------------------------------
  // FIXED-TIME PRE-PASS: every non-passive fixedTime task places FIRST, so
  // its pinned slot is carved out of `workingFree` before any other task
  // (fixedTime or not) gets a chance to compete for that time — a fixed
  // time commitment should always win its exact slot regardless of the
  // other task's priority/urgency score. Sorted by the same score as the
  // main pass so two competing fixedTime tasks still resolve by
  // priority/urgency, just among themselves first. Passive fixedTime tasks
  // are excluded (they draw from `passiveTemplate`, never `workingFree` —
  // see PASSIVE TASK PLACEMENT — so they never compete for shared capacity
  // regardless of pass ordering) and are left in the normal pass below.
  // ----------------------------------------------------------------------
  const fixedTimeTasks = prioritized.filter((t) => t.fixedTime && !t.isPassive);
  const restTasks = prioritized.filter((t) => !t.fixedTime || t.isPassive);
  for (const task of fixedTimeTasks) processTask(task);
  for (const task of restTasks) processTask(task);

  return { blocks: newBlocks, overflow, timeShifted };
}

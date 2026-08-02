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
 *   5. min/max chunk sizes per task (no 6-minute slivers, no marathon
 *      8-hour blocks that ignore human context-switching limits).
 *   6. Passive tasks (task.isPassive — e.g. laundry, something baking) are
 *      allowed to overlap other blocks in time, since they don't need
 *      attention. See "PASSIVE TASK PLACEMENT" below.
 *   7. task.fixedTime ("HH:MM"), when set, pins every block placed for that
 *      task to start at that exact time of day instead of wherever first-fit
 *      would land — see placeFixedTimeInDay below. Exception: when the task's
 *      whole window is a single day (enforceDueDate, or dayScoped "Plan
 *      today") and the pinned slot isn't available that day, there's no OTHER
 *      day left to retry on — see placeAndRecordBlocks' allowSameDayFallback,
 *      which lets the leftover hours fall back to ordinary first-fit
 *      placement elsewhere that same day rather than reporting a visibly free
 *      day as out of capacity.
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
 *     - Clamp to [minChunkHours, maxChunkHours] and to remaining day capacity
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
// Hard floor for any chunk produced by SPLITTING a task across multiple
// blocks — 30 minutes. Unlike the old per-task `minChunkHours` (which a task
// could set smaller), this floor is never overridden: a task whose total
// remaining time is at or under this floor is never split at all (it must
// land as one single block, even if that means waiting for a later day with
// a big-enough opening — see the `remainingHours <= MIN_SPLIT_CHUNK_HOURS`
// checks below), and a task larger than this floor may still be split, but
// never into a piece smaller than it.
const MIN_SPLIT_CHUNK_HOURS = 0.5;

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
function resolveDueDate(task, taskById) {
  return task.dueDate || findAncestorDueDate(task, taskById);
}

/**
 * The date by which a task's remaining hours must effectively be finished:
 * the buffer-shrunk deadline normally, but the raw due date itself when
 * `enforceDueDate` is set (the buffer doesn't apply — there's no "finish
 * early" cushion once the whole window is collapsed onto the due date).
 * `enforceDueDate` only ever applies against the task's OWN due date (per
 * its typedef) — never against a borrowed ancestor deadline, which is a
 * softer "pressure" signal, not a hard collapse-the-window override.
 * Returns null if there's no due date to resolve at all (see resolveDueDate).
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
 * respecting min/max chunk size. Mutates `dayFreeIntervals` (minute-based,
 * array of {start,end}) in place and returns the number of hours actually
 * placed plus the concrete {start,end} minute ranges used.
 *
 * `allowUndersizedChunks` is a last-resort relaxation of the min-chunk floor
 * down to MIN_SPLIT_CHUNK_HOURS (30 min), used only by allocateTasks' final
 * "split what's left" pass after every normal pass (weighted share, sweep,
 * buffer overflow) has already tried and failed to fit the task's remaining
 * hours into a single chunk per interval that clears the task's own (or
 * `floorHours`-capped) `minChunkHours`. Normally a free interval smaller than
 * that floor is skipped entirely — the deliberate "no slivers" behavior that
 * keeps a big task's leftover fragments from getting scattered across tiny
 * gaps. But when that's the ONLY reason a task with real remaining hours
 * would end up reported as unschedulable, on a day that visibly still has
 * free time (just spread across several DIFFERENT intervals, each still
 * >= MIN_SPLIT_CHUNK_HOURS but individually below the task's own larger
 * floor), splitting across those intervals is strictly better than
 * reporting a false conflict — the user explicitly wants a continuous block
 * preferred, but a split allowed when a continuous one is genuinely
 * impossible. This flag never relaxes the floor below MIN_SPLIT_CHUNK_HOURS
 * itself, though — a single placed piece is never allowed to be shorter than
 * that, no matter how this pass is invoked (see MIN_SPLIT_CHUNK_HOURS above).
 */
function placeHoursInDay(hours, dayFreeIntervals, minChunkHours, maxChunkHours, floorHours = hours, allowUndersizedChunks = false) {
  let hoursToPlace = Math.min(hours, maxChunkHours);
  // A task's total remaining time can itself be smaller than its own
  // minChunkHours (e.g. a 5-minute task against the default 30-minute min
  // chunk) — the "no slivers" rule exists to stop a big task's leftover
  // fragments from getting scattered, not to make a task that's inherently
  // shorter than the floor permanently unplaceable. Cap the floor at
  // `floorHours` (the task's full remaining total, not whatever fragment
  // this particular call/pass is placing) so a leftover sliver from an
  // earlier pass — e.g. 5 minutes left over from a 1-hour task — still
  // has to clear the real 30-minute floor instead of the floor shrinking
  // down to match the sliver itself.
  // Even the last-resort `allowUndersizedChunks` pass never drops below
  // MIN_SPLIT_CHUNK_HOURS (30 min) per placed piece — that pass exists to
  // stitch together several DIFFERENT intervals each still >= the floor when
  // no single one held the task's continuous total, not to shave a piece
  // under 30 min out of a too-small interval (see MIN_SPLIT_CHUNK_HOURS above).
  const effectiveMinChunk = allowUndersizedChunks ? MIN_SPLIT_CHUNK_HOURS : Math.min(minChunkHours, floorHours);
  const placements = [];

  for (let i = 0; i < dayFreeIntervals.length && hoursToPlace >= effectiveMinChunk - EPSILON_HOURS; i++) {
    const interval = dayFreeIntervals[i];
    const availableMins = interval.end - interval.start;
    const availableHours = availableMins / 60;
    if (availableHours < effectiveMinChunk) continue;

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
 * Like placeHoursInDay, but for a task with `fixedTime` set: the placement
 * MUST start at `fixedStartMins` (the fixed time-of-day, in minutes) rather
 * than wherever first-fit would land. Finds the single free interval that
 * contains that start time and carves forward from it, splitting the
 * interval around the placement (front slice, if any, stays free; back
 * slice, if any, stays free) instead of always shrinking from the front like
 * placeHoursInDay does.
 *
 * If no free interval contains the fixed start time, or the interval doesn't
 * have enough room from that point to fit at least `minChunkHours`, this
 * places nothing for the day — consistent with how the rest of the allocator
 * treats a day that can't fit a task's requirements: the hours simply aren't
 * placed there, and the caller's normal overflow reporting picks up any
 * hours that end up unplaceable across the whole window (see allocateTasks).
 * No fallback to a different time is attempted HERE; the whole point of
 * `fixedTime` is that the task is done at that time or not that day — a
 * multi-day window simply retries the same fixed time on the next day. The
 * one exception (a single-day window with nowhere else to retry) is handled
 * one level up, by placeAndRecordBlocks' allowSameDayFallback.
 *
 * On failure, also attempts to identify WHAT occupies the slot (see
 * findFixedTimeConflict) using `dayBusyIntervals`/`gapMins` — surfaced as
 * `conflict` on the returned object (null if nothing tagged overlaps) so the
 * caller can report a specific reason rather than a generic one.
 */
function placeFixedTimeInDay(hours, dayFreeIntervals, minChunkHours, maxChunkHours, fixedStartMins, floorHours = hours, dayBusyIntervals, gapMins = 0) {
  const hoursToPlace = Math.min(hours, maxChunkHours);
  const effectiveMinChunk = Math.min(minChunkHours, floorHours);
  const neededMins = Math.round(effectiveMinChunk * 60);

  const idx = dayFreeIntervals.findIndex((iv) => iv.start <= fixedStartMins && iv.end > fixedStartMins);
  if (idx === -1) {
    return { placedHours: 0, placements: [], conflict: findFixedTimeConflict(fixedStartMins, neededMins, dayBusyIntervals, gapMins) };
  }

  const interval = dayFreeIntervals[idx];
  const availableHours = (interval.end - fixedStartMins) / 60;
  if (availableHours < effectiveMinChunk - EPSILON_HOURS) {
    return { placedHours: 0, placements: [], conflict: findFixedTimeConflict(fixedStartMins, neededMins, dayBusyIntervals, gapMins) };
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

  return { placedHours: takeHours, placements: [{ start: placementStart, end: placementEnd }], conflict: null };
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
 * `gapMins` are only consulted on that path, to identify a conflict on
 * failure; when found (and this is the first day this task has failed on),
 * it's recorded onto `conflictTracker` (Map<taskId, conflict>, mutated in
 * place) for allocateTasks to attach to the task's eventual overflow entry.
 *
 * `allowSameDayFallback`, when true, lets a `fixedTime` task that couldn't
 * fully place at its pinned time-of-day fall back to ordinary first-fit
 * placement for whatever hours are left over, on this SAME day's remaining
 * free intervals — see allocateTasks' `singleDayWindow` for when/why this is
 * enabled (a single-day window, from enforceDueDate or dayScoped, has no
 * other day for the task to retry on, unlike fixedTime's normal multi-day
 * "try again tomorrow" behavior). This fallback runs whether or not something
 * identifiable conflicted with the pinned slot itself — a real event sitting
 * on the fixed time only explains why THAT slot didn't work, it says nothing
 * about whether the rest of the day is free. Splitting the remainder across
 * whatever open intervals are left (this same function's caller already
 * loops this per-day, and placeHoursInDay itself already splits across
 * multiple intervals within a day) is strictly better than reporting the
 * whole task as unschedulable while the calendar visibly shows free time.
 */
function placeAndRecordBlocks(task, date, hours, dayIntervals, newBlocks, idSuffix = '', dayBusyIntervals, gapMins, conflictTracker, allowSameDayFallback = false, allowUndersizedChunks = false) {
  // 30 minutes is a hard floor for any SPLIT chunk — never shrunk by a
  // smaller task.minChunkHours (see MIN_SPLIT_CHUNK_HOURS above). A task can
  // still ask for a larger minimum chunk than this via task.minChunkHours.
  const minChunkHours = Math.max(task.minChunkHours ?? MIN_SPLIT_CHUNK_HOURS, MIN_SPLIT_CHUNK_HOURS);
  const maxChunkHours = task.maxChunkHours ?? 4;
  // Floor the min-chunk check against the task's true total remaining hours,
  // not `hours` (which may already be a shrunk-down leftover from an earlier
  // pass) — see placeHoursInDay's floorHours comment.
  const floorHours = task.remainingHours;
  const result = task.fixedTime
    ? placeFixedTimeInDay(hours, dayIntervals, minChunkHours, maxChunkHours, timeToMinutes(task.fixedTime), floorHours, dayBusyIntervals, gapMins)
    : placeHoursInDay(hours, dayIntervals, minChunkHours, maxChunkHours, floorHours, allowUndersizedChunks);
  let { placedHours, placements } = result;
  const { conflict } = result;
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
      const fallback = placeHoursInDay(leftoverHours, dayIntervals, minChunkHours, maxChunkHours, floorHours - placedHours, allowUndersizedChunks);
      if (fallback.placedHours > EPSILON_HOURS) {
        placedHours += fallback.placedHours;
        placements = [...placements, ...fallback.placements];
      }
    }
  }
  if (conflict && conflictTracker && !conflictTracker.has(task.id)) conflictTracker.set(task.id, conflict);
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
 * @param {Object} [options]
 * @param {boolean} [options.dayScoped] - "Plan today" mode (see rebalanceEngine's planToday). When true, EVERY
 *   task's window collapses to just `today` (skipping the normal due-date-driven getTaskWindow resolution) and
 *   every task targets its FULL remaining hours on that single day instead of an ideal per-day share — i.e. the
 *   existing "blocker" greedy-fill behavior (see module doc comment, point 8) is extended to apply to all tasks,
 *   not just blockers. This deliberately bypasses even-pacing/front-loading rather than trying to approximate it
 *   over a truncated horizon: computing an "ideal share" against a task's real multi-day due-date window while
 *   only exposing one day of capacity would dilute today's placement based on runway the caller isn't offering
 *   anyway, and would report false overflow for tasks that have plenty of time on days simply not in this
 *   `capacityMap`. Callers should pass a `capacityMap` covering only `today` in this mode, both so passes 2/3
 *   below can't spill into other days and so this stays simple (nothing here filters placements by date beyond
 *   what `capacityMap` already contains).
 * @returns {{ blocks: import('../types').ScheduledBlock[], overflow: Array<{taskId:string,unplacedHours:number,reason:Object}> }}
 *   Each overflow entry's `reason` is one of:
 *     - `{ type: 'fixed_time_conflict', conflictingItem: { id, type: 'routine'|'event'|'block', label, start, end } }`
 *       — the task has `fixedTime` set and something identifiable occupies that slot ('block' entries have
 *       `label: null`; the caller resolves it from the owning task, see rebalanceEngine.js).
 *     - `{ type: 'no_capacity' }` — ran out of free time in the task's window; either it isn't `fixedTime`, or
 *       nothing tagged could be identified as the specific blocker (e.g. the fixed time is outside working hours).
 *       Never reported when the task's resolved due date is beyond `horizonEnd` (the capacityMap's last date):
 *       `no_capacity` there would just mean "ran out of visible horizon," not "no room before the real due
 *       date" — the task still has genuine runway past the horizon. `fixed_time_conflict` is unaffected by this
 *       (it's a real conflict on a specific day, not a horizon artifact), and a task with no resolvable due date
 *       at all keeps reporting as before, since there's nothing to compare against the horizon.
 */
export function allocateTasks(tasks, capacityMap, rules, today, taskById, options = {}) {
  const { dayScoped = false } = options;
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
  // First conflict found (if any) for each fixedTime task that fails to
  // place — see placeAndRecordBlocks/placeFixedTimeInDay/findFixedTimeConflict.
  // Kept across all three placement passes below so the earliest, most
  // relevant conflict wins rather than being overwritten by a later day.
  const conflictTracker = new Map();
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

  for (const task of prioritized) {
    const isBlocker = blockerIds.has(task.id);
    const { windowStart, windowEnd } = dayScoped
      ? { windowStart: today, windowEnd: today }
      : getTaskWindow(task, today, horizonEnd, rules.bufferDays, taskById);
    const frontLoad = !dayScoped && !isBlocker && rules.frontLoadUrgent && (task.priority === 'urgent' || task.priority === 'high');
    const dayWeights = buildDayWeights(windowStart, windowEnd, frontLoad);
    // A single-day window (enforceDueDate collapsing a recurring occurrence
    // onto its one due date, or dayScoped's "Plan today") gives a fixedTime
    // task no OTHER day to retry on if its pinned time-of-day slot is
    // unavailable (already passed today per nowClamp, or occupied) — unlike
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

    // Clamps `hours` to the day's remaining deep-work budget (passive tasks
    // are exempt — see dailyBudgetMins' own comment), places into `dayIntervals`,
    // then deducts whatever was actually placed back out of that budget.
    const placeWithinDailyBudget = (date, hours, dayIntervals, idSuffix, allowUndersizedChunks = false) => {
      const budget = dailyBudgetMins.get(date);
      const cappedHours = task.isPassive || budget == null ? hours : Math.min(hours, Math.max(0, budget / 60));
      const placedHours = placeAndRecordBlocks(
        task, date, cappedHours, dayIntervals, newBlocks, idSuffix,
        capacityMap.get(date)?.busyIntervals, gapMins, conflictTracker, singleDayWindow, allowUndersizedChunks
      );
      if (!task.isPassive && budget != null) dailyBudgetMins.set(date, budget - Math.round(placedHours * 60));
      return placedHours;
    };

    for (const { date, weight } of attackOrder) {
      if (remaining <= EPSILON_HOURS) break;
      if (!freeForTask.has(date)) continue; // outside computed horizon

      const idealShare = task.remainingHours * (weight / totalWeight);
      const targetHours = dayScoped || isBlocker ? remaining : Math.max(Math.min(idealShare, remaining), 0);
      if (targetHours < Math.max(task.minChunkHours ?? MIN_SPLIT_CHUNK_HOURS, MIN_SPLIT_CHUNK_HOURS) - EPSILON_HOURS) continue;

      remaining -= placeWithinDailyBudget(date, targetHours, freeForTask.get(date), '');
    }

    // Second pass: if weighted shares left gaps (common when a day's free
    // time is smaller than its ideal share), sweep remaining hours into any
    // still-open capacity across the window, chronologically, before falling
    // through to the buffer-day overflow pass below. This maximizes
    // utilization without ever exceeding a day's real free time.
    if (remaining > EPSILON_HOURS) {
      for (const { date } of dayWeights) {
        if (remaining <= EPSILON_HOURS) break;
        const dayIntervals = freeForTask.get(date);
        if (!dayIntervals || dayIntervals.length === 0) continue;
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

    // Fourth pass, genuinely last resort: every pass above only ever placed a
    // chunk into a free interval that could hold at least `minChunkHours`
    // continuously — the deliberate "prefer one uninterrupted block" bias
    // (see module doc comment). If hours are STILL left after that, the
    // remaining free time (if any) is fragmented into pieces individually
    // smaller than the floor. Rather than reporting that as unschedulable
    // while the day visibly has open time, split into whatever's left,
    // wherever it is — across the same window this task already searched
    // (including the buffer-overflow days above). Only engages when a
    // continuous block truly isn't possible; every earlier pass had first
    // claim on any interval long enough to avoid fragmenting this task at
    // all.
    //
    // A task whose ENTIRE remaining time is at or under MIN_SPLIT_CHUNK_HOURS
    // (30 min) is never allowed to fragment at all, even as a last resort —
    // it must land as one single block or not be placed this run (falling
    // through to overflow below). Splitting a task that's already ≤30 min
    // into still-smaller pieces defeats the point of a minimum chunk size.
    if (remaining > EPSILON_HOURS && task.remainingHours > MIN_SPLIT_CHUNK_HOURS + EPSILON_HOURS) {
      for (const { date } of dayWeights) {
        if (remaining <= EPSILON_HOURS) break;
        const dayIntervals = freeForTask.get(date);
        if (!dayIntervals || dayIntervals.length === 0) continue;
        remaining -= placeWithinDailyBudget(date, remaining, dayIntervals, '_split', true);
      }
    }

    if (remaining > EPSILON_HOURS) {
      const conflict = task.fixedTime ? conflictTracker.get(task.id) : null;
      const reason = conflict
        ? { type: 'fixed_time_conflict', conflictingItem: { id: conflict.id, type: conflict.source, label: conflict.label, start: minutesToTime(conflict.start), end: minutesToTime(conflict.end) } }
        : { type: 'no_capacity' };
      // A `no_capacity` reason means "ran out of visible planning horizon,"
      // not "no room before the real due date" — if the task's resolved due
      // date (own, or a borrowed ancestor's — see resolveDueDate) is beyond
      // horizonEnd, it still has genuine runway that just isn't in the
      // current capacity map, so suppress the false report. A
      // fixed_time_conflict is a real, specific-day conflict regardless of
      // horizon, so it's still reported. Tasks with no resolvable due date
      // at all have nothing to compare against the horizon, so they keep
      // reporting as before.
      const resolvedDueDate = resolveDueDate(task, taskById);
      const isFalseHorizonOverflow = reason.type === 'no_capacity' && resolvedDueDate && resolvedDueDate > horizonEnd;
      if (!isFalseHorizonOverflow) {
        overflow.push({ taskId: task.id, unplacedHours: Math.round(remaining * 100) / 100, reason, dueDate: task.dueDate ?? null });
      }
    }
  }

  return { blocks: newBlocks, overflow };
}

/**
 * ============================================================================
 * ALLOCATION ENGINE  (the scheduling heuristic)
 * ============================================================================
 * This is the mathematical/logical core of the app. Given:
 *   - a list of Tasks (with estimatedHours / remainingHours, priority, dueDate)
 *   - a Map<date, DayCapacity> describing free hours per day
 *   - SchedulingRules (buffer days, pacing preference, chunk sizes)
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
 *   Tasks with no due date get a fixed low urgency multiplier (1) so they
 *   fill in the gaps around deadline-driven work rather than crowding it out.
 *
 *   Final sort: descending score. This single score elegantly captures both
 *   "priority" and "due date" as required, instead of a brittle nested
 *   if/else cascade.
 *
 * Step 2 — DETERMINE EACH TASK'S PLANNING WINDOW:
 *   effectiveDeadline = dueDate - bufferDays   (finish 1 day early, by default)
 *   windowStart = today (or task.earliestDate if later — a user-set "don't
 *                 schedule before this" override)
 *   windowEnd   = effectiveDeadline (or horizon end, if no due date)
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
 *     - Determine target hours for that day (from Step 3's distribution)
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

const PRIORITY_WEIGHT = { urgent: 4, high: 3, medium: 2, low: 1 };
// "Close enough to zero" threshold for hour comparisons below. Placements
// round to the nearest minute (see placeHoursInDay's takeMins), which can
// leave up to half a minute (~0.0083h) of rounding error in `remaining` —
// a threshold tighter than that spuriously carries a fully-schedulable task
// through the sweep/spill passes and into the overflow report.
const EPSILON_HOURS = 1 / 120;

/** Compute a single sortable urgency+priority score for a task, relative to `today`. */
export function scoreTask(task, today, bufferDays) {
  const weight = PRIORITY_WEIGHT[task.priority] ?? 1;

  if (!task.dueDate) {
    return weight * 1; // no deadline -> baseline urgency multiplier of 1
  }

  const effectiveDeadline = addDays(task.dueDate, -bufferDays);
  const daysRemaining = Math.max(1, diffDays(today, effectiveDeadline));
  const urgencyMultiplier = 1 + (1 / daysRemaining) * 10;

  return weight * urgencyMultiplier;
}

/** Sort tasks by descending schedulability score. Pure function, does not mutate input. */
export function prioritizeTasks(tasks, today, bufferDays) {
  return [...tasks]
    .filter((t) => !t.isCompleted && t.remainingHours > 0)
    .sort((a, b) => scoreTask(b, today, bufferDays) - scoreTask(a, today, bufferDays));
}

/**
 * Compute the [windowStart, windowEnd] ISO date pair a task's remaining
 * hours must be placed within.
 */
function getTaskWindow(task, today, horizonEnd, bufferDays) {
  // task.earliestDate is a user-set override ("don't schedule this before
  // day X") — clamp the window start to it when it's later than today, but
  // never let it push the start before today (that would try to schedule
  // into the past).
  const windowStart = task.earliestDate && task.earliestDate > today ? task.earliestDate : today;
  let windowEnd = horizonEnd;
  if (task.dueDate) {
    const effectiveDeadline = addDays(task.dueDate, -bufferDays);
    // If the buffer pushes the deadline back past windowStart, the buffer
    // can't be honored in full — fall back to the actual due date (clamped
    // to the horizon) rather than collapsing the window to windowStart
    // alone, which would exclude the due date itself from consideration.
    windowEnd = effectiveDeadline < windowStart ? (task.dueDate < horizonEnd ? task.dueDate : horizonEnd) : effectiveDeadline;
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
 */
function placeHoursInDay(hours, dayFreeIntervals, minChunkHours, maxChunkHours) {
  let hoursToPlace = Math.min(hours, maxChunkHours);
  // A task's total remaining time can itself be smaller than its own
  // minChunkHours (e.g. a 5-minute task against the default 30-minute min
  // chunk) — the "no slivers" rule exists to stop a big task's leftover
  // fragments from getting scattered, not to make a task that's inherently
  // shorter than the floor permanently unplaceable. Cap the floor at what
  // we're actually trying to place for this call.
  const effectiveMinChunk = Math.min(minChunkHours, hoursToPlace);
  const placements = [];

  for (let i = 0; i < dayFreeIntervals.length && hoursToPlace >= effectiveMinChunk - EPSILON_HOURS; i++) {
    const interval = dayFreeIntervals[i];
    const availableMins = interval.end - interval.start;
    const availableHours = availableMins / 60;
    if (availableHours < effectiveMinChunk) continue;

    const takeHours = Math.min(hoursToPlace, availableHours);
    const takeMins = Math.round(takeHours * 60);
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
 * Shared by all three placement passes below: carve `hours` out of a day's
 * free intervals for `task`, push a ScheduledBlock per placement onto
 * `newBlocks` (mutated in place), and return the hours actually placed.
 * `idSuffix` keeps block ids unique/traceable across passes (e.g. "_sweep").
 */
function placeAndRecordBlocks(task, date, hours, dayIntervals, newBlocks, idSuffix = '') {
  const { placedHours, placements } = placeHoursInDay(
    hours,
    dayIntervals,
    task.minChunkHours ?? 0.5,
    task.maxChunkHours ?? 4
  );
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
 * @returns {{ blocks: import('../types').ScheduledBlock[], overflow: Array<{taskId:string,unplacedHours:number}> }}
 */
export function allocateTasks(tasks, capacityMap, rules, today) {
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

  const prioritized = prioritizeTasks(tasks, today, rules.bufferDays);
  const newBlocks = [];
  const overflow = [];

  for (const task of prioritized) {
    const { windowStart, windowEnd } = getTaskWindow(task, today, horizonEnd, rules.bufferDays);
    const frontLoad = rules.frontLoadUrgent && (task.priority === 'urgent' || task.priority === 'high');
    const dayWeights = buildDayWeights(windowStart, windowEnd, frontLoad);

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

    for (const { date, weight } of attackOrder) {
      if (remaining <= EPSILON_HOURS) break;
      if (!freeForTask.has(date)) continue; // outside computed horizon

      const idealShare = task.remainingHours * (weight / totalWeight);
      const targetHours = Math.max(Math.min(idealShare, remaining), 0);
      if (targetHours < (task.minChunkHours ?? 0.5) - EPSILON_HOURS) continue;

      remaining -= placeAndRecordBlocks(task, date, targetHours, freeForTask.get(date), newBlocks);
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
        remaining -= placeAndRecordBlocks(task, date, remaining, dayIntervals, newBlocks, '_sweep');
      }
    }

    // Third pass: the buffer day rule ("finish this many days before due
    // date") is a soft preference for early completion, not a hard cutoff —
    // it must never be the reason a task that could still fit before its
    // real due date gets reported as unschedulable. If hours remain after
    // exhausting the buffer-shrunk window, spill into the days between that
    // window and the actual due date (still never touching the due date's
    // own day past its end, and never past the horizon) before giving up.
    if (remaining > EPSILON_HOURS && task.dueDate) {
      const dueWindowEnd = task.dueDate < horizonEnd ? task.dueDate : horizonEnd;
      if (dueWindowEnd > windowEnd) {
        const extraDays = dateRange(addDays(windowEnd, 1), diffDays(windowEnd, dueWindowEnd));
        for (const date of extraDays) {
          if (remaining <= EPSILON_HOURS) break;
          if (!freeForTask.has(date)) continue;
          remaining -= placeAndRecordBlocks(task, date, remaining, freeForTask.get(date), newBlocks, '_overflow');
        }
      }
    }

    if (remaining > EPSILON_HOURS) {
      overflow.push({ taskId: task.id, unplacedHours: Math.round(remaining * 100) / 100 });
    }
  }

  return { blocks: newBlocks, overflow };
}

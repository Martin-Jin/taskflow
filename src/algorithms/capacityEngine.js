/**
 * ============================================================================
 * CAPACITY ENGINE
 * ============================================================================
 * Responsible for answering exactly one question per day, for every day in
 * the planning horizon:
 *
 *      "Given fixed routines, external calendar events, and blocks already
 *       scheduled, what open time windows remain, and how many hours do
 *       they total?"
 *
 * This is computed BEFORE the allocator runs. The allocator then consumes
 * DayCapacity objects and never has to reason about routines/events itself —
 * clean separation of concerns.
 * ============================================================================
 */

import { dayOfWeek, timeToMinutes, dateRange } from '../utils/dateUtils';
import { subtractIntervals, toTimeIntervals, totalMinutes } from '../utils/intervalUtils';

/**
 * Build the list of busy minute-intervals for a single day from fixed
 * routines + calendar events + already-placed scheduled blocks.
 *
 * Events/routines flagged `isFreeTime` / inactive are excluded, honoring
 * the "Free Time / Ignore" override rule from the requirements (e.g. a
 * lecture the user wants to be schedulable-over).
 *
 * Each entry is tagged with `source`/`id`/`label` identifying what's
 * occupying that time (a routine, calendar event, or another task's
 * scheduled block) — purely additive metadata that `subtractIntervals`
 * ignores (it only reads `start`/`end`), used only so a `fixedTime` task
 * that fails to place can report exactly what it conflicted with (see
 * allocator.js's `placeFixedTimeInDay`). A `block` entry's `label` is left
 * null here since capacityEngine has no task lookup; the caller (usually
 * rebalanceEngine, which has the full task list) fills in the owning
 * task's title afterward.
 */
function collectBusyIntervals(date, { routines, events, blocks }) {
  const dow = dayOfWeek(date);
  const busy = [];

  for (const r of routines) {
    if (!r.isActive) continue;
    if (!r.daysOfWeek.includes(dow)) continue;
    busy.push({ start: timeToMinutes(r.startTime), end: timeToMinutes(r.endTime), source: 'routine', id: r.id, label: r.label });
  }

  for (const e of events) {
    if (e.date !== date) continue;
    if (e.isFreeTime) continue; // explicit override: treat as available, not busy
    busy.push({ start: timeToMinutes(e.startTime), end: timeToMinutes(e.endTime), source: 'event', id: e.id, label: e.title });
  }

  for (const b of blocks) {
    if (b.date !== date) continue;
    busy.push({ start: timeToMinutes(b.startTime), end: timeToMinutes(b.endTime), source: 'block', id: b.taskId, label: null });
  }

  return busy;
}

/**
 * Compute a DayCapacity for a single ISO date.
 * @param {string} date
 * @param {{routines: import('../types').FixedRoutine[], events: import('../types').CalendarEvent[], blocks: import('../types').ScheduledBlock[], rules: import('../types').SchedulingRules, nowClamp?: {date: string, minutes: number}}} ctx
 * @returns {import('../types').DayCapacity}
 */
export function computeDayCapacity(date, ctx) {
  const { rules } = ctx;
  let workStart = timeToMinutes(rules.workDayStart);
  const workEnd = timeToMinutes(rules.workDayEnd);
  // Never schedule into the past: on the real "today" (see rebalanceEngine's
  // nowClamp), push the work window's start forward to the current
  // wall-clock time — e.g. if it's already 5pm, don't open up any capacity
  // before 5pm today. Other days in the horizon are unaffected.
  if (ctx.nowClamp && date === ctx.nowClamp.date) {
    workStart = Math.max(workStart, ctx.nowClamp.minutes);
  }
  const workWindow = { start: Math.min(workStart, workEnd), end: workEnd };
  const busy = collectBusyIntervals(date, ctx);

  // Enforce minimum-gap-between-blocks by padding each busy interval on both
  // sides before subtracting — prevents scheduling work butted directly
  // against a meeting with zero breathing room.
  const gap = rules.minGapBetweenBlocksMins ?? 0;
  const paddedBusy = gap > 0 ? busy.map((iv) => ({ start: iv.start - gap, end: iv.end + gap })) : busy;
  const freeMinuteIntervals = subtractIntervals(workWindow, paddedBusy);
  const positive = freeMinuteIntervals.filter((iv) => iv.end - iv.start > 0);
  // totalAvailableHours (the summary stat consumed e.g. by StatsDashboard's
  // "free time this week" figure) is capped to the deep-work-hours-per-day
  // rule, but freeIntervals themselves are deliberately left UNCAPPED here.
  // Capping the intervals directly (as this used to do, via capTotalMinutes)
  // truncated the day's free time from the FRONT of the list — e.g. an
  // 06:00-23:59 open day with an 8-hour cap became "06:00-14:00 only",
  // silently deleting every slot after 2pm from the allocator's view. That
  // broke any task that specifically needed a later slot that day — a
  // fixedTime task like a bedtime routine at 22:00, or a lower-priority task
  // whose earlier-day share was already claimed by something else — even
  // though the real calendar still had plenty of open time later on, and
  // even though nothing had actually been scheduled into most of the
  // "capped away" hours yet. The deep-work ceiling is enforced instead as a
  // running per-day budget while the allocator actually places blocks (see
  // allocateTasks' dailyBudgetMins) — that only holds back a day once ITS
  // hours are actually spent, rather than pre-deleting time-of-day slots
  // nothing has claimed yet.
  const totalAvailableHours = Math.max(0, Math.min(totalMinutes(positive), rules.maxDailyDeepWorkHours * 60) / 60);

  return {
    date,
    totalAvailableHours,
    allocatedHours: 0,
    freeIntervals: toTimeIntervals(positive),
    // Raw (unpadded) tagged busy intervals, in minutes-since-midnight, kept
    // separately from the freeIntervals math above purely so the allocator
    // can identify what's occupying a `fixedTime` task's target slot when
    // placement fails — see collectBusyIntervals' doc comment.
    busyIntervals: busy,
    // The day's overall working-hours bounds (minutes-since-midnight, already
    // nowClamp-adjusted for "today") — distinct from freeIntervals, which are
    // just the OPEN slices within this window after subtracting busy time.
    // Kept so the allocator can tell "a fixedTime task's pinned slot is inside
    // working hours but something occupies it" (findFixedTimeConflict) apart
    // from "the pinned slot was never inside working hours at all" (see
    // allocator.js's placeFixedTimeInDay / fixed_time_outside_hours).
    workWindow,
  };
}

/**
 * Compute DayCapacity for every day in the horizon.
 * @param {string} startIso
 * @param {number} horizonDays
 * @param {*} ctx
 * @returns {Map<string, import('../types').DayCapacity>}
 */
export function computeHorizonCapacity(startIso, horizonDays, ctx) {
  const map = new Map();
  for (const date of dateRange(startIso, horizonDays)) {
    map.set(date, computeDayCapacity(date, ctx));
  }
  return map;
}

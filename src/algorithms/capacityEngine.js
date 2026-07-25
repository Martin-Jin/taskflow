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
import { subtractIntervals, toTimeIntervals, totalMinutes, capTotalMinutes } from '../utils/intervalUtils';

/**
 * Build the list of busy minute-intervals for a single day from fixed
 * routines + calendar events + already-placed scheduled blocks.
 *
 * Events/routines flagged `isFreeTime` / inactive are excluded, honoring
 * the "Free Time / Ignore" override rule from the requirements (e.g. a
 * lecture the user wants to be schedulable-over).
 */
function collectBusyIntervals(date, { routines, events, blocks }) {
  const dow = dayOfWeek(date);
  const busy = [];

  for (const r of routines) {
    if (!r.isActive) continue;
    if (!r.daysOfWeek.includes(dow)) continue;
    busy.push({ start: timeToMinutes(r.startTime), end: timeToMinutes(r.endTime) });
  }

  for (const e of events) {
    if (e.date !== date) continue;
    if (e.isFreeTime) continue; // explicit override: treat as available, not busy
    busy.push({ start: timeToMinutes(e.startTime), end: timeToMinutes(e.endTime) });
  }

  for (const b of blocks) {
    if (b.date !== date) continue;
    busy.push({ start: timeToMinutes(b.startTime), end: timeToMinutes(b.endTime) });
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
  // Enforce the deep-work-hours-per-day cap on the actual slots the
  // allocator will place work into, not just on the summary stat below —
  // otherwise the rule is only ever reported, never scheduled against.
  const trimmed = capTotalMinutes(positive, rules.maxDailyDeepWorkHours * 60);

  const totalAvailableHours = Math.max(0, totalMinutes(trimmed) / 60);

  return {
    date,
    totalAvailableHours,
    allocatedHours: 0,
    freeIntervals: toTimeIntervals(trimmed),
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

/**
 * ============================================================================
 * WEEKLY REVIEW
 * ============================================================================
 * One screen that answers "how did last week actually go, and does next week
 * fit?" — and lets you act on the answer without leaving it. The inputs all
 * existed already (completions, due dates, the postponement counter, capacity);
 * what didn't exist was a moment where the app puts them together and asks you
 * to decide something.
 *
 * THE WINDOW IS A REAL WEEK, per rules.weekStartsOn (Sunday or Monday), which
 * is what makes the review agree with every other week-based view. It stops at
 * TODAY rather than the end of the week: the rest of the week hasn't happened,
 * and counting it would mean reporting on the future.
 *
 * ON THE FIRST DAY OF THE WEEK IT REVIEWS THE WEEK JUST FINISHED. That's the
 * dead zone a calendar-week review has, and it's not hypothetical — the first
 * version of this shipped on a Sunday with Sunday-start weeks, so "this week"
 * was a single day old and every real slip fell into "carried over" instead of
 * "slipped". Rolling back one week when today is the week's first day removes
 * the dead zone without adding a mode or a date picker, and it lands on the
 * right answer for the moment people actually do a weekly review: the start of
 * a week, looking back at the last one.
 *
 * THE THREE BUCKETS DO NOT OVERLAP, which matters because a task appearing
 * twice would make the counts meaningless:
 *   - finished    — completed on any day of this week so far
 *   - slipped     — still open, was due this week on a day that has PASSED
 *   - carriedOver — still open, was due before this week (older debt)
 *
 * A TASK DUE TODAY HAS NOT SLIPPED, and getting this wrong is what made the
 * first version report fifteen "missed" tasks at breakfast on the day they were
 * due. The day isn't over. This matches the app's own long-standing definition
 * of overdue (utils/overdueTasks.js: strictly `dueDate < today`), so the review
 * and the rest of the app can't disagree about what's late. A task due today,
 * or later this week, is in none of the buckets — telling you about it is what
 * the Tasks list is for.
 *
 * WHY THERE IS NO "SHRINK" ACTION, despite the original sketch listing one.
 * Reschedule, complete and drop are all genuinely one tap. Changing an estimate
 * is a number, so it needs a field, a keyboard and a decision about what the
 * new number is — which turns a review pass into data entry. The capacity
 * section already tells you when next week doesn't fit; acting on that by
 * editing an estimate belongs in the task itself.
 * ============================================================================
 */

import { addDays, diffDays, dayOfWeek, startOfWeek } from './dateUtils';
import { computeEstimateAccuracy } from './estimateAccuracy';

/** Days in the window. Not configurable — a "weekly" review with a tunable period is just a report. */
export const REVIEW_WINDOW_DAYS = 7;

/** How long before the review is worth nudging about again. */
export const REVIEW_NUDGE_INTERVAL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Splits the task list into the review's three buckets, plus the numbers each
 * section reports.
 *
 * Pure, and takes `todayIso` rather than reading the clock, so every boundary
 * case (a task completed on the week's first day, one due today) is testable.
 *
 * @param {{tasks: import('../types').Task[], todayIso: string, weekStartsOn?: 0|1}} input
 * @returns {{windowStart: string, windowEnd: string, nextWindowStart: string, nextWindowEnd: string,
 *   finished: object[], slipped: object[], carriedOver: object[],
 *   finishedHours: number, accuracy: object, carriedOverHours: number, slippedHours: number}}
 */
export function computeWeeklyReview({ tasks, todayIso, weekStartsOn = 0 }) {
  const thisWeekStart = startOfWeek(todayIso, weekStartsOn);
  // See the header: on the week's first day there is no "this week" to review
  // yet, so review the one that just ended instead.
  const reviewingPreviousWeek = thisWeekStart === todayIso;
  const windowStart = reviewingPreviousWeek ? addDays(thisWeekStart, -REVIEW_WINDOW_DAYS) : thisWeekStart;
  // Never past today, and never past the reviewed week's own last day.
  const windowEnd = reviewingPreviousWeek ? addDays(thisWeekStart, -1) : todayIso;
  const nextWindowStart = addDays(todayIso, 1);
  const nextWindowEnd = addDays(todayIso, REVIEW_WINDOW_DAYS);

  const all = (tasks || []).filter((t) => t && !t.deletedAt);

  // A completedAt is an ISO DATETIME, so it's sliced to its date before
  // comparing against ISO dates — comparing the full timestamp against
  // 'YYYY-MM-DD' would sort every same-day completion after the boundary.
  const finished = all.filter((t) => {
    if (!t.isCompleted || !t.completedAt) return false;
    const day = String(t.completedAt).slice(0, 10);
    return day >= windowStart && day <= windowEnd;
  });

  const open = all.filter((t) => !t.isCompleted);
  // Bounded by BOTH the window and today: a task due today still has the day
  // to run, which is the app's own definition of overdue (see the header). The
  // `< todayIso` clause is what does the work when the window is the current
  // week; `<= windowEnd` when it's the previous one.
  const slipped = open.filter(
    (t) => t.dueDate && t.dueDate >= windowStart && t.dueDate <= windowEnd && t.dueDate < todayIso
  );
  const carriedOver = open.filter((t) => t.dueDate && t.dueDate < windowStart);

  const hoursOf = (list, field) => list.reduce((sum, t) => sum + (Number(t[field]) || 0), 0);

  return {
    windowStart,
    windowEnd,
    // Lets the UI say "last week" rather than "this week" when it rolled back.
    reviewingPreviousWeek,
    nextWindowStart,
    nextWindowEnd,
    finished,
    slipped,
    carriedOver,
    // What the week actually cost, where it's known. Only timer-tracked tasks
    // carry actualHours, so this is deliberately "hours tracked", not a claim
    // about total effort — see computeEstimateAccuracy's own note.
    finishedHours: hoursOf(finished, 'actualHours'),
    finishedEstimatedHours: hoursOf(finished, 'estimatedHours'),
    // Reuses the same estimate-accuracy maths the Stats page shows, narrowed to
    // this window, rather than a second implementation of the same ratio.
    accuracy: computeEstimateAccuracy(finished),
    slippedHours: hoursOf(slipped, 'remainingHours'),
    carriedOverHours: hoursOf(carriedOver, 'remainingHours'),
  };
}

/**
 * Where "Move to next week" puts a task: the same weekday, one week into the
 * next window.
 *
 * Keeping the weekday is the point — a Friday task becomes next Friday, which
 * is what someone rescheduling their week expects. A flat `+7 days` would do
 * that too for a task due this week, but not for older debt: a task three
 * weeks overdue would land another two weeks in the past, which is the bug
 * this function exists to avoid.
 *
 * @param {import('../types').Task} task
 * @param {string} todayIso
 * @returns {string} the new ISO due date
 */
export function planMoveToNextWeek(task, todayIso) {
  const nextWindowStart = addDays(todayIso, 1);
  if (!task?.dueDate) return nextWindowStart;
  const targetDow = dayOfWeek(task.dueDate);
  // Walk forward from tomorrow to the first matching weekday, which lands
  // inside the next 7 days by construction.
  for (let i = 0; i < REVIEW_WINDOW_DAYS; i += 1) {
    const candidate = addDays(nextWindowStart, i);
    if (dayOfWeek(candidate) === targetDow) return candidate;
  }
  return nextWindowStart;
}

/**
 * Whether to nudge. True when the review has never been run, or when it was
 * last run at least REVIEW_NUDGE_INTERVAL_DAYS ago AND there is actually
 * something to look at — a nudge for an empty review teaches people to ignore
 * nudges.
 *
 * @param {{lastReviewedAt: number|null, nowMs: number, hasAnythingToReview: boolean}} input
 * @returns {boolean}
 */
export function isReviewDue({ lastReviewedAt, nowMs, hasAnythingToReview }) {
  if (!hasAnythingToReview) return false;
  if (!lastReviewedAt) return true;
  return nowMs - lastReviewedAt >= REVIEW_NUDGE_INTERVAL_DAYS * MS_PER_DAY;
}

/**
 * The PROMPT is what goes away once a review is done; the review itself stays
 * openable. Two different questions, so two functions — conflating them is what
 * made a closed review unreachable except through the command palette, which
 * nobody discovers.
 *
 * @param {object} review
 * @returns {boolean} whether the review has anything worth opening
 */
export function canOpenReview(review) {
  return hasReviewContent(review);
}

/**
 * One-line verdict on whether next week's plan fits the time available.
 *
 * Deliberately three states rather than a percentage: the useful question is
 * "is this plausible?", and a number invites precision the estimate underneath
 * doesn't have.
 *
 * @param {{committedHours: number, freeHours: number}} input
 * @returns {{status: 'fits'|'tight'|'over', message: string}}
 */
export function describeNextWeekFit({ committedHours, freeHours }) {
  const round = (n) => Math.round(n * 10) / 10;
  if (committedHours <= 0) {
    return { status: 'fits', message: `Nothing is due in the next 7 days, with ${round(freeHours)}h free.` };
  }
  if (committedHours > freeHours) {
    return {
      status: 'over',
      message: `${round(committedHours)}h of work is due in the next 7 days but only ${round(freeHours)}h is free. Something has to move.`,
    };
  }
  // Within a tenth of capacity is "tight" rather than "fits" — nothing ever
  // goes exactly to plan, so calling a full week comfortable would be a lie.
  if (committedHours > freeHours * 0.9) {
    return {
      status: 'tight',
      message: `${round(committedHours)}h of work against ${round(freeHours)}h free. That leaves no room for anything unexpected.`,
    };
  }
  return { status: 'fits', message: `${round(committedHours)}h of work against ${round(freeHours)}h free.` };
}

/** Whether any section has content — drives both the nudge and the empty state. */
export function hasReviewContent(review) {
  return (review?.finished?.length || 0) + (review?.slipped?.length || 0) + (review?.carriedOver?.length || 0) > 0;
}

/** How stale the oldest carried-over item is, for the "this has been sitting a while" line. */
export function describeOldestCarriedOver(carriedOver, todayIso) {
  if (!carriedOver || carriedOver.length === 0) return null;
  const oldest = carriedOver.reduce((a, b) => (a.dueDate < b.dueDate ? a : b));
  const days = diffDays(oldest.dueDate, todayIso);
  if (days < 14) return null;
  return `The oldest has been overdue for ${Math.floor(days / 7)} weeks.`;
}

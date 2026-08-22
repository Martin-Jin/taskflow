/**
 * Coverage for the weekly review's bucketing and its one date-maths action.
 *
 * Two things here are easy to get wrong and invisible when wrong: the window
 * boundaries (an off-by-one silently drops or double-counts a day's work), and
 * "move to next week" for a task that is already weeks overdue — a naive +7
 * days lands it back in the past, which looks like the button did nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  computeWeeklyReview,
  planMoveToNextWeek,
  isReviewDue,
  describeNextWeekFit,
  hasReviewContent,
  describeOldestCarriedOver,
  REVIEW_WINDOW_DAYS,
  REVIEW_NUDGE_INTERVAL_DAYS,
} from '../../src/utils/weeklyReview';

const TODAY = '2026-08-22'; // a Saturday
// Every day of the Sunday-start week EXCEPT its first day, for the no-rollback case.
const WEEK_AFTER_START = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];
const DAY_MS = 24 * 60 * 60 * 1000;

const done = (over) => ({ id: 'd', title: 'done', isCompleted: true, completedAt: `${TODAY}T10:00:00.000Z`, ...over });
const open = (over) => ({ id: 'o', title: 'open', isCompleted: false, remainingHours: 1, ...over });

describe('computeWeeklyReview — the window', () => {
  it('runs from the start of the user’s week to today, and looks 7 days ahead', () => {
    // TODAY is a Saturday. Sunday-start (the default) makes the week begin
    // last Sunday; Monday-start makes it begin last Monday.
    const sunday = computeWeeklyReview({ tasks: [], todayIso: TODAY });
    expect(sunday.windowStart).toBe('2026-08-16');
    expect(sunday.windowEnd).toBe(TODAY);
    expect(sunday.nextWindowStart).toBe('2026-08-23');
    expect(sunday.nextWindowEnd).toBe('2026-08-29');

    const monday = computeWeeklyReview({ tasks: [], todayIso: TODAY, weekStartsOn: 1 });
    expect(monday.windowStart).toBe('2026-08-17');
  });

  it('reviews the week just finished when today is the first day of the week', () => {
    // The dead zone, and it bit for real: shipped on a Sunday with Sunday-start
    // weeks, "this week" was one day old and every real slip fell into
    // "carried over" instead of "slipped".
    const sun = computeWeeklyReview({ tasks: [], todayIso: '2026-08-16' });
    expect(sun.reviewingPreviousWeek).toBe(true);
    expect(sun.windowStart).toBe('2026-08-09');
    expect(sun.windowEnd).toBe('2026-08-15'); // the day before, not today
    const mon = computeWeeklyReview({ tasks: [], todayIso: '2026-08-17', weekStartsOn: 1 });
    expect(mon.reviewingPreviousWeek).toBe(true);
    expect(mon.windowStart).toBe('2026-08-10');
    expect(mon.windowEnd).toBe('2026-08-16');
  });

  it('does not roll back on any other day of the week', () => {
    for (const iso of WEEK_AFTER_START) {
      expect(computeWeeklyReview({ tasks: [], todayIso: iso }).reviewingPreviousWeek).toBe(false);
    }
  });

  it('on the first day of the week, yesterday’s slip is SLIPPED, not carried over', () => {
    // The exact misreport: with no rollback, windowStart === today, so
    // yesterday fell below it and was filed as older debt.
    const r = computeWeeklyReview({ tasks: [open({ id: 'y', dueDate: '2026-08-15' })], todayIso: '2026-08-16' });
    expect(r.slipped.map((t) => t.id)).toEqual(['y']);
    expect(r.carriedOver).toEqual([]);
  });

  it('does NOT treat a task due today as slipped', () => {
    // THE bug this replaced: fifteen tasks due today were reported as missed
    // at breakfast on the day they were due. The day isn't over, and this is
    // the app's own definition of overdue (utils/overdueTasks.js).
    const r = computeWeeklyReview({ tasks: [open({ id: 'dueToday', dueDate: TODAY })], todayIso: TODAY });
    expect(r.slipped).toHaveLength(0);
    expect(r.carriedOver).toHaveLength(0);
  });

  it('treats a task due yesterday as slipped', () => {
    const r = computeWeeklyReview({ tasks: [open({ id: 'y', dueDate: '2026-08-21' })], todayIso: TODAY });
    expect(r.slipped.map((t) => t.id)).toEqual(['y']);
  });

  it('counts a task completed on either boundary day', () => {
    const r = computeWeeklyReview({
      tasks: [
        done({ id: 'first', completedAt: '2026-08-16T23:59:00.000Z' }),
        done({ id: 'last', completedAt: '2026-08-22T00:01:00.000Z' }),
        done({ id: 'tooOld', completedAt: '2026-08-15T23:59:00.000Z' }),
      ],
      todayIso: TODAY,
    });
    expect(r.finished.map((t) => t.id)).toEqual(['first', 'last']);
  });

  it('compares the completion DATE, not the raw timestamp', () => {
    // A same-day completion whose timestamp sorts after 'YYYY-MM-DD' would be
    // dropped by a naive string compare against the window end.
    const r = computeWeeklyReview({ tasks: [done({ completedAt: `${TODAY}T23:59:59.999Z` })], todayIso: TODAY });
    expect(r.finished).toHaveLength(1);
  });

  it('ignores a completed task with no completedAt rather than guessing', () => {
    const r = computeWeeklyReview({ tasks: [done({ completedAt: null })], todayIso: TODAY });
    expect(r.finished).toHaveLength(0);
  });

  it('ignores tombstoned tasks', () => {
    const r = computeWeeklyReview({ tasks: [done({ deletedAt: '2026-08-20T00:00:00.000Z' })], todayIso: TODAY });
    expect(r.finished).toHaveLength(0);
  });
});

describe('computeWeeklyReview — the three buckets never overlap', () => {
  const tasks = [
    done({ id: 'finished' }),
    open({ id: 'dueToday', dueDate: TODAY }),
    open({ id: 'slippedStart', dueDate: '2026-08-16' }),
    open({ id: 'carried', dueDate: '2026-08-15' }),
    open({ id: 'ancient', dueDate: '2026-07-01' }),
    open({ id: 'future', dueDate: '2026-09-01' }),
    open({ id: 'undated' }),
  ];

  it('sorts each task into at most one bucket', () => {
    const r = computeWeeklyReview({ tasks, todayIso: TODAY });
    expect(r.finished.map((t) => t.id)).toEqual(['finished']);
    expect(r.slipped.map((t) => t.id)).toEqual(['slippedStart']);
    expect(r.carriedOver.map((t) => t.id)).toEqual(['carried', 'ancient']);
    const all = [...r.finished, ...r.slipped, ...r.carriedOver].map((t) => t.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves a future or undated open task out of every bucket', () => {
    // Neither has slipped, and listing them is what the Tasks page is for.
    const r = computeWeeklyReview({ tasks, todayIso: TODAY });
    const all = [...r.finished, ...r.slipped, ...r.carriedOver].map((t) => t.id);
    expect(all).not.toContain('future');
    expect(all).not.toContain('undated');
    // Nor one due today — it still has the day to run.
    expect(all).not.toContain('dueToday');
  });

  it('sums remaining hours per bucket, and tracked hours for what got done', () => {
    const r = computeWeeklyReview({
      tasks: [
        done({ id: 'a', actualHours: 2.5, estimatedHours: 2 }),
        open({ id: 'b', dueDate: '2026-08-21', remainingHours: 3 }),
        open({ id: 'c', dueDate: '2026-08-01', remainingHours: 1.5 }),
      ],
      todayIso: TODAY,
    });
    expect(r.finishedHours).toBe(2.5);
    expect(r.finishedEstimatedHours).toBe(2);
    expect(r.slippedHours).toBe(3);
    expect(r.carriedOverHours).toBe(1.5);
  });

  it('tolerates missing hour fields instead of producing NaN', () => {
    const r = computeWeeklyReview({ tasks: [done({}), open({ dueDate: '2026-08-21' })], todayIso: TODAY });
    expect(r.finishedHours).toBe(0);
    expect(Number.isNaN(r.slippedHours)).toBe(false);
  });

  it('tolerates no tasks at all', () => {
    const r = computeWeeklyReview({ tasks: null, todayIso: TODAY });
    expect(hasReviewContent(r)).toBe(false);
  });
});

describe('planMoveToNextWeek', () => {
  it('keeps the weekday, one week on', () => {
    // 2026-08-22 is a Saturday; a Monday task becomes next Monday.
    expect(planMoveToNextWeek({ dueDate: '2026-08-17' }, TODAY)).toBe('2026-08-24');
  });

  it('always lands inside the next 7 days, even for a task weeks overdue', () => {
    // THE case: a flat +7 days would put a three-weeks-overdue task back in
    // the past, so the button would look broken.
    const moved = planMoveToNextWeek({ dueDate: '2026-07-06' }, TODAY); // a Monday, 7 weeks back
    expect(moved).toBe('2026-08-24');
    expect(moved > TODAY).toBe(true);
  });

  it('never returns a date in the past, for any weekday', () => {
    for (let back = 0; back < 40; back += 1) {
      const due = new Date(Date.UTC(2026, 7, 22 - back)).toISOString().slice(0, 10);
      const moved = planMoveToNextWeek({ dueDate: due }, TODAY);
      expect(moved > TODAY).toBe(true);
      expect(moved <= '2026-08-29').toBe(true);
    }
  });

  it('gives an undated task tomorrow rather than refusing', () => {
    expect(planMoveToNextWeek({}, TODAY)).toBe('2026-08-23');
    expect(planMoveToNextWeek(null, TODAY)).toBe('2026-08-23');
  });
});

describe('isReviewDue', () => {
  const NOW = 1_800_000_000_000;

  it('nudges when never reviewed and there is something to see', () => {
    expect(isReviewDue({ lastReviewedAt: null, nowMs: NOW, hasAnythingToReview: true })).toBe(true);
  });

  it('never nudges about an empty review', () => {
    // A nudge that opens onto nothing teaches people to ignore nudges.
    expect(isReviewDue({ lastReviewedAt: null, nowMs: NOW, hasAnythingToReview: false })).toBe(false);
  });

  it('waits the full interval after a review', () => {
    const justDone = NOW - (REVIEW_NUDGE_INTERVAL_DAYS - 1) * DAY_MS;
    expect(isReviewDue({ lastReviewedAt: justDone, nowMs: NOW, hasAnythingToReview: true })).toBe(false);
    const aWeekAgo = NOW - REVIEW_NUDGE_INTERVAL_DAYS * DAY_MS;
    expect(isReviewDue({ lastReviewedAt: aWeekAgo, nowMs: NOW, hasAnythingToReview: true })).toBe(true);
  });
});

describe('describeNextWeekFit', () => {
  it('calls it over when the work exceeds the time', () => {
    const out = describeNextWeekFit({ committedHours: 30, freeHours: 20 });
    expect(out.status).toBe('over');
    expect(out.message).toMatch(/has to move/);
  });

  it('calls a nearly-full week tight rather than fine', () => {
    // Nothing goes exactly to plan, so "it fits" at 99% would be a lie.
    expect(describeNextWeekFit({ committedHours: 19, freeHours: 20 }).status).toBe('tight');
  });

  it('calls a comfortable week a fit', () => {
    expect(describeNextWeekFit({ committedHours: 5, freeHours: 20 }).status).toBe('fits');
  });

  it('handles an empty next week without dividing by anything', () => {
    const out = describeNextWeekFit({ committedHours: 0, freeHours: 20 });
    expect(out.status).toBe('fits');
    expect(out.message).toMatch(/Nothing is due/);
  });

  it('rounds to one decimal rather than printing float noise', () => {
    expect(describeNextWeekFit({ committedHours: 1 / 3, freeHours: 20 }).message).toContain('0.3h');
  });
});

describe('describeOldestCarriedOver', () => {
  it('stays quiet for recent debt', () => {
    expect(describeOldestCarriedOver([{ dueDate: '2026-08-15' }], TODAY)).toBeNull();
    expect(describeOldestCarriedOver([], TODAY)).toBeNull();
  });

  it('calls out debt older than a fortnight, in weeks', () => {
    expect(describeOldestCarriedOver([{ dueDate: '2026-08-01' }, { dueDate: '2026-08-15' }], TODAY)).toBe(
      'The oldest has been overdue for 3 weeks.'
    );
  });
});

describe('the window length is fixed', () => {
  it('is 7 days, deliberately not configurable', () => {
    expect(REVIEW_WINDOW_DAYS).toBe(7);
  });
});

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
const DAY_MS = 24 * 60 * 60 * 1000;

const done = (over) => ({ id: 'd', title: 'done', isCompleted: true, completedAt: `${TODAY}T10:00:00.000Z`, ...over });
const open = (over) => ({ id: 'o', title: 'open', isCompleted: false, remainingHours: 1, ...over });

describe('computeWeeklyReview — the window', () => {
  it('reports an inclusive 7-day window ending today, and the next 7 days', () => {
    const r = computeWeeklyReview({ tasks: [], todayIso: TODAY });
    expect(r.windowStart).toBe('2026-08-16');
    expect(r.windowEnd).toBe('2026-08-22');
    expect(r.nextWindowStart).toBe('2026-08-23');
    expect(r.nextWindowEnd).toBe('2026-08-29');
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
    open({ id: 'slippedToday', dueDate: TODAY }),
    open({ id: 'slippedStart', dueDate: '2026-08-16' }),
    open({ id: 'carried', dueDate: '2026-08-15' }),
    open({ id: 'ancient', dueDate: '2026-07-01' }),
    open({ id: 'future', dueDate: '2026-09-01' }),
    open({ id: 'undated' }),
  ];

  it('sorts each task into at most one bucket', () => {
    const r = computeWeeklyReview({ tasks, todayIso: TODAY });
    expect(r.finished.map((t) => t.id)).toEqual(['finished']);
    expect(r.slipped.map((t) => t.id)).toEqual(['slippedToday', 'slippedStart']);
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
  });

  it('sums remaining hours per bucket, and tracked hours for what got done', () => {
    const r = computeWeeklyReview({
      tasks: [
        done({ id: 'a', actualHours: 2.5, estimatedHours: 2 }),
        open({ id: 'b', dueDate: TODAY, remainingHours: 3 }),
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
    const r = computeWeeklyReview({ tasks: [done({}), open({ dueDate: TODAY })], todayIso: TODAY });
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

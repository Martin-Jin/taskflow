/**
 * Coverage for the postponement counter.
 *
 * The exclusions are the whole point here, so they get most of the cases. A
 * false positive is worse than a miss: a "pushed 4×" badge on a task the user
 * never postponed makes the signal untrustworthy, and the most likely cause is
 * a resubmitted-but-unchanged due date, which no functional UI assertion would
 * distinguish from a real slip.
 */

import { describe, it, expect } from 'vitest';
import {
  planPostponeUpdate,
  shouldShowPostponeBadge,
  describePostponeCount,
  POSTPONE_BADGE_THRESHOLD,
} from '../../src/utils/rescheduleHistory';

const NOW = '2026-08-22T10:00:00.000Z';
const task = (over = {}) => ({ id: 't1', dueDate: '2026-08-10', isRecurring: false, ...over });

describe('planPostponeUpdate — counting a real slip', () => {
  it('counts a due date moved later', () => {
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-11' }, NOW)).toEqual({
      postponeCount: 1,
      lastPostponedAt: NOW,
    });
  });

  it('increments an existing count', () => {
    const out = planPostponeUpdate(task({ postponeCount: 3 }), { dueDate: '2026-09-01' }, NOW);
    expect(out.postponeCount).toBe(4);
  });

  it('counts a slip across a month and a year boundary', () => {
    // ISO strings compared as strings — the boundaries are where a naive
    // day-of-month or Date-parsing comparison would break.
    expect(planPostponeUpdate(task({ dueDate: '2026-08-31' }), { dueDate: '2026-09-01' }, NOW)).toBeTruthy();
    expect(planPostponeUpdate(task({ dueDate: '2026-12-31' }), { dueDate: '2027-01-01' }, NOW)).toBeTruthy();
  });

  it('still counts when the task was completed and this edit reopens it', () => {
    // Moving a finished task's deadline out IS a postponement; the reopen is a
    // side effect of it. Only an EXPLICIT isCompleted in the update is exempt.
    const out = planPostponeUpdate(task({ isCompleted: true }), { dueDate: '2026-08-20' }, NOW);
    expect(out.postponeCount).toBe(1);
  });

  it('treats a corrupt existing count as zero rather than producing NaN', () => {
    expect(planPostponeUpdate(task({ postponeCount: 'lots' }), { dueDate: '2026-08-11' }, NOW).postponeCount).toBe(1);
    expect(planPostponeUpdate(task({ postponeCount: null }), { dueDate: '2026-08-11' }, NOW).postponeCount).toBe(1);
  });
});

describe('planPostponeUpdate — the exclusions', () => {
  it('ignores a resubmitted identical due date', () => {
    // THE important case. TaskDetailModal's commitChanges sends dueDate on
    // every save whether or not the user touched it, so without this, editing
    // a task's title or notes would count as postponing it.
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-10' }, NOW)).toBeNull();
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-10', title: 'renamed' }, NOW)).toBeNull();
  });

  it('ignores an edit that does not touch the due date at all', () => {
    expect(planPostponeUpdate(task(), { title: 'renamed', priority: 'high' }, NOW)).toBeNull();
  });

  it('ignores a due date pulled earlier', () => {
    // Pulling work forward is the opposite of the behaviour being measured.
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-01' }, NOW)).toBeNull();
  });

  it('ignores an undated task gaining its first due date', () => {
    // Scheduling, not slipping.
    expect(planPostponeUpdate(task({ dueDate: null }), { dueDate: '2026-08-11' }, NOW)).toBeNull();
    expect(planPostponeUpdate(task({ dueDate: undefined }), { dueDate: '2026-08-11' }, NOW)).toBeNull();
  });

  it('ignores a due date being cleared', () => {
    expect(planPostponeUpdate(task(), { dueDate: null }, NOW)).toBeNull();
    expect(planPostponeUpdate(task(), { dueDate: '' }, NOW)).toBeNull();
  });

  it('ignores a recurring task entirely', () => {
    // Its whole model is "the date moves"; a count there measures how long the
    // task has existed, not whether it is stuck.
    expect(planPostponeUpdate(task({ isRecurring: true }), { dueDate: '2026-08-20' }, NOW)).toBeNull();
  });

  it('ignores an update that explicitly sets completion state', () => {
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-20', isCompleted: true }, NOW)).toBeNull();
    expect(planPostponeUpdate(task(), { dueDate: '2026-08-20', isCompleted: false }, NOW)).toBeNull();
  });

  it('tolerates missing arguments rather than throwing', () => {
    expect(planPostponeUpdate(null, { dueDate: '2026-08-11' }, NOW)).toBeNull();
    expect(planPostponeUpdate(task(), null, NOW)).toBeNull();
    expect(planPostponeUpdate(undefined, undefined, NOW)).toBeNull();
  });
});

describe('the badge threshold', () => {
  it('stays hidden below the threshold, including for an untouched task', () => {
    expect(shouldShowPostponeBadge({})).toBe(false);
    expect(shouldShowPostponeBadge({ postponeCount: 0 })).toBe(false);
    expect(shouldShowPostponeBadge({ postponeCount: POSTPONE_BADGE_THRESHOLD - 1 })).toBe(false);
    expect(shouldShowPostponeBadge(undefined)).toBe(false);
  });

  it('appears at the threshold and stays', () => {
    expect(shouldShowPostponeBadge({ postponeCount: POSTPONE_BADGE_THRESHOLD })).toBe(true);
    expect(shouldShowPostponeBadge({ postponeCount: 99 })).toBe(true);
  });

  it('reads as a count of events, not a judgement', () => {
    expect(describePostponeCount({ postponeCount: 4 })).toBe('pushed 4×');
  });
});

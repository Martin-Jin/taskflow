/**
 * useWeeklyReview — assembles the review's data and its actions in one place,
 * so both entry points (the Dashboard nudge card and the command palette) get
 * identical behaviour and the modal itself stays presentational.
 *
 * WHY THE CAPACITY DENOMINATOR IGNORES EXISTING BLOCKS. `computeHorizonCapacity`
 * treats already-scheduled blocks as busy time, so its `totalAvailableHours`
 * is "time still open". Comparing that against the remaining hours of every
 * task due next week would double-count anything already on the calendar —
 * scheduled work would subtract from the capacity AND count as work still to
 * do, making a well-planned week look over-committed. Passing `blocks: []`
 * gives the honest denominator instead: total working time next week, against
 * which the total work due is the numerator. Routines and calendar events stay
 * busy, because that time genuinely isn't available.
 *
 * `lastReviewedAt` is DEVICE-LOCAL, like the dashboard widget toggles. It's a
 * nudge cadence rather than data — the review holds no state of its own and
 * recomputes from live tasks every time — so losing it costs one extra prompt.
 * The trade-off it accepts: doing the review on a laptop won't silence the
 * phone's card. If that becomes annoying it wants to move into
 * SchedulerContext and BACKUP_FIELDS, which is why it's called out here.
 */

import { useCallback, useMemo } from 'react';
import { useScheduler } from '../context/SchedulerContext';
import { useCompleteTask } from '../context/CompleteTaskContext';
import { usePersistedState } from './usePersistedState';
import { computeHorizonCapacity } from '../algorithms/capacityEngine';
import { toISODate } from '../utils/dateUtils';
import {
  computeWeeklyReview,
  planMoveToNextWeek,
  isReviewDue,
  hasReviewContent,
  canOpenReview,
  REVIEW_WINDOW_DAYS,
} from '../utils/weeklyReview';

export function useWeeklyReview() {
  const { tasks, blocks, routines, events, rules, updateTask, deleteTask, setNotification } = useScheduler();
  // Completion goes through requestComplete, never completeTask directly, so a
  // running timer on the task is handled/confirmed rather than silently lost.
  const { requestComplete } = useCompleteTask();
  const [lastReviewedAt, setLastReviewedAt] = usePersistedState('lastWeeklyReviewAt', null);

  const todayIso = toISODate(new Date());
  const review = useMemo(
    () => computeWeeklyReview({ tasks, todayIso, weekStartsOn: rules.weekStartsOn }),
    [tasks, todayIso, rules.weekStartsOn]
  );

  const { committedHours, freeHours } = useMemo(() => {
    const capacity = computeHorizonCapacity(review.nextWindowStart, REVIEW_WINDOW_DAYS, {
      routines,
      events,
      // Deliberately empty — see the header on double-counting.
      blocks: [],
      rules,
    });
    const free = [...capacity.values()].reduce((sum, day) => sum + day.totalAvailableHours, 0);
    const committed = (tasks || [])
      .filter(
        (t) =>
          !t.isCompleted &&
          !t.deletedAt &&
          t.dueDate &&
          t.dueDate >= review.nextWindowStart &&
          t.dueDate <= review.nextWindowEnd
      )
      .reduce((sum, t) => sum + (Number(t.remainingHours) || 0), 0);
    return { committedHours: committed, freeHours: free };
  }, [tasks, routines, events, rules, review.nextWindowStart, review.nextWindowEnd]);

  const moveToNextWeek = useCallback(
    (task) => {
      const nextDue = planMoveToNextWeek(task, todayIso);
      updateTask(task.id, { dueDate: nextDue });
    },
    [updateTask, todayIso]
  );

  const completeFromReview = useCallback((task) => requestComplete(task.id), [requestComplete]);

  const dropFromReview = useCallback(
    (task) => {
      // No confirm: deleting a task is already undoable (it goes through
      // commit and pops the standard undo toast), unlike the structural
      // deletes that needed a trash.
      deleteTask(task.id);
      setNotification({ type: 'success', message: `Deleted "${task.title}".` });
    },
    [deleteTask, setNotification]
  );

  /** Called when the review is closed — that's what "I did my review" means. */
  const markReviewed = useCallback(() => setLastReviewedAt(Date.now()), [setLastReviewedAt]);

  const nudgeVisible = isReviewDue({
    lastReviewedAt,
    nowMs: Date.now(),
    hasAnythingToReview: hasReviewContent(review),
  });

  return {
    review,
    // Whether there's anything worth opening at all, as opposed to whether a
    // review is DUE — the dashboard needs both (see WeeklyReviewCard).
    canOpen: canOpenReview(review),
    todayIso,
    committedHours,
    freeHours,
    nudgeVisible,
    moveToNextWeek,
    completeFromReview,
    dropFromReview,
    markReviewed,
  };
}

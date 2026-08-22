/**
 * WeeklyReviewModal — one screen: how the last 7 days went, what's still
 * outstanding, and whether the next 7 days actually fit.
 *
 * ONE SCREEN, NOT A WIZARD. A multi-step flow would make a weekly habit feel
 * like a form to fill in, and the whole value here is that you can see the
 * numbers and act on them in the same glance. So: four sections, each with the
 * one or two actions that section makes obvious, and no "next" button.
 *
 * The actions apply immediately and the sections recompute, which is the point
 * — moving three tasks out of next week should visibly change the capacity
 * verdict while you're still looking at it. That's also why capacity arrives as
 * plain numbers from the caller rather than being computed here: the caller
 * already owns the scheduler inputs (rules, routines, events, blocks), and this
 * component has no business knowing about any of them.
 *
 * Actions are deliberately not undo-batched into one entry. Each is a separate
 * decision a user makes and might want to take back on its own, unlike a
 * template instantiation where the batch IS the action.
 */

import React from 'react';
import { CheckCircle2, Clock, AlertTriangle, CalendarClock, ArrowRight, Trash2, Check } from 'lucide-react';
import Modal from '../Common/Modal';
import { formatHours } from '../../utils/formatHours';
import { formatDisplayDate } from '../../utils/dateUtils';
import { accuracyHeadline } from '../../utils/estimateAccuracy';
import { describeNextWeekFit, describeOldestCarriedOver, hasReviewContent } from '../../utils/weeklyReview';
import { shouldShowPostponeBadge, describePostponeCount } from '../../utils/rescheduleHistory';
import Badge from '../Common/Badge';

/** One actionable task row. Kept local — nothing else in the app has this shape. */
function ReviewRow({ task, todayIso, onMove, onComplete, onDrop }) {
  return (
    <div className="review-row">
      <div className="review-row-main">
        <span className="review-row-title">{task.title}</span>
        <span className="form-hint review-row-meta">
          {formatHours(task.remainingHours ?? task.estimatedHours ?? 0)} left
          {task.dueDate ? ` · was due ${formatDisplayDate(task.dueDate)}` : ''}
        </span>
      </div>
      {/* The badge earns its place here more than anywhere: this is the screen
          where you decide whether a chronically-pushed task is really going to
          happen. */}
      {shouldShowPostponeBadge(task) && <Badge variant="postponed">{describePostponeCount(task)}</Badge>}
      <div className="review-row-actions">
        <button type="button" className="btn settings-inline" onClick={() => onMove(task)} title="Move to next week">
          <ArrowRight size={13} />
          Next week
        </button>
        <button type="button" className="btn btn-icon" onClick={() => onComplete(task)} aria-label={`Mark "${task.title}" done`} title="Mark done">
          <Check size={14} />
        </button>
        <button type="button" className="btn btn-icon" onClick={() => onDrop(task)} aria-label={`Delete "${task.title}"`} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export default function WeeklyReviewModal({
  review,
  todayIso,
  committedHours,
  freeHours,
  onMoveToNextWeek,
  onCompleteTask,
  onDropTask,
  onClose,
}) {
  const fit = describeNextWeekFit({ committedHours, freeHours });
  const oldestNote = describeOldestCarriedOver(review.carriedOver, todayIso);
  const rowProps = { todayIso, onMove: onMoveToNextWeek, onComplete: onCompleteTask, onDrop: onDropTask };

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Weekly review"
      size="lg"
      header={
        <div>
          <h3 style={{ margin: 0 }}>Weekly review</h3>
          <p className="form-hint" style={{ margin: '2px 0 0' }}>
            {formatDisplayDate(review.windowStart)} – {formatDisplayDate(review.windowEnd)}
          </p>
        </div>
      }
    >
      {({ requestClose }) => (
        <>
          {!hasReviewContent(review) ? (
            <p className="settings-hint" style={{ marginTop: 0 }}>
              Nothing finished, slipped or outstanding in the last 7 days. Enjoy it.
            </p>
          ) : (
            <>
              <section className="review-section">
                <h4 className="review-section-title">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  Finished
                  <span className="review-section-count">{review.finished.length}</span>
                </h4>
                {review.finished.length === 0 ? (
                  <p className="form-hint review-section-empty">Nothing completed in the last 7 days.</p>
                ) : (
                  <p className="form-hint review-section-empty">
                    {review.finished.length} task{review.finished.length === 1 ? '' : 's'} done
                    {review.finishedHours > 0 ? `, ${formatHours(review.finishedHours)} tracked` : ''}.
                    {/* Only shown when the sample is big enough to mean
                        something — computeEstimateAccuracy owns that judgement. */}
                    {/* accuracyHeadline returns a bare sentence with no
                        terminator, so it can sit in a table cell too — it needs
                        the full stop adding here. */}
                    {review.accuracy?.ratio ? ` ${accuracyHeadline(review.accuracy.ratio)}.` : ''}
                  </p>
                )}
              </section>

              <section className="review-section">
                <h4 className="review-section-title">
                  <AlertTriangle size={14} aria-hidden="true" />
                  Slipped this week
                  <span className="review-section-count">{review.slipped.length}</span>
                </h4>
                {review.slipped.length === 0 ? (
                  <p className="form-hint review-section-empty">Nothing due in the last 7 days is still open.</p>
                ) : (
                  <div className="review-list">
                    {review.slipped.map((task) => (
                      <ReviewRow key={task.id} task={task} {...rowProps} />
                    ))}
                  </div>
                )}
              </section>

              <section className="review-section">
                <h4 className="review-section-title">
                  <Clock size={14} aria-hidden="true" />
                  Carried over
                  <span className="review-section-count">{review.carriedOver.length}</span>
                </h4>
                {review.carriedOver.length === 0 ? (
                  <p className="form-hint review-section-empty">No older overdue work.</p>
                ) : (
                  <>
                    <p className="form-hint review-section-empty">
                      Due before this week and still open — {formatHours(review.carriedOverHours)} of work.
                      {oldestNote ? ` ${oldestNote}` : ''}
                    </p>
                    <div className="review-list">
                      {review.carriedOver.map((task) => (
                        <ReviewRow key={task.id} task={task} {...rowProps} />
                      ))}
                    </div>
                  </>
                )}
              </section>

              <section className="review-section">
                <h4 className="review-section-title">
                  <CalendarClock size={14} aria-hidden="true" />
                  Next 7 days
                </h4>
                {/* The reality check, and the reason the actions above are on
                    this screen rather than in the Tasks list: this line should
                    change as you move things. */}
                <p className={`review-fit review-fit-${fit.status}`}>{fit.message}</p>
              </section>
            </>
          )}

          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={requestClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

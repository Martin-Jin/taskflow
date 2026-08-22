/**
 * WeeklyReviewCard — the nudge that makes the weekly review a habit rather
 * than a screen nobody finds.
 *
 * TWO STATES, because "is a review due?" and "can I look at the review?" are
 * different questions. Conflating them meant closing the review made it
 * unreachable except through the command palette, which nobody discovers.
 *   - PROMPT (`variant="prompt"`) — a review is due. Accent-styled, states the
 *     counts, sits above the stats strip where it's unmissable.
 *   - QUIET (`variant="quiet"`) — already reviewed, but there's still something
 *     to look at. A plain link-weight row under the progress rings, so last
 *     week's report stays one click away without nagging.
 * Neither renders when the review is empty: a card reading "nothing to review"
 * would be rendering the absence of information, which the direction rules
 * reject, and a prompt opening onto an empty screen teaches people to ignore
 * prompts.
 *
 * The prompt states the counts rather than just saying "time for your review",
 * because those numbers are the reason to click: "4 slipped, 6 carried over"
 * is a decision waiting to be made, where a bare prompt is a chore.
 */

import React from 'react';
import { ClipboardCheck } from 'lucide-react';

export default function WeeklyReviewCard({ review, onOpen, variant = 'prompt' }) {
  const slipped = review.slipped.length;
  const carried = review.carriedOver.length;
  const parts = [];
  // Matches the modal's own wording — on the first day of a week the review
  // covers the week that just ended (see computeWeeklyReview).
  if (slipped > 0) parts.push(`${slipped} slipped ${review.reviewingPreviousWeek ? 'last' : 'this'} week`);
  if (carried > 0) parts.push(`${carried} carried over`);
  if (review.finished.length > 0 && parts.length === 0) {
    parts.push(`${review.finished.length} finished and nothing outstanding`);
  }

  if (variant === 'quiet') {
    return (
      <button type="button" className="weekly-review-reopen" onClick={onOpen}>
        <ClipboardCheck size={14} aria-hidden="true" />
        <span>View this week's review</span>
      </button>
    );
  }

  return (
    <div className="card weekly-review-card">
      <div className="weekly-review-card-body">
        <ClipboardCheck size={18} className="weekly-review-card-icon" aria-hidden="true" />
        <div>
          <p className="weekly-review-card-title">Weekly review</p>
          <p className="form-hint" style={{ margin: 0 }}>
            {parts.join(' · ')}. Take a look at what to move.
          </p>
        </div>
      </div>
      <button type="button" className="btn btn-primary" onClick={onOpen}>
        Review
      </button>
    </div>
  );
}

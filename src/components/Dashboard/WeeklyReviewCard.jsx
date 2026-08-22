/**
 * WeeklyReviewCard — the nudge that makes the weekly review a habit rather
 * than a screen nobody finds.
 *
 * RENDERS ONLY WHEN THERE IS SOMETHING TO DO, and only once a week (see
 * isReviewDue). A permanent card reading "nothing to review" would be
 * rendering the absence of information, which this app's direction rules
 * explicitly reject — and a nudge that regularly opens onto an empty screen
 * teaches people to ignore nudges. The review itself stays reachable any time
 * from the command palette, so hiding the card costs nothing.
 *
 * It states the two counts rather than just saying "time for your review",
 * because those numbers are the reason to click: "4 slipped, 6 carried over"
 * is a decision waiting to be made, where a bare prompt is a chore.
 */

import React from 'react';
import { ClipboardCheck } from 'lucide-react';

export default function WeeklyReviewCard({ review, onOpen }) {
  const slipped = review.slipped.length;
  const carried = review.carriedOver.length;
  const parts = [];
  if (slipped > 0) parts.push(`${slipped} slipped this week`);
  if (carried > 0) parts.push(`${carried} carried over`);
  if (review.finished.length > 0 && parts.length === 0) {
    parts.push(`${review.finished.length} finished and nothing outstanding`);
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

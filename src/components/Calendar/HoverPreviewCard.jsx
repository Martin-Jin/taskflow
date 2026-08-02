/**
 * HoverPreviewCard
 * ============================================================================
 * Small hover-only preview for a calendar block/event or Gantt row whose
 * title has been truncated (ellipsis/clip) in its compact home — shows the
 * full title, time range, and priority/project without needing to open the
 * detail modal. Desktop-only; callers gate on `isMobile`/hover support
 * themselves (no hover concept on touch), this component just renders
 * whatever it's given whenever `rect` is non-null.
 *
 * Rendered as a `position: fixed` portal to <body> rather than absolutely
 * inside the calendar/Gantt grid, since those containers scroll with
 * `overflow: auto` — an absolutely-positioned child would get clipped or
 * scroll away with the grid instead of floating above the whole page.
 * `pointer-events: none` (see calendar.css) so it can never itself intercept
 * a click meant for the block underneath or beside it.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Wind } from 'lucide-react';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { formatDisplayDateTime } from '../../utils/dateUtils';

const WIDTH = 220;
const EST_HEIGHT = 90;
const GAP = 8;

/** Prefers sitting just to the right of the hovered element's rect, falling
 * back to the left if that would run off the right edge of the viewport,
 * and clamps both axes so the card never gets clipped off-screen. */
function computeStyle(rect) {
  let left = rect.right + GAP;
  if (left + WIDTH > window.innerWidth - 8) left = rect.left - WIDTH - GAP;
  if (left < 8) left = 8;
  let top = rect.top;
  if (top + EST_HEIGHT > window.innerHeight - 8) top = window.innerHeight - EST_HEIGHT - 8;
  if (top < 8) top = 8;
  return { left, top, width: WIDTH };
}

export default function HoverPreviewCard({ rect, title, timeText, priority, projectName, parentTitle, isPassive, completedAt }) {
  if (!rect) return null;
  return createPortal(
    <div className="cal-hover-preview" style={{ position: 'fixed', ...computeStyle(rect) }}>
      <div className="cal-hover-preview-title">
        {isPassive && <Wind size={12} style={{ verticalAlign: -2, marginRight: 4 }} />}
        {title}
      </div>
      {parentTitle && <div className="cal-hover-preview-parent">Sub-task of {parentTitle}</div>}
      {timeText && <div className="cal-hover-preview-time">{timeText}</div>}
      {completedAt && <div className="cal-hover-preview-completed">Completed at {formatDisplayDateTime(completedAt)}</div>}
      {(priority || projectName) && (
        <div className="cal-hover-preview-meta">
          {priority && (
            <span className="cal-hover-preview-priority">
              <span className={`priority-dot ${priority}`} />
              {PRIORITY_LABELS[priority] || priority}
            </span>
          )}
          {projectName && <span className="cal-hover-preview-project">{projectName}</span>}
        </div>
      )}
    </div>,
    document.body
  );
}

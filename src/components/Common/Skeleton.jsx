/**
 * Skeleton — placeholder blocks shown while first-load data is still arriving.
 *
 * WHEN THIS IS CORRECT, and when it isn't. There is exactly one moment the app
 * genuinely doesn't know whether you have tasks: a signed-in cloud pull is in
 * flight and local storage is empty (a fresh device, a new browser). Until now
 * that window rendered the ordinary empty state, so the app confidently told
 * you that you had no tasks a moment before showing you your tasks.
 *
 * A skeleton must NOT be shown merely because a collection is empty — a genuinely
 * new user would then watch a placeholder that never resolves, which is worse
 * than the honest "nothing here yet" it replaced. Every caller gates on
 * `isPullingCloud && isEmpty`; see `useFirstLoadSkeleton`.
 *
 * The shimmer is gated on the app's motion preference like every other
 * animation (CLAUDE.md: "motion explains causality or it doesn't ship" — here it
 * explains "this is not your data, it's a placeholder"). With motion off the
 * blocks are static, which still reads as "loading" from the shape alone.
 */

import React from 'react';
import { useMotionEnabled } from '../../hooks/useMotionEnabled';

/**
 * One placeholder block.
 *
 * @param {{width?: string, height?: string, radius?: string, className?: string}} props
 */
export function SkeletonBlock({ width = '100%', height = '1rem', radius, className = '' }) {
  const motionEnabled = useMotionEnabled();
  return (
    <span
      className={`skeleton-block ${motionEnabled ? 'is-animated' : ''} ${className}`.trim()}
      style={{ width, height, ...(radius ? { borderRadius: radius } : {}) }}
      aria-hidden="true"
    />
  );
}

/**
 * A stack of rows standing in for a list. Widths vary per row so it reads as
 * text rather than a bar chart — uniform bars look like a broken layout.
 *
 * The whole stack carries one `role="status"` with a label, so a screen reader
 * hears "Loading" once instead of narrating every placeholder.
 */
export function SkeletonList({ rows = 4, label = 'Loading…', className = '' }) {
  const widths = ['92%', '74%', '85%', '63%', '80%', '70%'];
  return (
    <div className={`skeleton-list ${className}`.trim()} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <SkeletonBlock width="1rem" height="1rem" radius="4px" />
          <SkeletonBlock width={widths[i % widths.length]} height="0.85rem" />
        </div>
      ))}
    </div>
  );
}

import { describe, it, expect } from 'vitest';
import { computeShowTimeLine } from '../../src/components/Calendar/WeekView';

// Pinned regression tests for computeShowTimeLine (extracted from WeekView's
// itemLiveState so this arithmetic can be tested directly — see its own doc
// comment).
//
// This used to also degrade a box tagged `tightGap` (close to a neighbour —
// see foldSequentialItems) even once it cleared its own two-line height
// threshold, on the theory that a short-ish box near a close neighbour could
// still look visually cramped. That produced its own real bug report: a
// "Prepare for tutorial" block (real 30-minute duration, rendering at its
// own honest compact-mode height, comfortably above the 32px it needs to
// show both lines) lost its time line purely because an unrelated earlier
// item ("Test 1 - Lane 1") happened to end within TIGHT_GAP_PX of it — even
// though the box itself had plenty of its own visible room, and the two
// boxes were stacked in a single lane with a real (if smallish) gap between
// them, not actually overlapping or colliding on screen.
//
// The fix removes tightGap/totalLanes from this decision entirely: once a
// box's own height clears the two-line minimum for whichever type size it's
// drawn at, it always shows its time line, full stop — no ceiling, no
// neighbour-adjacency exception.
describe('computeShowTimeLine', () => {
  describe('normal (non-compact) boxes — twoLineMinHeight=44', () => {
    it('shows the time line once height clears 44px', () => {
      expect(computeShowTimeLine({ height: 44, isCompact: false, isResizing: false })).toBe(true);
      expect(computeShowTimeLine({ height: 75, isCompact: false, isResizing: false })).toBe(true);
    });

    it('hides the time line below the 44px threshold', () => {
      expect(computeShowTimeLine({ height: 43, isCompact: false, isResizing: false })).toBe(false);
      expect(computeShowTimeLine({ height: 30, isCompact: false, isResizing: false })).toBe(false);
    });

    it('THE REPORTED BUG — a comfortably-tall box near a close neighbour still shows its time line', () => {
      // 58px comfortably clears the 44px threshold on its own — must show
      // its time line regardless of how close a neighbour happens to sit.
      expect(computeShowTimeLine({ height: 58, isCompact: false, isResizing: false })).toBe(true);
    });
  });

  describe('compact boxes — twoLineMinHeight=32', () => {
    it('shows the time line once height clears 32px', () => {
      expect(computeShowTimeLine({ height: 32, isCompact: true, isResizing: false })).toBe(true);
      expect(computeShowTimeLine({ height: 34, isCompact: true, isResizing: false })).toBe(true);
    });

    it('hides the time line below the compact 32px threshold', () => {
      expect(computeShowTimeLine({ height: 31, isCompact: true, isResizing: false })).toBe(false);
      expect(computeShowTimeLine({ height: 28, isCompact: true, isResizing: false })).toBe(false);
    });

    it('THE EXACT REPORTED BUG — a 38px compact "Prepare for tutorial" box shows its time line despite a close neighbour', () => {
      // The precise real numbers from the report: a 30-real-minute block at
      // max zoom (1.25px/min) renders at 38px in compact mode — comfortably
      // above the 32px it needs — but used to lose its time line purely
      // because "Test 1 - Lane 1" ended 15 real minutes (~19px) before it.
      expect(computeShowTimeLine({ height: 38, isCompact: true, isResizing: false })).toBe(true);
    });
  });

  describe('resizing always shows the time line regardless of height', () => {
    it('shows the time line while resizing even if short', () => {
      expect(computeShowTimeLine({ height: 10, isCompact: true, isResizing: true })).toBe(true);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { computeShowTimeLine } from '../../src/components/Calendar/WeekView';

// Pinned regression tests for computeShowTimeLine (extracted from WeekView's
// itemLiveState so this arithmetic can be tested directly — see its own doc
// comment). Covers two real reported bugs:
//
//   1. A flat TIGHT_GAP_HEIGHT_CEILING (originally 60px, now derived from the
//      corrected TWO_LINE_MIN_HEIGHT_PX below) didn't account for compact
//      boxes needing less height to show two lines in the first place
//      (COMPACT_TWO_LINE_MIN_HEIGHT vs the normal one) — so a compact box
//      with plenty of its own room still lost its time line purely because
//      it fell under a ceiling tuned for the OTHER font size. Fixed by
//      deriving the ceiling as twoLineMinHeight + 24 for whichever threshold
//      is actually live.
//   2. The original bug this mechanism exists for at all: a `tightGap`-
//      tagged box tall enough to have visible room to spare must never lose
//      its time line just because a neighbour happens to sit close to it.
//
// TWO_LINE_MIN_HEIGHT_PX itself was later corrected from 36 to 44 (see its
// own derivation comment in calendarLayout.js — the original 36 predated a
// padding-top change to .cal-block and no longer matched the real rendered
// height needed for two lines, causing visible clipping). The ceiling here
// moves with it (44 + 24 = 68), so every boundary number below is tied to
// the CURRENT threshold, not the original 36/60 pairing this file was first
// written against.
describe('computeShowTimeLine', () => {
  describe('normal (non-compact) boxes — twoLineMinHeight=44, ceiling=68', () => {
    it('shows the time line when comfortably tall and not tightGap', () => {
      expect(computeShowTimeLine({ height: 75, isCompact: false, tightGap: false, isResizing: false })).toBe(true);
    });

    it('hides the time line below the base 44px threshold regardless of tightGap', () => {
      expect(computeShowTimeLine({ height: 30, isCompact: false, tightGap: false, isResizing: false })).toBe(false);
    });

    it('hides the time line when tightGap AND still under the 68px ceiling (genuine crowding case)', () => {
      // 58px clears the 44px base threshold but sits under the 68px ceiling
      // while tagged tightGap — this is the mechanism's original intent:
      // a short-ish box crowded by a close neighbour still degrades.
      expect(computeShowTimeLine({ height: 58, isCompact: false, tightGap: true, isResizing: false })).toBe(false);
    });

    it('shows the time line when tightGap but height clears the 68px ceiling (the Bug 1 fix)', () => {
      // Root-cause case from the bug report: a block landing in a 2-lane
      // overlap group, tagged tightGap by an unrelated earlier sequential
      // neighbour (see foldSequentialItems — tightGap is set from adjacency
      // in the whole day's sorted sequence, not from whichever item it
      // happens to share a lane with). At exactly the ceiling's own boundary,
      // it must still show its time line since it's not BELOW the ceiling.
      expect(computeShowTimeLine({ height: 68, isCompact: false, tightGap: true, isResizing: false })).toBe(true);
    });

    it('still degrades a 63px tightGap box — under the 68px ceiling for normal (non-compact) type', () => {
      // A short-ish box crowded by a close neighbour still degrades even
      // after the corrected threshold — the mechanism's original intent is
      // unaffected by the height-derivation fix, only the exact boundary
      // numbers moved with TWO_LINE_MIN_HEIGHT_PX.
      expect(computeShowTimeLine({ height: 63, isCompact: false, tightGap: true, isResizing: false })).toBe(false);
    });
  });

  describe('compact boxes — twoLineMinHeight=32, ceiling=56', () => {
    it('shows the time line when comfortably tall and not tightGap', () => {
      expect(computeShowTimeLine({ height: 34, isCompact: true, tightGap: false, isResizing: false })).toBe(true);
    });

    it('hides the time line below the compact 32px threshold', () => {
      expect(computeShowTimeLine({ height: 28, isCompact: true, tightGap: false, isResizing: false })).toBe(false);
    });

    it('hides the time line when tightGap AND under the compact 56px ceiling', () => {
      expect(computeShowTimeLine({ height: 40, isCompact: true, tightGap: true, isResizing: false })).toBe(false);
    });

    it('shows the time line when tightGap but height clears the compact 56px ceiling', () => {
      expect(computeShowTimeLine({ height: 56, isCompact: true, tightGap: true, isResizing: false })).toBe(true);
    });

    it('a 50px compact box still degrades under its own 56px ceiling (genuine crowding, not the reported bug)', () => {
      // 50px clears the compact 32px base threshold, but is still below its
      // OWN compact ceiling (32 + 24 = 56) — this is a case that legitimately
      // stays degraded even after the fix, proving the fix narrowed the
      // ceiling mismatch rather than removing the ceiling outright.
      expect(computeShowTimeLine({ height: 50, isCompact: true, tightGap: true, isResizing: false })).toBe(false);
    });

    it('a 57px compact box clears its own ceiling and must show its time line', () => {
      expect(computeShowTimeLine({ height: 57, isCompact: true, tightGap: true, isResizing: false })).toBe(true);
    });
  });

  describe('resizing always overrides tightGap/height entirely', () => {
    it('shows the time line while resizing even if short and tightGap', () => {
      expect(computeShowTimeLine({ height: 10, isCompact: true, tightGap: true, isResizing: true })).toBe(true);
    });
  });

  describe('totalLanes > 1 exempts a tightGap-tagged box from the height ceiling entirely (root cause of the reported "Piano" bug)', () => {
    // foldSequentialItems tags tightGap purely from adjacency in the WHOLE
    // day's start-sorted sequence, before layoutDayItems ever splits items
    // into side-by-side lanes. So a box can be tagged tightGap because of an
    // entirely unrelated, non-overlapping neighbour earlier/later in the
    // day, then separately land in its own side-by-side lane next to a
    // DIFFERENT item it actually overlaps in time. Once that happens, the
    // "close neighbour" tightGap refers to isn't even rendered next to this
    // box any more — it's off in another lane or another overlap group — so
    // the height ceiling should never have applied in the first place.
    //
    // Concrete reproduction of the reported bug: a 60-real-minute "Piano"
    // block tagged tightGap by an unrelated earlier item ("Warmup" ending
    // right as Piano starts), landing in a 2-lane overlap group with
    // "Email student". Piano's height across the app's real zoom levels:
    //   pxPerMin 0.55 -> 33px   pxPerMin 0.65 -> 39px   pxPerMin 0.8 -> 48px
    //   pxPerMin 1.0  -> 60px   pxPerMin 1.25 -> 75px
    // Against the CORRECTED 44px base two-line floor (see this file's own
    // top comment), 33px and 39px are now genuinely below it — there is no
    // room for two lines regardless of lane exemption — so only the zoom
    // levels that still clear 44px pin the reported bug (each fell under the
    // OLD flat 60px ceiling purely because of an unrelated neighbour in a
    // different lane, before this fix; 48px is now the lowest of the four
    // real Piano heights that still applies once the floor moved).
    it.each([48, 60, 75])(
      'shows the time line for a %ipx tightGap box once it is lane-split (totalLanes=2), at every zoom level that clears the base two-line floor',
      (height) => {
        expect(computeShowTimeLine({ height, isCompact: false, tightGap: true, isResizing: false, totalLanes: 2 })).toBe(true);
      }
    );

    it('a lane-split box below the BASE two-line threshold (not just the ceiling) still hides its time line — totalLanes only waives the tightGap ceiling, not the base height floor', () => {
      expect(computeShowTimeLine({ height: 20, isCompact: false, tightGap: true, isResizing: false, totalLanes: 2 })).toBe(false);
    });

    it('a lane-split 39px Piano height (real zoom pxPerMin=0.65) now correctly hides its time line — it fell under the OLD 36px floor\'s slack but is genuinely below the CORRECTED 44px one', () => {
      expect(computeShowTimeLine({ height: 39, isCompact: false, tightGap: true, isResizing: false, totalLanes: 2 })).toBe(false);
    });

    it('still degrades a genuinely stacked (totalLanes=1), short, tightGap-tagged box — the exemption does not apply to real single-lane crowding', () => {
      // Same 50px/tightGap shape as the "genuine crowding" pinned case
      // above, just explicit about totalLanes=1 (the default) to pin that
      // the new lane-based exemption doesn't accidentally swallow the
      // original, still-valid "two boxes stacked flush in one lane" case.
      expect(computeShowTimeLine({ height: 50, isCompact: false, tightGap: true, isResizing: false, totalLanes: 1 })).toBe(false);
    });

    it('totalLanes defaults to 1 (stacked/single-lane) when omitted, matching the pre-fix single-lane behaviour', () => {
      expect(computeShowTimeLine({ height: 50, isCompact: false, tightGap: true, isResizing: false })).toBe(false);
    });
  });
});

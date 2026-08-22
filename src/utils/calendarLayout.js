/**
 * ============================================================================
 * CALENDAR LAYOUT
 * ============================================================================
 * Pure day-column layout math for WeekView's time-grid rendering: folding
 * short/crowded items into "N tasks" chips, packing genuinely-overlapping
 * items into side-by-side lanes, and turning both into final pixel
 * {top, height} positions. Extracted out of WeekView.jsx (which still owns
 * everything DOM/render/interaction-related) purely so this error-prone
 * gap/duration math can be unit tested directly — see tests/unit/calendarLayout.test.js.
 * ============================================================================
 */

import { SHORT_BLOCK_MAX_MIN } from './calendarGrouping';

// Top of the rendered time grid — the full day, so nothing can ever land
// above it. It used to start at 06:00, which meant an early-morning block or
// event simply rendered off the top of the grid with no way to scroll to it.
// WeekView scrolls to DEFAULT_SCROLL_MIN on mount so the extra pre-dawn hours
// don't just show up as empty space. Needed here only to convert an item's
// start minute into a top-of-grid pixel offset in packLane.
export const GRID_START_MIN = 0;

// Where WeekView parks the grid's scroll position on mount: early enough to
// show a normal morning start, late enough that the overnight hours aren't
// taking up the viewport. Overridden downward when a visible item actually
// starts earlier (see WeekView's initial-scroll effect).
export const DEFAULT_SCROLL_MIN = 6 * 60;

// A run of tiny tasks (e.g. several 5-minute defaults back-to-back) renders
// as unreadable slivers if drawn individually — see foldSequentialItems below.
// (SHORT_BLOCK_MAX_MIN itself lives in calendarGrouping.js, shared with MonthView.)
// Absolute sanity ceiling (real minutes, NOT zoom-scaled) on how far apart two
// too-short-alone blocks can be and still fold together — see
// foldSequentialItems' durationFoldGapMin, which takes the smaller of this and
// the zoom-scaled tightGapMin so raising pxPerMin can still shrink the
// effective gap ceiling below this fixed cap, rather than this cap alone
// forcing a fold regardless of how much pixel room the zoom level offers.
export const CLUSTER_MAX_GAP_MIN = 30;

// Floor height a box needs to show at least one legible line of text: derived
// from .cal-block's own font-size (11.5px) + line-height + vertical padding
// (~4px top, ~4px bottom — see calendar.css), which together need roughly
// 22-24px to avoid clipping into the box border. Rounded up slightly for
// breathing room. This is a judgment call (there's no single "correct" pixel
// value — it depends on font metrics that could themselves change), so it's
// named for what it protects (legibility) rather than an arbitrary duration.
//
// Two different jobs read this same floor:
//   1. packLane: the MINIMUM a `kind: 'cluster'` box is ever drawn at
//      (clusters deliberately summarize 2+ items the caller already decided
//      couldn't render individually — see isLegibleAlone below — so unlike a
//      single item, a cluster is NEVER allowed to render shorter than "one
//      legible line", since there'd be nothing else to fall back to). A
//      single (non-cluster) item's height is its TRUE proportional duration
//      instead — no floor — matching Google Calendar's own continuous,
//      zoom-aware layout: a 5-minute event is a genuinely thin sliver, not
//      stretched to look like a 20-minute one.
//   2. layoutDayItems: the height (not duration) below which an overlapping
//      item is a cluster-candidate — see isLegibleAlone.
export const MIN_BLOCK_HEIGHT_PX = 26;
export const BLOCK_GAP_PX = 2;

// The same floor, recomputed for a DELIBERATELY SMALLER type size. A box in
// this band renders its title at .cal-block.is-compact's reduced font
// (10px/~13.5px line + tighter padding, see calendar.css) rather than folding
// into an anonymous chip — shrinking the text slightly is a much better trade
// than hiding the title behind "3 tasks", and it's only worth doing down to
// the point where the smaller type is still comfortably readable.
//
// Derived the same way MIN_BLOCK_HEIGHT_PX is, from the compact rule's own
// metrics, which is why the two must move together if either type size
// changes. Below THIS, there is no font size left that helps and folding is
// the honest answer.
//
// Every "can this stand on its own?" decision uses this floor, not the
// full-size one: an item that can render compactly does not need to be
// clustered. packLane's minimum height for a `cluster` box deliberately keeps
// using MIN_BLOCK_HEIGHT_PX — a chip is a summary of things that couldn't be
// shown, so it has to be fully legible at normal size.
export const COMPACT_BLOCK_HEIGHT_PX = 20;

// Within an overlap group (see layoutDayItems), an item whose OWN true
// proportional height (at the current zoom) would already clear
// MIN_BLOCK_HEIGHT_PX always gets its own visible side-by-side lane, however
// short its duration is — a 10-minute event at max zoom (1.25px/min = 12.5px)
// is still under this floor and folds, but the same 10 minutes at a lower
// zoom that already renders past MIN_BLOCK_HEIGHT_PX must NOT fold just
// because "10 minutes" sounds short: whether an item can stand on its own is
// a question of pixels, not duration, exactly like everything else in this
// file. This intentionally replaces an earlier fixed-duration cutoff
// (`LONG_ITEM_MIN = 30`, "any overlapping item under 30 real minutes always
// clusters") that ignored zoom entirely and force-merged plenty of
// individually-legible short events — see git history / calendarLayout.test.js
// for the cases this used to wrongly cluster.
// Applies to a whole `kind: 'cluster'` run's own span, not its individual
// blocks — a cluster is already one unit by the time layoutDayItems sees it.
export function isLegibleAlone(durationMin, pxPerMin) {
  return durationMin * pxPerMin >= COMPACT_BLOCK_HEIGHT_PX;
}

// Two individually "legible enough to stand alone" (see isLegibleAlone)
// items can still read as a jumbled mess at a zoomed-out level if they sit
// nearly flush against each other — e.g. two 90-min blocks with only 30 real
// minutes (~16px at the lowest zoom) between them, each rendering a full
// title+time-range at that height. Below TIGHT_GAP_PX of real (natural,
// unclamped) gap, drop straight to a single-line/compact render for BOTH
// neighbouring items even if their own height would otherwise fit two lines
// — see WeekView's itemLiveState `showTimeLine`. Below the smaller
// COLLISION_GAP_PX, even that minimal single-line render would still feel
// like a collision, so as a last resort the pair is folded into the existing
// "N tasks" chip mechanism instead — see foldSequentialItems.
//
// Both are PIXEL thresholds by definition (how close two boxes look on
// screen), but every other cutoff in foldSequentialItems is expressed in real
// minutes so the whole decision scales with pxPerMin in one consistent unit.
export const TIGHT_GAP_PX = 22;
export const COLLISION_GAP_PX = 8;

// An item this long or longer always gets to render as its own box, however
// tight the gap to its neighbour — it has plenty of natural height to fall
// back to a single-line render, so folding it into an anonymous "N events"
// chip would hide a substantial, easily-legible block for no real gain.
export const CHIP_EXEMPT_MIN = 60;

// Widest side-by-side split any overlap group is ever allowed to grow to,
// however individually legible (per isLegibleAlone) each item's own HEIGHT
// is. isLegibleAlone only ever asks "is this box tall enough" — it has no
// concept of the box's WIDTH, which for a lane depends on totalLanes AND the
// day column's own rendered width (itself a function of dayCount, sidebar
// state, and window size — genuinely unknown to this pure module, unlike
// pxPerMin). Left unchecked, 3+ mutually-overlapping legible items in a 7-day
// week view each get squeezed to roughly a third of an already-narrow day
// column: too thin for .cal-block-title's ellipsis to show more than a
// single truncated letter, and too thin for .cal-block-time's un-wrapped
// "HH:MM–HH:MM" to fit on one line, so it wraps across 2-3 lines — the
// result reads as a jumbled/merged mess indistinguishable from a real
// `kind: 'cluster'` chip in a screenshot, even though every item is
// correctly positioned in its own separate, non-overlapping lane. Verified
// against the real rendered DOM: 2 concurrent legible items at typical
// 7-day-view width still render a legible truncated title + single-line time
// (fine); 3 does not (see this constant's own regression test). Once an
// overlap group would need more than this many real lanes, whichever item
// would have needed the first beyond-the-cap lane is folded into the last
// allowed lane's current occupant instead, growing (or starting) a `kind:
// 'cluster'` chip there rather than forcing an ever-thinner lane — see
// layoutDayItems' own packLanesCapped.
export const MAX_SIDE_BY_SIDE_LANES = 2;

/**
 * Fold a day's sequential (non-overlapping-in-time) items into "N tasks"
 * chips using ONE zoom-scaled rule, so the amount of clustering changes
 * monotonically as the user zooms — more room (higher pxPerMin) can only
 * ever mean less clustering, never more. This replaces two earlier passes
 * (clusterShortBlocks + collapseTightPairs) that used different units —
 * one compared an item's real-minute duration to a zoom-scaled cutoff, the
 * other compared the real-minute GAP between items to a fixed pixel
 * threshold — which could disagree about how much room a given zoom level
 * actually offered, producing more chips at higher zoom than lower zoom in
 * some layouts (see git history for the bug this replaced).
 *
 * Everything here is expressed in real minutes, converted from the pixel
 * constants (MIN_BLOCK_HEIGHT_PX, COLLISION_GAP_PX, TIGHT_GAP_PX) via the
 * current pxPerMin, so raising pxPerMin can only shrink every cutoff below:
 *   - minVisibleMin: an item's OWN duration below this renders thinner than
 *     MIN_BLOCK_HEIGHT_PX and is a fold-candidate purely for being too short
 *     to read on its own. Applies to events and blocks alike — see
 *     isTooShortAlone on why the earlier blocks-only rule left short events
 *     rendering as unreadable slivers. Passive blocks are still exempt.
 *   - minGapMin: a real gap to the next item below this looks like an
 *     outright collision at this zoom, so the two items fold into one chip
 *     regardless of either item's own duration (applies to blocks and
 *     events alike — this is about visual crowding, not "is this a tiny
 *     default task").
 *   - tightGapMin: a real gap at or above minGapMin but below this is still
 *     too tight for a full two-line render, so both neighbours are tagged
 *     `tightGap: true` (single-line degrade — see WeekView's itemLiveState)
 *     without folding into a chip.
 * A run of 3+ mutually-close items folds into ONE growing chip rather than
 * a chain of chips flush against each other. Passive tasks and any item
 * whose own duration is >= CHIP_EXEMPT_MIN are never folded into a chip
 * (they may still single-line-degrade under tightGapMin crowding) — they
 * always keep their own tappable box.
 *
 * Operates on generic `{ type: 'block'|'event', data, start, end }` items,
 * already sorted by start. Only ever considers items adjacent by start time
 * — genuinely overlapping-in-time items are a distinct concept (see
 * layoutDayItems' overlap-group/lane split) handled entirely separately,
 * before this function ever runs on a given lane's own sequential items. A
 * negative gapMin (the two items actually overlap in time rather than just
 * sitting close together) is exactly that case, so it's treated as "never
 * fold" here — letting a negative gap trivially satisfy every fold condition
 * below would merge genuinely overlapping items into one chip before
 * layoutDayItems' overlap-group/lane-packing sweep ever runs, which is a
 * distinct bug from the sequential-crowding this function exists to solve.
 */
export function foldSequentialItems(items, pxPerMin) {
  const minVisibleMin = Math.max(SHORT_BLOCK_MAX_MIN, COMPACT_BLOCK_HEIGHT_PX / pxPerMin);
  const minGapMin = COLLISION_GAP_PX / pxPerMin;
  const tightGapMin = TIGHT_GAP_PX / pxPerMin;
  // Ceiling on how far apart two too-short-alone items can be and still fold
  // together (see durationFold below). Scales with zoom via tightGapMin (more
  // room -> a smaller gap already reads as "too tight", so less reach is
  // needed) but never exceeds CLUSTER_MAX_GAP_MIN, which exists purely as an
  // absolute sanity cap so two isolated slivers at opposite ends of the day
  // never merge just because a very zoomed-out view makes tightGapMin huge.
  // Without the min() here, CLUSTER_MAX_GAP_MIN alone would force-fold any
  // too-short-alone pair within a *fixed* 30 real minutes of each other at
  // EVERY zoom level, even once zooming in has opened up enough pixel room
  // (e.g. ~31px at max zoom for a 25-minute gap) to show them separately —
  // contradicting the "more room -> less folding" goal the rest of this
  // function scales for.
  const durationFoldGapMin = Math.min(tightGapMin, CLUSTER_MAX_GAP_MIN);

  // A raw `single`-kind item is a fold candidate purely on its own duration
  // if it's a non-passive block rendering thinner than minVisibleMin at this
  // zoom. A `cluster` (already 2+ items folded together) has no duration-
  // based exemption of its own — it only carries forward whichever items
  // were already inside it; whether it can still absorb another item is
  // decided by the gap check below, same as an exempt single would be.
  // Applies to events as well as blocks. It used to require
  // `type === 'block'`, on the reasoning that "an event's title always
  // deserves its own box regardless of duration" — true in intent, false in
  // effect: measured in the real DOM, three 10-minute events rendered at
  // 10-17px each and never folded, while three equivalent task blocks
  // correctly clustered. A 10-minute event at the lowest zoom is 5.5px, which
  // is not a box with a title in it, it's a line. Whether something can stand
  // on its own is a question of pixels, exactly like every other decision in
  // this file, and it does not depend on which of the two kinds it is.
  // Passive blocks keep their exemption (they're background by nature and
  // always keep a tappable box), and CHIP_EXEMPT_MIN still protects anything
  // with real height — see the 1-hour-events regression test.
  function isTooShortAlone(single) {
    return !single.data.isPassive && single.end - single.start < minVisibleMin;
  }
  function isExempt(entry) {
    return entry.kind === 'single' && entry.end - entry.start >= CHIP_EXEMPT_MIN;
  }

  const out = [];
  for (const raw of items) {
    const single = { kind: 'single', type: raw.type, data: raw.data, start: raw.start, end: raw.end };
    const prev = out[out.length - 1];
    const gapMin = prev ? single.start - prev.end : Infinity;
    // Two items that overlap in time (gapMin < 0) are never sequential-fold
    // candidates — that's layoutDayItems' overlap-group/lane-packing job.
    if (gapMin < 0) {
      out.push(single);
      continue;
    }

    // A "long enough to stand alone" prev/single must never be pulled into a
    // chip by either fold path below — an already-accumulating cluster is
    // exempt from this (it was only ever formed from too-short-alone items,
    // so it still needs to fold), but a plain `single` that comfortably fits
    // its own box at this zoom (e.g. a 45-min task right after a 5-min one,
    // with zero gap between them) is legitimate back-to-back scheduling, not
    // visual crowding — it must render standalone even with zero real gap to
    // its neighbour. Requiring BOTH sides to need it (rather than either) is
    // what keeps the fold decision genuinely about available space: a
    // long-enough item always has its own room to render regardless of what
    // sits next to it, so it should never be forced into a chip just because
    // its neighbour doesn't.
    const prevNeedsFold = prev && (prev.kind === 'cluster' || isTooShortAlone(prev));
    const singleNeedsFold = isTooShortAlone(single);

    // Fold into (or start) a chip if BOTH sides of the pair actually need
    // it — either because they're not individually tall enough to read
    // standalone (duration-based, gapMin <= durationFoldGapMin — otherwise
    // two isolated 5-minute tasks at opposite ends of the day would wrongly
    // merge into one chip spanning the gap between them), or because the
    // real gap between them is smaller than COLLISION_GAP_PX's worth of
    // minutes at this zoom (an outright pixel collision regardless of each
    // item's own duration).
    const durationFold = gapMin <= durationFoldGapMin && prevNeedsFold && singleNeedsFold;
    const collisionFold = gapMin < minGapMin && prevNeedsFold && singleNeedsFold;
    const shouldFold = prev && !isExempt(prev) && !isExempt(single) && (collisionFold || durationFold);

    if (shouldFold) {
      const prevItems = prev.kind === 'cluster' ? prev.items : [{ type: prev.type, data: prev.data }];
      out[out.length - 1] = {
        kind: 'cluster',
        items: [...prevItems, { type: single.type, data: single.data }],
        start: prev.start,
        end: single.end,
      };
      continue;
    }

    if (prev && prev.kind === 'single' && gapMin < tightGapMin) {
      prev.tightGap = true;
      single.tightGap = true;
    }
    out.push(single);
  }
  return out;
}

/**
 * Assign each item in a single day a {lane, totalLanes} pair so items that
 * overlap in time (normally impossible, but passive tasks are allowed to —
 * see allocator.js) render side-by-side instead of stacking on top of each
 * other. Items are grouped into "overlap groups" of mutually-overlapping
 * time ranges first, so a lane count only applies within the group it's
 * needed for — an unrelated item later in the day still gets full width.
 * Sequentially-adjacent items are pre-folded into `kind: 'cluster'` chips
 * (see foldSequentialItems) before lane assignment so a chip occupies one
 * lane like any other item — this is an entirely separate concept from the
 * overlap-group split below (a real time gap between two items means they
 * can never be side-by-side, so folding them never needs a lane decision).
 *
 * `dayItems` is a generic `{ type: 'block'|'event', data, start, end }[]`
 * (blocks and events already merged, see WeekView's dayItemsByDay) — the
 * caller is responsible for computing `start`/`end` via timeToMinutes
 * beforehand.
 *
 * Every item that CAN render as its own legible box does — side-by-side lane
 * assignment (packLanesCapped below) is the default outcome, matching Google
 * Calendar's own "every event gets a proportional column" layout. Only items
 * whose own true proportional height at this zoom would fall under
 * MIN_BLOCK_HEIGHT_PX (see isLegibleAlone) are cluster-candidates: within
 * each overlap group, those too-short items are further split out and
 * re-grouped by mutual overlap *among themselves* (a gap between two short
 * items is only "one group" if a legible-alone item happens to bridge them
 * into the same overlap group — removing it can split them into two
 * time-disjoint short-runs, which must become two separate chips, not one
 * spanning the gap). Each short-run of 2+ collapses into a single `kind:
 * 'cluster'` item (the same tappable chip foldSequentialItems produces — see
 * WeekView's render, which no longer needs to distinguish the two, and whose
 * label lists the contained items' own titles); a short-run of exactly 1
 * stays a normal item — nothing to collapse into. Legible-alone items always
 * keep an individual lane, whether that's alongside something shorter or
 * another legible-alone item — this is what keeps a real event visible in
 * its own box side-by-side with a chip of short items it genuinely overlaps,
 * rather than the two merging together. Legible items and chips are then
 * lane-packed together in one pass (sorted by start), capped at
 * MAX_SIDE_BY_SIDE_LANES real lanes (see packLanesCapped below):
 * isLegibleAlone alone only judges an item's HEIGHT, so 3+ genuinely
 * legible-alone items that all mutually overlap (a real, if less common,
 * shape — e.g. two identically-timed university lecture blocks with a third
 * item bridging both into one overlap group) would otherwise still each get
 * squeezed into an illegibly narrow WIDTH-wise lane in a 7-day week view,
 * reading as a jumbled mess indistinguishable from a real cluster chip even
 * though every item is technically in its own non-overlapping lane — see
 * packLanesCapped's own doc comment and git history for the real report
 * this fixes.
 */
export function layoutDayItems(dayItems, pxPerMin) {
  const items = [...dayItems].sort((a, b) => a.start - b.start || a.end - b.end);
  const folded = foldSequentialItems(items, pxPerMin);

  const results = [];
  let overlapGroup = [];
  let groupEnd = -Infinity;
  let groupId = 0;

  function flushGroup() {
    if (overlapGroup.length === 0) return;

    const legibleItems = overlapGroup.filter((it) => isLegibleAlone(it.end - it.start, pxPerMin));
    const shortItems = overlapGroup.filter((it) => !isLegibleAlone(it.end - it.start, pxPerMin));

    // Re-sweep just the short items (already start-sorted, as a subsequence
    // of `folded`) for their own mutual-overlap runs, independent of any
    // legible-alone item(s) that pulled them into the same overlapGroup.
    const laneItems = [...legibleItems];
    let shortRun = [];
    let shortRunEnd = -Infinity;
    function flushShortRun() {
      if (shortRun.length === 0) return;
      if (shortRun.length === 1) {
        laneItems.push(shortRun[0]);
      } else {
        laneItems.push({
          kind: 'cluster',
          items: shortRun.flatMap((g) => (g.kind === 'cluster' ? g.items : [{ type: g.type, data: g.data }])),
          start: Math.min(...shortRun.map((g) => g.start)),
          end: Math.max(...shortRun.map((g) => g.end)),
        });
      }
      shortRun = [];
    }
    for (const item of shortItems) {
      if (shortRun.length === 0 || item.start < shortRunEnd) {
        shortRun.push(item);
        shortRunEnd = Math.max(shortRunEnd, item.end);
      } else {
        flushShortRun();
        shortRun = [item];
        shortRunEnd = item.end;
      }
    }
    flushShortRun();

    laneItems.sort((a, b) => a.start - b.start);
    packLanesCapped(laneItems);
    overlapGroup = [];
    groupId += 1;
  }

  /**
   * Greedy interval-graph-coloring lane assignment (an item takes the first
   * lane whose last-placed occupant has already ended, else opens a new
   * one), same idea a naive "give every overlapping item its own lane"
   * packer would use — but capped at MAX_SIDE_BY_SIDE_LANES real
   * side-by-side lanes. Uncapped, a peak of 3+ concurrent legible-alone
   * items (each individually tall enough per isLegibleAlone, which only
   * ever checks HEIGHT) still squeezes every lane to an illegibly thin
   * sliver of the day column's WIDTH in a 7-day week view, which
   * isLegibleAlone has no way to see (regression for the real "two same-time
   * lecture events look merged" report — see MAX_SIDE_BY_SIDE_LANES' own doc
   * comment).
   *
   * Whenever the greedy pass would need a genuinely new lane beyond the cap,
   * the item is instead MERGED IN PLACE into whichever item currently
   * occupies the last allowed lane (index MAX_SIDE_BY_SIDE_LANES - 1),
   * turning that lane's occupant into (or growing its existing) `kind:
   * 'cluster'`. This has to happen as ONE pass, not "simulate the cap
   * separately, wrap whatever overflowed in a cluster, then hand the
   * combined list to an uncapped packer" — that two-pass shape looks
   * reasonable but is subtly wrong: the merged cluster's own (possibly
   * wider, min-to-max) span can still fail to fit into any of the other
   * lanes when the uncapped packer re-simulates from scratch, handing it a
   * 3rd lane anyway — a cluster occupies a lane exactly like any single
   * item, so wrapping something in one doesn't by itself make it stop
   * needing a lane. Growing the last lane's occupant in place, right where
   * the overflow is first detected, is what actually keeps the final lane
   * count at the cap: every subsequent item that could only ever have
   * overlapped the ORIGINAL (now-merged) occupant continues to correctly
   * see that lane as busy until the cluster's own (possibly extended) end.
   */
  function packLanesCapped(laneItems) {
    const laneEnds = []; // end minute of the last item/cluster placed in each lane
    // Index into `results` of the most recently placed entry in each lane —
    // NOT the same as "the item currently in that lane" the way laneEnds'
    // parallel array works in the uncapped case: a lane can be reused
    // sequentially by several non-overlapping items over the course of the
    // day (see below), each getting its OWN results entry, so this only
    // ever needs to track the LATEST one — which is exactly the one an
    // overflow needs to merge into, and exactly the one whose totalLanes
    // gets backfilled once this group's own lane count is final.
    const lastResultIndexInLane = [];
    const firstResultIndex = results.length;

    for (const item of laneItems) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) lane = laneEnds.length;

      if (lane >= MAX_SIDE_BY_SIDE_LANES) {
        // No free lane within the cap — fold into the last allowed lane's
        // CURRENT occupant (its most recent results entry) rather than
        // opening a new one. That occupant may already be a cluster from an
        // earlier overflow onto this same lane; either way, always
        // read/write through `.items` (a cluster has no top-level
        // type/data of its own — see packLane's own matching note).
        const capLane = MAX_SIDE_BY_SIDE_LANES - 1;
        const prev = results[lastResultIndexInLane[capLane]];
        const prevItems = prev.kind === 'cluster' ? prev.items : [{ type: prev.type, data: prev.data }];
        const itemItems = item.kind === 'cluster' ? item.items : [{ type: item.type, data: item.data }];
        const merged = {
          ...prev,
          kind: 'cluster',
          items: [...prevItems, ...itemItems],
          start: Math.min(prev.start, item.start),
          end: Math.max(prev.end, item.end),
        };
        results[lastResultIndexInLane[capLane]] = merged;
        laneEnds[capLane] = merged.end;
        continue;
      }

      laneEnds[lane] = item.end;
      lastResultIndexInLane[lane] = results.length;
      results.push({ ...item, lane, groupId });
    }

    const totalLanes = laneEnds.length;
    for (let i = firstResultIndex; i < results.length; i++) results[i].totalLanes = totalLanes;
  }

  for (const item of folded) {
    if (overlapGroup.length === 0 || item.start < groupEnd) {
      overlapGroup.push(item);
      groupEnd = Math.max(groupEnd, item.end);
    } else {
      flushGroup();
      overlapGroup = [item];
      groupEnd = item.end;
    }
  }
  flushGroup();

  return results;
}

// Maximum GENUINE pushdown (in pixels) a single item is allowed to inherit
// from its predecessor(s) in the same lane before it's folded into a chip
// instead of stacked — see packLane. This is a NEAR-ZERO tolerance, not a
// "how much crowding is acceptable" budget: any pushdown beyond a couple of
// pixels of rounding slack means the box no longer sits at its own honest
// position, so it folds rather than silently drift. Several earlier, more
// permissive versions of this check (a flat pixel budget, a real-minute
// budget, a fraction of the hour-row height — see git history) each
// independently turned out to still tolerate real, user-visible
// misalignment at some zoom level or item shape, because "how much drift is
// tolerable" is inherently an unstable question to tune — different zoom
// levels and item durations keep finding the edge of whatever budget was
// chosen. A near-zero tolerance sidesteps that entirely: there is nothing
// left to tune, and the rule is simple to reason about — an item either sits
// at its own real position (give or take rounding) or it's folded into a
// chip that's honest about spanning multiple items.
//
// "GENUINE" is doing real work in that first sentence — see packLane's own
// doc comment for why this must be measured against a running cosmetic
// BLOCK_GAP_PX baseline rather than a flat zero, and git history (the
// "N tasks" cluster regression for 3+ back-to-back full-hour blocks/events)
// for the bug that shipped when it wasn't.
export const EXCESSIVE_PUSHDOWN_PX = 2;

/**
 * Assign a final {top, height} in px to every item in a lane, guaranteeing
 * zero overlap no matter how many short items are packed back-to-back.
 * Each box's top is clamped to at least the *actual rendered* bottom of the
 * previous box in its lane (not just the next item's natural start time),
 * so a chain of short blocks/clusters pushes each subsequent box down as
 * far as needed — mirroring how Google Calendar visually stretches a dense
 * run of short meetings rather than letting their boxes collide.
 *
 * Before that pushdown logic even runs, a too-short single item (own natural
 * height under MIN_BLOCK_HEIGHT_PX) first gets a chance to grow into any
 * genuinely idle space below it in the same lane — capped by the NEXT item's
 * own natural top, so it only ever borrows real empty space, never reaches
 * into a neighbour. This is what fixes the "5-minute sliver sitting above a
 * big empty gap" look while everything after it (pushdown/fold) still works
 * exactly the same off the resulting (possibly grown) naturalHeight — growing
 * is a strictly separate, earlier step. The box's bottom no longer landing
 * exactly on its true end time is an accepted tradeoff here.
 *
 * That pushdown has no upper bound by itself though: if enough predecessors
 * in a lane were stretched (each pushdown adding to the last), the
 * accumulated push can shove a later, perfectly real-length item's box down
 * far enough that it visually overflows past its own true end time on the
 * hour axis (e.g. a task truly ending at 10:00 rendering well into the 11:00
 * slot) — a worse lie than the harmless few-px stretch this mechanism is
 * meant to produce. Critically, this is NOT caught by checking the pushed
 * TOP alone against the item's own natural end (an earlier version of this
 * check did just that): a chain of several small pushdowns can each
 * individually leave the TOP well before the item's own end, while their sum
 * still drags the BOTTOM (top + height) past it — the top-only check misses
 * exactly the multi-predecessor chain that causes the worst overflow. So
 * before accepting a pushed position, check how far the pushdown itself
 * (pushedTop - naturalTop, in pixels) exceeds a threshold based on
 * EXCESSIVE_PUSHDOWN_PX (see its own doc comment for why that's a near-zero
 * tolerance rather than a tunable budget). If it does, don't render the pair
 * stacked at all — fold the pushed-down item into the previous box as a
 * `kind: 'cluster'` chip instead (same shape foldSequentialItems/
 * layoutDayItems already produce), sized to its own honest natural span
 * rather than a further-pushed one. The merged cluster then becomes the new
 * "previous" item, so a third item that would also collide with it goes
 * through the same check and can keep growing the same chip — mirroring
 * foldSequentialItems' own "chain into one growing chip" behaviour for 3+
 * mutually-close items.
 *
 * That threshold is NOT simply EXCESSIVE_PUSHDOWN_PX in isolation, though —
 * see the `requiresStrictCheck`/`chainBaseline` logic below. BLOCK_GAP_PX is
 * unconditionally added after every placed item (see prevBottom), which is
 * correct and deliberate for genuine visual separation, but means a run of
 * items that are exactly flush in real time (zero actual gap, e.g. 9-10,
 * 10-11, 11-12) inherits another full BLOCK_GAP_PX of "pushdown" at EVERY
 * step even though nothing is actually crowded — after only 2 such steps
 * that alone already exceeds a flat EXCESSIVE_PUSHDOWN_PX(2px) check,
 * incorrectly folding the 3rd perfectly legible item into the 2nd's box
 * (real regression: three back-to-back full-hour blocks/events randomly
 * clustering). The fix distinguishes GENUINE crowding — an item (or its
 * predecessor) was actually stretched past its own true duration by the
 * grow-into-idle-space step above, a predecessor is already a `cluster`
 * (always deliberately floored), or there's a real negative time gap
 * (an actual overlap) — from the merely-cosmetic, unboundedly-chainable
 * BLOCK_GAP_PX baseline every flush run accumulates by design. Only genuine
 * crowding is held to the near-zero EXCESSIVE_PUSHDOWN_PX tolerance; a run
 * with none of it may keep accumulating pushdown baseline indefinitely
 * (still checked against EXCESSIVE_PUSHDOWN_PX worth of tolerance ON TOP of
 * that running baseline, so a genuinely unexplained jump is still caught).
 */
export function packLane(items, pxPerMin) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const out = [];
  let prevBottom = -Infinity;
  // Running total of pushdown so far that's fully explained by legitimate,
  // purely-cosmetic BLOCK_GAP_PX chaining (see this function's own doc
  // comment) — reset to 0 whenever a fold happens or the chain breaks.
  // Carried forward so an arbitrarily long run of genuinely flush, never-
  // stretched items can keep chaining without ever looking "excessive".
  let chainBaseline = 0;
  // Whether the most recently placed item was itself GENUINELY crowded
  // (stretched past its own true duration, or a cluster) rather than merely
  // carrying forward cosmetic chain baseline — a genuinely crowded
  // predecessor means the NEXT item's own pushdown must be held to the
  // strict near-zero tolerance too, since its baseline is no longer purely
  // cosmetic.
  let prevGenuinelyCrowded = false;

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const naturalTop = (item.start - GRID_START_MIN) * pxPerMin;
    const trueHeight = (item.end - item.start) * pxPerMin;
    // Only a `kind: 'cluster'` box is floored to MIN_BLOCK_HEIGHT_PX — it's
    // already a stand-in for 2+ items layoutDayItems/foldSequentialItems
    // decided couldn't render individually, so it must stay legible. A plain
    // single item renders at its TRUE proportional height, however short —
    // no floor — matching Google Calendar's own continuous, zoom-aware
    // layout rather than artificially stretching short (but individually
    // legible-enough-to-be-here-at-all) events. This is what keeps pushdown
    // (below) a genuinely rare event now: two real back-to-back items with
    // zero gap naturally sit flush with no floor-induced false collision.
    let naturalHeight = item.kind === 'cluster' ? Math.max(MIN_BLOCK_HEIGHT_PX, trueHeight) : trueHeight;

    // A too-short single item that has genuinely free room below it (the
    // next lane-mate's natural top is well past this item's own natural
    // bottom) may borrow some of that idle space to reach MIN_BLOCK_HEIGHT_PX
    // instead of rendering as an illegible sliver with empty space sitting
    // right below it — e.g. a 5-minute task followed 40 minutes later by the
    // next item. This never reaches INTO another item (capped by the next
    // item's own natural top, so it can still be pushed down if needed
    // afterward) and never applies to a cluster (already floored above). The
    // bottom no longer landing exactly on the true end time is an accepted
    // tradeoff here — see this function's own doc comment.
    if (item.kind !== 'cluster' && naturalHeight < MIN_BLOCK_HEIGHT_PX) {
      const nextNaturalTop = i + 1 < sorted.length ? (sorted[i + 1].start - GRID_START_MIN) * pxPerMin : Infinity;
      // Leave BLOCK_GAP_PX of the available room untouched so growing into it
      // still lands comfortably under EXCESSIVE_PUSHDOWN_PX against the next
      // item's own natural top — otherwise this growth step could itself
      // trigger the fold-into-cluster path below for a pair that actually had
      // (barely) enough real breathing room to stay separate.
      const availableBelow = nextNaturalTop - naturalTop - BLOCK_GAP_PX;
      naturalHeight = Math.min(MIN_BLOCK_HEIGHT_PX, Math.max(naturalHeight, availableBelow));
    }

    const pushedTop = Math.max(naturalTop, prevBottom);
    const pushdownPx = pushedTop - naturalTop;

    const prevPacked = out[out.length - 1];

    // GENUINE crowding for this item: it was itself stretched past its own
    // true duration by the grow-into-idle-space step above; OR it couldn't
    // stand on its own even at its true (unstretched) duration in the first
    // place (per isLegibleAlone — the same "is this box tall enough to be
    // trusted alone" test the rest of this file already uses); OR it's a
    // `kind: 'cluster'` (always deliberately floored, per this function's
    // own doc comment); OR the real time gap to its predecessor is negative
    // (an actual overlap, not mere back-to-back adjacency). That middle
    // condition matters because an ILLEGIBLE item accepted via the loose
    // (chain-tolerant) path below can still accumulate a large baseline of
    // its own — one that's fine while the chain stays all-illegible, but
    // becomes a problem the moment a later genuinely-crowded item folds
    // INTO it, since the merge inherits whatever position the predecessor
    // already had (see the merge branch's own doc comment on why it can
    // never render earlier than prevPacked.top). Gating on isLegibleAlone
    // keeps the generous, unbounded-chain treatment restricted to items that
    // could legitimately anchor a merge without smuggling in stale drift —
    // exactly the items real usage would hand packLane as un-folded singles
    // in the first place (see layoutDayItems' own legible/short split).
    //
    // Combined with prevGenuinelyCrowded (whether the PREDECESSOR was itself
    // genuinely crowded, which would make ITS position untrustworthy as a
    // baseline too), this decides whether the near-zero EXCESSIVE_PUSHDOWN_PX
    // tolerance applies as-is, or on top of the legitimately-accumulated
    // cosmetic chainBaseline — see the doc comment above packLane for why
    // these are different.
    const naturalGapToPrev = prevPacked ? item.start - prevPacked.end : Infinity;
    const itemGenuinelyCrowded =
      item.kind === 'cluster' || naturalHeight > trueHeight + 0.01 || !isLegibleAlone(item.end - item.start, pxPerMin);
    const requiresStrictCheck = prevGenuinelyCrowded || itemGenuinelyCrowded || naturalGapToPrev < 0;
    const excessiveThreshold = requiresStrictCheck ? EXCESSIVE_PUSHDOWN_PX : chainBaseline + EXCESSIVE_PUSHDOWN_PX;

    if (prevPacked && pushdownPx > excessiveThreshold) {
      // Fold into (or grow) a cluster instead of accepting a position that
      // would misrepresent this item's real end time. The cluster's own
      // box uses ITS natural span (min start, max end across every merged
      // item), not the rejected pushed-down position.
      //
      // EITHER side of the merge may already be a `kind: 'cluster'` itself —
      // prevPacked can be a cluster this same loop already grew (see below),
      // and `item` can independently arrive as a cluster straight out of
      // layoutDayItems' own short-run folding (see flushShortRun) or
      // foldSequentialItems. A cluster has no top-level `type`/`data` of its
      // own (only `.items`), so reading `item.type`/`item.data` directly
      // when `item` is itself a cluster silently produces a `{}` placeholder
      // and drops every task inside it — always read through `.items` on
      // whichever side is a cluster.
      const prevItems = prevPacked.kind === 'cluster' ? prevPacked.items : [{ type: prevPacked.type, data: prevPacked.data }];
      const itemItems = item.kind === 'cluster' ? item.items : [{ type: item.type, data: item.data }];
      const mergedStart = Math.min(prevPacked.start, item.start);
      const mergedEnd = Math.max(prevPacked.end, item.end);
      // prevPacked's own placed `top` may already sit below its natural top
      // (it was itself accepted as a within-budget pushdown against
      // whatever came before it in the lane) — the merged cluster must
      // never render EARLIER than that already-validated position, or it
      // would reopen the exact overlap-with-an-earlier-item problem
      // prevPacked's own placement was computed to avoid.
      const mergedTop = Math.max(prevPacked.top, Math.round((mergedStart - GRID_START_MIN) * pxPerMin));
      const mergedHeight = Math.round(Math.max(MIN_BLOCK_HEIGHT_PX, (mergedEnd - mergedStart) * pxPerMin));
      const cluster = {
        ...prevPacked,
        kind: 'cluster',
        items: [...prevItems, ...itemItems],
        start: mergedStart,
        end: mergedEnd,
        top: mergedTop,
        height: mergedHeight,
      };
      out[out.length - 1] = cluster;
      prevBottom = cluster.top + cluster.height + BLOCK_GAP_PX;
      // The merged box is a cluster — always genuinely crowded going
      // forward (see itemGenuinelyCrowded above), and its own baseline is
      // fresh (it was just validated against the strict tolerance, not
      // inherited from further back).
      chainBaseline = 0;
      prevGenuinelyCrowded = true;
      continue;
    }

    // Round to whole pixels so block edges land on the same pixel grid as
    // the hour lines (painted at integer --hour-height multiples) — left
    // unrounded, sub-hour offsets go fractional at non-default zoom levels
    // (e.g. 0.55 px/min -> 8.25px per 15min) and drift out of alignment.
    const top = Math.round(pushedTop);
    const height = Math.round(naturalHeight);
    prevBottom = top + height + BLOCK_GAP_PX;
    // How far AHEAD of this item's own true natural end prevBottom now sits
    // — always at least BLOCK_GAP_PX (added unconditionally above, even for
    // a first/unpushed item), plus this item's own top/height rounding
    // noise. This, not pushdownPx itself, is what the NEXT item inherits as
    // its baseline: pushdownPx is 0 for a first item with no predecessor,
    // but prevBottom for the item AFTER it still starts one BLOCK_GAP_PX
    // ahead regardless — using pushdownPx here would under-count that and
    // let a 2-item rounding-noise case slip past the strict tolerance.
    chainBaseline = prevBottom - (naturalTop + naturalHeight);
    prevGenuinelyCrowded = itemGenuinelyCrowded;
    out.push({ ...item, top, height });
  }

  return out;
}

/**
 * Runs packLane independently within each (overlap group, lane) pair so
 * side-by-side (genuinely overlapping-in-time) items don't interfere with
 * each other's stacking. Two DIFFERENT (groupId, lane) buckets can still sit
 * directly adjacent on screen though (e.g. a 5-min item ending exactly when
 * the next item starts lands each in its own overlap group, since they never
 * overlap in time — see layoutDayItems) — a naive per-bucket-only pass would
 * give the second bucket a fresh, unconstrained prevBottom, so nothing stops
 * the first bucket's MIN_BLOCK_HEIGHT_PX-clamped box (stretched taller than
 * its natural time slot) from visually overlapping the very next item's box.
 * So this still buckets by (groupId, lane) to decide which items are lane-
 * mates, but packs each lane INDEX in start-time order across the whole day,
 * carrying prevBottom from one bucket into the next only when they're
 * actually going to render back-to-back — see packLane's own doc comment for
 * why this doesn't reintroduce the earlier chain-stacking-across-unrelated-
 * groups bug (see git history) that (groupId, lane) bucketing was
 * introduced to fix.
 */
export function computeDayPositions(items, pxPerMin) {
  const byGroupLane = new Map();
  for (const item of items) {
    const key = `${item.groupId}:${item.lane}`;
    if (!byGroupLane.has(key)) byGroupLane.set(key, []);
    byGroupLane.get(key).push(item);
  }

  // Re-bucket by raw lane index so packLane can see every item that will
  // ever render in that lane column, across every overlap group, in one
  // continuous start-time-ordered pass.
  const byLane = new Map();
  for (const [key, laneItems] of byGroupLane) {
    const lane = Number(key.split(':')[1]);
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(...laneItems);
  }
  const out = [];
  for (const laneItems of byLane.values()) out.push(...packLane(laneItems, pxPerMin));
  return out;
}

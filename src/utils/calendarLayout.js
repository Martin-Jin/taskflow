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

// Top of the rendered time grid (06:00) — mirrors WeekView's own
// GRID_START_MIN (the source of truth for the grid's visible range), needed
// here only to convert an item's start minute into a top-of-grid pixel offset
// in packLane.
export const GRID_START_MIN = 6 * 60;

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

// Within an overlap group (see layoutDayItems), an item this long or longer
// always gets its own visible side-by-side lane, even if it overlaps
// something shorter. Items below this duration are candidates to fold into
// an "N events" chip alongside other short items they actually overlap.
// Applies to a whole `kind: 'cluster'` run's own span, not its individual
// blocks — a cluster is already one unit by the time layoutDayItems sees it.
export const LONG_ITEM_MIN = 30;

// Floor height for any single block/cluster, and the breathing room left
// between two boxes stacked back-to-back in the same lane — see packLane.
export const MIN_BLOCK_HEIGHT_PX = 26;
export const BLOCK_GAP_PX = 2;

// Two individually "long enough" (non-cluster-eligible, see LONG_ITEM_MIN)
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
 *     to read on its own (only ever applies to blocks — an event's title
 *     always deserves its own box regardless of duration, so events are
 *     never fold-candidates on this basis alone).
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
  const minVisibleMin = Math.max(SHORT_BLOCK_MAX_MIN, MIN_BLOCK_HEIGHT_PX / pxPerMin);
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
  function isTooShortAlone(single) {
    return single.type === 'block' && !single.data.isPassive && single.end - single.start < minVisibleMin;
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
 * Side-by-side lanes get thin on both mobile and (to a lesser extent)
 * desktop once 3+ items overlap, so within each overlap group, items whose
 * OWN duration is under LONG_ITEM_MIN are further split out and re-grouped
 * by mutual overlap *among themselves* (a gap between two short items is
 * only "one group" if a long item happens to bridge them into the same
 * overlap group — removing the long item can split them into two
 * time-disjoint short-runs, which must become two separate chips, not one
 * spanning the gap). Each short-run of 2+ collapses into a single `kind:
 * 'cluster'` item (the same tappable "N tasks/events" chip foldSequentialItems
 * produces — see WeekView's render, which no longer needs to distinguish the
 * two); a short-run of exactly 1 stays a normal item — nothing to collapse
 * into. Items >= LONG_ITEM_MIN always keep an individual lane, whether that's
 * alongside something shorter or another long item — this is what keeps a
 * long block visible in its own box side-by-side with a chip of short items
 * it genuinely overlaps, rather than the two merging together. Long items and
 * chips are then lane-packed together in one pass (sorted by start) so a chip
 * that overlaps a long item in time still gets a distinct lane rather than
 * visually colliding with it.
 */
export function layoutDayItems(dayItems, pxPerMin) {
  const items = [...dayItems].sort((a, b) => a.start - b.start || a.end - b.end);
  const folded = foldSequentialItems(items, pxPerMin);

  const results = [];
  let overlapGroup = [];
  let groupEnd = -Infinity;
  let groupId = 0;

  function packLanes(laneItems) {
    const laneEnds = []; // end minute of the last item placed in each lane
    for (const item of laneItems) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      // `lane` is only unique within this overlap group — two unrelated,
      // non-overlapping-in-time groups can both produce a "lane 0". Tag with
      // groupId too so computeDayPositions doesn't chain-stack them together.
      results.push({ ...item, lane, groupId });
    }
    const totalLanes = laneEnds.length;
    for (let i = results.length - laneItems.length; i < results.length; i++) results[i].totalLanes = totalLanes;
  }

  function flushGroup() {
    if (overlapGroup.length === 0) return;

    const longItems = overlapGroup.filter((it) => it.end - it.start >= LONG_ITEM_MIN);
    const shortItems = overlapGroup.filter((it) => it.end - it.start < LONG_ITEM_MIN);

    // Re-sweep just the short items (already start-sorted, as a subsequence
    // of `folded`) for their own mutual-overlap runs, independent of any
    // long item(s) that pulled them into the same overlapGroup.
    const laneItems = [...longItems];
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
    packLanes(laneItems);
    overlapGroup = [];
    groupId += 1;
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

// A pushed-down item's box TOP is never allowed to cross past the item's own
// natural END position on the axis — this is a hard geometric limit, not a
// tunable tolerance. Below this line, some pushdown is always fine no matter
// how large in isolation: as long as the box's top still lands somewhere
// within the item's own real time span, it still visually reads as "this
// box belongs to this time slot," even if crowded. The moment a pushed top
// would land AFTER the item's own true end time, though, the box's start
// itself would render later than when the task is even scheduled to
// finish — an unambiguous misalignment at any zoom level, not a matter of
// degree, so there's nothing to tune here (unlike a "how many minutes of
// drift is tolerable" budget, which by definition has to keep being
// re-justified against whatever zoom level breaks it next). See packLane for
// where this is enforced.

/**
 * Assign a final {top, height} in px to every item in a lane, guaranteeing
 * zero overlap no matter how many short items are packed back-to-back.
 * Each box's top is clamped to at least the *actual rendered* bottom of the
 * previous box in its lane (not just the next item's natural start time),
 * so a chain of short blocks/clusters pushes each subsequent box down as
 * far as needed — mirroring how Google Calendar visually stretches a dense
 * run of short meetings rather than letting their boxes collide.
 *
 * That pushdown has no upper bound by itself though: if enough predecessors
 * in a lane were stretched (or one was stretched a lot), the accumulated
 * push can shove a later, perfectly real-length item's box down far enough
 * that it visually overflows past its own true end time on the hour axis
 * (e.g. a task truly ending at 10:00 rendering into the 11:00 slot) — a
 * worse lie than the harmless few-px stretch this mechanism is meant to
 * produce. So before accepting a pushed position, check whether the pushed
 * TOP would land past the item's own natural END position on the axis — a
 * hard, zoom-independent line (see the comment directly above this function
 * for why this is a fixed geometric limit rather than a tunable budget). If
 * it would, don't render the pair stacked at all — fold the pushed-down item
 * into the previous box as a `kind: 'cluster'` chip instead (same shape
 * foldSequentialItems/layoutDayItems already produce), sized to its own
 * honest natural span rather than a further-pushed one. The merged cluster
 * then becomes the new "previous" item, so a third item that would also
 * collide with it goes through the same check and can keep growing the same
 * chip — mirroring foldSequentialItems' own "chain into one growing chip"
 * behaviour for 3+ mutually-close items.
 */
export function packLane(items, pxPerMin) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const out = [];
  let prevBottom = -Infinity;

  for (const item of sorted) {
    const naturalTop = (item.start - GRID_START_MIN) * pxPerMin;
    const naturalEnd = (item.end - GRID_START_MIN) * pxPerMin;
    const naturalHeight = Math.max(MIN_BLOCK_HEIGHT_PX, (item.end - item.start) * pxPerMin);
    const pushedTop = Math.max(naturalTop, prevBottom);

    const prevPacked = out[out.length - 1];
    if (prevPacked && pushedTop > naturalEnd) {
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
      continue;
    }

    // Round to whole pixels so block edges land on the same pixel grid as
    // the hour lines (painted at integer --hour-height multiples) — left
    // unrounded, sub-hour offsets go fractional at non-default zoom levels
    // (e.g. 0.55 px/min -> 8.25px per 15min) and drift out of alignment.
    const top = Math.round(pushedTop);
    const height = Math.round(naturalHeight);
    prevBottom = top + height + BLOCK_GAP_PX;
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

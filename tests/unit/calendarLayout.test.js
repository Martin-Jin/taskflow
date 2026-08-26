import { describe, it, expect } from 'vitest';
import {
  foldSequentialItems,
  layoutDayItems,
  computeDayPositions,
  packLane,
  isLegibleAlone,
  isLaneWidthTooNarrowForTitle,
  foldNarrowIllegibleTitles,
  MIN_BLOCK_HEIGHT_PX,
  GRID_START_MIN,
  EXCESSIVE_PUSHDOWN_PX,
  MAX_SIDE_BY_SIDE_LANES,
  TWO_LINE_MIN_HEIGHT_PX,
} from '../../src/utils/calendarLayout';

// Helper to build a generic block item ({ type, data, start, end }) with
// minimal fields — the layout logic only reads type/data.isPassive/start/end.
function block(id, start, end, extra = {}) {
  return { type: 'block', data: { id, title: id, isPassive: false, ...extra }, start, end };
}

function event(id, start, end) {
  return { type: 'event', data: { id, title: id }, start, end };
}

describe('foldSequentialItems', () => {
  it('never folds two items that overlap in time (gapMin < 0)', () => {
    // Regression test for the "Email student"/"Lower + Running" visual-overlap
    // bug: two 30+ minute items overlapping in time must NOT be merged into a
    // single cluster — that would skip layoutDayItems' lane-separation
    // entirely and let them render on top of each other. A negative gap (they
    // overlap) used to trivially satisfy every fold condition.
    const items = [block('A', 540, 575), block('B', 550, 585)]; // 9:00-9:35, 9:10-9:45
    const folded = foldSequentialItems(items, 1.25);
    expect(folded).toHaveLength(2);
    expect(folded.every((f) => f.kind === 'single')).toBe(true);
  });

  it('still folds two short, non-overlapping, closely-spaced items into a cluster', () => {
    const items = [block('A', 540, 545), block('B', 550, 555)]; // 5-min gap
    const folded = foldSequentialItems(items, 1.25);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).toBe('cluster');
    expect(folded[0].items).toHaveLength(2);
  });

  it('un-folds a pair of short items as zoom increases once there is enough pixel room', () => {
    // Two 5-min blocks 25 real minutes apart. CLUSTER_MAX_GAP_MIN (30) alone
    // would force-fold this at every zoom level; the fix caps the duration-fold
    // reach at min(tightGapMin, CLUSTER_MAX_GAP_MIN), which shrinks below 25
    // once pxPerMin is high enough (tightGapMin = 22/pxPerMin).
    const items = [block('A', 540, 545), block('B', 565, 570)]; // 25-min gap
    const foldedZoomedOut = foldSequentialItems(items, 0.55); // tightGapMin ~40 -> still folds
    const foldedZoomedIn = foldSequentialItems(items, 1.25); // tightGapMin ~17.6 -> should NOT fold
    expect(foldedZoomedOut).toHaveLength(1);
    expect(foldedZoomedOut[0].kind).toBe('cluster');
    expect(foldedZoomedIn).toHaveLength(2);
    expect(foldedZoomedIn.every((f) => f.kind === 'single')).toBe(true);
  });

  it('folding amount only shrinks (or stays the same) as pxPerMin increases, never grows', () => {
    // Monotonic zoom-in property the whole fold mechanism is built around.
    const items = [
      block('A', 540, 545),
      block('B', 552, 557),
      block('C', 564, 569),
      block('D', 800, 900), // long, unrelated, later in the day
    ];
    const zoomLevels = [0.55, 0.65, 0.8, 1.0, 1.25];
    let prevClusterCount = Infinity;
    for (const pxPerMin of zoomLevels) {
      const folded = foldSequentialItems(items, pxPerMin);
      const clusterCount = folded.filter((f) => f.kind === 'cluster').reduce((sum, c) => sum + c.items.length, 0);
      expect(clusterCount).toBeLessThanOrEqual(prevClusterCount);
      prevClusterCount = clusterCount;
    }
  });

  it('never folds an item at or above CHIP_EXEMPT_MIN duration', () => {
    const items = [block('A', 540, 545), block('B', 550, 610)]; // B is 60 min, chip-exempt
    const folded = foldSequentialItems(items, 0.55); // zoomed out, would otherwise fold
    expect(folded).toHaveLength(2);
  });

  it('does not swallow a long-enough item into a chip just because it directly follows a short one', () => {
    // Regression for the "Morning tasks (5min) + Piano (45min)" bug: Piano is
    // well above minVisibleMin at any zoom and should render standalone, not
    // get folded into "Morning tasks"'s chip just because the gap is 0 and
    // Morning tasks alone is too-short-alone.
    // Piano's own 45-min duration is only "enough room to stand alone"
    // (>= MIN_BLOCK_HEIGHT_PX / pxPerMin) once zoomed in enough — at the very
    // lowest zoom (0.55) even 45 real minutes doesn't reach MIN_BLOCK_HEIGHT_PX
    // worth of pixels, so it's correctly still fold-eligible there. From 0.8
    // upward it comfortably has its own room and must never fold, regardless
    // of "Morning tasks" being short and directly adjacent.
    const items = [block('Morning tasks', 480, 485), block('Piano', 485, 530)]; // 08:00-08:05, 08:05-08:50
    for (const pxPerMin of [0.8, 1.0, 1.25]) {
      const folded = foldSequentialItems(items, pxPerMin);
      expect(folded).toHaveLength(2);
      expect(folded.every((f) => f.kind === 'single')).toBe(true);
    }
  });

  it('still folds a short item into a short item even when back-to-back with zero gap', () => {
    const items = [block('A', 480, 485), block('B', 485, 490)]; // both 5-min, zero gap
    const folded = foldSequentialItems(items, 1.25);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).toBe('cluster');
  });

  it('does not drag an already-long-enough prev into a chip when a short item follows it', () => {
    const items = [block('Long', 480, 525), block('Short', 525, 530)]; // 45-min then 5-min, zero gap
    const folded = foldSequentialItems(items, 1.25);
    // The short item alone is still too-short-alone, so it may end up
    // tightGap-tagged or standalone, but it must never pull "Long" into a
    // cluster with it.
    expect(folded.some((f) => f.kind === 'cluster' && f.items?.some((it) => it.data.id === 'Long'))).toBe(false);
  });

  it('never treats a passive block as too-short-alone', () => {
    const items = [block('A', 540, 545, { isPassive: true }), block('B', 600, 605, { isPassive: true })];
    const folded = foldSequentialItems(items, 1.25);
    expect(folded).toHaveLength(2);
  });
});

describe('isLegibleAlone', () => {
  it('is true once an item’s own proportional height at this zoom reaches MIN_BLOCK_HEIGHT_PX', () => {
    // 25 minutes * 1.25px/min = 31.25px, comfortably over the 26px floor.
    expect(isLegibleAlone(25, 1.25)).toBe(true);
    // 10 minutes * 1.25px/min = 12.5px, well under the floor.
    expect(isLegibleAlone(10, 1.25)).toBe(false);
  });

  it('scales with zoom — the same duration can be legible at one zoom and not another', () => {
    // 30 real minutes: at 0.55px/min that's 16.5px (illegible alone); at
    // 1.25px/min that's 37.5px (comfortably legible). This is the entire
    // point of replacing a fixed-duration cutoff (the old LONG_ITEM_MIN=30)
    // with a pixel-based one — "is this event long enough to stand alone" is
    // a question of pixels at the current zoom, not a fixed minute count.
    expect(isLegibleAlone(30, 0.55)).toBe(false);
    expect(isLegibleAlone(30, 1.25)).toBe(true);
  });
});

describe('isLaneWidthTooNarrowForTitle', () => {
  it('is always false at 1 lane (full width), however long the title is', () => {
    expect(isLaneWidthTooNarrowForTitle('A very long task title that goes on and on', 1)).toBe(false);
  });

  it('is false for every title from the "must stay side-by-side" pinned lane-packing tests below, at 2 lanes', () => {
    // These are the exact titles used in the pinned tests asserting 2
    // legible-alone items must keep separate real lanes (see
    // "assigns two overlapping legible-alone items..." and "gives two
    // overlapping legible events..." below) — this check must never flag
    // any of them, or WeekView's downstream fold pass (foldNarrowIllegibleTitles)
    // would fold a pair that calendarLayout.js correctly decided should stay
    // side-by-side, reintroducing the "events with plenty of space folded
    // anyway" regression the user explicitly flagged.
    const mustStaySideBySideTitles = ['Email student', 'Lower + Running', 'Standup', 'Review', 'Sync', 'MECHENG 211', 'MECHENG 222', 'Piano', 'Test prep'];
    for (const title of mustStaySideBySideTitles) {
      expect(isLaneWidthTooNarrowForTitle(title, 2)).toBe(false);
    }
  });

  it('is true for a long real-world title at 2 lanes — the reported bug', () => {
    // Recreates the actual reported shape: a long task title ("Test 1 -
    // Physics assignment") sharing a 2-lane overlap group with a short one
    // ("Piano"). The long title alone is what should trip this check.
    expect(isLaneWidthTooNarrowForTitle('Test 1 - Physics assignment', 2)).toBe(true);
    expect(isLaneWidthTooNarrowForTitle('Piano', 2)).toBe(false);
  });

  it('gets stricter as lane count grows (smaller per-lane share)', () => {
    // Fits comfortably at 2 lanes (half width) but no longer at 4 (quarter
    // width) — the per-lane character budget shrinks as more lanes split the
    // same day column, so the same title can flip from fine to too-narrow
    // purely from more concurrent items, without changing its own length.
    const title = 'Team sync meeting';
    expect(isLaneWidthTooNarrowForTitle(title, 2)).toBe(false);
    expect(isLaneWidthTooNarrowForTitle(title, 4)).toBe(true);
  });
});

describe('foldNarrowIllegibleTitles', () => {
  // getTitle helper: reads a plain `title` field directly, since these tests
  // don't need WeekView's block-vs-task lookup — that indirection is
  // WeekView.jsx's own concern (see its thin wrapper), not this function's.
  const byTitle = (it) => it.data.title;

  it('folds the real reported bug: a long title sharing a 2-lane overlap group with a short one', () => {
    // Recreates the exact reported shape from the user's screenshot: "Test 1
    // - Physics assignment" 18:05-19:45 (100 min) overlapping "Piano"
    // 19:15-20:15 (60 min) by 30 minutes. Both are individually legible-alone
    // (well above MIN_BLOCK_HEIGHT_PX even at the lowest zoom) and there are
    // only 2 concurrent items, so layoutDayItems correctly gives both a real
    // side-by-side lane — the bug is that lane is only 50% of the day
    // column's width, which truncates the long title to 1-2 characters. This
    // must fold into a single cluster chip instead.
    const pxPerMin = 1.25;
    const items = [
      { type: 'block', data: { id: 'test1', title: 'Test 1 - Physics assignment' }, start: 18 * 60 + 5, end: 19 * 60 + 45 },
      { type: 'block', data: { id: 'piano', title: 'Piano' }, start: 19 * 60 + 15, end: 20 * 60 + 15 },
    ];
    const laidOut = layoutDayItems(items, pxPerMin);
    // Sanity check: layoutDayItems itself still gives both items separate
    // lanes (this bug is NOT about layoutDayItems' own fold decision).
    expect(laidOut.every((i) => i.kind !== 'cluster')).toBe(true);
    expect(new Set(laidOut.map((i) => i.lane)).size).toBe(2);

    const folded = foldNarrowIllegibleTitles(laidOut, byTitle);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).toBe('cluster');
    expect(folded[0].items.map((it) => it.data.id).sort()).toEqual(['piano', 'test1']);
    expect(folded[0].totalLanes).toBe(1);
  });

  it('does NOT fold the pinned "must stay side-by-side" cases (short titles) — the previously-fixed over-clustering regression', () => {
    // Same two shapes as the pinned layoutDayItems tests below ("Email
    // student"/"Lower + Running" and "Standup"/"Review") — both must still
    // render as 2 separate lanes after this pass, since their titles read
    // fine at half width. This is the user's own explicit warning: a
    // previous bug folded events that had "plenty of space to be displayed
    // individually", and this fix must not reintroduce it.
    const pxPerMin = 1.25;
    const shapes = [
      [
        { type: 'block', data: { id: 'a', title: 'Email student' }, start: 540, end: 575 },
        { type: 'block', data: { id: 'b', title: 'Lower + Running' }, start: 550, end: 585 },
      ],
      [
        { type: 'block', data: { id: 'a', title: 'Standup' }, start: 540, end: 565 },
        { type: 'block', data: { id: 'b', title: 'Review' }, start: 550, end: 575 },
      ],
    ];
    for (const items of shapes) {
      const laidOut = layoutDayItems(items, pxPerMin);
      const folded = foldNarrowIllegibleTitles(laidOut, byTitle);
      expect(folded).toHaveLength(2);
      expect(folded.every((f) => f.kind !== 'cluster')).toBe(true);
    }
  });

  it('is a no-op on a group with only 1 lane, regardless of title length', () => {
    // A single, non-overlapping item never gets split into multiple lanes in
    // the first place, so this pass must never touch it — a long title in a
    // full-width box is exactly the "1 lane -> always false" case
    // isLaneWidthTooNarrowForTitle itself pins.
    const pxPerMin = 1.25;
    const items = [{ type: 'block', data: { id: 'solo', title: 'A very long standalone task title indeed' }, start: 540, end: 600 }];
    const laidOut = layoutDayItems(items, pxPerMin);
    const folded = foldNarrowIllegibleTitles(laidOut, byTitle);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).not.toBe('cluster');
  });

  it('never drops an item — every input item is represented exactly once in the output, folded or not', () => {
    const pxPerMin = 1.25;
    const items = [
      { type: 'block', data: { id: 'long1', title: 'A genuinely very long overlapping task title one' }, start: 540, end: 640 },
      { type: 'block', data: { id: 'long2', title: 'Another genuinely very long overlapping title two' }, start: 560, end: 660 },
      { type: 'block', data: { id: 'short', title: 'Ok' }, start: 580, end: 620 },
    ];
    const laidOut = layoutDayItems(items, pxPerMin);
    const folded = foldNarrowIllegibleTitles(laidOut, byTitle);
    const total = folded.reduce((sum, f) => sum + (f.kind === 'cluster' ? f.items.length : 1), 0);
    expect(total).toBe(3);
  });

  it('leaves a group with no over-narrow title completely untouched, including lane numbers', () => {
    const pxPerMin = 1.25;
    const items = [
      { type: 'block', data: { id: 'a', title: 'Standup' }, start: 540, end: 565 },
      { type: 'block', data: { id: 'b', title: 'Review' }, start: 550, end: 575 },
    ];
    const laidOut = layoutDayItems(items, pxPerMin);
    const folded = foldNarrowIllegibleTitles(laidOut, byTitle);
    expect(folded).toEqual(laidOut);
  });
});

describe('layoutDayItems + computeDayPositions (lane packing)', () => {
  it('assigns two overlapping legible-alone items to separate lanes instead of folding them together', () => {
    const items = [block('Email student', 540, 575), block('Lower + Running', 550, 585)];
    const laidOut = layoutDayItems(items, 1.25);
    expect(laidOut).toHaveLength(2);
    const lanes = new Set(laidOut.map((i) => i.lane));
    expect(lanes.size).toBe(2); // two distinct lanes

    const positioned = computeDayPositions(laidOut, 1.25);
    const [a, b] = positioned;
    // Different lanes within the same overlap group -> never considered a
    // vertical-stacking collision; packLane runs independently per lane.
    expect(a.lane).not.toBe(b.lane);
  });

  it('gives two overlapping legible events their own proportional lane/column, instead of clustering them', () => {
    // Two 25-minute events overlapping by a few minutes — legible alone at
    // max zoom (25 * 1.25 = 31.25px >= 26px MIN_BLOCK_HEIGHT_PX) and, at just
    // two concurrent items, still within MAX_SIDE_BY_SIDE_LANES, so both keep
    // a real side-by-side lane rather than folding.
    const items = [block('Standup', 540, 565), block('Review', 550, 575)];
    const laidOut = layoutDayItems(items, 1.25);
    expect(laidOut.every((i) => i.kind !== 'cluster')).toBe(true);
    expect(laidOut).toHaveLength(2);
    const lanes = new Set(laidOut.map((i) => i.lane));
    expect(lanes.size).toBe(2);

    const positioned = computeDayPositions(laidOut, 1.25);
    for (const p of positioned) {
      // Individual items get their TRUE proportional height — no floor.
      expect(p.height).toBeCloseTo((p.end - p.start) * 1.25, 0);
    }
  });

  it('folds a 3rd+ concurrently-overlapping legible item into a cluster instead of forcing a 3rd side-by-side lane (MAX_SIDE_BY_SIDE_LANES)', () => {
    // Three 25-minute events, each overlapping the next in a staggered chain
    // (all individually legible per isLegibleAlone — this is NOT a height
    // problem). isLegibleAlone only ever judges height, so unlike the old
    // behavior (each concurrent legible item always got its own lane,
    // however many), a peak of 3 concurrent items must now fold the 3rd into
    // a cluster — 3 side-by-side lanes in a real 7-day week view squeezes
    // each to an illegibly narrow WIDTH, which isLegibleAlone can't see (see
    // packLanesCapped/MAX_SIDE_BY_SIDE_LANES doc comments — regression for
    // the real "two same-time MECHENG lectures look merged" report).
    const items = [block('Standup', 540, 565), block('Review', 550, 575), block('Sync', 560, 585)];
    const laidOut = layoutDayItems(items, 1.25);
    const clusters = laidOut.filter((i) => i.kind === 'cluster');
    expect(clusters).toHaveLength(1);
    // The overflow cluster holds whichever item needed the 3rd lane — the
    // exact member folded in is an implementation detail of the greedy
    // simulation, so just check total item count is preserved (2 kept singles + 1 folded).
    const singleCount = laidOut.filter((i) => i.kind !== 'cluster').length;
    expect(singleCount + clusters[0].items.length).toBe(3);
    const lanes = new Set(laidOut.map((i) => i.lane));
    expect(lanes.size).toBe(2); // capped at MAX_SIDE_BY_SIDE_LANES

    const positioned = computeDayPositions(laidOut, 1.25);
    for (const p of positioned) {
      if (p.kind !== 'cluster') expect(p.height).toBeCloseTo((p.end - p.start) * 1.25, 0);
    }
  });

  it('reproduces the real bug report: two identically-timed legible events plus two bridging items never render as a single merged chip', () => {
    // "Start stop Piano" 14:41-15:51, two same-time 2hr lecture-style events
    // 15:00-17:00, "Test prep" 16:01-17:10 — the exact reported shape. Piano
    // and Test prep don't overlap each other, but both bridge the two 2hr
    // events into one 4-item overlap group needing 3 concurrent lanes at
    // peak (15:00-15:51). Both 2hr events are always legible alone at every
    // zoom (2hr * even the lowest pxPerMin comfortably clears
    // MIN_BLOCK_HEIGHT_PX) — the old behavior gave all 4 real lanes, 3-wide
    // in a 7-day view, which rendered illegibly (verified against the actual
    // DOM/screenshot during investigation). The fix must cap real lanes at
    // MAX_SIDE_BY_SIDE_LANES and fold the peak's 3rd concurrent item into a
    // cluster, at every zoom level.
    const items = [
      event('Piano', 14 * 60 + 41, 15 * 60 + 51),
      event('MECHENG 211', 15 * 60, 17 * 60),
      event('MECHENG 222', 15 * 60, 17 * 60),
      event('Test prep', 16 * 60 + 1, 17 * 60 + 10),
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const laidOut = layoutDayItems(items, pxPerMin);
      const lanes = new Set(laidOut.map((i) => i.lane));
      expect(lanes.size).toBeLessThanOrEqual(MAX_SIDE_BY_SIDE_LANES);
      // Every one of the 4 original items must still be represented exactly
      // once (either as its own single, or inside the overflow cluster) —
      // the fold must never silently drop an item.
      const total = laidOut.reduce((sum, i) => sum + (i.kind === 'cluster' ? i.items.length : 1), 0);
      expect(total).toBe(4);
    }
  });

  it('clusters overlapping items whose own height would be illegibly short, and the cluster label lists their titles', () => {
    // Three 8-minute events overlapping each other at max zoom: 8 * 1.25 =
    // 10px each, well under the 26px legibility floor — must cluster.
    const items = [block('Standup', 540, 548), block('Review', 544, 552), block('Sync', 550, 558)];
    const laidOut = layoutDayItems(items, 1.25);
    const clusters = laidOut.filter((i) => i.kind === 'cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].items.map((it) => it.data.id).sort()).toEqual(['Review', 'Standup', 'Sync']);
  });

  it('keeps a legible-alone item in its own lane even alongside a short-item cluster it overlaps', () => {
    const items = [
      block('Long', 540, 540 + 40), // 40 min * 1.25 = 50px, comfortably legible
      block('S1', 545, 550), // 5 min, illegible alone
      block('S2', 551, 556), // 5 min, illegible alone
    ];
    const laidOut = layoutDayItems(items, 1.25);
    const longItem = laidOut.find((i) => i.kind !== 'cluster' && i.data.id === 'Long');
    const clusterItem = laidOut.find((i) => i.kind === 'cluster');
    expect(longItem).toBeTruthy();
    expect(clusterItem).toBeTruthy();
    expect(longItem.lane).not.toBe(clusterItem.lane);
  });

  it('never produces two items in the same (groupId, lane) whose top/height ranges overlap', () => {
    // Broad regression sweep: several shapes that combine long/short/cluster
    // items, all overlapping to different degrees, at every zoom level.
    const shapes = [
      [block('A', 540, 575), block('B', 550, 585)],
      [block('A', 540, 560), block('B', 545, 565), block('C', 600, 605), block('D', 601, 606), block('E', 602, 607)],
      [block('A', 540, 600), block('B', 555, 558), block('C', 559, 562), event('E', 545, 610)],
      [block('A', 540, 570), block('B', 560, 620), block('C', 610, 650)],
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      for (const items of shapes) {
        const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
        const byKey = new Map();
        for (const item of positioned) {
          const key = `${item.groupId}:${item.lane}`;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push(item);
        }
        for (const laneItems of byKey.values()) {
          const sorted = [...laneItems].sort((a, b) => a.top - b.top);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i].top).toBeGreaterThanOrEqual(sorted[i - 1].top + sorted[i - 1].height);
          }
        }
      }
    }
  });
});

describe('cross-group stacking does not resurrect the original chain-stacking bug', () => {
  it('does not push a genuinely distant, unrelated later item down just because an earlier short-item run inflated prevBottom', () => {
    // Regression for the ORIGINAL "chain-stacking across unrelated groups"
    // bug (see git history): a run of short items early in the day must not
    // push a later, clearly time-disjoint item's top down — only genuinely
    // adjacent (near-zero natural gap) items should ever influence each
    // other's position. These are far enough apart in time that they don't
    // even overlap or sequentially-fold, so they land as five separate
    // single items (no cluster this time, since none inherit a floor).
    const items = [
      block('A', 480, 481), // 08:00-08:01
      block('B', 481, 482),
      block('C', 482, 483),
      block('D', 483, 484),
      block('E', 484, 485), // run of 5 back-to-back 1-min items
      block('Later', 800, 830), // 13:20-13:50, hours later — clearly unrelated
    ];
    const pxPerMin = 1.25;
    const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
    const later = positioned.find((i) => i.data?.id === 'Later' || i.items?.some((it) => it.data.id === 'Later'));
    const expectedNaturalTop = Math.round((800 - GRID_START_MIN) * pxPerMin);
    expect(later.top).toBe(expectedNaturalTop);
  });
});

describe('cross-group sequential visual overlap', () => {
  it('does not let two sequential, non-overlapping-in-time single items render with overlapping top/height just because they land in different overlap groups', () => {
    // "Morning tasks" (5min, too-short-alone) then "Piano" (45min, long
    // enough) with zero gap between them. Because they don't overlap in
    // time (Piano starts exactly when Morning tasks ends), layoutDayItems'
    // overlapGroup sweep puts them in two SEPARATE groups, each producing
    // its own lane 0 — computeDayPositions then packs each group's lane 0
    // independently (fresh prevBottom per group), so nothing guarantees
    // Piano's box doesn't visually collide with Morning tasks' box below it.
    const items = [block('Morning tasks', 480, 485), block('Piano', 485, 530)];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
      const sorted = [...positioned].sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].top).toBeGreaterThanOrEqual(sorted[i - 1].top + sorted[i - 1].height);
      }
    }
  });
});

describe('packLane', () => {
  it('grows a too-short lone item up to a full two-line height when there is no next item to bump into', () => {
    // A lone 4-minute item at max zoom (1.25px/min) is genuinely only 5px
    // tall — with idle space below it (nothing else in the lane), it may
    // grow into that free room rather than rendering as an illegible sliver
    // sitting above empty space.
    //
    // It grows to TWO_LINE_MIN_HEIGHT_PX, not the smaller one-line
    // MIN_BLOCK_HEIGHT_PX this used to stop at. Stopping at one line meant
    // the stretch never actually achieved anything: 26px is under both
    // two-line thresholds, so the box came out taller but still couldn't show
    // its time range — a box that lies about its end time AND withholds the
    // real one, which is the worst of both. If the calendar is going to give
    // up exact bottom-edge alignment, it has to buy the time line with it.
    const items = [{ start: 540, end: 544, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } }];
    const packed = packLane(items, 1.25);
    expect(packed[0].height).toBe(TWO_LINE_MIN_HEIGHT_PX);
  });

  it('does not grow a too-short item past the real idle room before the next item in its lane', () => {
    // "Tiny" (4 min, ~5px) is followed 10 real minutes later by "Next" — only
    // 12.5px of genuinely free room, still under MIN_BLOCK_HEIGHT_PX (26px).
    // It should grow to fill exactly that idle room, not the full floor,
    // and must never reach into "Next"'s own natural top.
    const items = [
      { start: 540, end: 544, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } },
      { start: 554, end: 600, kind: 'single', type: 'block', data: { id: 'Next', title: 'Next' } },
    ];
    const packed = packLane(items, 1.25);
    const tiny = packed.find((p) => p.data?.id === 'Tiny');
    const next = packed.find((p) => p.data?.id === 'Next');
    expect(tiny.height).toBeLessThan(MIN_BLOCK_HEIGHT_PX);
    expect(tiny.top + tiny.height).toBeLessThanOrEqual(next.top);
  });

  it('grows a too-short item to fill ample idle room up to (but not past) a full two-line height', () => {
    // "Tiny" (4 min, ~5px) is followed 40 real minutes later by "Next" —
    // plenty of idle room, so growth stops as soon as the box can show its
    // title and time rather than expanding to swallow the entire gap. Taking
    // only what it needs keeps the overstatement of the item's end time as
    // small as it can be while still being readable.
    const items = [
      { start: 540, end: 544, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } },
      { start: 584, end: 600, kind: 'single', type: 'block', data: { id: 'Next', title: 'Next' } },
    ];
    const packed = packLane(items, 1.25);
    const tiny = packed.find((p) => p.data?.id === 'Tiny');
    expect(tiny.height).toBe(TWO_LINE_MIN_HEIGHT_PX);
    // ...and stops well short of the 55px gap it could have filled.
    expect(tiny.height).toBeLessThan((584 - 540) * 1.25);
  });

  it('a kind:"cluster" item is still floored to MIN_BLOCK_HEIGHT_PX', () => {
    const items = [
      {
        start: 540,
        end: 543,
        kind: 'cluster',
        items: [
          { type: 'block', data: { id: 't1', title: 't1' } },
          { type: 'block', data: { id: 't2', title: 't2' } },
        ],
      },
    ];
    const packed = packLane(items, 1.25);
    expect(packed[0].height).toBe(MIN_BLOCK_HEIGHT_PX);
  });

  it('two real back-to-back single items of ordinary length sit flush with no floor-driven pushdown', () => {
    // Previously, packLane's MIN_BLOCK_HEIGHT_PX floor on every single item
    // meant a short predecessor could push its immediate successor down even
    // though the two don't actually overlap in time — regardless of the
    // predecessor's own real duration. Since individual items are no longer
    // floored, that large floor-driven push no longer happens: a 20-minute
    // item comfortably clears any rounding/BLOCK_GAP_PX slack at every zoom
    // level, so it must never fold into its back-to-back successor.
    const items = [
      { start: 520, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const packed = packLane(items, pxPerMin);
      expect(packed).toHaveLength(2);
      expect(packed.every((p) => p.kind !== 'cluster')).toBe(true);
    }
  });

  it('a genuinely tiny (sub-minute-rounding) predecessor may still incur a couple px of rounding/gap slack, but that alone does not misrepresent its neighbour’s time', () => {
    // At high zoom, rounding a fractional height plus BLOCK_GAP_PX can tip a
    // very short (here 2-minute) predecessor just past EXCESSIVE_PUSHDOWN_PX,
    // triggering the existing near-zero-tolerance fold — this is expected,
    // pre-existing rounding-slack behaviour (see EXCESSIVE_PUSHDOWN_PX's own
    // doc comment), not a regression from removing the individual-item floor.
    const items = [
      { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const packed = packLane(items, pxPerMin);
      // Either it stacks as two honestly-positioned items, or the rounding
      // slack tipped it into a (still correctly labeled) cluster — both are
      // acceptable, but nothing may overlap.
      let prevBottom = -Infinity;
      for (const p of packed) {
        expect(p.top).toBeGreaterThanOrEqual(prevBottom);
        prevBottom = p.top + p.height + 2;
      }
    }
  });

  it('pushes a chained run of back-to-back items down so none overlap', () => {
    const items = [
      { start: 540, end: 545, kind: 'single' },
      { start: 545, end: 550, kind: 'single' },
      { start: 546, end: 552, kind: 'single' }, // slightly overlapping natural start
    ];
    const packed = packLane(items, 1.25);
    for (let i = 1; i < packed.length; i++) {
      expect(packed[i].top).toBeGreaterThanOrEqual(packed[i - 1].top + packed[i - 1].height);
    }
  });

  it('folds a cluster predecessor onto a real item when the cluster’s own floor pushes into it', () => {
    // A `kind: 'cluster'` predecessor is still floored to MIN_BLOCK_HEIGHT_PX
    // (see calendarLayout.js), so at low zoom levels its floored bottom can
    // still reach past a tightly-following real item's natural top — this is
    // the one remaining source of pushdown-triggered folding.
    const items = [
      {
        start: 538,
        end: 540,
        kind: 'cluster',
        items: [
          { type: 'block', data: { id: 't1', title: 't1' } },
          { type: 'block', data: { id: 't2', title: 't2' } },
        ],
      },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
    ];
    // At low zoom, MIN_BLOCK_HEIGHT_PX (26px) covers far more real minutes
    // than the cluster's own 2-minute natural span, so it pushes hard enough
    // into "Lower + Running" to force a fold.
    const packed = packLane(items, 0.55);
    expect(packed).toHaveLength(1);
    expect(packed[0].kind).toBe('cluster');
  });

  it('still stacks (does not fold) when there is no real pushdown at all', () => {
    // Two items with a genuine natural gap large enough that the
    // predecessor's own (possibly floored) box never reaches the next
    // item's natural top — zero inherited pushdown, so no fold.
    const pxPerMin = 1.25;
    const items = [
      { start: 480, end: 481, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } }, // 1-min single, no floor now -> ~1.25px tall
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Long', title: 'Long' } }, // starts 59 real min later
    ];
    const packed = packLane(items, pxPerMin);
    expect(packed).toHaveLength(2);
    expect(packed.every((p) => p.kind !== 'cluster')).toBe(true);
  });

  it('preserves every constituent item when the incoming item is ALREADY a cluster (not just a single)', () => {
    // Regression: the fold-merge branch used to read item.type/item.data
    // directly, which is undefined on a `kind: 'cluster'` item (clusters
    // only carry `.items`) — merging a real task with an already-clustered
    // run of short tasks silently produced a `{}` placeholder in its place,
    // dropping every task inside that incoming cluster and under-reporting
    // the resulting chip's count (e.g. showing "2 tasks" when 4 real items
    // were actually merged).
    const pxPerMin = 0.55;
    const items = [
      {
        start: 478,
        end: 480,
        kind: 'cluster',
        items: [{ type: 'block', data: { id: 'Email student', title: 'Email student' } }],
      },
      { start: 480, end: 540, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
      // Already pre-clustered by an earlier pass (mirrors what
      // layoutDayItems' flushShortRun/foldSequentialItems would hand to
      // packLane for a run of short, mutually-close items).
      {
        start: 540,
        end: 543,
        kind: 'cluster',
        items: [
          { type: 'block', data: { id: 't1', title: 't1' } },
          { type: 'block', data: { id: 't2', title: 't2' } },
          { type: 'block', data: { id: 't3', title: 't3' } },
        ],
      },
    ];
    const packed = packLane(items, pxPerMin);
    const allIds = packed.flatMap((p) => (p.kind === 'cluster' ? p.items.map((i) => i.data.id) : [p.data.id]));
    expect(allIds).toEqual(expect.arrayContaining(['Email student', 'Lower + Running', 't1', 't2', 't3']));
    expect(allIds).toHaveLength(5);
  });

  it('BUG REPRO: never folds 3+ genuinely back-to-back, individually legible full-hour items into a cluster purely from BLOCK_GAP_PX baseline compounding', () => {
    // The user-reported bug: three back-to-back 1-hour blocks (9-10, 10-11,
    // 11-12), zero real gap, zero overlap, each individually WAY above
    // MIN_BLOCK_HEIGHT_PX (75px at max zoom) — should never be a cluster.
    // Root cause (confirmed by hand-tracing packLane): prevBottom always
    // adds BLOCK_GAP_PX after every placed item, and since these items are
    // exactly flush (each one's naturalTop equals the previous one's
    // naturalBottom), that cosmetic gap compounds every single step: item 2
    // inherits 1*BLOCK_GAP_PX (2px) of pushdown, item 3 inherits 2*GAP (4px)
    // — which already exceeds the old flat EXCESSIVE_PUSHDOWN_PX(2) check,
    // folding item 3 into item 2's box even though nothing is actually
    // crowded. This reproduces with plain integer pxPerMin (1.0, from
    // ZOOM_LEVELS_PX_PER_MIN) and hour-aligned times — i.e. it is NOT merely
    // floating-point rounding noise, it is the baseline itself compounding.
    const items = [block('A', 9 * 60, 10 * 60), block('B', 10 * 60, 11 * 60), block('C', 11 * 60, 12 * 60)];
    const pxPerMin = 1.0;
    const laidOut = layoutDayItems(items, pxPerMin);
    const positioned = computeDayPositions(laidOut, pxPerMin);
    expect(positioned.filter((p) => p.kind === 'cluster')).toHaveLength(0);
    expect(positioned).toHaveLength(3);
  });

  it('BUG REPRO: a longer run (5) of back-to-back full-hour items never clusters purely from chained BLOCK_GAP_PX compounding, at max zoom', () => {
    // Same mechanism as above, pushed further (5 items instead of 3) and at
    // the highest zoom level, to confirm the fold-avoidance isn't a fluke of
    // one particular chain length — a genuinely flush chain of legible items
    // must never fold no matter how long it runs.
    const items = [
      block('A', 9 * 60, 10 * 60),
      block('B', 10 * 60, 11 * 60),
      block('C', 11 * 60, 12 * 60),
      block('D', 12 * 60, 13 * 60),
      block('E', 13 * 60, 14 * 60),
    ];
    const pxPerMin = 1.25;
    const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
    expect(positioned.filter((p) => p.kind === 'cluster')).toHaveLength(0);
    expect(positioned).toHaveLength(5);
  });

  it('BUG REPRO: rounding noise from a non-integer zoom level plus non-hour-aligned start times must not fold two legible back-to-back items either', () => {
    // Isolates the ROUNDING-noise mechanism from the compounding one: only
    // 2 items (so no multi-step baseline growth involved), but a non-"nice"
    // pxPerMin (0.65, from ZOOM_LEVELS_PX_PER_MIN) and non-hour-aligned start
    // times (9:07) mean naturalTop/naturalHeight don't land on exact pixel
    // boundaries — Math.round'ing each one individually can, by itself, tip
    // pushdownPx just past the old flat EXCESSIVE_PUSHDOWN_PX(2) threshold.
    const items = [block('A', 9 * 60 + 7, 10 * 60 + 7), block('B', 10 * 60 + 7, 11 * 60 + 7)];
    const pxPerMin = 0.65;
    const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
    expect(positioned.filter((p) => p.kind === 'cluster')).toHaveLength(0);
    expect(positioned).toHaveLength(2);
  });

  it('never lets any packed item inherit more than EXCESSIVE_PUSHDOWN_PX of pushdown from its predecessor(s), at any zoom level', () => {
    // The hard invariant itself, directly: for every packed item with a
    // predecessor, (pushedTop - naturalTop) must never exceed
    // EXCESSIVE_PUSHDOWN_PX (2px of rounding slack) — a near-zero tolerance
    // that requires no per-zoom or per-shape tuning. Mixes single items
    // (never floored) with a leading cluster (still floored) so both
    // pushdown sources are exercised.
    const shapes = [
      [
        { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Morning tasks', title: 'Morning tasks' } },
        { start: 540, end: 585, kind: 'single', type: 'block', data: { id: 'Piano', title: 'Piano' } },
      ],
      [
        {
          start: 538,
          end: 540,
          kind: 'cluster',
          items: [{ type: 'block', data: { id: 'Email student', title: 'Email student' } }],
        },
        { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
      ],
      [
        { start: 480, end: 481, kind: 'single', type: 'block', data: { id: 'A', title: 'A' } },
        { start: 481, end: 482, kind: 'single', type: 'block', data: { id: 'B', title: 'B' } },
        { start: 482, end: 483, kind: 'single', type: 'block', data: { id: 'C', title: 'C' } },
        { start: 483, end: 500, kind: 'single', type: 'block', data: { id: 'D', title: 'D' } },
      ],
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      for (const items of shapes) {
        const packed = packLane(items, pxPerMin);
        let prevBottom = -Infinity;
        for (const p of packed) {
          expect(p.top).toBeGreaterThanOrEqual(prevBottom);
          prevBottom = p.top + p.height + 2;
          const naturalTop = Math.round((p.start - GRID_START_MIN) * pxPerMin);
          expect(p.top - naturalTop).toBeLessThanOrEqual(EXCESSIVE_PUSHDOWN_PX + 1); // +1 rounding slack
        }
      }
    }
  });
});

describe('cluster label (vertical stack of real event titles instead of a generic summary)', () => {
  // clusterLabel/clusterMaxTitleLines themselves live in WeekView.jsx (pure
  // DOM-label formatting, not layout math), so these tests exercise the same
  // contract via a local copy of the logic to keep this file focused on
  // layout — see WeekView.jsx's own implementations for the authoritative
  // version and tests/e2e for the rendered result. Titles now stack one per
  // line (an array of lines) rather than a single comma-joined string, sized
  // to however many lines the chip's own pixel height has room for.
  const LINE_CHAR_BUDGET = 22;
  const LINE_HEIGHT_PX = 15;
  const VERTICAL_CHROME_PX = 10;

  function clusterLabel(items, maxLines) {
    const titles = items.map((it) => it.data.title || 'Untitled');
    const truncate = (t) => (t.length > LINE_CHAR_BUDGET ? `${t.slice(0, LINE_CHAR_BUDGET - 1)}…` : t);
    if (titles.length <= maxLines) return titles.map(truncate);
    if (maxLines <= 1) {
      const noun = items.every((it) => it.type === 'block') ? 'tasks' : 'items';
      return [`${titles.length} ${noun}`];
    }
    const shown = titles.slice(0, maxLines - 1).map(truncate);
    return [...shown, `+${titles.length - shown.length} more`];
  }

  function clusterMaxTitleLines(chipHeightPx, hasTimeLine) {
    const timeLineReserve = hasTimeLine ? LINE_HEIGHT_PX : 0;
    const available = chipHeightPx - VERTICAL_CHROME_PX - timeLineReserve;
    return Math.max(1, Math.floor(available / LINE_HEIGHT_PX));
  }

  it('lists every title on its own line when they all fit within the available lines', () => {
    const items = [
      { data: { title: 'Standup' } },
      { data: { title: 'Review' } },
    ];
    expect(clusterLabel(items, 5)).toEqual(['Standup', 'Review']);
  });

  it('never cuts a title in half — a too-long title truncates with a trailing ellipsis on its own line', () => {
    const items = [{ data: { title: 'Quarterly planning review meeting' } }];
    const lines = clusterLabel(items, 5);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(lines[0].length).toBeLessThanOrEqual(LINE_CHAR_BUDGET);
  });

  it('folds whatever does not fit into a trailing "+N more" summary line instead of dropping it silently', () => {
    const items = [
      { data: { title: 'Standup' } },
      { data: { title: '1:1 with Sam' } },
      { data: { title: 'Quarterly planning review meeting' } },
      { data: { title: 'Retro' } },
    ];
    const lines = clusterLabel(items, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('+2 more');
    expect(lines[0]).toBe('Standup');
    expect(lines[1]).toBe('1:1 with Sam');
  });

  it('falls back to a single summary line when there is only room for one line total', () => {
    const items = [
      { type: 'block', data: { title: 'Standup' } },
      { type: 'block', data: { title: 'Review' } },
      { type: 'block', data: { title: 'Retro' } },
    ];
    expect(clusterLabel(items, 1)).toEqual(['3 tasks']);
  });

  it('says "items", not "tasks", once a cluster can also hold calendar events', () => {
    // Short events fold now too (see isTooShortAlone), so a chip summarising
    // two events and a task calling itself "3 tasks" would simply be wrong.
    const mixed = [
      { type: 'block', data: { title: 'Standup' } },
      { type: 'event', data: { title: 'Review' } },
      { type: 'event', data: { title: 'Retro' } },
    ];
    expect(clusterLabel(mixed, 1)).toEqual(['3 items']);
  });

  describe('clusterMaxTitleLines', () => {
    it('always allows at least one line even for a very short chip', () => {
      expect(clusterMaxTitleLines(5, false)).toBe(1);
    });

    it('grows the number of available lines as the chip gets taller', () => {
      const short = clusterMaxTitleLines(20, false);
      const tall = clusterMaxTitleLines(80, false);
      expect(tall).toBeGreaterThan(short);
    });

    it('reserves room for the time-range line when shown, reducing available title lines', () => {
      const withoutTimeLine = clusterMaxTitleLines(50, false);
      const withTimeLine = clusterMaxTitleLines(50, true);
      expect(withTimeLine).toBeLessThan(withoutTimeLine);
    });
  });
});

describe('short EVENTS fold like short blocks (both directions pinned)', () => {
  // The reported bug, measured in the real DOM before being fixed here: three
  // 10-minute events rendered at 10-17px each and never folded, because the
  // fold-on-own-duration test only ever applied to `type: 'block'`. A 10-minute
  // event at 0.55px/min is 5.5px — not a box, a line — so "an event's title
  // always deserves its own box" was true in intent and false in effect.
  const shortRun = () => [event('E1', 540, 550), event('E2', 555, 565), event('E3', 570, 580)];

  it('folds a run of unreadably short events at low zoom', () => {
    const folded = foldSequentialItems(shortRun(), 0.55);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).toBe('cluster');
    expect(folded[0].items).toHaveLength(3);
  });

  it('folds them at max zoom too, where 10 minutes is still only 12.5px', () => {
    // 10min * 1.25 = 12.5px, well under MIN_BLOCK_HEIGHT_PX (26).
    const folded = foldSequentialItems(shortRun(), 1.25);
    expect(folded[0].kind).toBe('cluster');
  });

  it('does NOT fold 1-hour events, at any zoom — the regression that already happened once', () => {
    // Three back-to-back 1-hour events with zero gap. Each is 33px even at the
    // lowest zoom: clearly displayable on its own, and folding them into an
    // anonymous chip is the exact over-clustering this must not reintroduce.
    const hours = [event('H1', 540, 600), event('H2', 600, 660), event('H3', 660, 720)];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const folded = foldSequentialItems(hours, pxPerMin);
      expect(folded).toHaveLength(3);
      expect(folded.every((f) => f.kind === 'single')).toBe(true);
    }
  });

  it('does not fold a 30-minute event that already clears the legibility floor', () => {
    // 30min at 1.25 = 37.5px > 26px. Two of them, adjacent.
    const folded = foldSequentialItems([event('A', 540, 570), event('B', 570, 600)], 1.25);
    expect(folded).toHaveLength(2);
  });

  it('never folds an event long enough to stand alone with a short one beside it', () => {
    // A 5-minute event right before a 90-minute one: legitimate back-to-back
    // scheduling, and the long event must keep its own box.
    const folded = foldSequentialItems([event('tiny', 540, 545), event('long', 545, 635)], 1.25);
    expect(folded.some((f) => f.kind === 'single' && f.data.id === 'long')).toBe(true);
  });

  it('still never folds items that overlap in time, events included', () => {
    // That's layoutDayItems' lane-packing job, not this function's.
    const folded = foldSequentialItems([event('A', 540, 575), event('B', 550, 585)], 1.25);
    expect(folded).toHaveLength(2);
  });

  it('keeps the monotonic-zoom property for events', () => {
    // More pixel room can only ever mean less folding, never more.
    const items = shortRun();
    const counts = [0.55, 0.65, 0.8, 1.0, 1.25].map((p) => foldSequentialItems(items, p).length);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });

  it('mixes short blocks and short events into the same cluster', () => {
    // A user doesn't distinguish "task" from "calendar event" when three
    // unreadable slivers sit on top of each other.
    const folded = foldSequentialItems([block('B1', 540, 550), event('E1', 555, 565)], 1.25);
    expect(folded).toHaveLength(1);
    expect(folded[0].kind).toBe('cluster');
  });
});

/**
 * The three-step "a short box must still be readable" ladder, in priority
 * order. Each step only runs if the one before it couldn't solve the problem:
 *
 *   1. Render at the item's OWN true height (bottom edge lands exactly on its
 *      real end time), at normal type if that fits both the title and the
 *      time line, or at the smaller compact type if only that fits. Nothing
 *      moves — the box stays honest about where it sits on the clock.
 *   2. If neither type size fits inside the item's own true height, keep the
 *      NORMAL type and stretch the box downward into genuinely empty space
 *      below it instead, never past whatever comes next. The bottom edge no
 *      longer matches the real end time; that's the deliberate trade for
 *      being able to read the thing at all. Shrinking the type here would buy
 *      nothing — the only reason to shrink was to avoid stretching, and the
 *      box is being stretched regardless.
 *   3. If there isn't enough empty space below to stretch into either, fold
 *      the item into an "N items" chip with whatever is crowding it.
 */
describe('short-box legibility ladder (own height -> expand -> fold)', () => {
  it('step 1: an item whose own true height fits title+time at NORMAL type is left exactly at its true height', () => {
    // 30 minutes at max zoom is 37.5px, past TWO_LINE_MIN_HEIGHT_PX (36), so
    // both lines fit inside the item's own real duration. Nothing should be
    // stretched and the type must stay full-size — this is the case where the
    // calendar can be completely honest about the time axis.
    const pxPerMin = 1.25;
    const packed = packLane([block('A', 600, 630), block('B', 720, 780)], pxPerMin);
    const a = packed.find((p) => p.data?.id === 'A');
    expect(a.fontMode).toBe('normal');
    expect(a.height).toBe(Math.round(30 * pxPerMin));
  });

  it('step 1: an item that fits only at COMPACT type shrinks its type rather than stretching', () => {
    // 26 minutes at max zoom is 32.5px: too short for the normal two-line
    // height (36) but past the compact one (32). Shrinking the type keeps the
    // box's bottom edge on its real end time, which is strictly better than
    // stretching it, so this must NOT grow.
    const pxPerMin = 1.25;
    const packed = packLane([block('A', 600, 626), block('B', 720, 780)], pxPerMin);
    const a = packed.find((p) => p.data?.id === 'A');
    expect(a.fontMode).toBe('compact');
    expect(a.height).toBe(Math.round(26 * pxPerMin));
  });

  it('step 2: an item too short for EITHER type size expands at NORMAL type — never compact-and-stretched', () => {
    // THE CLARIFIED RULE. 15 minutes at max zoom is 18.75px — under the
    // compact two-line height (32), so no type size fits inside the item's own
    // duration. Shrinking the type is therefore pointless: it was only ever
    // worth doing to avoid stretching, and this box has to stretch anyway. It
    // must expand to a full two-line NORMAL-type height, not render as a
    // shrunken-AND-stretched box (the shape this rule exists to forbid).
    const pxPerMin = 1.25;
    const packed = packLane([block('A', 600, 615), block('B', 720, 780)], pxPerMin);
    const a = packed.find((p) => p.data?.id === 'A');
    expect(a.fontMode).toBe('normal');
    expect(a.height).toBe(TWO_LINE_MIN_HEIGHT_PX);
    // And the whole point of expanding: the time line can now actually render.
    expect(a.height).toBeGreaterThanOrEqual(TWO_LINE_MIN_HEIGHT_PX);
  });

  it('step 2: expansion stops at the next item’s own start rather than reaching into it', () => {
    // Only genuinely idle space may be borrowed. Here the follower starts 20
    // real minutes later (25px at max zoom), so the short item can take some
    // of that but must never reach the follower's own natural top.
    const pxPerMin = 1.25;
    const packed = packLane([block('A', 600, 605), block('B', 620, 680)], pxPerMin);
    const a = packed.find((p) => p.data?.id === 'A');
    const b = packed.find((p) => p.data?.id === 'B');
    expect(a.kind).not.toBe('cluster');
    expect(a.height).toBeGreaterThan(Math.round(5 * pxPerMin));
    expect(a.height).toBeLessThan(TWO_LINE_MIN_HEIGHT_PX);
    expect(a.top + a.height).toBeLessThanOrEqual(b.top);
  });

  it('step 3: THE REPORTED BUG — a 5-minute item wedged between a long side-by-side neighbour and an immediate follower folds instead of rendering as an unreadable sliver', () => {
    // "Test prep" 19:05-22:00 runs down lane 0. "Email student" is 5 real
    // minutes (19:55-20:00) and lands in lane 1, where "Piano" (20:00-21:00)
    // starts the very instant it ends — so there is no idle space below it to
    // expand into (4.25px at max zoom, against the ~36px a readable two-line
    // box needs). With no room to grow and too little height to read, the only
    // honest answer left is a chip. Before this ladder existed it rendered as
    // a 6px sliver with no title and no time, side-by-side with a full-height
    // block: the exact screenshot this test pins.
    const items = [block('Test prep', 1145, 1320), block('Email student', 1195, 1200), block('Piano', 1200, 1260)];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
      const email = positioned.find((p) => p.kind !== 'cluster' && p.data?.id === 'Email student');
      // It must not survive as a standalone sliver anywhere in the output.
      expect(email).toBeUndefined();
      // It must instead be inside a chip, with nothing silently dropped.
      const allIds = positioned.flatMap((p) => (p.kind === 'cluster' ? p.items.map((i) => i.data.id) : [p.data.id]));
      expect(allIds).toEqual(expect.arrayContaining(['Test prep', 'Email student', 'Piano']));
      expect(new Set(allIds).size).toBe(3);
    }
  });

  it('step 3 does NOT fire for an item that merely can’t show its TIME — only one that can’t show its title either', () => {
    // Guards the pinned "Email student" (20 min) / "Lower + Running" case
    // below from being dragged into a chip by this ladder. A 20-minute item
    // back-to-back with an hour-long one has no room to expand, and at low
    // zoom it is too short for a two-line render — but it is still perfectly
    // able to show its title on one line, which is a normal, honest calendar
    // render, not a failure. Folding it would hide a readable title behind an
    // anonymous chip, the exact over-clustering regression this file's history
    // is full of.
    const items = [block('Email student', 520, 540), block('Lower + Running', 540, 600)];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const packed = packLane(items, pxPerMin);
      expect(packed).toHaveLength(2);
      expect(packed.every((p) => p.kind !== 'cluster')).toBe(true);
    }
  });

  it('never reports the compact-and-stretched combination for ANY duration/zoom/spacing shape', () => {
    // The clarified rule as a hard invariant, swept across every zoom level,
    // every duration up to an hour, and a spread of gaps to the next item: no
    // box may ever come back both shrunk to compact type AND stretched past
    // its own true height. Those are alternatives to each other, never a pair.
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      for (let dur = 1; dur <= 60; dur += 1) {
        for (const gapAfter of [0, 5, 10, 20, 40, 90, 240]) {
          const items = [block('A', 600, 600 + dur), block('B', 600 + dur + gapAfter, 600 + dur + gapAfter + 60)];
          const positioned = computeDayPositions(layoutDayItems(items, pxPerMin), pxPerMin);
          const a = positioned.find((p) => p.kind !== 'cluster' && p.data?.id === 'A');
          if (!a) continue; // folded into a chip — a different branch of the ladder
          const trueHeight = (a.end - a.start) * pxPerMin;
          const stretched = a.height > trueHeight + 0.51; // ignore whole-pixel rounding
          expect(a.fontMode === 'compact' && stretched).toBe(false);
        }
      }
    }
  });
});

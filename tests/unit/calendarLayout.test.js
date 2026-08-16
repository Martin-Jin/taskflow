import { describe, it, expect } from 'vitest';
import {
  foldSequentialItems,
  layoutDayItems,
  computeDayPositions,
  packLane,
  isLegibleAlone,
  MIN_BLOCK_HEIGHT_PX,
  GRID_START_MIN,
  EXCESSIVE_PUSHDOWN_PX,
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

  it('gives several short overlapping events their own proportional lane/column when there is enough pixel room, instead of clustering them', () => {
    // Three 12-minute events, each overlapping the next by a few minutes.
    // At max zoom (1.25px/min), 12 min = 15px — under MIN_BLOCK_HEIGHT_PX
    // (26px), so individually still "too short to be legible"... but if we
    // zoom out to where the SAME real duration renders taller relative to a
    // lower bar, that's not how pxPerMin works (higher pxPerMin = taller).
    // Use a duration that clears the legibility floor at max zoom instead:
    // 25 minutes each (25 * 1.25 = 31.25px >= 26px) overlapping in a stagger.
    const items = [block('Standup', 540, 565), block('Review', 550, 575), block('Sync', 560, 585)];
    const laidOut = layoutDayItems(items, 1.25);
    // No cluster should have been produced — every item is legible alone.
    expect(laidOut.every((i) => i.kind !== 'cluster')).toBe(true);
    expect(laidOut).toHaveLength(3);
    // All three mutually overlap in a staggered chain, so they need 3 lanes.
    const lanes = new Set(laidOut.map((i) => i.lane));
    expect(lanes.size).toBe(3);

    const positioned = computeDayPositions(laidOut, 1.25);
    for (const p of positioned) {
      // Individual items get their TRUE proportional height — no floor.
      expect(p.height).toBeCloseTo((p.end - p.start) * 1.25, 0);
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
  it('grows a too-short lone item up to MIN_BLOCK_HEIGHT_PX when there is no next item to bump into', () => {
    // A lone 4-minute item at max zoom (1.25px/min) is genuinely only 5px
    // tall — with idle space below it (nothing else in the lane), it may
    // grow into that free room up to the legibility floor rather than
    // rendering as an illegible sliver sitting above empty space.
    const items = [{ start: 540, end: 544, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } }];
    const packed = packLane(items, 1.25);
    expect(packed[0].height).toBe(MIN_BLOCK_HEIGHT_PX);
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

  it('grows a too-short item to fill ample idle room up to (but not past) MIN_BLOCK_HEIGHT_PX', () => {
    // "Tiny" (4 min, ~5px) is followed 40 real minutes later by "Next" —
    // plenty of idle room, so growth is capped at the legibility floor
    // itself rather than expanding to fill the entire gap.
    const items = [
      { start: 540, end: 544, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } },
      { start: 584, end: 600, kind: 'single', type: 'block', data: { id: 'Next', title: 'Next' } },
    ];
    const packed = packLane(items, 1.25);
    const tiny = packed.find((p) => p.data?.id === 'Tiny');
    expect(tiny.height).toBe(MIN_BLOCK_HEIGHT_PX);
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
    if (maxLines <= 1) return [`${titles.length} tasks`];
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
    const items = [{ data: { title: 'Standup' } }, { data: { title: 'Review' } }, { data: { title: 'Retro' } }];
    expect(clusterLabel(items, 1)).toEqual(['3 tasks']);
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

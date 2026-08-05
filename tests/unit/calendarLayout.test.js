import { describe, it, expect } from 'vitest';
import { foldSequentialItems, layoutDayItems, computeDayPositions, packLane, LONG_ITEM_MIN, GRID_START_MIN, EXCESSIVE_PUSHDOWN_PX } from '../../src/utils/calendarLayout';

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
    // bug: two 30+ minute (LONG_ITEM_MIN-eligible) items overlapping in time
    // must NOT be merged into a single cluster — that would skip
    // layoutDayItems' lane-separation entirely and let them render on top of
    // each other. A negative gap (they overlap) used to trivially satisfy
    // every fold condition.
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

describe('layoutDayItems + computeDayPositions (lane packing)', () => {
  it('assigns two overlapping long-enough items to separate lanes instead of folding them together', () => {
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

  it('keeps an item >= LONG_ITEM_MIN in its own lane even alongside a short-item cluster it overlaps', () => {
    const items = [
      block('Long', 540, 540 + LONG_ITEM_MIN + 15),
      block('S1', 545, 550),
      block('S2', 551, 556),
    ];
    const laidOut = layoutDayItems(items, 1.25);
    const longItem = laidOut.find((i) => i.kind !== 'cluster' && i.data.id === 'Long');
    const clusterItem = laidOut.find((i) => i.kind === 'cluster');
    expect(longItem).toBeTruthy();
    expect(clusterItem).toBeTruthy();
    expect(longItem.lane).not.toBe(clusterItem.lane);
  });
});

describe('cross-group stacking does not resurrect the original chain-stacking bug', () => {
  it('does not push a genuinely distant, unrelated later item down just because an earlier short-item run inflated prevBottom', () => {
    // Regression for the ORIGINAL "chain-stacking across unrelated groups"
    // bug (see git history): a run of short, MIN_BLOCK_HEIGHT_PX-clamped
    // items early in the day must not push a later, clearly time-disjoint
    // item's top down — only genuinely adjacent (near-zero natural gap)
    // items should ever influence each other's position.
    const items = [
      block('A', 480, 481), // 08:00-08:01, clamped to MIN_BLOCK_HEIGHT_PX
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

describe('real-world screenshot reproduction (max zoom-out)', () => {
  it('matches the live DevTools measurement for Email student / Lower + Running / Morning tasks / Laundry', () => {
    // Exact real data confirmed via the user's own DevTools session at max
    // zoom-out (0.55px/min): Email student 08:35-08:40 (task, completed),
    // Lower + Running 09:00-10:00 (Google event), Morning tasks 10:10-10:15
    // (task, completed), Laundry 10:55-11:00 (task, completed). Before this
    // fix, "Lower + Running" rendered 14px past its own natural top purely
    // from Email student's MIN_BLOCK_HEIGHT_PX clamp (partially absorbed by
    // the real 20-min gap between them) — a single clamp, yet still visually
    // read as unacceptable drift once the user zoomed to check. Two earlier,
    // more permissive attempts at this exact bug (a flat pixel budget, then
    // an hour-row-fraction budget) both still tolerated this case. The fix:
    // EXCESSIVE_PUSHDOWN_PX is now a near-zero (2px) tolerance — any real
    // inherited pushdown beyond rounding slack folds, full stop, with no
    // "how much crowding is fine" judgment call left to get wrong.
    const pxPerMin = 0.55;
    const items = [
      { start: 515, end: 520, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
      { start: 540, end: 600, kind: 'single', type: 'event', data: { id: 'Lower + Running', title: 'Lower + Running' } },
      { start: 610, end: 615, kind: 'single', type: 'block', data: { id: 'Morning tasks', title: 'Morning tasks' } },
      { start: 655, end: 660, kind: 'single', type: 'block', data: { id: 'Laundry', title: 'Laundry' } },
    ];
    const packed = packLane(items, pxPerMin);
    const lowerRunning = packed.find(
      (p) => p.data?.id === 'Lower + Running' || p.items?.some((i) => i.data.id === 'Lower + Running')
    );
    expect(lowerRunning.kind).toBe('cluster');
    let prevBottom = -Infinity;
    for (const p of packed) {
      expect(p.top).toBeGreaterThanOrEqual(prevBottom);
      prevBottom = p.top + p.height + 2;
      const naturalTop = Math.round((p.start - GRID_START_MIN) * pxPerMin);
      expect(p.top - naturalTop).toBeLessThanOrEqual(EXCESSIVE_PUSHDOWN_PX + 1);
    }
  });
});

describe('packLane', () => {
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

  it('folds a single clamped predecessor onto a real item, at every zoom level', () => {
    // Near-zero tolerance: any real pushdown beyond rounding slack folds,
    // regardless of zoom. "Email student" (2-min block, ends exactly when
    // "Lower + Running" begins) always needs at least some clamp-driven
    // pushdown, so this always folds now — there's no zoom level where a
    // single clamp is quietly tolerated anymore (see EXCESSIVE_PUSHDOWN_PX's
    // doc comment for why earlier, more permissive attempts at this same bug
    // kept finding a zoom level or item shape they didn't cover).
    const items = [
      { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
    ];
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const packed = packLane(items, pxPerMin);
      expect(packed).toHaveLength(1);
      expect(packed[0].kind).toBe('cluster');
    }
  });

  it('still stacks (does not fold) when there is no real pushdown at all', () => {
    // Two items with a genuine natural gap large enough that the
    // predecessor's own (possibly clamped) box never reaches the next
    // item's natural top — zero inherited pushdown, so no fold.
    const pxPerMin = 1.25;
    const items = [
      { start: 480, end: 481, kind: 'single', type: 'block', data: { id: 'Tiny', title: 'Tiny' } }, // 1-min, clamped to 26px = ~20.8 real min at this zoom
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Long', title: 'Long' } }, // starts 59 real min later — comfortably past Tiny's clamped bottom
    ];
    const packed = packLane(items, pxPerMin);
    expect(packed).toHaveLength(2);
    expect(packed.every((p) => p.kind !== 'cluster')).toBe(true);
  });

  it('never produces overlapping boxes even when a fold-triggering pushdown occurs mid-chain', () => {
    const pxPerMin = 0.55;
    const items = [
      { start: 400, end: 405, kind: 'single', type: 'block', data: { id: 'X', title: 'X' } }, // far earlier, unrelated
      { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
    ];
    const packed = packLane(items, pxPerMin);
    for (let i = 1; i < packed.length; i++) {
      expect(packed[i].top).toBeGreaterThanOrEqual(packed[i - 1].top + packed[i - 1].height);
    }
    expect(packed.some((p) => p.kind === 'cluster')).toBe(true);
  });

  it('grows an existing cluster rather than double-folding when a third item also collides', () => {
    const pxPerMin = 0.55;
    const items = [
      { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'A', title: 'A' } },
      { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'B', title: 'B' } },
      { start: 600, end: 602, kind: 'single', type: 'block', data: { id: 'C', title: 'C' } },
    ];
    const packed = packLane(items, pxPerMin);
    // A and B fold together (as in the test above). Whether C also joins
    // depends on how far the merged cluster's bottom pushes past C's natural
    // top — either way there must be no overlap and no more than one cluster
    // absorbing both A and B.
    const clusters = packed.filter((p) => p.kind === 'cluster');
    expect(clusters.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < packed.length; i++) {
      expect(packed[i].top).toBeGreaterThanOrEqual(packed[i - 1].top + packed[i - 1].height);
    }
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
      { start: 478, end: 480, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
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
    // that requires no per-zoom or per-shape tuning, unlike the several
    // more permissive budgets this replaced (see git history and
    // EXCESSIVE_PUSHDOWN_PX's own doc comment).
    const shapes = [
      [
        { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Morning tasks', title: 'Morning tasks' } },
        { start: 540, end: 585, kind: 'single', type: 'block', data: { id: 'Piano', title: 'Piano' } },
      ],
      [
        { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
        { start: 540, end: 600, kind: 'single', type: 'block', data: { id: 'Lower + Running', title: 'Lower + Running' } },
      ],
      [
        { start: 480, end: 481, kind: 'single', type: 'block', data: { id: 'A', title: 'A' } },
        { start: 481, end: 482, kind: 'single', type: 'block', data: { id: 'B', title: 'B' } },
        { start: 482, end: 483, kind: 'single', type: 'block', data: { id: 'C', title: 'C' } },
        { start: 483, end: 500, kind: 'single', type: 'block', data: { id: 'D', title: 'D' } },
      ],
      [
        { start: 538, end: 540, kind: 'single', type: 'block', data: { id: 'Email student', title: 'Email student' } },
        { start: 540, end: 615, kind: 'single', type: 'block', data: { id: 'RealTask', title: 'RealTask' } },
        { start: 615, end: 660, kind: 'single', type: 'block', data: { id: 'Laundry', title: 'Laundry' } },
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

  it('folds once a chain of several short clamped items compounds enough pushdown to exceed the tolerance', () => {
    for (const pxPerMin of [0.55, 0.65, 0.8, 1.0, 1.25]) {
      const items = [
        { start: 480, end: 481, kind: 'single', type: 'block', data: { id: 'A', title: 'A' } },
        { start: 481, end: 482, kind: 'single', type: 'block', data: { id: 'B', title: 'B' } },
        { start: 482, end: 483, kind: 'single', type: 'block', data: { id: 'C', title: 'C' } },
        { start: 483, end: 503, kind: 'single', type: 'block', data: { id: 'D', title: 'D' } }, // 20-min real item
      ];
      const packed = packLane(items, pxPerMin);
      expect(packed.some((p) => p.kind === 'cluster')).toBe(true);
      let prevBottom = -Infinity;
      for (const p of packed) {
        expect(p.top).toBeGreaterThanOrEqual(prevBottom);
        prevBottom = p.top + p.height + 2;
      }
    }
  });
});

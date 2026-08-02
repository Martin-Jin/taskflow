/**
 * ============================================================================
 * Manual "Plan Today" enable/disable — coverage notes
 * ============================================================================
 * Covers `planEnableManualPlanToday`/`planDisableManualPlanToday`, the pure
 * decisions extracted from SchedulerContext.jsx's `toggleManualPlanToday`
 * specifically so they could be unit tested — same "extract the pure
 * decision" pattern useCloudSync.js's computeFingerprint/planRemoteDataMerge
 * use. The hook itself still performs the actual commit()/setState calls;
 * these functions only compute what should be removed/restored.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { planEnableManualPlanToday, planDisableManualPlanToday } from '../../src/context/SchedulerContext.jsx';

describe('planEnableManualPlanToday', () => {
  const todayIso = '2026-08-02';

  it("removes only auto-scheduled blocks dated today, leaving other days' blocks and manual/locked today blocks alone", () => {
    const blocks = [
      { id: 'b1', isAutoScheduled: true, date: todayIso },
      { id: 'b2', isAutoScheduled: false, date: todayIso }, // manual block, stays
      { id: 'b3', isAutoScheduled: true, date: '2026-08-03' }, // different day, stays
      { id: 'b4', isAutoScheduled: true, date: todayIso, isLocked: true }, // still auto-scheduled, still pulled
    ];
    const { removed, remaining } = planEnableManualPlanToday(blocks, todayIso);
    expect(removed.map((b) => b.id).sort()).toEqual(['b1', 'b4']);
    expect(remaining.map((b) => b.id).sort()).toEqual(['b2', 'b3']);
  });

  it('handles no auto-scheduled blocks today (nothing to remove)', () => {
    const blocks = [{ id: 'b1', isAutoScheduled: false, date: todayIso }];
    const { removed, remaining } = planEnableManualPlanToday(blocks, todayIso);
    expect(removed).toEqual([]);
    expect(remaining).toEqual(blocks);
  });
});

describe('planDisableManualPlanToday', () => {
  it('merges back every saved block when none of them collide with current blocks', () => {
    const blocks = [{ id: 'b2' }];
    const saved = [{ id: 'b1' }, { id: 'b4' }];
    const merged = planDisableManualPlanToday(blocks, saved);
    expect(merged.map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b4']);
  });

  it('skips saved blocks whose id already exists in current blocks (avoids duplicating a block something else recreated)', () => {
    const blocks = [{ id: 'b1', recreated: true }];
    const saved = [{ id: 'b1', recreated: false }, { id: 'b4' }];
    const merged = planDisableManualPlanToday(blocks, saved);
    expect(merged).toEqual([{ id: 'b1', recreated: true }, { id: 'b4' }]);
  });

  it('returns the original blocks unchanged when there is nothing saved to restore', () => {
    const blocks = [{ id: 'b2' }];
    expect(planDisableManualPlanToday(blocks, [])).toEqual(blocks);
  });
});

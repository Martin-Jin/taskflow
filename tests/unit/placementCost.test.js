import { describe, it, expect } from 'vitest';
import {
  evaluatePlacementCost,
  PRIORITY_MULTIPLIER,
  FRAG_DAY_PENALTY,
  SMALL_CHUNK_PENALTY,
  SMALL_CHUNK_THRESHOLD_MINS,
  EARLY_REWARD_PER_DAY,
  LATE_PENALTY_PER_DAY_SQUARED,
} from '../../src/algorithms/placementCost';

function block(taskId, date, startTime, endTime, extra = {}) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const durationHours = (eh * 60 + em - (sh * 60 + sm)) / 60;
  return { id: `${taskId}_${date}_${startTime}`, taskId, date, startTime, endTime, durationHours, isLocked: false, isAutoScheduled: true, status: 'scheduled', googleEventId: null, ...extra };
}

const resolveDueDate = (task) => task.dueDate || null;

describe('evaluatePlacementCost: fragmentation term', () => {
  it('charges nothing extra for a task placed as one continuous block on one day', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const blocks = [block('t1', '2026-08-01', '09:00', '10:00')];
    const { byTask } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    expect(byTask.get('t1').fragmentation).toBe(0);
  });

  it('charges (daysUsed - 1) * FRAG_DAY_PENALTY * priorityMultiplier for a task spread across multiple days', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const blocks = [
      block('t1', '2026-08-01', '09:00', '10:00'),
      block('t1', '2026-08-02', '09:00', '10:00'),
      block('t1', '2026-08-03', '09:00', '10:00'),
    ];
    const { byTask } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    // 3 days used -> 2 extra days.
    expect(byTask.get('t1').fragmentation).toBeCloseTo(2 * FRAG_DAY_PENALTY * PRIORITY_MULTIPLIER.medium, 6);
  });

  it('adds a small-chunk penalty per chunk under the threshold, ON TOP OF the day-count term (both apply together)', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    // Two days, and one of the two chunks is a tiny 10-minute sliver.
    const blocks = [
      block('t1', '2026-08-01', '09:00', '09:10'), // 10 min -- under the 15min threshold
      block('t1', '2026-08-02', '09:00', '10:00'), // 60 min -- fine
    ];
    const { byTask } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    const expectedDayTerm = 1 * FRAG_DAY_PENALTY * PRIORITY_MULTIPLIER.medium;
    const expectedSmallChunkTerm = 1 * SMALL_CHUNK_PENALTY * PRIORITY_MULTIPLIER.medium;
    expect(byTask.get('t1').fragmentation).toBeCloseTo(expectedDayTerm + expectedSmallChunkTerm, 6);
  });

  it('scales fragmentation cost by priorityMultiplier -- an urgent task costs more than a low-priority task for the identical placement shape', () => {
    const urgentTask = { id: 'u', priority: 'urgent', dueDate: '2026-08-10' };
    const lowTask = { id: 'l', priority: 'low', dueDate: '2026-08-10' };
    const shape = (id) => [block(id, '2026-08-01', '09:00', '09:10'), block(id, '2026-08-02', '09:00', '10:00')];
    const { byTask } = evaluatePlacementCost([...shape('u'), ...shape('l')], [urgentTask, lowTask], resolveDueDate);
    expect(byTask.get('u').fragmentation).toBeGreaterThan(byTask.get('l').fragmentation);
  });

  it('does not double- or under-count a chunk exactly at the small-chunk threshold boundary', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const blocks = [block('t1', '2026-08-01', '09:00', `09:${String(SMALL_CHUNK_THRESHOLD_MINS).padStart(2, '0')}`)];
    const { byTask } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    // Exactly at the threshold -- should NOT be penalized (only STRICTLY under it is).
    expect(byTask.get('t1').fragmentation).toBe(0);
  });
});

describe('evaluatePlacementCost: due-date term', () => {
  it('rewards (negative cost) finishing early, scaling linearly with days of slack', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const blocks3 = [block('t1', '2026-08-07', '09:00', '10:00')]; // 3 days early
    const blocks1 = [block('t1', '2026-08-09', '09:00', '10:00')]; // 1 day early
    const cost3 = evaluatePlacementCost(blocks3, [task], resolveDueDate).byTask.get('t1').dueDate;
    const cost1 = evaluatePlacementCost(blocks1, [task], resolveDueDate).byTask.get('t1').dueDate;
    expect(cost3).toBeLessThan(cost1); // more slack = more negative = cheaper
    expect(cost3).toBeCloseTo(-3 * EARLY_REWARD_PER_DAY * PRIORITY_MULTIPLIER.medium, 6);
  });

  it('escalates quadratically (not flatly) for finishing after the due date', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const lateBy1 = [block('t1', '2026-08-11', '09:00', '10:00')];
    const lateBy4 = [block('t1', '2026-08-14', '09:00', '10:00')];
    const cost1 = evaluatePlacementCost(lateBy1, [task], resolveDueDate).byTask.get('t1').dueDate;
    const cost4 = evaluatePlacementCost(lateBy4, [task], resolveDueDate).byTask.get('t1').dueDate;
    expect(cost1).toBeCloseTo(LATE_PENALTY_PER_DAY_SQUARED * 1 * 1 * PRIORITY_MULTIPLIER.medium, 6);
    expect(cost4).toBeCloseTo(LATE_PENALTY_PER_DAY_SQUARED * 4 * 4 * PRIORITY_MULTIPLIER.medium, 6);
    // Quadratic escalation: 4 days late costs 16x 1 day late, not 4x (flat/linear would be 4x).
    expect(cost4 / cost1).toBeCloseTo(16, 3);
  });

  it('contributes zero cost for a task with no resolvable due date', () => {
    const task = { id: 't1', priority: 'medium' };
    const blocks = [block('t1', '2026-08-01', '09:00', '10:00')];
    const { byTask } = evaluatePlacementCost(blocks, [task], () => null);
    expect(byTask.get('t1').dueDate).toBe(0);
  });

  it('contributes zero due-date cost (not a penalty) for a task with no blocks at all -- unplaced tasks surface via overflow, not a standalone cost term', () => {
    const task = { id: 't1', priority: 'urgent', dueDate: '2026-08-01' };
    const { byTask } = evaluatePlacementCost([], [task], resolveDueDate);
    expect(byTask.get('t1').dueDate).toBe(0);
    expect(byTask.get('t1').fragmentation).toBe(0);
    expect(byTask.get('t1').total).toBe(0);
  });
});

describe('evaluatePlacementCost: totals and multi-task aggregation', () => {
  it('sums fragmentation + due-date cost per task, and totals across all tasks', () => {
    const task = { id: 't1', priority: 'high', dueDate: '2026-08-05' };
    const blocks = [
      block('t1', '2026-08-01', '09:00', '10:00'),
      block('t1', '2026-08-02', '09:00', '10:00'),
    ];
    const { byTask, total } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    const entry = byTask.get('t1');
    expect(entry.total).toBeCloseTo(entry.fragmentation + entry.dueDate, 9);
    expect(total).toBeCloseTo(entry.total, 9);
  });

  it('ignores blocks belonging to tasks not in the scored task list', () => {
    const task = { id: 't1', priority: 'medium', dueDate: '2026-08-10' };
    const blocks = [block('t1', '2026-08-01', '09:00', '10:00'), block('other', '2026-08-01', '10:00', '11:00')];
    const { byTask } = evaluatePlacementCost(blocks, [task], resolveDueDate);
    expect(byTask.has('other')).toBe(false);
    expect(byTask.get('t1').fragmentation).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { deriveRemainingHoursOnEstimateChange, needsRescheduleOnTaskUpdate } from '../../src/utils/taskFieldDerivations';

describe('deriveRemainingHoursOnEstimateChange', () => {
  it('shifts remainingHours up by the same delta when the estimate increases', () => {
    // 2h remaining out of 5h estimated; estimate raised to 8h -> remaining should also gain 3h.
    expect(deriveRemainingHoursOnEstimateChange(2, 5, 8)).toBe(5);
  });

  it('shifts remainingHours down by the same delta when the estimate decreases', () => {
    // 4h remaining out of 5h estimated; estimate lowered to 3h -> remaining loses 2h too.
    expect(deriveRemainingHoursOnEstimateChange(4, 5, 3)).toBe(2);
  });

  it('adds hours for the scheduler to place when raising the estimate on a fully-scheduled (0 remaining) task', () => {
    expect(deriveRemainingHoursOnEstimateChange(0, 5, 10)).toBe(5);
  });

  it('clamps to the new estimate when the shift would push remaining above it', () => {
    // 5h remaining out of 5h estimated (nothing done yet); estimate lowered to 2h ->
    // naive shift would give 2h too, but also verify the clamp itself against a larger raw overshoot.
    expect(deriveRemainingHoursOnEstimateChange(5, 5, 2)).toBe(2);
    expect(deriveRemainingHoursOnEstimateChange(9, 10, 3)).toBe(2);
  });

  it('clamps at zero rather than going negative when the estimate drops a lot', () => {
    // 1h remaining out of 5h estimated; estimate slashed to 1h -> delta is -4, 1 + -4 = -3, clamped to 0.
    expect(deriveRemainingHoursOnEstimateChange(1, 5, 1)).toBe(0);
  });

  it('leaves remainingHours unchanged when the estimate does not change', () => {
    expect(deriveRemainingHoursOnEstimateChange(3, 5, 5)).toBe(3);
  });
});

describe('needsRescheduleOnTaskUpdate', () => {
  const baseTask = {
    id: 't1',
    dueDate: '2026-08-10',
    estimatedHours: 5,
    earliestDate: null,
    enforceDueDate: false,
    dependsOn: [],
    priority: 'medium',
    isPassive: false,
    fixedTime: null,
    recurrenceString: null,
    isLocked: false,
  };

  it('returns false when there is no previous task', () => {
    expect(needsRescheduleOnTaskUpdate(null, { dueDate: '2026-08-11' }, true)).toBe(false);
  });

  it('returns false when an unrelated field changes', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { title: 'New title' }, true)).toBe(false);
  });

  it('returns false when a scheduling field changes but there is no existing unlocked block', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { dueDate: '2026-08-11' }, false)).toBe(false);
  });

  it('flags a dueDate change with an existing unlocked block', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { dueDate: '2026-08-11' }, true)).toBe(true);
  });

  it('flags an estimatedHours change with an existing unlocked block', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { estimatedHours: 8 }, true)).toBe(true);
  });

  it('flags earliestDate being set (the originally reported bug)', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { earliestDate: '2026-08-12' }, true)).toBe(true);
  });

  it('flags enforceDueDate being toggled on', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { enforceDueDate: true }, true)).toBe(true);
  });

  it('flags dependsOn gaining a new dependency', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { dependsOn: ['t2'] }, true)).toBe(true);
  });

  it('does not flag dependsOn when the array is set to an equivalent value', () => {
    const task = { ...baseTask, dependsOn: ['t2', 't3'] };
    expect(needsRescheduleOnTaskUpdate(task, { dependsOn: ['t2', 't3'] }, true)).toBe(false);
  });

  it('flags a priority change', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { priority: 'high' }, true)).toBe(true);
  });

  it('flags isPassive being toggled', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { isPassive: true }, true)).toBe(true);
  });

  it('flags fixedTime being set', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { fixedTime: '09:00' }, true)).toBe(true);
  });

  it('flags a recurrenceString change even without a dueDate change', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { recurrenceString: 'weekly' }, true)).toBe(true);
  });

  it('flags unlocking a task even with no existing unlocked block (it had none while locked)', () => {
    const lockedTask = { ...baseTask, isLocked: true };
    expect(needsRescheduleOnTaskUpdate(lockedTask, { isLocked: false }, false)).toBe(true);
  });

  it('does not flag locking a task', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { isLocked: true }, true)).toBe(false);
  });

  it('does not flag isLocked already false being redundantly set to false', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { isLocked: false }, true)).toBe(false);
  });

  it('flags turning excludeFromAutoSchedule on, even with an existing block to invalidate', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { excludeFromAutoSchedule: true }, true)).toBe(true);
  });

  it('flags turning excludeFromAutoSchedule off so the task can be placed for the first time', () => {
    const excludedTask = { ...baseTask, excludeFromAutoSchedule: true };
    expect(needsRescheduleOnTaskUpdate(excludedTask, { excludeFromAutoSchedule: false }, false)).toBe(true);
  });

  it('does not flag excludeFromAutoSchedule already false being redundantly set to false', () => {
    expect(needsRescheduleOnTaskUpdate(baseTask, { excludeFromAutoSchedule: false }, true)).toBe(false);
  });

  // assignedTo: a shared-task-only eligibility switch, same idea as
  // excludeFromAutoSchedule but relative to currentUserId (see
  // rebalanceEngine.js's eligibleTasks filter) instead of a plain boolean.
  describe('assignedTo (shared task)', () => {
    const sharedTask = { ...baseTask, sharedProjectId: 'proj1', assignedTo: null };

    it('flags assigning a shared task to the current user (newly eligible)', () => {
      expect(needsRescheduleOnTaskUpdate(sharedTask, { assignedTo: 'user-a' }, false, 'user-a')).toBe(true);
    });

    it('flags unassigning a shared task that was assigned to the current user (newly ineligible)', () => {
      const assignedToMe = { ...sharedTask, assignedTo: 'user-a' };
      expect(needsRescheduleOnTaskUpdate(assignedToMe, { assignedTo: null }, true, 'user-a')).toBe(true);
    });

    it('flags reassigning a shared task away from the current user to someone else', () => {
      const assignedToMe = { ...sharedTask, assignedTo: 'user-a' };
      expect(needsRescheduleOnTaskUpdate(assignedToMe, { assignedTo: 'user-b' }, true, 'user-a')).toBe(true);
    });

    it('does not flag reassigning a shared task between two OTHER collaborators (never eligible for this device either way)', () => {
      const assignedToB = { ...sharedTask, assignedTo: 'user-b' };
      expect(needsRescheduleOnTaskUpdate(assignedToB, { assignedTo: 'user-c' }, false, 'user-a')).toBe(false);
    });

    it('does not flag assignedTo being redundantly re-set to the same value', () => {
      const assignedToMe = { ...sharedTask, assignedTo: 'user-a' };
      expect(needsRescheduleOnTaskUpdate(assignedToMe, { assignedTo: 'user-a' }, true, 'user-a')).toBe(false);
    });

    it('does not flag an assignedTo change on a non-shared (personal) task', () => {
      const personalTask = { ...baseTask, assignedTo: null };
      expect(needsRescheduleOnTaskUpdate(personalTask, { assignedTo: 'user-a' }, false, 'user-a')).toBe(false);
    });
  });
});

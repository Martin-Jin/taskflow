import { describe, it, expect } from 'vitest';
import {
  computeDueDateError,
  computeDueDateRequiredError,
  computeFixedTimeError,
  computeEnforcingAncestor,
} from '../../src/utils/taskValidation';

function tasksById(tasks) {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe('computeDueDateError', () => {
  it('is empty when the task has no parent at all', () => {
    const task = { id: 'a', parentId: null };
    expect(computeDueDateError(task, '2026-08-20', tasksById([task]))).toBe('');
  });

  it('is empty when the ancestor has no due date of its own', () => {
    const parent = { id: 'p', title: 'Parent' };
    const task = { id: 'a', parentId: 'p' };
    expect(computeDueDateError(task, '2026-08-20', tasksById([parent, task]))).toBe('');
  });

  it('is empty when the candidate due date is on or before the ancestor deadline', () => {
    const parent = { id: 'p', title: 'Parent', dueDate: '2026-08-25' };
    const task = { id: 'a', parentId: 'p' };
    expect(computeDueDateError(task, '2026-08-25', tasksById([parent, task]))).toBe('');
    expect(computeDueDateError(task, '2026-08-20', tasksById([parent, task]))).toBe('');
  });

  it('is empty when there is no candidate due date at all', () => {
    const parent = { id: 'p', title: 'Parent', dueDate: '2026-08-25' };
    const task = { id: 'a', parentId: 'p' };
    expect(computeDueDateError(task, '', tasksById([parent, task]))).toBe('');
  });

  it('flags a candidate due date later than the nearest dated ancestor', () => {
    const parent = { id: 'p', title: 'Parent Goal', dueDate: '2026-08-20' };
    const task = { id: 'a', parentId: 'p' };
    const err = computeDueDateError(task, '2026-08-25', tasksById([parent, task]));
    expect(err).toContain('Parent Goal');
    expect(err).toContain("Can't be later than");
  });

  it('walks up to a grandparent for the DEADLINE check when the direct parent has no due date of its own', () => {
    // findNearestAncestorDueDate walks past the undated direct parent to find
    // the grandparent's due date as the effective cap — but the message still
    // names task.parentId's own title (the direct parent), matching
    // TaskDetailModal's original inline behavior this was extracted from
    // verbatim (see commitChanges' `tasks.find((t) => t.id === task.parentId)`).
    const grandparent = { id: 'gp', title: 'Grandparent', dueDate: '2026-08-20' };
    const parent = { id: 'p', title: 'Parent', parentId: 'gp' };
    const task = { id: 'a', parentId: 'p' };
    const err = computeDueDateError(task, '2026-08-25', tasksById([grandparent, parent, task]));
    expect(err).toContain('Parent'); // names the direct parent, not the grandparent whose date is enforced
    expect(err).toContain('20 Aug'); // but the enforced DATE is still the grandparent's
  });
});

describe('computeDueDateRequiredError', () => {
  it('is empty for a non-recurring task regardless of due date', () => {
    expect(computeDueDateRequiredError(false, '')).toBe('');
    expect(computeDueDateRequiredError(false, '2026-08-20')).toBe('');
  });

  it('is empty for a recurring task that has a due date', () => {
    expect(computeDueDateRequiredError(true, '2026-08-20')).toBe('');
  });

  it('flags a recurring task with no due date', () => {
    expect(computeDueDateRequiredError(true, '')).toMatch(/due date/i);
  });
});

describe('computeFixedTimeError', () => {
  it('is empty when fixed time is disabled', () => {
    expect(computeFixedTimeError(false, '')).toBe('');
  });

  it('is empty when fixed time is enabled with a time picked', () => {
    expect(computeFixedTimeError(true, '09:00')).toBe('');
  });

  it('flags fixed time enabled with no time picked yet', () => {
    expect(computeFixedTimeError(true, '')).toMatch(/pick a time/i);
  });
});

describe('computeEnforcingAncestor', () => {
  it('returns null for a task with no parent', () => {
    const task = { id: 'a', parentId: null };
    expect(computeEnforcingAncestor(task, tasksById([task]))).toBeNull();
  });

  it('returns null when no ancestor enforces its due date', () => {
    const parent = { id: 'p', enforceDueDate: false, dueDate: '2026-08-20' };
    const task = { id: 'a', parentId: 'p' };
    expect(computeEnforcingAncestor(task, tasksById([parent, task]))).toBeNull();
  });

  it('returns null when the enforcing ancestor has no due date (nothing to enforce)', () => {
    const parent = { id: 'p', enforceDueDate: true, dueDate: null };
    const task = { id: 'a', parentId: 'p' };
    expect(computeEnforcingAncestor(task, tasksById([parent, task]))).toBeNull();
  });

  it('returns the direct parent when it enforces its own due date', () => {
    const parent = { id: 'p', enforceDueDate: true, dueDate: '2026-08-20' };
    const task = { id: 'a', parentId: 'p' };
    expect(computeEnforcingAncestor(task, tasksById([parent, task]))).toBe(parent);
  });

  it('walks up to a grandparent that enforces its due date', () => {
    const grandparent = { id: 'gp', enforceDueDate: true, dueDate: '2026-08-20' };
    const parent = { id: 'p', parentId: 'gp', enforceDueDate: false };
    const task = { id: 'a', parentId: 'p' };
    expect(computeEnforcingAncestor(task, tasksById([grandparent, parent, task]))).toBe(grandparent);
  });

  it('terminates safely on a corrupted-backup parentId cycle rather than infinite-looping', () => {
    const a = { id: 'a', parentId: 'b' };
    const b = { id: 'b', parentId: 'a' };
    expect(() => computeEnforcingAncestor(a, tasksById([a, b]))).not.toThrow();
    expect(computeEnforcingAncestor(a, tasksById([a, b]))).toBeNull();
  });
});

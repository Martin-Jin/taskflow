import { describe, it, expect } from 'vitest';
import {
  getProjectTaskCount,
  getProjectTotalHours,
  sortProjectsBy,
} from '../../src/utils/projectStats';

describe('getProjectTaskCount', () => {
  it('counts every task with the matching projectId, subtasks included', () => {
    const tasks = [
      { id: 't1', projectId: 'p1' },
      { id: 't2', projectId: 'p1', parentId: 't1' },
      { id: 't3', projectId: 'p2' },
    ];
    expect(getProjectTaskCount('p1', tasks)).toBe(2);
  });

  it('is 0 for a project with no tasks', () => {
    expect(getProjectTaskCount('empty', [{ id: 't1', projectId: 'other' }])).toBe(0);
    expect(getProjectTaskCount('empty', [])).toBe(0);
  });
});

describe('getProjectTotalHours', () => {
  it('sums top-level tasks only, not double-counting a parent + its subtasks', () => {
    const tasks = [
      { id: 'parent', projectId: 'p1', estimatedHours: 10 }, // ignored: has children, rolls up instead
      { id: 'c1', projectId: 'p1', parentId: 'parent', estimatedHours: 3 },
      { id: 'c2', projectId: 'p1', parentId: 'parent', estimatedHours: 4 },
    ];
    // Must equal the children's sum (7), not parent(10) + children(7) = 17.
    expect(getProjectTotalHours('p1', tasks)).toBe(7);
  });

  it('sums plain top-level tasks with no children directly', () => {
    const tasks = [
      { id: 't1', projectId: 'p1', estimatedHours: 2 },
      { id: 't2', projectId: 'p1', estimatedHours: 5 },
    ];
    expect(getProjectTotalHours('p1', tasks)).toBe(7);
  });

  it('treats a subtask whose parent is in a different project as top-level', () => {
    const tasks = [
      { id: 'parent', projectId: 'other', estimatedHours: 10 },
      { id: 'sub', projectId: 'p1', parentId: 'parent', estimatedHours: 4 },
    ];
    expect(getProjectTotalHours('p1', tasks)).toBe(4);
  });

  it('is 0 for a project with no tasks', () => {
    expect(getProjectTotalHours('empty', [])).toBe(0);
  });

  it('handles a mix of top-level tasks and a parent/children group', () => {
    const tasks = [
      { id: 'solo', projectId: 'p1', estimatedHours: 1 },
      { id: 'parent', projectId: 'p1', estimatedHours: 99 },
      { id: 'c1', projectId: 'p1', parentId: 'parent', estimatedHours: 2 },
      { id: 'c2', projectId: 'p1', parentId: 'parent', estimatedHours: 3 },
    ];
    // solo(1) + children(2+3) = 6, parent's own 99 must not be counted.
    expect(getProjectTotalHours('p1', tasks)).toBe(6);
  });
});

describe('sortProjectsBy', () => {
  const tasks = [
    { id: 't1', projectId: 'small', estimatedHours: 1 },
    { id: 't2', projectId: 'medium', estimatedHours: 5 },
    { id: 't3', projectId: 'medium', estimatedHours: 5 },
    { id: 't4', projectId: 'large', estimatedHours: 20 },
    { id: 't5', projectId: 'large', estimatedHours: 20 },
    { id: 't6', projectId: 'large', estimatedHours: 20 },
  ];
  const projects = [
    { id: 'small', name: 'Small', order: 3 },
    { id: 'medium', name: 'Medium', order: 1 },
    { id: 'large', name: 'Large', order: 2 },
    { id: 'empty', name: 'Empty', order: 4 },
  ];

  it('does not mutate the input array', () => {
    const original = [...projects];
    sortProjectsBy(projects, tasks, 'size');
    expect(projects).toEqual(original);
  });

  it('sorts by size descending by default (biggest first)', () => {
    const result = sortProjectsBy(projects, tasks, 'size');
    expect(result.map((p) => p.id)).toEqual(['large', 'medium', 'small', 'empty']);
  });

  it('sorts by size ascending when requested', () => {
    const result = sortProjectsBy(projects, tasks, 'size', { ascending: true });
    expect(result.map((p) => p.id)).toEqual(['empty', 'small', 'medium', 'large']);
  });

  it('sorts by duration descending by default', () => {
    const result = sortProjectsBy(projects, tasks, 'duration');
    expect(result.map((p) => p.id)).toEqual(['large', 'medium', 'small', 'empty']);
  });

  it('sorts by duration ascending when requested', () => {
    const result = sortProjectsBy(projects, tasks, 'duration', { ascending: true });
    expect(result.map((p) => p.id)).toEqual(['empty', 'small', 'medium', 'large']);
  });

  it('sorts by created (order field) descending by default — newest first', () => {
    const result = sortProjectsBy(projects, tasks, 'created');
    expect(result.map((p) => p.id)).toEqual(['empty', 'small', 'large', 'medium']);
  });

  it('sorts by created ascending when requested — oldest first', () => {
    const result = sortProjectsBy(projects, tasks, 'created', { ascending: true });
    expect(result.map((p) => p.id)).toEqual(['medium', 'large', 'small', 'empty']);
  });

  it('handles an empty projects array', () => {
    expect(sortProjectsBy([], tasks, 'size')).toEqual([]);
  });
});

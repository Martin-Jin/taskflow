import { describe, it, expect } from 'vitest';
import {
  areDependenciesMet,
  getDependentsMap,
  getIneligibleDependencyIds,
} from '../../src/utils/dependencyUtils';

function taskById(tasks) {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe('areDependenciesMet', () => {
  it('is met when the task has no dependsOn at all', () => {
    const task = { id: 'a' };
    expect(areDependenciesMet(task, taskById([task]))).toBe(true);
  });

  it('is met when dependsOn is an empty array', () => {
    const task = { id: 'a', dependsOn: [] };
    expect(areDependenciesMet(task, taskById([task]))).toBe(true);
  });

  it('is met when every dependency is completed', () => {
    const dep = { id: 'b', isCompleted: true };
    const task = { id: 'a', dependsOn: ['b'] };
    expect(areDependenciesMet(task, taskById([task, dep]))).toBe(true);
  });

  it('is not met when a dependency is incomplete', () => {
    const dep = { id: 'b', isCompleted: false };
    const task = { id: 'a', dependsOn: ['b'] };
    expect(areDependenciesMet(task, taskById([task, dep]))).toBe(false);
  });

  it('is not met when a dependency id does not resolve to any task', () => {
    const task = { id: 'a', dependsOn: ['missing'] };
    expect(areDependenciesMet(task, taskById([task]))).toBe(false);
  });

  it('requires ALL dependencies to be completed, not just one of several', () => {
    const depDone = { id: 'b', isCompleted: true };
    const depNotDone = { id: 'c', isCompleted: false };
    const task = { id: 'a', dependsOn: ['b', 'c'] };
    expect(areDependenciesMet(task, taskById([task, depDone, depNotDone]))).toBe(false);
  });
});

describe('getDependentsMap', () => {
  it('builds an empty map when no task has dependencies', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }];
    const map = getDependentsMap(tasks);
    expect(map.size).toBe(0);
  });

  it('maps a blocker id to the list of tasks depending on it', () => {
    const tasks = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'c', dependsOn: ['b'] },
      { id: 'b' },
    ];
    const map = getDependentsMap(tasks);
    expect(map.get('b')).toEqual(expect.arrayContaining(['a', 'c']));
    expect(map.get('b')).toHaveLength(2);
  });

  it('handles a chain of dependencies (a depends on b depends on c)', () => {
    const tasks = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['c'] },
      { id: 'c' },
    ];
    const map = getDependentsMap(tasks);
    expect(map.get('c')).toEqual(['b']);
    expect(map.get('b')).toEqual(['a']);
  });
});

describe('getIneligibleDependencyIds', () => {
  it('always includes the task itself (cannot depend on itself)', () => {
    const tasks = [{ id: 'a' }];
    const ineligible = getIneligibleDependencyIds('a', tasks);
    expect(ineligible.has('a')).toBe(true);
  });

  it('excludes an unrelated task with no dependency relationship', () => {
    const tasks = [{ id: 'a' }, { id: 'z' }];
    const ineligible = getIneligibleDependencyIds('a', tasks);
    expect(ineligible.has('z')).toBe(false);
  });

  it('marks a direct dependent as ineligible (would create an immediate 2-cycle)', () => {
    // b depends on a -> offering a as a dependency of b is fine, but offering
    // b as a dependency of a would create a cycle (a -> b -> a).
    const tasks = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }];
    const ineligible = getIneligibleDependencyIds('a', tasks);
    expect(ineligible.has('b')).toBe(true);
  });

  it('marks a transitive dependent chain as ineligible (a <- b <- c)', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ];
    const ineligible = getIneligibleDependencyIds('a', tasks);
    expect(ineligible.has('a')).toBe(true);
    expect(ineligible.has('b')).toBe(true);
    expect(ineligible.has('c')).toBe(true);
  });

  it('terminates and returns correctly even when an actual A<->B cycle already exists in the data', () => {
    // A depends on B and B depends on A - a pre-existing cycle in the data.
    // The BFS/DFS must not infinite-loop on this.
    const tasks = [
      { id: 'A', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
    ];
    let ineligible;
    expect(() => {
      ineligible = getIneligibleDependencyIds('A', tasks);
    }).not.toThrow();
    expect(ineligible.has('A')).toBe(true);
    expect(ineligible.has('B')).toBe(true);
  });

  it('terminates on a longer existing cycle (A -> B -> C -> A)', () => {
    const tasks = [
      { id: 'A', dependsOn: ['C'] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    let ineligible;
    expect(() => {
      ineligible = getIneligibleDependencyIds('A', tasks);
    }).not.toThrow();
    expect(ineligible).toEqual(new Set(['A', 'B', 'C']));
  });

  it('does not mark a sibling task (depends on the same blocker but unrelated to the target) as ineligible', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'sibling', dependsOn: ['a'] },
    ];
    // Checking eligibility for 'b': sibling also depends on 'a' but not on
    // 'b', so it shouldn't be blocked from being a future dependency of 'b'.
    const ineligible = getIneligibleDependencyIds('b', tasks);
    expect(ineligible.has('sibling')).toBe(false);
  });
});

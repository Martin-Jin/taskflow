import { describe, it, expect } from 'vitest';
import { ALL_TASKS_PROJECT_ID, INBOX_PROJECT_ID, filterTasksByProject } from '../../src/utils/projectConstants';

describe('filterTasksByProject', () => {
  const tasks = [
    { id: 't1', projectId: 'p1' },
    { id: 't2', projectId: 'p2' },
    { id: 't3', projectId: null },
    { id: 't4' }, // no projectId key at all
    { id: 't5', projectId: '' },
  ];

  it('ALL_TASKS_PROJECT_ID returns every task unfiltered', () => {
    expect(filterTasksByProject(tasks, ALL_TASKS_PROJECT_ID)).toEqual(tasks);
  });

  it('a real projectId returns only tasks with a matching projectId', () => {
    expect(filterTasksByProject(tasks, 'p1')).toEqual([{ id: 't1', projectId: 'p1' }]);
  });

  it('INBOX_PROJECT_ID returns only tasks with no projectId (null, undefined, or empty string)', () => {
    const result = filterTasksByProject(tasks, INBOX_PROJECT_ID);
    expect(result.map((t) => t.id)).toEqual(['t3', 't4', 't5']);
  });

  it('INBOX_PROJECT_ID is empty when every task has a real project', () => {
    const allAssigned = [
      { id: 't1', projectId: 'p1' },
      { id: 't2', projectId: 'p2' },
    ];
    expect(filterTasksByProject(allAssigned, INBOX_PROJECT_ID)).toEqual([]);
  });
});

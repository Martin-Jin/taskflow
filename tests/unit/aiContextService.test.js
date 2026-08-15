import { describe, it, expect } from 'vitest';
import { buildAIContext, filterContextData } from '../../src/services/aiContextService';

const projects = [
  { id: 'p1', name: 'Work' },
  { id: 'p2', name: 'Home' },
];
const sections = [
  { id: 's1', name: 'Todo', projectId: 'p1' },
  { id: 's2', name: 'Chores', projectId: 'p2' },
];
const labels = [{ id: 'l1', name: 'Urgent' }];
const tasks = [
  { id: 't1', title: 'Work task', projectId: 'p1', isCompleted: false },
  { id: 't2', title: 'Home task', projectId: 'p2', isCompleted: false },
];
const events = [
  { id: 'e1', title: 'Early', date: '2026-08-01' },
  { id: 'e2', title: 'Mid', date: '2026-08-15' },
  { id: 'e3', title: 'Late', date: '2026-09-01' },
];

const fullData = { tasks, projects, sections, labels, events };

describe('filterContextData', () => {
  it('mode "full" (or omitted) returns the arrays unchanged', () => {
    expect(filterContextData(fullData, { mode: 'full' })).toEqual(fullData);
    expect(filterContextData(fullData, undefined)).toEqual(fullData);
  });

  it('mode "none" empties every array, including labels', () => {
    const result = filterContextData(fullData, { mode: 'none' });
    expect(result).toEqual({ tasks: [], projects: [], sections: [], labels: [], events: [] });
  });

  it('mode "custom" with no sub-filters behaves like full (no restriction)', () => {
    const result = filterContextData(fullData, { mode: 'custom' });
    expect(result).toEqual(fullData);
  });

  it('mode "custom" with a projectId restricts projects/sections/tasks to that project, but not labels', () => {
    const result = filterContextData(fullData, { mode: 'custom', projectId: 'p1' });
    expect(result.projects).toEqual([{ id: 'p1', name: 'Work' }]);
    expect(result.sections).toEqual([{ id: 's1', name: 'Todo', projectId: 'p1' }]);
    expect(result.tasks).toEqual([{ id: 't1', title: 'Work task', projectId: 'p1', isCompleted: false }]);
    expect(result.labels).toEqual(labels);
    // Events have no projectId — a project filter must never touch them.
    expect(result.events).toEqual(events);
  });

  it('mode "custom" with an event date range restricts only events', () => {
    const result = filterContextData(fullData, { mode: 'custom', eventStart: '2026-08-01', eventEnd: '2026-08-31' });
    expect(result.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.tasks).toEqual(tasks);
    expect(result.projects).toEqual(projects);
  });

  it('mode "custom" combines an independent project filter and event date range', () => {
    const result = filterContextData(fullData, { mode: 'custom', projectId: 'p2', eventStart: '2026-08-10', eventEnd: '2026-08-20' });
    expect(result.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(result.events.map((e) => e.id)).toEqual(['e2']);
  });

  it('a one-sided event range (only eventStart) is an open-ended lower bound', () => {
    const result = filterContextData(fullData, { mode: 'custom', eventStart: '2026-08-15' });
    expect(result.events.map((e) => e.id)).toEqual(['e2', 'e3']);
  });
});

describe('buildAIContext — reduced-context instructions addendum', () => {
  it('omits the addendum for full context (default)', () => {
    const { markdown } = buildAIContext({ ...fullData, today: '2026-08-16' });
    expect(markdown).not.toMatch(/Limited context/);
  });

  it('includes the addendum whenever scope.mode is not "full"', () => {
    const noneMd = buildAIContext({ ...fullData, today: '2026-08-16', scope: { mode: 'none' } }).markdown;
    expect(noneMd).toMatch(/Limited context/);
    const customMd = buildAIContext({ ...fullData, today: '2026-08-16', scope: { mode: 'custom', projectId: 'p1' } }).markdown;
    expect(customMd).toMatch(/Limited context/);
  });
});

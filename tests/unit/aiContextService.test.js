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

const notes = [
  { id: 'n1', title: 'Packing list', body: '- socks' },
  { id: 'n2', title: 'Meeting notes', body: 'shipped v1' },
];

// Notes are opt-in per request, so the "no notes" shape (an empty notes array)
// is the DEFAULT everywhere below — only the includeNotes tests pass them on.
const fullData = { tasks, projects, sections, labels, events, notes };
const fullDataNoNotes = { ...fullData, notes: [] };

describe('filterContextData', () => {
  it('mode "full" (or omitted) returns the arrays unchanged', () => {
    expect(filterContextData(fullData, { mode: 'full' })).toEqual(fullDataNoNotes);
    expect(filterContextData(fullData, undefined)).toEqual(fullDataNoNotes);
  });

  it('mode "none" empties every array, including labels', () => {
    const result = filterContextData(fullData, { mode: 'none' });
    expect(result).toEqual({ tasks: [], projects: [], sections: [], labels: [], events: [], notes: [] });
  });

  it('mode "custom" with no sub-filters behaves like full (no restriction)', () => {
    const result = filterContextData(fullData, { mode: 'custom' });
    expect(result).toEqual(fullDataNoNotes);
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

describe('filterContextData — notes are opt-in', () => {
  it('drops notes unless includeNotes is set, in every mode', () => {
    expect(filterContextData(fullData, { mode: 'full' }).notes).toEqual([]);
    expect(filterContextData(fullData, { mode: 'custom', projectId: 'p1' }).notes).toEqual([]);
    expect(filterContextData(fullData, undefined).notes).toEqual([]);
  });

  it('passes notes through untouched when includeNotes is set', () => {
    expect(filterContextData(fullData, { mode: 'full', includeNotes: true }).notes).toEqual(notes);
    // A project filter must not touch notes — a note belongs to a notes folder,
    // not a project.
    expect(filterContextData(fullData, { mode: 'custom', projectId: 'p1', includeNotes: true }).notes).toEqual(notes);
  });

  it('"no context" beats includeNotes — nothing at all means nothing at all', () => {
    expect(filterContextData(fullData, { mode: 'none', includeNotes: true }).notes).toEqual([]);
  });
});

describe('buildAIContext — notes section', () => {
  it('lists the notes it was given when includeNotes is set', () => {
    const { markdown } = buildAIContext({ ...fullData, today: '2026-08-20', scope: { mode: 'full', includeNotes: true } });
    expect(markdown).toMatch(/## Existing notes \(2 total\)/);
    expect(markdown).toContain('Packing list');
  });

  it('says notes were deliberately withheld rather than showing an empty list', () => {
    const { markdown } = buildAIContext({ ...fullData, today: '2026-08-20', scope: { mode: 'full' } });
    expect(markdown).toMatch(/chose not to send their notes/);
    expect(markdown).not.toContain('Packing list');
    // "0 total" would read as "this user has no notes", a different claim.
    expect(markdown).not.toMatch(/Existing notes \(0 total\)/);
  });
});

/**
 * Coverage for search operators. Two things here are easy to get wrong by
 * reading the code and hard to notice in the UI: the multi-word `due:` phrase
 * having to consume the right number of tokens (so `due:end of month report`
 * still searches for "report"), and every operator staying unambiguous enough
 * that a plain word search never gets hijacked.
 */

import { describe, it, expect } from 'vitest';
import { parseSearchQuery, taskMatchesParsedQuery } from '../../src/utils/searchQuery';

// Fixed reference so date operators don't rot (see googleCalendarSyncRetry's
// own hardcoded-date lesson). 2026-09-15 is a Tuesday.
const REF = new Date(2026, 8, 15);
const parse = (q) => parseSearchQuery(q, { referenceDate: REF });

const LABELS = [
  { id: 'l1', name: 'errand' },
  { id: 'l2', name: 'deep-work' },
];
const PROJECTS = [
  { id: 'p1', name: 'Work' },
  { id: 'p2', name: 'Personal' },
];
const CTX = { labels: LABELS, projects: PROJECTS, today: '2026-09-15' };

const task = (over = {}) => ({
  id: 't',
  title: 'Write the report',
  notes: '',
  priority: 'medium',
  dueDate: '2026-09-20',
  projectId: 'p1',
  labelIds: [],
  isCompleted: false,
  ...over,
});

const matches = (q, over) => taskMatchesParsedQuery(task(over), parse(q), CTX);

describe('parseSearchQuery — plain text is untouched', () => {
  it('reports no operators for ordinary text', () => {
    const p = parse('write the report');
    expect(p.hasOperators).toBe(false);
    expect(p.text).toBe('write the report');
  });

  it('treats an empty query as matching everything', () => {
    expect(parse('').hasOperators).toBe(false);
    expect(parse('   ').text).toBe('');
  });

  it('does not steal a bare word that looks like an operator', () => {
    // The whole reason every operator is sigil- or colon-prefixed: a task
    // genuinely called "Overdue invoices" must still be findable.
    const p = parse('overdue invoices');
    expect(p.overdue).toBe(false);
    expect(p.text).toBe('overdue invoices');
    expect(matches('overdue invoices', { title: 'Overdue invoices' })).toBe(true);
  });

  it('leaves an unrecognised colon token as free text', () => {
    const p = parse('ratio:widgets');
    expect(p.hasOperators).toBe(false);
    expect(p.text).toBe('ratio:widgets');
  });
});

describe('parseSearchQuery — operators', () => {
  it('reads p1-p4 as priorities', () => {
    expect(parse('p1').priorities).toEqual(['urgent']);
    expect(parse('p4').priorities).toEqual(['low']);
    expect(parse('p1 p2').priorities).toEqual(['urgent', 'high']);
  });

  it('reads @tag and #project', () => {
    const p = parse('@errand #work');
    expect(p.tags).toEqual(['errand']);
    expect(p.projects).toEqual(['work']);
  });

  it('reads is: forms', () => {
    expect(parse('is:overdue').overdue).toBe(true);
    expect(parse('is:done').completed).toBe(true);
    expect(parse('is:completed').completed).toBe(true);
    expect(parse('is:open').completed).toBe(false);
  });

  it('reads no: forms and their aliases', () => {
    expect(parse('no:date').missing).toEqual(['date']);
    expect(parse('no:due').missing).toEqual(['date']);
    expect(parse('no:tag').missing).toEqual(['label']);
    expect(parse('no:project').missing).toEqual(['project']);
  });

  it('reads single-word due: values through the shared date parser', () => {
    expect(parse('due:today').dueOn).toBe('2026-09-15');
    expect(parse('due:tomorrow').dueOn).toBe('2026-09-16');
    expect(parse('due:2026-12-01').dueOn).toBe('2026-12-01');
  });

  it('reads a multi-word due: phrase and consumes exactly its own words', () => {
    // The bug this guards: "report" being swallowed into the date phrase, or
    // "of month" being left behind as free text that matches nothing.
    const p = parse('due:end of month report');
    expect(p.dueOn).toBe('2026-09-30');
    expect(p.text).toBe('report');
  });

  it('keeps text either side of an operator', () => {
    const p = parse('quarterly p1 deck');
    expect(p.priorities).toEqual(['urgent']);
    expect(p.text).toBe('quarterly deck');
  });

  it('falls back to free text when due: has no parseable date', () => {
    const p = parse('due:someday');
    expect(p.dueOn).toBeNull();
    expect(p.text).toBe('due:someday');
  });
});

describe('taskMatchesParsedQuery', () => {
  it('matches free text against title, notes and section', () => {
    expect(matches('report')).toBe(true);
    expect(matches('missing')).toBe(false);
    expect(matches('groceries', { notes: 'buy groceries' })).toBe(true);
    expect(matches('backlog', { sectionName: 'Backlog' })).toBe(true);
  });

  it('filters by priority, OR within the group', () => {
    expect(matches('p1', { priority: 'urgent' })).toBe(true);
    expect(matches('p1', { priority: 'low' })).toBe(false);
    expect(matches('p1 p4', { priority: 'low' })).toBe(true);
  });

  it('ANDs tags, because a task can carry several', () => {
    expect(matches('@errand', { labelIds: ['l1'] })).toBe(true);
    expect(matches('@errand @deep', { labelIds: ['l1'] })).toBe(false);
    expect(matches('@errand @deep', { labelIds: ['l1', 'l2'] })).toBe(true);
  });

  it('ORs projects, because a task only has one', () => {
    // AND'ing two project filters could only ever match nothing.
    expect(matches('#work')).toBe(true);
    expect(matches('#personal')).toBe(false);
    expect(matches('#work #personal')).toBe(true);
  });

  it('ANDs across different groups', () => {
    expect(matches('#work p1', { priority: 'urgent' })).toBe(true);
    expect(matches('#personal p1', { priority: 'urgent' })).toBe(false);
  });

  it('matches due: on an exact date', () => {
    expect(matches('due:2026-09-20')).toBe(true);
    expect(matches('due:2026-09-21')).toBe(false);
  });

  it('treats overdue as past and unfinished', () => {
    expect(matches('is:overdue', { dueDate: '2026-09-01' })).toBe(true);
    expect(matches('is:overdue', { dueDate: '2026-09-20' })).toBe(false);
    // Due today is not overdue.
    expect(matches('is:overdue', { dueDate: '2026-09-15' })).toBe(false);
    // A finished task is history, not a problem.
    expect(matches('is:overdue', { dueDate: '2026-09-01', isCompleted: true })).toBe(false);
    expect(matches('is:overdue', { dueDate: null })).toBe(false);
  });

  it('filters on completion state in both directions', () => {
    expect(matches('is:done', { isCompleted: true })).toBe(true);
    expect(matches('is:done', { isCompleted: false })).toBe(false);
    expect(matches('is:open', { isCompleted: false })).toBe(true);
    expect(matches('is:open', { isCompleted: true })).toBe(false);
  });

  it('finds tasks missing a field', () => {
    expect(matches('no:date', { dueDate: null })).toBe(true);
    expect(matches('no:date')).toBe(false);
    expect(matches('no:label')).toBe(true);
    expect(matches('no:label', { labelIds: ['l1'] })).toBe(false);
    expect(matches('no:project', { projectId: null })).toBe(true);
    expect(matches('no:project')).toBe(false);
  });

  it('combines an operator with free text', () => {
    expect(matches('p1 report', { priority: 'urgent' })).toBe(true);
    expect(matches('p1 invoice', { priority: 'urgent' })).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(matches('')).toBe(true);
  });
});

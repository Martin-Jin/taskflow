import { describe, it, expect } from 'vitest';
import { parseTaskText, findLinkPhrases } from '../../src/utils/smartParse';

// parseTaskText's due-date detection (via findDuePhrase) has no injectable
// reference date, so these tests deliberately stick to "tomorrow"/"today" —
// phrases whose resolved value is always correct relative to whatever day
// the suite actually runs on, so nothing here is flaky.

describe('parseTaskText', () => {
  it('detects a due date, project, label, and link all combined in one string', () => {
    const projects = [{ id: 'p1', name: 'Work' }];
    const { cleanedTitle, detected } = parseTaskText(
      'Design homepage tomorrow #Work @urgent https://example.com',
      { projects }
    );

    expect(detected.dueDate).toBeTruthy();
    expect(detected.dueDate.matchedText).toBe('tomorrow');
    expect(detected.link).toEqual({ url: 'https://example.com', matchedText: 'https://example.com', index: expect.any(Number) });
    expect(detected.project.project).toEqual(projects[0]);
    expect(detected.labels).toEqual([{ name: 'urgent', matchedText: '@urgent', index: expect.any(Number) }]);
    expect(cleanedTitle).toBe('Design homepage');
  });

  it('resolves the longest matching project name first when one project name is a prefix of another', () => {
    const projects = [
      { id: 'p1', name: 'Work' },
      { id: 'p2', name: 'Work Trip' },
    ];
    const { cleanedTitle, detected } = parseTaskText('Book flights #Work Trip', { projects });

    expect(detected.project.project).toEqual(projects[1]);
    expect(detected.project.fragment).toBe('Work Trip');
    expect(cleanedTitle).toBe('Book flights');
  });

  it('detects both a due date and an independent fixed time in the same string', () => {
    const { detected, cleanedTitle } = parseTaskText('Call client at 3pm tomorrow');

    expect(detected.dueDate.matchedText).toBe('tomorrow');
    expect(detected.fixedTime).toEqual({ time: '15:00', matchedText: 'at 3pm', index: expect.any(Number) });
    expect(cleanedTitle).toBe('Call client');
  });

  it('detects priority shorthand alongside a due date without either interfering with the other', () => {
    const { detected, cleanedTitle } = parseTaskText('Submit report tomorrow p2');

    expect(detected.dueDate.matchedText).toBe('tomorrow');
    expect(detected.priority).toEqual({ level: 'high', matchedText: 'p2', index: expect.any(Number) });
    expect(cleanedTitle).toBe('Submit report');
  });

  it('leaves a trailing "#project"/"@label" mention alone for a dependency fragment bounded at "after"', () => {
    const existingTasks = [{ id: 't1', title: 'Design review' }];
    const { detected, cleanedTitle } = parseTaskText('Ship release after Design review #Writing', {
      existingTasks,
      projects: [{ id: 'p1', name: 'Writing' }],
    });

    expect(detected.dependency.task).toEqual(existingTasks[0]);
    expect(detected.dependency.fragment).toBe('Design review');
    expect(detected.project.project).toEqual({ id: 'p1', name: 'Writing' });
    expect(cleanedTitle).toBe('Ship release');
  });

  it('resolves an exact title match for "sub of <task>"', () => {
    const existingTasks = [{ id: 't1', title: 'Video Assignment' }, { id: 't2', title: 'Essay Assignment' }];
    const { detected, cleanedTitle } = parseTaskText('Draft script sub of Video Assignment', { existingTasks });

    expect(detected.subOf.task).toEqual(existingTasks[0]);
    expect(detected.subOf.fragment).toBe('Video Assignment');
    expect(cleanedTitle).toBe('Draft script');
  });

  it('resolves an unambiguous fuzzy/substring match for "subtask of <task>"', () => {
    const existingTasks = [{ id: 't1', title: 'Video Assignment for Class' }];
    const { detected, cleanedTitle } = parseTaskText('Draft script subtask of Video Assignment', { existingTasks });

    expect(detected.subOf.task).toEqual(existingTasks[0]);
    expect(cleanedTitle).toBe('Draft script');
  });

  it('returns a null task with the raw fragment preserved when "sub of <task>" is ambiguous or has no match', () => {
    const existingTasks = [{ id: 't1', title: 'Video Assignment' }, { id: 't2', title: 'Video Assignment Two' }];
    const { detected } = parseTaskText('Draft script sub of Video Assignment', { existingTasks: [] });
    expect(detected.subOf.task).toBeNull();
    expect(detected.subOf.fragment).toBe('Video Assignment');

    const ambiguous = parseTaskText('Draft script sub of Video', { existingTasks });
    expect(ambiguous.detected.subOf.task).toBeNull();
    expect(ambiguous.detected.subOf.fragment).toBe('Video');
  });

  it('leaves a trailing "#project"/"@label" mention alone for a "sub of" fragment bounded at the trigger', () => {
    const existingTasks = [{ id: 't1', title: 'Design review' }];
    const { detected, cleanedTitle } = parseTaskText('Draft script sub of Design review #Writing', {
      existingTasks,
      projects: [{ id: 'p1', name: 'Writing' }],
    });

    expect(detected.subOf.task).toEqual(existingTasks[0]);
    expect(detected.subOf.fragment).toBe('Design review');
    expect(detected.project.project).toEqual({ id: 'p1', name: 'Writing' });
    expect(cleanedTitle).toBe('Draft script');
  });

  it('returns plain text with no detections and an unmodified cleanedTitle when nothing matches', () => {
    const result = parseTaskText('Buy groceries and cook dinner');
    expect(result.detected).toEqual({});
    expect(result.cleanedTitle).toBe('Buy groceries and cook dinner');
  });

  it('returns an empty result for blank/whitespace-only input', () => {
    expect(parseTaskText('')).toEqual({ cleanedTitle: '', detected: {} });
    expect(parseTaskText('   ')).toEqual({ cleanedTitle: '   ', detected: {} });
  });

  it('creates a label detection even when no existing label/task/project matches it', () => {
    const result = parseTaskText('Water the plants @home');
    expect(result.detected.labels).toEqual([{ name: 'home', matchedText: '@home', index: 17 }]);
    expect(result.detected.project).toBeUndefined();
    expect(result.cleanedTitle).toBe('Water the plants');
  });

  it('detects multiple labels in the same title', () => {
    const result = parseTaskText('Plan trip @errand @urgent');
    expect(result.detected.labels.map((l) => l.name)).toEqual(['errand', 'urgent']);
    expect(result.cleanedTitle).toBe('Plan trip');
  });

  it('detects a bare "unattended" mention and an enforce-due-date phrase together', () => {
    const result = parseTaskText('Backup script tomorrow unattended hard deadline');
    expect(result.detected.unattended).toEqual({ matchedText: 'unattended', index: expect.any(Number) });
    expect(result.detected.enforceDueDate).toEqual({ matchedText: 'hard deadline', index: expect.any(Number) });
    expect(result.cleanedTitle).toBe('Backup script');
  });

  it('detects a "not before <date>" earliest-date phrase and strips the full trigger+date span', () => {
    const result = parseTaskText('Draft proposal not before tomorrow');
    expect(result.detected.earliestDate).toBeTruthy();
    expect(result.detected.earliestDate.matchedText).toBe('not before tomorrow');
    expect(result.cleanedTitle).toBe('Draft proposal');
  });

  it('detects "don\'t start until <date>" as an earliest-date phrase', () => {
    const result = parseTaskText("Write report don't start until tomorrow");
    expect(result.detected.earliestDate).toBeTruthy();
    expect(result.detected.earliestDate.matchedText).toBe("don't start until tomorrow");
    expect(result.cleanedTitle).toBe('Write report');
  });

  it('does not detect an earliest date when the trigger phrase has no parseable date after it', () => {
    const result = parseTaskText('Draft proposal not before lunch');
    expect(result.detected.earliestDate).toBeUndefined();
    expect(result.cleanedTitle).toBe('Draft proposal not before lunch');
  });

  it('does not mistake incidental "before"/"until" text for the earliest-date trigger', () => {
    const result = parseTaskText('Finish before lunch');
    expect(result.detected.earliestDate).toBeUndefined();
    expect(result.cleanedTitle).toBe('Finish before lunch');
  });

  it('does not confuse "no earlier" (enforce due date) with "no sooner than <date>" (earliest date)', () => {
    const result = parseTaskText('Renew passport tomorrow no earlier no sooner than next week');
    expect(result.detected.enforceDueDate).toEqual({ matchedText: 'no earlier', index: expect.any(Number) });
    expect(result.detected.earliestDate).toBeTruthy();
    expect(result.detected.earliestDate.matchedText).toBe('no sooner than next week');
  });

  it('detects "!noauto" as an exclude-from-auto-schedule mention and strips it', () => {
    const result = parseTaskText('Water the garden !noauto');
    expect(result.detected.excludeFromAutoSchedule).toEqual({ matchedText: '!noauto', index: expect.any(Number) });
    expect(result.cleanedTitle).toBe('Water the garden');
  });

  it('also accepts "!manual" for the same exclude-from-auto-schedule mention', () => {
    const result = parseTaskText('Water the garden !manual');
    expect(result.detected.excludeFromAutoSchedule).toEqual({ matchedText: '!manual', index: expect.any(Number) });
    expect(result.cleanedTitle).toBe('Water the garden');
  });

  it('does not detect exclude-from-auto-schedule when there is no "!" trigger', () => {
    const result = parseTaskText('Water the garden manually noauto');
    expect(result.detected.excludeFromAutoSchedule).toBeUndefined();
  });
});

describe('parseTaskText — "%section" shorthand', () => {
  it('resolves a unique exact-name match across all projects, with the owning project attached', () => {
    const projects = [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }];
    const sections = [
      { id: 's1', name: 'Groceries', projectId: 'p1' },
      { id: 's2', name: 'Inbox', projectId: 'p2' },
    ];
    const { detected, cleanedTitle } = parseTaskText('Buy milk %Groceries', { projects, sections });

    expect(detected.sectionShorthand.section).toEqual(sections[0]);
    expect(detected.sectionShorthand.project).toEqual(projects[0]);
    expect(detected.sectionShorthand.candidates).toEqual([]);
    expect(cleanedTitle).toBe('Buy milk');
  });

  it('resolves an unambiguous substring match', () => {
    const projects = [{ id: 'p1', name: 'Home' }];
    const sections = [{ id: 's1', name: 'Groceries List', projectId: 'p1' }];
    const { detected } = parseTaskText('Buy milk %Groc', { projects, sections });

    expect(detected.sectionShorthand.section).toEqual(sections[0]);
    expect(detected.sectionShorthand.project).toEqual(projects[0]);
  });

  it('returns every candidate when multiple projects share an exact-name section, without picking one', () => {
    const projects = [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }];
    const sections = [
      { id: 's1', name: 'Todo', projectId: 'p1' },
      { id: 's2', name: 'Todo', projectId: 'p2' },
    ];
    const { detected } = parseTaskText('Plan trip %Todo', { projects, sections });

    expect(detected.sectionShorthand.section).toBeNull();
    expect(detected.sectionShorthand.project).toBeNull();
    expect(detected.sectionShorthand.fragment).toBe('Todo');
    expect(detected.sectionShorthand.candidates).toEqual([
      { section: sections[0], project: projects[0] },
      { section: sections[1], project: projects[1] },
    ]);
  });

  it('exact-name match beats substring match when only the exact match is unique', () => {
    const projects = [{ id: 'p1', name: 'Home' }];
    const sections = [
      { id: 's1', name: 'Todo', projectId: 'p1' },
      { id: 's2', name: 'Todo List', projectId: 'p1' },
    ];
    const { detected } = parseTaskText('Plan trip %Todo', { projects, sections });

    expect(detected.sectionShorthand.section).toEqual(sections[0]);
  });

  it('returns null section/project with the raw fragment preserved when there is no match at all', () => {
    const { detected, cleanedTitle } = parseTaskText('Plan trip %Nonexistent', { projects: [], sections: [] });

    expect(detected.sectionShorthand.section).toBeNull();
    expect(detected.sectionShorthand.project).toBeNull();
    expect(detected.sectionShorthand.fragment).toBe('Nonexistent');
    expect(detected.sectionShorthand.candidates).toEqual([]);
    expect(cleanedTitle).toBe('Plan trip');
  });

  it('does not detect anything when there is no "%" trigger', () => {
    const result = parseTaskText('Plan trip to the store');
    expect(result.detected.sectionShorthand).toBeUndefined();
  });

  it('lets an explicit "#Project/Section" mention take priority and does not double-match the same text', () => {
    const projects = [{ id: 'p1', name: 'Home' }];
    const sections = [{ id: 's1', name: 'Groceries', projectId: 'p1' }];
    // "#Home/Groceries" is consumed entirely by findProjectPhrase (including the
    // section name after the slash) before the "%section" detector ever runs, so
    // there's no leftover "%"-triggered text left for it to match.
    const { detected, cleanedTitle } = parseTaskText('Buy milk #Home/Groceries', { projects, sections });

    expect(detected.project.project).toEqual(projects[0]);
    expect(detected.project.section).toEqual(sections[0]);
    expect(detected.sectionShorthand).toBeUndefined();
    expect(cleanedTitle).toBe('Buy milk');
  });

  it('detects a standalone "%section" mention alongside an unrelated "#project" mention in the same title', () => {
    const projects = [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }];
    const sections = [{ id: 's1', name: 'Groceries', projectId: 'p1' }];
    const { detected, cleanedTitle } = parseTaskText('Buy milk #Work %Groceries', { projects, sections });

    expect(detected.project.project).toEqual(projects[1]);
    expect(detected.sectionShorthand.section).toEqual(sections[0]);
    expect(detected.sectionShorthand.project).toEqual(projects[0]);
    expect(cleanedTitle).toBe('Buy milk');
  });
});

describe('findLinkPhrases', () => {
  it('finds every URL-like phrase in a longer piece of text, preserving indexes', () => {
    const text = 'See https://example.com/path and also www.foo.com/bar for details';
    const matches = findLinkPhrases(text);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ url: 'https://example.com/path', matchedText: 'https://example.com/path', index: 4 });
    expect(matches[1]).toEqual({ url: 'https://www.foo.com/bar', matchedText: 'www.foo.com/bar', index: 38 });
  });

  it('returns an empty array when no URL is present', () => {
    expect(findLinkPhrases('just a plain task title')).toEqual([]);
  });

  it('returns an empty array for empty/blank input', () => {
    expect(findLinkPhrases('')).toEqual([]);
    expect(findLinkPhrases('   ')).toEqual([]);
  });
});

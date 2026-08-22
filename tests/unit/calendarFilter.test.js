import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CALENDAR_FILTER,
  UNASSIGNED_PROJECT_ID,
  filterCalendarItems,
  isCalendarFilterActive,
  normalizeCalendarFilter,
} from '../../src/utils/calendarFilter';

function taskById(tasks) {
  return new Map(tasks.map((t) => [t.id, t]));
}

function block(id, taskId, extra = {}) {
  return { id, taskId, date: '2026-08-06', startTime: '09:00', endTime: '10:00', ...extra };
}

function event(id, extra = {}) {
  return { id, title: `Event ${id}`, date: '2026-08-06', startTime: '09:00', endTime: '10:00', ...extra };
}

describe('normalizeCalendarFilter', () => {
  it('returns the default filter for null/undefined/non-object input', () => {
    expect(normalizeCalendarFilter(null)).toEqual(DEFAULT_CALENDAR_FILTER);
    expect(normalizeCalendarFilter(undefined)).toEqual(DEFAULT_CALENDAR_FILTER);
    expect(normalizeCalendarFilter('bogus')).toEqual(DEFAULT_CALENDAR_FILTER);
  });

  it('falls back to defaults for an invalid showMode or non-array id lists', () => {
    expect(normalizeCalendarFilter({ showMode: 'nonsense', projectIds: 'not-an-array', labelIds: 42 })).toEqual(
      DEFAULT_CALENDAR_FILTER
    );
  });

  it('passes through a valid shape unchanged', () => {
    const valid = { showMode: 'tasks', projectIds: ['p1'], labelIds: null };
    expect(normalizeCalendarFilter(valid)).toEqual(valid);
  });

  it('merges a partial/stale shape (missing keys) over the defaults', () => {
    expect(normalizeCalendarFilter({ showMode: 'events' })).toEqual({ showMode: 'events', projectIds: null, labelIds: null });
  });
});

describe('isCalendarFilterActive', () => {
  it('is false for the all-inclusive default', () => {
    expect(isCalendarFilterActive(DEFAULT_CALENDAR_FILTER)).toBe(false);
  });

  it('is true when showMode narrows to tasks or events only', () => {
    expect(isCalendarFilterActive({ ...DEFAULT_CALENDAR_FILTER, showMode: 'tasks' })).toBe(true);
    expect(isCalendarFilterActive({ ...DEFAULT_CALENDAR_FILTER, showMode: 'events' })).toBe(true);
  });

  it('is true when projectIds or labelIds is a non-null (even empty) array', () => {
    expect(isCalendarFilterActive({ ...DEFAULT_CALENDAR_FILTER, projectIds: [] })).toBe(true);
    expect(isCalendarFilterActive({ ...DEFAULT_CALENDAR_FILTER, labelIds: [] })).toBe(true);
  });
});

describe('filterCalendarItems — showMode', () => {
  const tasks = [{ id: 't1', projectId: 'work' }];
  const blocks = [block('b1', 't1')];
  const events = [event('e1')];

  it('"both" keeps everything', () => {
    const { filteredBlocks, filteredEvents } = filterCalendarItems(blocks, events, DEFAULT_CALENDAR_FILTER, taskById(tasks));
    expect(filteredBlocks).toHaveLength(1);
    expect(filteredEvents).toHaveLength(1);
  });

  it('"tasks" drops all events, keeps blocks', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, showMode: 'tasks' };
    const { filteredBlocks, filteredEvents } = filterCalendarItems(blocks, events, filter, taskById(tasks));
    expect(filteredBlocks).toHaveLength(1);
    expect(filteredEvents).toHaveLength(0);
  });

  it('"events" drops all blocks, keeps events', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, showMode: 'events' };
    const { filteredBlocks, filteredEvents } = filterCalendarItems(blocks, events, filter, taskById(tasks));
    expect(filteredBlocks).toHaveLength(0);
    expect(filteredEvents).toHaveLength(1);
  });
});

describe('filterCalendarItems — project multi-select', () => {
  const tasks = [
    { id: 't_work', projectId: 'work' },
    { id: 't_home', projectId: 'home' },
    { id: 't_none', projectId: null },
  ];
  const blocks = [block('b_work', 't_work'), block('b_home', 't_home'), block('b_none', 't_none')];

  it('null projectIds (the default) matches every project, including no-project tasks', () => {
    const { filteredBlocks } = filterCalendarItems(blocks, [], DEFAULT_CALENDAR_FILTER, taskById(tasks));
    expect(filteredBlocks.map((b) => b.id).sort()).toEqual(['b_home', 'b_none', 'b_work']);
  });

  it('an explicit list only keeps blocks whose task is in it', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, projectIds: ['work'] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById(tasks));
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_work']);
  });

  it('UNASSIGNED_PROJECT_ID selects tasks with no project', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, projectIds: [UNASSIGNED_PROJECT_ID] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById(tasks));
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_none']);
  });

  it('an empty selection excludes every block', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, projectIds: [] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById(tasks));
    expect(filteredBlocks).toHaveLength(0);
  });
});

describe('filterCalendarItems — label multi-select', () => {
  const tasks = [
    { id: 't_urgent', labelIds: ['urgent'] },
    { id: 't_multi', labelIds: ['urgent', 'home'] },
    { id: 't_none', labelIds: [] },
  ];
  const blocks = [block('b_urgent', 't_urgent'), block('b_multi', 't_multi'), block('b_none', 't_none')];

  it('null labelIds matches every task regardless of tags', () => {
    const { filteredBlocks } = filterCalendarItems(blocks, [], DEFAULT_CALENDAR_FILTER, taskById(tasks));
    expect(filteredBlocks).toHaveLength(3);
  });

  it('matches a block if the task has ANY of the selected labels', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, labelIds: ['home'] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById(tasks));
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_multi']);
  });

  it('a task with no labels never matches a non-null label selection', () => {
    const filter = { ...DEFAULT_CALENDAR_FILTER, labelIds: ['urgent', 'home'] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById(tasks));
    expect(filteredBlocks.map((b) => b.id).sort()).toEqual(['b_multi', 'b_urgent']);
  });
});

describe('filterCalendarItems — sub-task inheritance fallback', () => {
  it('falls back to the parent project/labels when the sub-task has none of its own', () => {
    const tasks = [
      { id: 'parent', projectId: 'work', labelIds: ['urgent'] },
      { id: 'child', parentId: 'parent', projectId: null, labelIds: [] },
    ];
    const blocks = [block('b_child', 'child')];

    const byProject = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, projectIds: ['work'] }, taskById(tasks));
    expect(byProject.filteredBlocks.map((b) => b.id)).toEqual(['b_child']);

    const byLabel = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, labelIds: ['urgent'] }, taskById(tasks));
    expect(byLabel.filteredBlocks.map((b) => b.id)).toEqual(['b_child']);
  });

  it('uses the sub-task’s own project/labels when it has them, not the parent’s', () => {
    const tasks = [
      { id: 'parent', projectId: 'work', labelIds: ['urgent'] },
      { id: 'child', parentId: 'parent', projectId: 'home', labelIds: ['chores'] },
    ];
    const blocks = [block('b_child', 'child')];

    const byWork = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, projectIds: ['work'] }, taskById(tasks));
    expect(byWork.filteredBlocks).toHaveLength(0);

    const byHome = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, projectIds: ['home'] }, taskById(tasks));
    expect(byHome.filteredBlocks.map((b) => b.id)).toEqual(['b_child']);
  });

  it('walks up multiple levels (sub-task of a sub-task) to find an ancestor project', () => {
    const tasks = [
      { id: 'grandparent', projectId: 'work' },
      { id: 'parent', parentId: 'grandparent', projectId: null },
      { id: 'child', parentId: 'parent', projectId: null },
    ];
    const blocks = [block('b_child', 'child')];
    const { filteredBlocks } = filterCalendarItems(
      blocks,
      [],
      { ...DEFAULT_CALENDAR_FILTER, projectIds: ['work'] },
      taskById(tasks)
    );
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_child']);
  });
});

describe('filterCalendarItems — orphaned/task-less block', () => {
  it('a block whose task no longer resolves never matches a project or label filter', () => {
    const blocks = [block('b_orphan', 'missing-task')];

    const byProject = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, projectIds: ['work'] }, taskById([]));
    expect(byProject.filteredBlocks).toHaveLength(0);

    const byLabel = filterCalendarItems(blocks, [], { ...DEFAULT_CALENDAR_FILTER, labelIds: ['urgent'] }, taskById([]));
    expect(byLabel.filteredBlocks).toHaveLength(0);
  });

  it('an orphaned block still falls into the "Unassigned" project bucket', () => {
    const blocks = [block('b_orphan', 'missing-task')];
    const filter = { ...DEFAULT_CALENDAR_FILTER, projectIds: [UNASSIGNED_PROJECT_ID] };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById([]));
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_orphan']);
  });

  it('an orphaned block is unaffected by showMode (still a "task" block, not dropped like an event would be)', () => {
    const blocks = [block('b_orphan', 'missing-task')];
    const filter = { ...DEFAULT_CALENDAR_FILTER, showMode: 'tasks' };
    const { filteredBlocks } = filterCalendarItems(blocks, [], filter, taskById([]));
    expect(filteredBlocks.map((b) => b.id)).toEqual(['b_orphan']);
  });
});

// The Projects-search-box ranker (formerly scoreProjectMatch/rankProjectsBySearch,
// defined in this file) moved to src/utils/nameSearch.js as scoreNameMatch/
// rankByNameSearch once other project-search call sites (Sidebar,
// ManageProjectsModal, SearchBar, useMentionAutocomplete, CommandPalette)
// adopted it too — see tests/unit/nameSearch.test.js for its coverage.

import { describe, it, expect } from 'vitest';
import { findDemoEventIds, findDemoTaskIds } from '../../src/services/demoDataCleanup.js';
import { getMockEvents, getMockTasks } from '../../src/services/mockData.js';
import { taskflowGoogleEventId } from '../../src/services/googleCalendarService.js';

describe('findDemoEventIds', () => {
  it('finds every untouched sample event', () => {
    const events = getMockEvents();
    expect(findDemoEventIds(events).sort()).toEqual(events.map((e) => e.id).sort());
  });

  it('finds a sample event pulled back from Google under its pulled id', () => {
    const pulled = { id: 'gcal_me@x.com_abc', googleEventId: taskflowGoogleEventId('evt_conference'), title: 'Design Conference', source: 'google' };
    expect(findDemoEventIds([pulled])).toEqual(['gcal_me@x.com_abc']);
  });

  it('leaves a renamed sample event, a real event and a tombstone alone', () => {
    const renamed = { ...getMockEvents()[0], title: 'My real standup' };
    const real = { id: 'abc', title: 'Design Conference' };
    const tomb = { ...getMockEvents()[1], deletedAt: '2026-10-01T00:00:00.000Z' };
    expect(findDemoEventIds([renamed, real, tomb])).toEqual([]);
  });
});

describe('findDemoTaskIds', () => {
  it('finds untouched sample tasks but not renamed ones', () => {
    const [first, second] = getMockTasks();
    expect(findDemoTaskIds([first, { ...second, title: 'Mine now' }])).toEqual([first.id]);
  });
});

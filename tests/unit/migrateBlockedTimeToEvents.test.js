import { describe, it, expect } from 'vitest';
import { migrateBlockedTimeToEvents } from '../../src/migrations/migrateBlockedTimeToEvents';

describe('migrateBlockedTimeToEvents', () => {
  it('backfills description/location/recurrenceRule onto a pre-migration manual event missing those fields', () => {
    const events = [{ id: 'e1', source: 'manual', title: 'Blocked time' }];
    const result = migrateBlockedTimeToEvents(events);
    expect(result).toEqual([
      {
        id: 'e1',
        source: 'manual',
        title: 'Blocked time',
        description: '',
        location: '',
        recurrenceRule: null,
      },
    ]);
  });

  it('does not touch non-manual events (e.g. synced from Google Calendar)', () => {
    const events = [{ id: 'e2', source: 'google', title: 'Synced meeting' }];
    const result = migrateBlockedTimeToEvents(events);
    expect(result).toEqual(events);
    expect(result[0]).not.toHaveProperty('description');
  });

  it('preserves existing values on an already-migrated manual event instead of overwriting them (idempotent)', () => {
    const alreadyMigrated = {
      id: 'e3',
      source: 'manual',
      title: 'Doctor appointment',
      description: 'Annual checkup',
      location: 'Clinic',
      recurrenceRule: 'every year',
    };
    const result = migrateBlockedTimeToEvents([alreadyMigrated]);
    expect(result).toEqual([alreadyMigrated]);
  });

  it('running the migration twice produces the same result as running it once (safe to re-run)', () => {
    const events = [{ id: 'e1', source: 'manual', title: 'Blocked time' }];
    const once = migrateBlockedTimeToEvents(events);
    const twice = migrateBlockedTimeToEvents(once);
    expect(twice).toEqual(once);
  });

  it('passes through an empty array unchanged', () => {
    expect(migrateBlockedTimeToEvents([])).toEqual([]);
  });

  it('passes through non-array input unchanged (defensive no-op)', () => {
    expect(migrateBlockedTimeToEvents(undefined)).toBeUndefined();
    expect(migrateBlockedTimeToEvents(null)).toBeNull();
  });

  it('handles a mixed list of manual and non-manual events, only backfilling the manual ones', () => {
    const events = [
      { id: 'm1', source: 'manual', title: 'Focus block' },
      { id: 'g1', source: 'google', title: 'Standup' },
      { id: 'm2', source: 'manual', title: 'Lunch', description: 'already set' },
    ];
    const result = migrateBlockedTimeToEvents(events);
    expect(result[0]).toEqual({
      id: 'm1',
      source: 'manual',
      title: 'Focus block',
      description: '',
      location: '',
      recurrenceRule: null,
    });
    expect(result[1]).toEqual(events[1]);
    expect(result[2]).toEqual({
      id: 'm2',
      source: 'manual',
      title: 'Lunch',
      description: 'already set',
      location: '',
      recurrenceRule: null,
    });
  });
});

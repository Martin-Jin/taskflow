import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BACKUP_FIELDS,
  FIELD_TYPES,
  isValidFieldValue,
  buildBackupPayload,
  isValidBackupPayload,
} from '../../src/services/backupService';

/** A realistic state object covering every BACKUP_FIELDS entry with valid values. */
function makeSampleState() {
  return {
    tasks: [
      { id: 't1', title: 'Write report', isCompleted: false },
      { id: 't2', title: 'Finished thing', isCompleted: true },
    ],
    blocks: [
      { id: 'b1', taskId: 't1', start: '2026-07-31T09:00:00.000Z' },
      { id: 'b2', taskId: 't2', start: '2026-07-30T09:00:00.000Z' },
    ],
    sections: [{ id: 's1', name: 'Work' }],
    projects: [{ id: 'p1', name: 'Taskflow' }],
    labels: [{ id: 'l1', name: 'urgent' }],
    routines: [{ id: 'r1', name: 'Morning routine' }],
    rules: { bufferDays: 1, workDayStart: '07:00', workDayEnd: '23:00' },
    soundEnabled: true,
    soundVolume: 0.5,
    animationsEnabled: false,
    notificationSettings: { timezone: 'UTC', enabled: true },
    theme: 'dark',
    notes: { folders: [], notes: [] },
    shortcutBindings: { addTask: 'n' },
    events: [{ id: 'e1', title: 'Standup', date: '2026-07-31' }],
  };
}

describe('BACKUP_FIELDS / buildBackupPayload integrity', () => {
  it('includes every BACKUP_FIELDS entry in the built payload (regression guard for a silently-dropped field)', () => {
    const state = makeSampleState();
    const payload = buildBackupPayload(state);
    for (const field of BACKUP_FIELDS) {
      expect(payload).toHaveProperty(field);
    }
  });

  it('every BACKUP_FIELDS entry has a declared FIELD_TYPES entry (so isValidBackupPayload actually checks it)', () => {
    for (const field of BACKUP_FIELDS) {
      expect(FIELD_TYPES).toHaveProperty(field);
    }
  });

  it('includes events in the built payload (point-in-time backups are a safety net; live cross-device sync still excludes them separately, see useCloudSync.test.js)', () => {
    const state = makeSampleState();
    const payload = buildBackupPayload(state);
    expect(BACKUP_FIELDS).toContain('events');
    expect(payload.events).toBe(state.events);
  });

  it('round-trips events through export + validate unchanged (backup/restore parity)', () => {
    const state = makeSampleState();
    const payload = buildBackupPayload(state);
    expect(isValidBackupPayload(payload)).toBe(true);
    expect(payload.events).toEqual(state.events);
  });

  it('accepts a legacy backup that predates events being added to BACKUP_FIELDS (missing `events` entirely)', () => {
    const payload = buildBackupPayload(makeSampleState());
    delete payload.events;
    expect(isValidBackupPayload(payload)).toBe(true);
  });

  it('tags the payload with an exportedAt ISO timestamp', () => {
    const payload = buildBackupPayload(makeSampleState());
    expect(typeof payload.exportedAt).toBe('string');
    expect(() => new Date(payload.exportedAt).toISOString()).not.toThrow();
  });

  it('excludes completed one-off tasks and their blocks from the payload', () => {
    const payload = buildBackupPayload(makeSampleState());
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t2');
    const blockTaskIds = payload.blocks.map((b) => b.taskId);
    expect(blockTaskIds).toContain('t1');
    expect(blockTaskIds).not.toContain('t2');
  });

  it('keeps incomplete tasks and blocks referencing them intact', () => {
    const payload = buildBackupPayload(makeSampleState());
    expect(payload.tasks).toHaveLength(1);
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0].id).toBe('b1');
  });
});

describe('isValidFieldValue', () => {
  it('accepts an array for an array-typed field', () => {
    expect(isValidFieldValue('tasks', [])).toBe(true);
  });

  it('rejects a string for an array-typed field', () => {
    expect(isValidFieldValue('tasks', 'not-an-array')).toBe(false);
  });

  it('accepts a plain object for an object-typed field', () => {
    expect(isValidFieldValue('notificationSettings', { enabled: true })).toBe(true);
  });

  it('rejects an array for an object-typed field (arrays are not plain objects here)', () => {
    expect(isValidFieldValue('notificationSettings', [])).toBe(false);
  });

  it('rejects null for an object-typed field', () => {
    expect(isValidFieldValue('notes', null)).toBe(false);
  });

  it('accepts a boolean for a boolean-typed field', () => {
    expect(isValidFieldValue('soundEnabled', false)).toBe(true);
  });

  it('rejects a non-boolean for a boolean-typed field', () => {
    expect(isValidFieldValue('soundEnabled', 'true')).toBe(false);
  });

  it('accepts a finite number for a number-typed field', () => {
    expect(isValidFieldValue('soundVolume', 0.8)).toBe(true);
  });

  it('rejects NaN/Infinity for a number-typed field', () => {
    expect(isValidFieldValue('soundVolume', NaN)).toBe(false);
    expect(isValidFieldValue('soundVolume', Infinity)).toBe(false);
  });

  it('rejects a string for a number-typed field', () => {
    expect(isValidFieldValue('soundVolume', '0.8')).toBe(false);
  });

  it('accepts a string for a string-typed field', () => {
    expect(isValidFieldValue('theme', 'dark')).toBe(true);
  });

  it('rejects a non-string for a string-typed field', () => {
    expect(isValidFieldValue('theme', 42)).toBe(false);
  });

  it('defaults to true for an unknown field (no declared type to check)', () => {
    expect(isValidFieldValue('someUnknownField', 12345)).toBe(true);
  });
});

describe('isValidBackupPayload', () => {
  it('accepts a fully valid backup payload', () => {
    const payload = buildBackupPayload(makeSampleState());
    expect(isValidBackupPayload(payload)).toBe(true);
  });

  it('rejects null/non-object input', () => {
    expect(isValidBackupPayload(null)).toBe(false);
    expect(isValidBackupPayload(undefined)).toBe(false);
    expect(isValidBackupPayload('a string')).toBe(false);
  });

  it('rejects a payload missing a required field', () => {
    const payload = buildBackupPayload(makeSampleState());
    delete payload.tasks;
    expect(isValidBackupPayload(payload)).toBe(false);
  });

  it('rejects a payload where a field has the wrong type (array field given a string)', () => {
    const payload = buildBackupPayload(makeSampleState());
    payload.sections = 'oops-a-string';
    expect(isValidBackupPayload(payload)).toBe(false);
  });

  it('rejects a payload where an object field has been swapped for an array', () => {
    const payload = buildBackupPayload(makeSampleState());
    payload.notificationSettings = [];
    expect(isValidBackupPayload(payload)).toBe(false);
  });

  it('accepts a legacy pre-Notes payload that has `pinnedLinks` instead of `notes`', () => {
    const payload = buildBackupPayload(makeSampleState());
    delete payload.notes;
    payload.pinnedLinks = [{ id: 'link1', url: 'https://example.com' }];
    expect(isValidBackupPayload(payload)).toBe(true);
  });

  it('rejects a payload missing both `notes` and the legacy `pinnedLinks` fallback', () => {
    const payload = buildBackupPayload(makeSampleState());
    delete payload.notes;
    expect(isValidBackupPayload(payload)).toBe(false);
  });

  it('rejects an unrelated JSON object (e.g. some other app export) with none of the required fields', () => {
    expect(isValidBackupPayload({ hello: 'world', foo: [1, 2, 3] })).toBe(false);
  });

  // Regression guard: `rules` (getDefaultRules in mockData.js) is a single
  // scheduling-config object, not a list of rule entries — FIELD_TYPES once
  // declared it 'array', which meant every real export failed its own
  // isValidBackupPayload check on import ("Invalid backup file.").
  it('accepts `rules` as a plain object, matching its actual runtime shape', () => {
    const payload = buildBackupPayload(makeSampleState());
    expect(Array.isArray(payload.rules)).toBe(false);
    expect(isValidBackupPayload(payload)).toBe(true);
  });
});

/**
 * Cross-check against useCloudSync.js's applyBackupPayload (the function that
 * actually restores a backup — SchedulerContext itself has no function named
 * `restoreFromBackup`; it delegates to this hook). We can't import/execute it
 * directly since it's defined inside a React hook (useCallback closing over
 * component state setters) rather than exported as a standalone function, so
 * this reads the hook's source as text and checks, per BACKUP_FIELDS entry,
 * that applyBackupPayload has a matching `'field' in payload` branch — a
 * plain static/textual check, not a mount of the hook or its component tree.
 */
describe('applyBackupPayload field coverage (static source cross-check)', () => {
  let applyBackupPayloadSource = '';

  beforeAll(() => {
    const hookPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/hooks/useCloudSync.js'
    );
    const fullSource = readFileSync(hookPath, 'utf-8');
    const start = fullSource.indexOf('const applyBackupPayload = useCallback');
    expect(start).toBeGreaterThan(-1);
    // Grab a generous slice following the function start — enough to cover
    // its whole body without needing to parse balanced braces.
    applyBackupPayloadSource = fullSource.slice(start, start + 3000);
  });

  it('has an `in payload` check for every BACKUP_FIELDS entry (except tasks/blocks, handled via a combined check)', () => {
    const combinedCheckFields = ['tasks', 'blocks'];
    for (const field of BACKUP_FIELDS) {
      if (combinedCheckFields.includes(field)) continue;
      expect(applyBackupPayloadSource).toContain(`'${field}' in payload`);
    }
    // tasks/blocks are restored together via a single combined guard.
    expect(applyBackupPayloadSource).toContain("'tasks' in payload || 'blocks' in payload");
  });
});

import { describe, it, expect } from 'vitest';
import { resolvePlan } from '../../src/services/aiPlanService';

const emptyContext = { projects: [], sections: [], labels: [], tasks: [], events: [] };

function entryFor(plan, index) {
  return plan.entries.find((e) => e.index === index);
}

describe('resolvePlan — date/time field format validation', () => {
  it('accepts a create_task with a well-formed ISO dueDate', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', dueDate: '2026-08-10' }], emptyContext);
    expect(entryFor(plan, 0).valid).toBe(true);
  });

  it('rejects a create_task with a non-ISO dueDate', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', dueDate: 'next Tuesday' }], emptyContext);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/dueDate/);
  });

  it('rejects a calendar-invalid date (e.g. Feb 30th) even though it matches the regex shape', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', dueDate: '2026-02-30' }], emptyContext);
    expect(entryFor(plan, 0).valid).toBe(false);
  });

  it('rejects a malformed fixedTime', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', fixedTime: '9am' }], emptyContext);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/fixedTime/);
  });

  it('accepts a create_event with valid date/startTime/endTime', () => {
    const plan = resolvePlan(
      [{ op: 'create_event', localId: 'new:1', title: 'Meeting', date: '2026-08-10', startTime: '09:00', endTime: '10:00' }],
      emptyContext
    );
    expect(entryFor(plan, 0).valid).toBe(true);
  });

  it('rejects a create_event whose endTime is not after startTime', () => {
    const plan = resolvePlan(
      [{ op: 'create_event', localId: 'new:1', title: 'Meeting', date: '2026-08-10', startTime: '10:00', endTime: '09:00' }],
      emptyContext
    );
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/endTime .* after startTime/);
  });

  it('rejects an invalid startTime/endTime format', () => {
    const plan = resolvePlan(
      [{ op: 'create_event', localId: 'new:1', title: 'Meeting', date: '2026-08-10', startTime: '9:00', endTime: '25:00' }],
      emptyContext
    );
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/startTime/);
    expect(entry.errors.join(' ')).toMatch(/endTime/);
  });

  it('leaves omitted optional date/time fields alone (no format error)', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A' }], emptyContext);
    expect(entryFor(plan, 0).valid).toBe(true);
  });
});

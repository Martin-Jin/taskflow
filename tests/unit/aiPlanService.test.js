import { describe, it, expect } from 'vitest';
import { resolvePlan, applyPlan } from '../../src/services/aiPlanService';

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

describe('resolvePlan — enforceDueDate cross-field validation', () => {
  it('rejects create_task with enforceDueDate: true and no dueDate', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', enforceDueDate: true }], emptyContext);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/enforceDueDate/);
  });

  it('accepts create_task with enforceDueDate: true and a dueDate on the same operation', () => {
    const plan = resolvePlan(
      [{ op: 'create_task', localId: 'new:1', title: 'A', dueDate: '2026-08-10', enforceDueDate: true }],
      emptyContext
    );
    expect(entryFor(plan, 0).valid).toBe(true);
  });

  it('rejects update_task with enforceDueDate: true when the target task has no dueDate and the op does not set one', () => {
    const context = { ...emptyContext, tasks: [{ id: 'task_1', title: 'Existing', dueDate: null }] };
    const plan = resolvePlan([{ op: 'update_task', taskId: 'task_1', enforceDueDate: true }], context);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/enforceDueDate/);
  });

  it('accepts update_task with enforceDueDate: true when the target task already has a dueDate', () => {
    const context = { ...emptyContext, tasks: [{ id: 'task_1', title: 'Existing', dueDate: '2026-08-10' }] };
    const plan = resolvePlan([{ op: 'update_task', taskId: 'task_1', enforceDueDate: true }], context);
    expect(entryFor(plan, 0).valid).toBe(true);
  });

  it('rejects update_task that clears dueDate while leaving enforceDueDate: true', () => {
    const context = { ...emptyContext, tasks: [{ id: 'task_1', title: 'Existing', dueDate: '2026-08-10' }] };
    const plan = resolvePlan([{ op: 'update_task', taskId: 'task_1', dueDate: '', enforceDueDate: true }], context);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(false);
    expect(entry.errors.join(' ')).toMatch(/enforceDueDate/);
  });

  it('does not flag enforceDueDate: false regardless of dueDate', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'A', enforceDueDate: false }], emptyContext);
    expect(entryFor(plan, 0).valid).toBe(true);
  });
});

describe('resolvePlan — note operations', () => {
  const contextWithNotes = { ...emptyContext, notes: [{ id: 'n1', title: 'Packing list' }] };

  it('accepts a create_note and describes it by title', () => {
    const plan = resolvePlan([{ op: 'create_note', localId: 'new:1', title: 'Recipe', body: '- eggs' }], emptyContext);
    const entry = entryFor(plan, 0);
    expect(entry.valid).toBe(true);
    expect(entry.humanDescription).toContain('Recipe');
  });

  it('accepts update_note and delete_note pointing at a real note id', () => {
    const update = resolvePlan([{ op: 'update_note', noteId: 'n1', body: 'new body' }], contextWithNotes);
    expect(entryFor(update, 0).valid).toBe(true);
    // Resolves the id back to a human title rather than echoing "n1".
    expect(entryFor(update, 0).humanDescription).toContain('Packing list');

    const del = resolvePlan([{ op: 'delete_note', noteId: 'n1' }], contextWithNotes);
    expect(entryFor(del, 0).valid).toBe(true);
  });

  it('rejects editing a note the same plan also deletes', () => {
    const plan = resolvePlan(
      [
        { op: 'update_note', noteId: 'n1', body: 'new body' },
        { op: 'delete_note', noteId: 'n1' },
      ],
      contextWithNotes
    );
    expect(entryFor(plan, 0).valid).toBe(false);
  });

  it('rejects a note id that was never in the context — including when notes were withheld', () => {
    // Exactly the "user unticked Include my notes" case: the AI must not
    // invent an id for a note it was never shown.
    const plan = resolvePlan([{ op: 'update_note', noteId: 'n1', title: 'x' }], emptyContext);
    expect(entryFor(plan, 0).valid).toBe(false);
  });
});

describe('repeating events from the AI assistant', () => {
  const evt = { op: 'create_event', localId: 'new:1', title: 'Class', date: '2026-08-10', startTime: '09:00', endTime: '10:00' };

  it('accepts a valid recurrenceRule and rejects a made-up one', () => {
    expect(entryFor(resolvePlan([{ ...evt, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE' }], emptyContext), 0).valid).toBe(true);
    const bad = entryFor(resolvePlan([{ ...evt, recurrenceRule: 'weekly' }], emptyContext), 0);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/recurrenceRule/);
  });

  it('passes recurrenceRule through to addManualEvent on create', () => {
    const plan = resolvePlan([{ ...evt, recurrenceRule: 'FREQ=WEEKLY' }], emptyContext);
    let received;
    applyPlan(plan, new Set([0]), { addManualEvent: (f) => ((received = f), { id: 'e1' }) });
    expect(received.recurrenceRule).toBe('FREQ=WEEKLY');
  });

  it('update_event makes the whole series repeat, and "" stops it', () => {
    const context = { ...emptyContext, events: [{ id: 'e1', title: 'Class' }] };
    const calls = [];
    const mutators = { updateEvent: (id, fields, scope) => calls.push({ id, fields, scope }) };
    for (const rule of ['FREQ=WEEKLY', '']) {
      const plan = resolvePlan([{ op: 'update_event', eventId: 'e1', recurrenceRule: rule }], context);
      applyPlan(plan, new Set([0]), mutators);
    }
    expect(calls[0]).toMatchObject({ id: 'e1', scope: 'all', fields: { recurrenceRule: 'FREQ=WEEKLY', isRecurring: true, seriesId: 'e1' } });
    expect(calls[1].fields).toMatchObject({ recurrenceRule: null, isRecurring: false, seriesId: null });
  });

  it('a task given only recurrenceString is still marked recurring', () => {
    const plan = resolvePlan([{ op: 'create_task', localId: 'new:1', title: 'Water plants', recurrenceString: 'every week' }], emptyContext);
    let received;
    applyPlan(plan, new Set([0]), { addTask: (f) => ((received = f), { id: 't1' }) });
    expect(received.isRecurring).toBe(true);
  });
});

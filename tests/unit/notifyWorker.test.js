import { describe, it, expect } from 'vitest';
import { computeCandidates, isCandidateStillValid } from '../../notify-worker/src/computeNotifications';
import { claimNotification, clearNotificationState } from '../../notify-worker/src/notificationState';

const BASE_SETTINGS = { taskStartingSoon: true, taskOverdue: true, taskDueToday: true, startingSoonMinutes: 10, timezone: 'UTC' };
const BASE_RULES = { workDayStart: '09:00' };

// claimNotification/clearNotificationState build refs via
// db.collection('users').doc(uid).collection('notificationState').doc(stateId)
// — wire a minimal fake that supports exactly that chain plus transactions.
function makeFirestore() {
  const docs = new Map();
  function ref(key) {
    return {
      _id: key,
      async get() {
        return { exists: docs.has(key), data: () => docs.get(key) };
      },
      async delete() {
        docs.delete(key);
      },
    };
  }
  return {
    docs,
    collection() {
      return {
        doc(uid) {
          return {
            collection() {
              return {
                doc(stateId) {
                  return ref(`${uid}/${stateId}`);
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, value) => docs.set(r._id, value),
      };
      return fn(tx);
    },
  };
}

describe('computeCandidates', () => {
  it('skips completed tasks entirely for overdue and dueToday', () => {
    const tasks = [{ id: 't1', title: 'Done', isCompleted: true, dueDate: '2020-01-01', priority: 'high' }];
    const { toNotify } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
    });
    expect(toNotify).toEqual([]);
  });

  it('produces an overdue candidate carrying dueDate for change-detection', () => {
    const tasks = [{ id: 't1', title: 'Late', isCompleted: false, dueDate: '2026-07-30', priority: 'medium' }];
    const { toNotify } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
    });
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]).toMatchObject({ type: 'overdue', stateId: 'overdue_t1', dueDate: '2026-07-30' });
  });

  it('clears stale overdue state once a task is rescheduled forward and no longer overdue', () => {
    const tasks = [{ id: 't1', title: 'Fixed', isCompleted: false, dueDate: '2026-08-05', priority: 'medium' }];
    const { toNotify, toClear } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_t1'],
    });
    expect(toNotify).toEqual([]);
    expect(toClear).toEqual([{ stateId: 'overdue_t1' }]);
  });

  // The three cases below are the actual stale-notification bug: each one used
  // to leak its state doc forever, because the clear lived inside the tasks
  // loop after `if (task.isCompleted || !task.dueDate) continue`.
  it('clears overdue state for a task that has since been COMPLETED', () => {
    const tasks = [{ id: 't1', title: 'Finished it', isCompleted: true, dueDate: '2026-07-30', priority: 'high' }];
    const { toNotify, toClear } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_t1'],
    });
    expect(toNotify).toEqual([]);
    expect(toClear).toEqual([{ stateId: 'overdue_t1' }]);
  });

  it('clears overdue state for a task that has since been DELETED', () => {
    const { toNotify, toClear } = computeCandidates({
      tasks: [],
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_gone'],
    });
    expect(toNotify).toEqual([]);
    expect(toClear).toEqual([{ stateId: 'overdue_gone' }]);
  });

  it('clears overdue state for a task whose dueDate was removed entirely', () => {
    const tasks = [{ id: 't1', title: 'No due date now', isCompleted: false, dueDate: null, priority: 'medium' }];
    const { toClear } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_t1'],
    });
    expect(toClear).toEqual([{ stateId: 'overdue_t1' }]);
  });

  it('does not clear overdue state when the user has overdue notifications turned off', () => {
    // Only "due today" is on, so nothing computes overdue-ness this run —
    // clearing here would silently drop state and cause a burst of stale
    // emails whenever the user re-enabled the toggle.
    const tasks = [{ id: 't1', title: 'Still late', isCompleted: false, dueDate: '2026-07-30', priority: 'medium' }];
    const { toClear } = computeCandidates({
      tasks,
      blocks: [],
      settings: { ...BASE_SETTINGS, taskOverdue: false },
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_t1', 'overdue_t2'],
    });
    expect(toClear).toEqual([]);
  });

  it('keeps the state doc of a task that IS still overdue', () => {
    const tasks = [{ id: 't1', title: 'Still late', isCompleted: false, dueDate: '2026-07-30', priority: 'medium' }];
    const { toClear } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
      existingOverdueStateIds: ['overdue_t1'],
    });
    expect(toClear).toEqual([]);
  });

  it('includes scheduledAt on startingSoon candidates for reschedule detection', () => {
    const tasks = [{ id: 't1', title: 'Soon', isCompleted: false }];
    const blocks = [{ id: 'b1', taskId: 't1', status: 'scheduled', date: '2026-08-02', startTime: '12:05', endTime: '12:30' }];
    const { toNotify } = computeCandidates({
      tasks,
      blocks,
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T12:00:00Z'),
    });
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]).toMatchObject({ type: 'startingSoon', scheduledAt: '2026-08-02T12:05' });
  });

  it('does not fire the dueToday digest before the user\'s workDayStart', () => {
    const tasks = [{ id: 't1', title: 'Today task', isCompleted: false, dueDate: '2026-08-02' }];
    // 08:00 UTC, workDayStart is 09:00 — too early.
    const { toNotify } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T08:00:00Z'),
    });
    expect(toNotify).toEqual([]);
  });

  it('fires one consolidated dueTodayDigest candidate at/after workDayStart, carrying every due-today task', () => {
    const tasks = [
      { id: 't1', title: 'Today task 1', isCompleted: false, dueDate: '2026-08-02' },
      { id: 't2', title: 'Today task 2', isCompleted: false, dueDate: '2026-08-02' },
      { id: 't3', title: 'Not today', isCompleted: false, dueDate: '2026-08-03' },
    ];
    const { toNotify } = computeCandidates({
      tasks,
      blocks: [],
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T09:00:00Z'),
    });
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0].type).toBe('dueTodayDigest');
    expect(toNotify[0].stateId).toBe('dueTodayDigest');
    expect(toNotify[0].tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('produces a missed candidate for a scheduled block whose end time has passed, distinguishing due-today from not', () => {
    const tasks = [
      { id: 't1', title: 'Missed, due today', isCompleted: false, dueDate: '2026-08-02' },
      { id: 't2', title: 'Missed, not due today', isCompleted: false, dueDate: '2026-08-10' },
    ];
    const blocks = [
      { id: 'b1', taskId: 't1', status: 'scheduled', date: '2026-08-02', startTime: '08:00', endTime: '08:30' },
      { id: 'b2', taskId: 't2', status: 'scheduled', date: '2026-08-02', startTime: '08:00', endTime: '08:30' },
    ];
    const { toNotify } = computeCandidates({
      tasks,
      blocks,
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T09:00:00Z'),
    });
    const missed = toNotify.filter((c) => c.type === 'missed');
    expect(missed).toHaveLength(2);
    expect(missed.find((c) => c.task.id === 't1')).toMatchObject({ isDueToday: true, dueDate: '2026-08-02' });
    expect(missed.find((c) => c.task.id === 't2')).toMatchObject({ isDueToday: false, dueDate: '2026-08-10' });
  });

  it('does not produce a missed candidate for a block whose end time has not yet passed, or one marked done', () => {
    const tasks = [{ id: 't1', title: 'Future/done', isCompleted: false, dueDate: '2026-08-02' }];
    const blocks = [
      { id: 'b1', taskId: 't1', status: 'scheduled', date: '2026-08-02', startTime: '10:00', endTime: '10:30' },
      { id: 'b2', taskId: 't1', status: 'done', date: '2026-08-02', startTime: '07:00', endTime: '07:30' },
    ];
    const { toNotify } = computeCandidates({
      tasks,
      blocks,
      settings: BASE_SETTINGS,
      rules: BASE_RULES,
      now: Date.parse('2026-08-02T09:00:00Z'),
    });
    expect(toNotify.filter((c) => c.type === 'missed')).toEqual([]);
  });
});

describe('claimNotification', () => {
  it('claims an overdue notification only ONCE per dueDate, never re-arming on a new calendar day', async () => {
    const db = makeFirestore();
    const candidate = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: true, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);

    // Same day, an hour later — suppressed (as before).
    const t1 = t0 + 60 * 60 * 1000;
    expect(await claimNotification(db, 'u1', candidate, t1)).toBe(false);

    // Crossing midnight must NOT re-arm. This is the regression guard for the
    // repeat-overdue-email bug: a daily re-arm meant a task whose completion
    // never reached Firestore got re-emailed every single day, indefinitely.
    const nextDay = { ...candidate, todayISO: '2026-08-03' };
    expect(await claimNotification(db, 'u1', nextDay, t1 + 20 * 60 * 60 * 1000)).toBe(false);

    // Still suppressed several days on, same unchanged dueDate.
    const muchLater = { ...candidate, todayISO: '2026-08-09' };
    expect(await claimNotification(db, 'u1', muchLater, t0 + 7 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('re-arms overdue across days when the dueDate itself changed', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    const first = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: false, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    expect(await claimNotification(db, 'u1', first, t0)).toBe(true);

    // Pushed to a new (still past) due date on a later day — fresh news.
    const moved = { ...first, todayISO: '2026-08-04', dueDate: '2026-08-03' };
    expect(await claimNotification(db, 'u1', moved, t0 + 2 * 24 * 60 * 60 * 1000)).toBe(true);
    // ...but only once for that new date.
    expect(await claimNotification(db, 'u1', moved, t0 + 2 * 24 * 60 * 60 * 1000 + 5000)).toBe(false);
  });

  it('re-notifies after a cleared state doc, so a task going overdue again is not silently suppressed', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    const candidate = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: false, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', candidate, t0 + 1000)).toBe(false);

    // Task completed (or rescheduled forward) → computeCandidates emits a
    // toClear → state doc removed. A later overdue period must notify again.
    await clearNotificationState(db, 'u1', 'overdue_t1');
    expect(await claimNotification(db, 'u1', candidate, t0 + 10 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('re-arms immediately within the same day when the overdue dueDate changes', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    const first = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: false, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    expect(await claimNotification(db, 'u1', first, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', first, t0 + 1000)).toBe(false);

    // Task rescheduled to a different (still overdue) date, same day.
    const rescheduled = { ...first, dueDate: '2026-08-01' };
    expect(await claimNotification(db, 'u1', rescheduled, t0 + 2000)).toBe(true);
  });

  it('does not resend the dueTodayDigest twice on the same calendar day', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T09:00:00Z');
    const candidate = { type: 'dueTodayDigest', stateId: 'dueTodayDigest', todayISO: '2026-08-02' };
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', candidate, t0 + 5000)).toBe(false);

    const nextDay = { ...candidate, todayISO: '2026-08-03' };
    expect(await claimNotification(db, 'u1', nextDay, t0 + 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('re-arms startingSoon when the block is rescheduled after already firing', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    const candidate = { type: 'startingSoon', stateId: 'startingSoon_b1', scheduledAt: '2026-08-02T12:00' };
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', candidate, t0 + 1000)).toBe(false);

    const rescheduled = { ...candidate, scheduledAt: '2026-08-02T15:00' };
    expect(await claimNotification(db, 'u1', rescheduled, t0 + 2000)).toBe(true);
  });

  it('re-arms missed when the block is rescheduled and the new slot is also missed', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T09:00:00Z');
    const candidate = { type: 'missed', stateId: 'missed_b1', scheduledAt: '2026-08-02T08:30' };
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', candidate, t0 + 1000)).toBe(false);

    const rescheduled = { ...candidate, scheduledAt: '2026-08-02T15:30' };
    expect(await claimNotification(db, 'u1', rescheduled, t0 + 2000)).toBe(true);
  });
});

describe('isCandidateStillValid', () => {
  it('always considers a dueTodayDigest candidate valid (no per-task completion to race against)', () => {
    expect(isCandidateStillValid({ type: 'dueTodayDigest' }, [], [])).toBe(true);
  });

  it('rejects a missed/overdue candidate if the task was completed since the snapshot was taken', () => {
    const candidate = { type: 'missed', task: { id: 't1' }, block: { id: 'b1' } };
    const freshTasks = [{ id: 't1', isCompleted: true }];
    const freshBlocks = [{ id: 'b1', status: 'scheduled' }];
    expect(isCandidateStillValid(candidate, freshTasks, freshBlocks)).toBe(false);
  });

  it('rejects a missed candidate if the block was marked done since the snapshot was taken', () => {
    const candidate = { type: 'missed', task: { id: 't1' }, block: { id: 'b1' } };
    const freshTasks = [{ id: 't1', isCompleted: false }];
    const freshBlocks = [{ id: 'b1', status: 'done' }];
    expect(isCandidateStillValid(candidate, freshTasks, freshBlocks)).toBe(false);
  });

  it('rejects a candidate whose task or block was deleted since the snapshot was taken', () => {
    const candidate = { type: 'missed', task: { id: 't1' }, block: { id: 'b1' } };
    expect(isCandidateStillValid(candidate, [], [])).toBe(false);
  });

  it('accepts a still-incomplete task/block combo unchanged since the snapshot', () => {
    const candidate = { type: 'missed', task: { id: 't1' }, block: { id: 'b1' } };
    const freshTasks = [{ id: 't1', isCompleted: false }];
    const freshBlocks = [{ id: 'b1', status: 'scheduled' }];
    expect(isCandidateStillValid(candidate, freshTasks, freshBlocks)).toBe(true);
  });

  it('accepts an overdue candidate (no block) whose task is still incomplete', () => {
    const candidate = { type: 'overdue', task: { id: 't1' } };
    const freshTasks = [{ id: 't1', isCompleted: false }];
    expect(isCandidateStillValid(candidate, freshTasks, [])).toBe(true);
  });
});

describe('clearNotificationState', () => {
  it('deletes the given state doc', async () => {
    const db = makeFirestore();
    const candidate = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: false, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    await claimNotification(db, 'u1', candidate, Date.parse('2026-08-02T08:00:00Z'));
    expect(db.docs.has('u1/overdue_t1')).toBe(true);
    await clearNotificationState(db, 'u1', 'overdue_t1');
    expect(db.docs.has('u1/overdue_t1')).toBe(false);
  });
});

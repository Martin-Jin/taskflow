import { describe, it, expect } from 'vitest';
import { computeCandidates } from '../../notify-worker/src/computeNotifications';
import { claimNotification, clearNotificationState } from '../../notify-worker/src/notificationState';

const BASE_SETTINGS = { taskStartingSoon: true, taskOverdue: true, taskDueToday: true, startingSoonMinutes: 10, timezone: 'UTC' };

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
    const { toNotify } = computeCandidates({ tasks, blocks: [], settings: BASE_SETTINGS, now: Date.parse('2026-08-02T12:00:00Z') });
    expect(toNotify).toEqual([]);
  });

  it('produces an overdue candidate carrying dueDate for change-detection', () => {
    const tasks = [{ id: 't1', title: 'Late', isCompleted: false, dueDate: '2026-07-30', priority: 'medium' }];
    const { toNotify } = computeCandidates({ tasks, blocks: [], settings: BASE_SETTINGS, now: Date.parse('2026-08-02T12:00:00Z') });
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]).toMatchObject({ type: 'overdue', stateId: 'overdue_t1', dueDate: '2026-07-30' });
  });

  it('clears stale overdue state once a task is no longer overdue', () => {
    const tasks = [{ id: 't1', title: 'Fixed', isCompleted: false, dueDate: '2026-08-05', priority: 'medium' }];
    const { toNotify, toClear } = computeCandidates({ tasks, blocks: [], settings: BASE_SETTINGS, now: Date.parse('2026-08-02T12:00:00Z') });
    expect(toNotify).toEqual([]);
    expect(toClear).toEqual([{ stateId: 'overdue_t1' }]);
  });

  it('includes scheduledAt on startingSoon candidates for reschedule detection', () => {
    const tasks = [{ id: 't1', title: 'Soon', isCompleted: false }];
    const blocks = [{ id: 'b1', taskId: 't1', status: 'scheduled', date: '2026-08-02', startTime: '12:05' }];
    const { toNotify } = computeCandidates({ tasks, blocks, settings: BASE_SETTINGS, now: Date.parse('2026-08-02T12:00:00Z') });
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]).toMatchObject({ type: 'startingSoon', scheduledAt: '2026-08-02T12:05' });
  });
});

describe('claimNotification', () => {
  it('only claims an overdue notification once per calendar day for urgent priority', async () => {
    const db = makeFirestore();
    const candidate = { type: 'overdue', stateId: 'overdue_t1', isUrgentish: true, todayISO: '2026-08-02', dueDate: '2026-07-30' };
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);

    // Same day, an hour later — used to re-fire hourly for urgent tasks; now must stay suppressed.
    const t1 = t0 + 60 * 60 * 1000;
    expect(await claimNotification(db, 'u1', candidate, t1)).toBe(false);

    // Next calendar day — fires again.
    const t2 = { ...candidate, todayISO: '2026-08-03' };
    expect(await claimNotification(db, 'u1', t2, t1 + 20 * 60 * 60 * 1000)).toBe(true);
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

  it('does not resend a dueToday notification for the same dueDate on the same day', async () => {
    const db = makeFirestore();
    const t0 = Date.parse('2026-08-02T08:00:00Z');
    const candidate = { type: 'dueToday', stateId: 'dueToday_t1', todayISO: '2026-08-02', dueDate: '2026-08-02' };
    expect(await claimNotification(db, 'u1', candidate, t0)).toBe(true);
    expect(await claimNotification(db, 'u1', candidate, t0 + 5000)).toBe(false);
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

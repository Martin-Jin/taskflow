import { describe, it, expect } from 'vitest';
import {
  isSharedTask,
  partitionTasksBySharing,
  serializeSharedTask,
  deserializeSharedTask,
  sharedTaskFingerprint,
  planSharedTaskWrites,
  planRemoteTaskApply,
  mergeSharedTask,
  preserveSharedTasks,
  computeActiveViewers,
  PRESENCE_STALE_MS,
} from '../../src/utils/sharedTaskSync';
import { deriveRecurrenceRule } from '../../src/utils/recurrence';

const PROJECT = 'proj_1';

function sharedTask(overrides = {}) {
  return {
    id: 's1',
    title: 'Shared task',
    sharedProjectId: PROJECT,
    estimatedHours: 1,
    isCompleted: false,
    ...overrides,
  };
}

function personalTask(overrides = {}) {
  return { id: 'p1', title: 'Personal task', estimatedHours: 1, ...overrides };
}

/** The fingerprint map a caller holds after a successful sync of `tasks`. */
function syncedFrom(tasks) {
  return new Map(tasks.map((t) => [t.id, sharedTaskFingerprint(t)]));
}

describe('classification', () => {
  it('recognises a shared task by its project pointer', () => {
    expect(isSharedTask(sharedTask())).toBe(true);
    expect(isSharedTask(personalTask())).toBe(false);
    expect(isSharedTask({ sharedProjectId: '' })).toBe(false);
    expect(isSharedTask(null)).toBe(false);
  });

  it('partitions a mixed list', () => {
    const { personalTasks, sharedTasks } = partitionTasksBySharing([personalTask(), sharedTask()]);
    expect(personalTasks).toHaveLength(1);
    expect(sharedTasks).toHaveLength(1);
  });

  it('tolerates an empty/absent list', () => {
    expect(partitionTasksBySharing(undefined)).toEqual({ personalTasks: [], sharedTasks: [] });
  });
});

describe('serialization', () => {
  it('strips the local-only project pointer — the document path already says which project it is in', () => {
    expect(serializeSharedTask(sharedTask())).not.toHaveProperty('sharedProjectId');
  });

  it('strips undefined values, which the Firestore SDK rejects outright', () => {
    const serialized = serializeSharedTask(sharedTask({ notes: undefined, link: null }));
    expect(serialized).not.toHaveProperty('notes');
    expect(serialized.link).toBeNull();
  });

  it('round-trips back into the app-local shape', () => {
    const task = sharedTask();
    expect(deserializeSharedTask(serializeSharedTask(task), PROJECT)).toEqual(task);
  });

  it('fingerprints ignore key order, so a rebuilt object is not seen as an edit', () => {
    const a = { id: 's1', title: 'X', estimatedHours: 2 };
    const b = { estimatedHours: 2, id: 's1', title: 'X' };
    expect(sharedTaskFingerprint(a)).toBe(sharedTaskFingerprint(b));
  });

  it('fingerprints ignore the local-only pointer but catch real edits', () => {
    expect(sharedTaskFingerprint(sharedTask())).toBe(sharedTaskFingerprint({ ...sharedTask(), sharedProjectId: 'other' }));
    expect(sharedTaskFingerprint(sharedTask())).not.toBe(sharedTaskFingerprint(sharedTask({ title: 'Changed' })));
  });

  it('treats a new/edited comment (including author fields, Phase 3) as a real edit — comments sync for free as just another task field, not a dedicated code path', () => {
    const withoutComment = sharedTask();
    const comment = {
      id: 'c1',
      text: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
      authorUid: 'u1',
      authorDisplayName: 'Alice',
      authorPhotoURL: null,
      mentions: ['u2'],
    };
    const withComment = sharedTask({ comments: [comment] });
    expect(sharedTaskFingerprint(withoutComment)).not.toBe(sharedTaskFingerprint(withComment));
    // Round-trips through serialize/deserialize untouched, same as any other field.
    expect(deserializeSharedTask(serializeSharedTask(withComment), PROJECT)).toEqual(withComment);
  });
});

describe('planSharedTaskWrites', () => {
  it('creates tasks not yet known to be stored', () => {
    const plan = planSharedTaskWrites({ tasks: [sharedTask()], projectId: PROJECT, syncedFingerprints: new Map() });
    expect(plan.creates.map((t) => t.id)).toEqual(['s1']);
    expect(plan.updates).toEqual([]);
  });

  it('updates only genuinely changed tasks', () => {
    const original = sharedTask();
    const synced = syncedFrom([original]);
    const edited = { ...original, title: 'Edited' };
    const plan = planSharedTaskWrites({ tasks: [edited], projectId: PROJECT, syncedFingerprints: synced });
    expect(plan.updates.map((t) => t.id)).toEqual(['s1']);
    expect(plan.creates).toEqual([]);
  });

  it('writes nothing when nothing changed — no write loop', () => {
    const task = sharedTask();
    const plan = planSharedTaskWrites({ tasks: [task], projectId: PROJECT, syncedFingerprints: syncedFrom([task]) });
    expect(plan).toEqual({ creates: [], updates: [], deletes: [] });
  });

  it('ignores personal tasks and other projects entirely', () => {
    const plan = planSharedTaskWrites({
      tasks: [personalTask(), sharedTask({ id: 'other', sharedProjectId: 'proj_2' })],
      projectId: PROJECT,
      syncedFingerprints: new Map(),
    });
    expect(plan.creates).toEqual([]);
  });

  it('NEVER infers a delete from a task simply being absent', () => {
    // The whole point: an undo, a backup restore or a cloud pull can replace
    // the array wholesale. Treating "gone" as "delete it remotely" would
    // destroy a collaborator's data on any of those.
    const task = sharedTask();
    const plan = planSharedTaskWrites({ tasks: [], projectId: PROJECT, syncedFingerprints: syncedFrom([task]) });
    expect(plan.deletes).toEqual([]);
  });

  it('deletes only what the caller explicitly says was deleted', () => {
    const task = sharedTask();
    const plan = planSharedTaskWrites({
      tasks: [],
      projectId: PROJECT,
      syncedFingerprints: syncedFrom([task]),
      deletedIds: ['s1'],
    });
    expect(plan.deletes).toEqual(['s1']);
  });

  it('skips a delete for something never synced — no wasted round-trip', () => {
    const plan = planSharedTaskWrites({
      tasks: [],
      projectId: PROJECT,
      syncedFingerprints: new Map(),
      deletedIds: ['never-existed'],
    });
    expect(plan.deletes).toEqual([]);
  });
});

describe('planRemoteTaskApply — the in-flight write race guard', () => {
  it('applies a remote change when nothing is pending', () => {
    const local = sharedTask();
    const remote = [{ ...serializeSharedTask(local), title: 'Changed elsewhere' }];
    const { tasks } = planRemoteTaskApply({ localTasks: [local], remoteTasks: remote, projectId: PROJECT, pending: new Map() });
    expect(tasks[0].title).toBe('Changed elsewhere');
    expect(tasks[0].sharedProjectId).toBe(PROJECT);
  });

  it('IGNORES a stale snapshot that predates our own in-flight write', () => {
    // The race: we edited locally, the write is in flight, and a snapshot
    // computed before it arrives. Applying it would revert the edit on screen
    // AND clobber the copy the pending write came from, losing it entirely.
    const edited = sharedTask({ title: 'My edit' });
    const pending = new Map([['s1', sharedTaskFingerprint(edited)]]);
    const staleRemote = [{ ...serializeSharedTask(sharedTask()), title: 'Old value' }];
    const { tasks, confirmedIds } = planRemoteTaskApply({
      localTasks: [edited],
      remoteTasks: staleRemote,
      projectId: PROJECT,
      pending,
    });
    expect(tasks[0].title).toBe('My edit');
    expect(confirmedIds).toEqual([]);
  });

  it('clears the guard once the server echoes back what we wrote', () => {
    const edited = sharedTask({ title: 'My edit' });
    const pending = new Map([['s1', sharedTaskFingerprint(edited)]]);
    const { tasks, confirmedIds } = planRemoteTaskApply({
      localTasks: [edited],
      remoteTasks: [serializeSharedTask(edited)],
      projectId: PROJECT,
      pending,
    });
    expect(confirmedIds).toEqual(['s1']);
    expect(tasks[0].title).toBe('My edit');
  });

  it('guards per task — one in-flight edit does not block other collaborators changes', () => {
    const mine = sharedTask({ id: 'mine', title: 'My edit' });
    const theirs = sharedTask({ id: 'theirs', title: 'Old' });
    const pending = new Map([['mine', sharedTaskFingerprint(mine)]]);
    const remote = [
      { ...serializeSharedTask(sharedTask({ id: 'mine' })), title: 'Stale' },
      { ...serializeSharedTask(theirs), title: 'Their new edit' },
    ];
    const { tasks } = planRemoteTaskApply({ localTasks: [mine, theirs], remoteTasks: remote, projectId: PROJECT, pending });
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(byId.mine.title).toBe('My edit');
    expect(byId.theirs.title).toBe('Their new edit');
  });

  it('removes a task deleted remotely, and reports it so blocks can be pruned', () => {
    const local = sharedTask();
    const { tasks, removedIds } = planRemoteTaskApply({
      localTasks: [local],
      remoteTasks: [],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(tasks).toEqual([]);
    expect(removedIds).toEqual(['s1']);
  });

  it('keeps a locally-created task the server has not echoed yet, rather than flickering it away', () => {
    const created = sharedTask();
    const pending = new Map([['s1', sharedTaskFingerprint(created)]]);
    const { tasks, removedIds } = planRemoteTaskApply({
      localTasks: [created],
      remoteTasks: [],
      projectId: PROJECT,
      pending,
    });
    expect(tasks.map((t) => t.id)).toEqual(['s1']);
    expect(removedIds).toEqual([]);
  });

  it('keeps a locally-deleted task deleted while our delete is in flight', () => {
    const pending = new Map([['s1', null]]);
    const { tasks, confirmedIds } = planRemoteTaskApply({
      localTasks: [],
      remoteTasks: [serializeSharedTask(sharedTask())],
      projectId: PROJECT,
      pending,
    });
    expect(tasks).toEqual([]);
    expect(confirmedIds).toEqual([]);
  });

  it('confirms our delete once the server no longer has it', () => {
    const pending = new Map([['s1', null]]);
    const { confirmedIds } = planRemoteTaskApply({
      localTasks: [sharedTask()],
      remoteTasks: [],
      projectId: PROJECT,
      pending,
    });
    expect(confirmedIds).toEqual(['s1']);
  });

  it('leaves personal tasks and other projects untouched, preserving their order', () => {
    const personal = personalTask();
    const other = sharedTask({ id: 'o1', sharedProjectId: 'proj_2' });
    const { tasks } = planRemoteTaskApply({
      localTasks: [personal, sharedTask(), other],
      remoteTasks: [serializeSharedTask(sharedTask())],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(tasks.map((t) => t.id)).toEqual(['p1', 's1', 'o1']);
  });

  it('adds a task created by a collaborator', () => {
    const { tasks } = planRemoteTaskApply({
      localTasks: [],
      remoteTasks: [serializeSharedTask(sharedTask({ id: 'new' }))],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(tasks.map((t) => t.id)).toEqual(['new']);
  });

  it('REGRESSION: keeps a just-created local task with no `pending` entry yet — addTask tags sharedProjectId synchronously, but the debounced push (and thus `pending`) has not run yet, so a snapshot landing in that window must not treat "not pending, not remote, not yet known-remote" as deleted', () => {
    const justCreated = sharedTask({ id: 'brand-new' });
    const { tasks, removedIds } = planRemoteTaskApply({
      localTasks: [justCreated],
      remoteTasks: [], // server hasn't seen it yet, and there's no pending entry for it either
      projectId: PROJECT,
      pending: new Map(), // debounce window: nothing marked in-flight yet
      knownRemoteIds: [], // never confirmed to exist server-side — exactly the ambiguous case
    });
    expect(tasks.map((t) => t.id)).toEqual(['brand-new']);
    expect(removedIds).toEqual([]);
  });

  it('still removes a task genuinely deleted by a collaborator, once it was previously known to exist server-side', () => {
    // Guards against a fix that's too permissive: a task the server used to
    // have (present in knownRemoteIds) but no longer does must still disappear,
    // even with no pending entry for it.
    const local = sharedTask({ id: 'was-here' });
    const { tasks, removedIds } = planRemoteTaskApply({
      localTasks: [local],
      remoteTasks: [],
      projectId: PROJECT,
      pending: new Map(),
      knownRemoteIds: ['was-here'],
    });
    expect(tasks).toEqual([]);
    expect(removedIds).toEqual(['was-here']);
  });

  it('without knownRemoteIds supplied at all (old callers), falls back to the pre-existing behaviour of removing an unpending local task', () => {
    const local = sharedTask({ id: 'legacy' });
    const { tasks, removedIds } = planRemoteTaskApply({
      localTasks: [local],
      remoteTasks: [],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(tasks).toEqual([]);
    expect(removedIds).toEqual(['legacy']);
  });
});

describe('mergeSharedTask — last-write-wins, except for recurring completions', () => {
  it('takes the remote document wholesale for a plain task', () => {
    const local = sharedTask({ title: 'Mine' });
    const remote = sharedTask({ title: 'Theirs' });
    expect(mergeSharedTask(local, remote).title).toBe('Theirs');
  });

  it('unions recurring completions instead of letting one side erase the other', () => {
    const recurring = {
      ...sharedTask(),
      isRecurring: true,
      recurrenceString: 'every day',
      recurrenceRule: deriveRecurrenceRule('every day'),
      recurrenceAnchor: '2026-08-01',
    };
    const local = { ...recurring, completedOccurrences: ['2026-08-01'], skippedThrough: null };
    const remote = { ...recurring, completedOccurrences: ['2026-08-02'], skippedThrough: null };
    expect(mergeSharedTask(local, remote).completedOccurrences).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('returns the remote task when there is no local counterpart', () => {
    const remote = sharedTask();
    expect(mergeSharedTask(undefined, remote)).toBe(remote);
  });

  it('re-derives dueDate from the MERGED occurrence set, not whatever the remote doc happened to carry', () => {
    // Two collaborators complete different occurrences of the same daily
    // task, written from snapshots taken before either saw the other's
    // completion. Remote's OWN dueDate (computed from its lone completion,
    // 08-02) still points at 08-02 — a date the merged/unioned set now shows
    // as already completed. It must be re-derived from the union, not taken
    // wholesale from remote.
    const recurring = {
      ...sharedTask(),
      isRecurring: true,
      recurrenceString: 'every day',
      recurrenceRule: deriveRecurrenceRule('every day'),
      recurrenceAnchor: '2026-08-01',
    };
    // Local completed 08-01 only; its own dueDate advanced to 08-02.
    const local = { ...recurring, completedOccurrences: ['2026-08-01'], skippedThrough: null, dueDate: '2026-08-02' };
    // Remote completed 08-02 (never having seen local's 08-01 completion), so
    // ITS OWN dueDate is still just the occurrence after 08-02: 08-02 itself
    // was the due date being completed, so remote's stored dueDate is 08-02
    // (the value it read/advanced from) — stale once unioned with local.
    const remote = { ...recurring, completedOccurrences: ['2026-08-02'], skippedThrough: null, dueDate: '2026-08-02' };
    const merged = mergeSharedTask(local, remote, '2026-08-02');
    expect(merged.completedOccurrences).toEqual(['2026-08-01', '2026-08-02']);
    // The union completes both 08-01 and 08-02, so the correct next due date
    // is 08-03 — remote's stale 08-02 (already completed in the union) must
    // not survive the merge.
    expect(merged.dueDate).toBe('2026-08-03');
  });

  it('still honours the mixed-version-device guard after re-deriving: a stored dueDate further ahead than derivation wins', () => {
    // A pre-migration client can legitimately push dueDate ahead without
    // recording an occurrence. Re-deriving on merge must not undo that.
    const recurring = {
      ...sharedTask(),
      isRecurring: true,
      recurrenceString: 'every day',
      recurrenceRule: deriveRecurrenceRule('every day'),
      recurrenceAnchor: '2026-08-01',
    };
    const local = { ...recurring, completedOccurrences: [], skippedThrough: null, dueDate: '2026-08-01' };
    // Remote is a stale/pre-migration write that jumped dueDate ahead without
    // recording the occurrence in completedOccurrences.
    const remote = { ...recurring, completedOccurrences: [], skippedThrough: null, dueDate: '2026-08-10' };
    const merged = mergeSharedTask(local, remote, '2026-08-01');
    expect(merged.dueDate).toBe('2026-08-10');
  });
});

describe('preserveSharedTasks — the undo/redo landmine', () => {
  it('keeps live shared tasks instead of a history snapshot copy', () => {
    // Undoing an unrelated action must not revert a collaborator's concurrent
    // edit to a task the undoing user never touched.
    const snapshot = [personalTask({ title: 'Old personal' }), sharedTask({ title: 'Stale snapshot copy' })];
    const live = [sharedTask({ title: 'Collaborator current' })];
    const result = preserveSharedTasks(snapshot, live);
    expect(result.map((t) => t.title)).toEqual(['Old personal', 'Collaborator current']);
  });

  it('resurrects shared tasks dropped entirely by a restore that never knew about them', () => {
    const result = preserveSharedTasks([personalTask()], [sharedTask()]);
    expect(result.map((t) => t.id)).toEqual(['p1', 's1']);
  });

  it('drops shared tasks when there are none live (project left or deleted)', () => {
    expect(preserveSharedTasks([personalTask(), sharedTask()], [])).toHaveLength(1);
  });
});

describe('computeActiveViewers', () => {
  const now = 1_800_000_000_000;

  it('includes recent heartbeats and excludes stale ones', () => {
    const viewers = computeActiveViewers(
      [
        { uid: 'a', displayName: 'Ana', lastSeenAt: now - 5_000 },
        { uid: 'b', displayName: 'Bo', lastSeenAt: now - PRESENCE_STALE_MS - 1 },
      ],
      now
    );
    expect(viewers.map((v) => v.uid)).toEqual(['a']);
  });

  it('excludes the current user, who is not shown their own avatar', () => {
    const viewers = computeActiveViewers([{ uid: 'me', displayName: 'Me', lastSeenAt: now }], now, 'me');
    expect(viewers).toEqual([]);
  });

  it('accepts the timestamp shapes Firestore actually returns', () => {
    const entries = [
      { uid: 'a', displayName: 'A', lastSeenAt: now },
      { uid: 'b', displayName: 'B', lastSeenAt: new Date(now) },
      { uid: 'c', displayName: 'C', lastSeenAt: { toMillis: () => now } },
      { uid: 'd', displayName: 'D', lastSeenAt: { seconds: Math.floor(now / 1000) } },
    ];
    expect(computeActiveViewers(entries, now).map((v) => v.uid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops an unresolved serverTimestamp placeholder rather than treating it as 1970', () => {
    expect(computeActiveViewers([{ uid: 'a', displayName: 'A', lastSeenAt: null }], now)).toEqual([]);
  });

  it('falls back to a neutral name and never trusts a non-string photo URL', () => {
    const [viewer] = computeActiveViewers([{ uid: 'a', lastSeenAt: now, photoURL: { evil: true } }], now);
    expect(viewer.displayName).toBe('Someone');
    expect(viewer.photoURL).toBeNull();
  });

  it('sorts by display name so avatars do not reshuffle between heartbeats', () => {
    const viewers = computeActiveViewers(
      [
        { uid: 'z', displayName: 'Zoe', lastSeenAt: now },
        { uid: 'a', displayName: 'Ana', lastSeenAt: now },
      ],
      now
    );
    expect(viewers.map((v) => v.displayName)).toEqual(['Ana', 'Zoe']);
  });

  it('tolerates an empty/absent list', () => {
    expect(computeActiveViewers(undefined, now)).toEqual([]);
  });
});

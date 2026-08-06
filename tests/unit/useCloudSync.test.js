/**
 * ============================================================================
 * useCloudSync race-condition logic — coverage notes
 * ============================================================================
 * useCloudSync.js (src/hooks/useCloudSync.js) is the file that owns the
 * fingerprint/echo-detection and race-guard logic fixed in e4fc1c0
 * ("Fix 12 audit findings: cloud-sync races, validation gaps, and UI
 * staleness"). The hook itself still can't be rendered here (no
 * `@testing-library/react`, node environment, real Firebase calls), but its
 * pure decision logic — previously all closures over hook-internal refs —
 * has since been extracted into standalone, exported functions specifically
 * so it could be unit tested directly, without rendering the hook:
 *   - `computeFingerprint(source)` — hashes the syncable state subset.
 *   - `hasLocalEditRaced(baselineActionId, currentActionId)` — the race
 *     guard shared by the live-listener (`localEditLandedFirst`) and
 *     initial-pull (`localEditLandedDuringPull`) effects.
 *   - `planRemoteDataMerge(remoteData, localState, { skipTasksBlocks })` —
 *     applyRemoteData's merge decision (which fields to apply, whether to
 *     stamp lastPushedFingerprintRef).
 *   - `computePushStampPlan(currentState, lastPushedFingerprint)` —
 *     schedulePush's optimistic-stamp/rollback fingerprint sequencing.
 *   - `hasNewCompletion(prevTasks, nextTasks)` — whether an edit just marked a
 *     task completed, which schedulePush uses to bypass the push debounce so
 *     the notify-worker can't read a stale incomplete task and email an
 *     overdue reminder for something already finished.
 * The hook still performs all the actual React state-setting/Firestore I/O;
 * these functions only compute the decisions, so they're safe to test in
 * isolation while trusting (per a read-through of useCloudSync.js) that the
 * hook's call sites feed them the same inputs the old inline code used.
 *
 * What follows also includes real unit coverage of backupService.js's
 * `isValidFieldValue` / `isValidBackupPayload` — the exported, pure
 * validation helpers useCloudSync.js's own `pickValid` and
 * `applyBackupPayload` guards are built on. These are the concrete
 * "validation gaps" half of the same commit: they're what stops a
 * malformed Firestore doc, corrupted backup file, or partial live-sync
 * write from being applied as-is and crashing later at render time.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { isValidFieldValue, isValidBackupPayload, BACKUP_FIELDS } from '../../src/services/backupService.js';
import {
  computeFingerprint,
  hasLocalEditRaced,
  planRemoteDataMerge,
  computePushStampPlan,
  planAutoBackupPrune,
  shouldRestoreEventsFromBackup,
  hasNewCompletion,
} from '../../src/hooks/useCloudSync.js';

describe('isValidFieldValue', () => {
  it('accepts arrays for array-typed fields (tasks/blocks/sections/...)', () => {
    expect(isValidFieldValue('tasks', [])).toBe(true);
    expect(isValidFieldValue('tasks', [{ id: '1' }])).toBe(true);
  });

  it('rejects a non-array for an array-typed field (e.g. a tampered doc with tasks as a string)', () => {
    expect(isValidFieldValue('tasks', 'not-an-array')).toBe(false);
    expect(isValidFieldValue('blocks', null)).toBe(false);
    expect(isValidFieldValue('sections', {})).toBe(false);
  });

  it('accepts plain objects (not arrays) for object-typed fields', () => {
    expect(isValidFieldValue('notificationSettings', { timezone: 'UTC' })).toBe(true);
    expect(isValidFieldValue('notes', { folders: [], notes: [] })).toBe(true);
  });

  it('rejects an array or null for an object-typed field', () => {
    expect(isValidFieldValue('notificationSettings', [])).toBe(false);
    expect(isValidFieldValue('notificationSettings', null)).toBe(false);
  });

  it('validates boolean-typed fields strictly (no truthy/falsy coercion)', () => {
    expect(isValidFieldValue('soundEnabled', true)).toBe(true);
    expect(isValidFieldValue('soundEnabled', false)).toBe(true);
    expect(isValidFieldValue('soundEnabled', 1)).toBe(false);
    expect(isValidFieldValue('animationsEnabled', 'true')).toBe(false);
  });

  it('validates number-typed fields and rejects NaN/Infinity', () => {
    expect(isValidFieldValue('soundVolume', 0.5)).toBe(true);
    expect(isValidFieldValue('soundVolume', NaN)).toBe(false);
    expect(isValidFieldValue('soundVolume', Infinity)).toBe(false);
    expect(isValidFieldValue('soundVolume', '0.5')).toBe(false);
  });

  it('validates string-typed fields (theme)', () => {
    expect(isValidFieldValue('theme', 'dark')).toBe(true);
    expect(isValidFieldValue('theme', 123)).toBe(false);
  });

  it('falls back to accepting anything for a field with no declared type', () => {
    expect(isValidFieldValue('someUnknownField', 'whatever')).toBe(true);
  });
});

describe('isValidBackupPayload', () => {
  const validPayload = {
    tasks: [],
    blocks: [],
    sections: [],
    projects: [],
    labels: [],
    routines: [],
    rules: {},
    soundEnabled: true,
    soundVolume: 0.5,
    animationsEnabled: true,
    notificationSettings: {},
    theme: 'dark',
    notes: { folders: [], notes: [] },
    shortcutBindings: {},
    events: [],
    sharedProjectIds: [],
  };

  it('accepts a payload with every backup field present and correctly typed', () => {
    expect(isValidBackupPayload(validPayload)).toBe(true);
  });

  it('rejects null/non-object payloads outright', () => {
    expect(isValidBackupPayload(null)).toBe(false);
    expect(isValidBackupPayload(undefined)).toBe(false);
    expect(isValidBackupPayload('not-an-object')).toBe(false);
  });

  it('rejects a payload missing a required field entirely', () => {
    const { tasks, ...missingTasks } = validPayload;
    expect(isValidBackupPayload(missingTasks)).toBe(false);
  });

  it('rejects a payload where one field has the wrong runtime shape (would otherwise crash at render, e.g. sections.map on a string)', () => {
    expect(isValidBackupPayload({ ...validPayload, sections: 'oops' })).toBe(false);
  });

  it('accepts a legacy pre-Notes payload carrying pinnedLinks in place of notes', () => {
    const { notes, ...rest } = validPayload;
    const legacyPayload = { ...rest, pinnedLinks: [{ url: 'https://example.com' }] };
    expect(isValidBackupPayload(legacyPayload)).toBe(true);
  });

  it('still requires every OTHER field even in the legacy pinnedLinks case', () => {
    const { notes, tasks, ...rest } = validPayload;
    const legacyPayload = { ...rest, pinnedLinks: [] };
    expect(isValidBackupPayload(legacyPayload)).toBe(false);
  });

  it('covers every field useCloudSync.js applies via pickValid (BACKUP_FIELDS list stays in sync)', () => {
    // Sanity check that the fixture above actually exercises the full field
    // set applyRemoteData/applyBackupPayload guard against, so this test
    // doesn't silently go stale if BACKUP_FIELDS gains a new field.
    BACKUP_FIELDS.forEach((field) => {
      expect(field in validPayload).toBe(true);
    });
  });
});

describe('computeFingerprint', () => {
  const baseState = {
    tasks: [{ id: '1', title: 'A' }],
    blocks: [{ id: 'b1' }],
    sections: [],
    projects: [],
    labels: [],
    routines: [],
    rules: {},
    soundEnabled: true,
    soundVolume: 0.5,
    animationsEnabled: true,
    notificationSettings: { timezone: 'UTC' },
    notes: { folders: [], notes: [] },
    shortcutBindings: {},
  };

  it('ignores an events field entirely (events are excluded from LIVE cross-device sync specifically — they ARE included in point-in-time backups, see backupService.test.js)', () => {
    const withEvents = { ...baseState, events: [{ id: 'e1' }] };
    expect(computeFingerprint(baseState)).toBe(computeFingerprint(withEvents));
  });

  it('produces the same fingerprint for the same data (so a pushed echo is recognized)', () => {
    const copy = JSON.parse(JSON.stringify(baseState));
    expect(computeFingerprint(baseState)).toBe(computeFingerprint(copy));
  });

  it('produces a different fingerprint when a syncable field changes', () => {
    const changed = { ...baseState, tasks: [{ id: '1', title: 'A (edited)' }] };
    expect(computeFingerprint(baseState)).not.toBe(computeFingerprint(changed));
  });

  it('ignores fields outside the syncable subset (e.g. extra local-only keys)', () => {
    const withExtra = { ...baseState, someLocalOnlyField: 'ignored' };
    expect(computeFingerprint(baseState)).toBe(computeFingerprint(withExtra));
  });

  it('is sensitive to sharedProjectIds (unlike events, this membership list IS live cross-device synced)', () => {
    const withShared = { ...baseState, sharedProjectIds: ['sp1'] };
    expect(computeFingerprint(baseState)).not.toBe(computeFingerprint(withShared));
  });

  // Documents a deliberate, benign one-off effect of adding sharedProjectIds to
  // the fingerprint: a cloud doc written before the field existed has no
  // `sharedProjectIds` key at all, and JSON.stringify omits undefined, so its
  // fingerprint differs from a current client's (which defaults to []). On the
  // first sync after upgrading, an existing signed-in user therefore sees one
  // spurious "something changed" signal and pushes once, writing
  // `sharedProjectIds: []` and converging permanently after that.
  //
  // This is safe rather than lossy because every consumer guards on
  // `'sharedProjectIds' in ...` with a pickValid fallback (see
  // planRemoteDataMerge / applyRemoteData / applyBackupPayload), so a legacy
  // doc or legacy backup is never clobbered — the absent field is left alone.
  // Asserted explicitly so nobody "fixes" this into a silent default that would
  // make a genuinely-empty membership list indistinguishable from a missing one.
  it('distinguishes a legacy doc with no sharedProjectIds key from an explicit empty list', () => {
    const legacyRemote = { ...baseState };
    delete legacyRemote.sharedProjectIds;
    const currentLocal = { ...baseState, sharedProjectIds: [] };
    expect(computeFingerprint(legacyRemote)).not.toBe(computeFingerprint(currentLocal));
    // ...and the legacy fingerprint simply omits the key rather than encoding null.
    expect(computeFingerprint(legacyRemote)).not.toContain('sharedProjectIds');
    expect(computeFingerprint(currentLocal)).toContain('"sharedProjectIds":[]');
  });
});

describe('hasLocalEditRaced', () => {
  it('reports no race when the current action id still matches the baseline (listener shape)', () => {
    // Mirrors the live-listener effect: actionIdAtSubscribe vs. currentActionIdRef.current.
    expect(hasLocalEditRaced('action-5', 'action-5')).toBe(false);
  });

  it('reports a race when the action id changed since the baseline (listener shape)', () => {
    expect(hasLocalEditRaced('action-5', 'action-6')).toBe(true);
  });

  it('reports no race when the action id still matches the baseline (initial-pull shape)', () => {
    // Mirrors the initial-pull effect: actionIdAtStart vs. currentActionIdRef.current.
    expect(hasLocalEditRaced('pull-start-1', 'pull-start-1')).toBe(false);
  });

  it('reports a race when a local commit landed during the pull (initial-pull shape)', () => {
    expect(hasLocalEditRaced('pull-start-1', 'pull-start-2')).toBe(true);
  });

  it('treats undefined/null baseline and current consistently (initial mount, no prior action)', () => {
    expect(hasLocalEditRaced(undefined, undefined)).toBe(false);
    expect(hasLocalEditRaced(null, undefined)).toBe(true);
  });
});

describe('planRemoteDataMerge', () => {
  const localState = {
    tasks: [{ id: 'local-1' }],
    blocks: [{ id: 'local-block-1' }],
    sections: ['local-section'],
    projects: ['local-project'],
    labels: ['local-label'],
    routines: ['local-routine'],
    rules: { id: 'local-rule' },
    soundEnabled: false,
    soundVolume: 0.2,
    animationsEnabled: false,
    notificationSettings: { timezone: 'Local/Zone', remindersEnabled: true },
    notes: { folders: [], notes: [{ id: 'local-note' }] },
    shortcutBindings: { local: 'binding' },
  };

  const remoteData = {
    tasks: [{ id: 'remote-1' }],
    blocks: [{ id: 'remote-block-1' }],
    sections: ['remote-section'],
    projects: ['remote-project'],
    labels: ['remote-label'],
    routines: ['remote-routine'],
    rules: { id: 'remote-rule' },
    // Deliberately included in remoteData/localState fixtures (as a stray
    // extra field, same as an old Firestore doc from before events were
    // excluded from sync would still carry) to prove planRemoteDataMerge
    // ignores it — see the dedicated test below.
    events: [{ id: 'e2', occurrenceId: 'e2-occ' }],
    soundEnabled: true,
    soundVolume: 0.9,
    animationsEnabled: true,
    notificationSettings: { timezone: 'Remote/Zone', remindersEnabled: false },
    notes: { folders: [], notes: [{ id: 'remote-note' }] },
    shortcutBindings: { remote: 'binding' },
  };

  it('non-race path: applies every field including tasks/blocks, and stamps the fingerprint', () => {
    const plan = planRemoteDataMerge(remoteData, localState, { skipTasksBlocks: false });
    expect(plan.tasksBlocks).toEqual({ tasks: remoteData.tasks, blocks: remoteData.blocks });
    expect(plan.sections).toBe(remoteData.sections);
    expect(plan.projects).toBe(remoteData.projects);
    expect(plan.labels).toBe(remoteData.labels);
    expect(plan.routines).toBe(remoteData.routines);
    expect(plan.rules).toBe(remoteData.rules);
    expect(plan.soundEnabled).toBe(true);
    expect(plan.soundVolume).toBe(0.9);
    expect(plan.animationsEnabled).toBe(true);
    expect(plan.notes).toBe(remoteData.notes);
    expect(plan.shortcutBindings).toBe(remoteData.shortcutBindings);
    expect(plan.stampFingerprint).toBe(true);
  });

  it("notificationSettings always keeps this device's own timezone, even applied normally", () => {
    const plan = planRemoteDataMerge(remoteData, localState, { skipTasksBlocks: false });
    expect(plan.notificationSettings.remindersEnabled).toBe(false); // remote value wins
    // getBrowserTimeZone() in a node/vitest environment resolves to the host's
    // real IANA zone (not 'Local/Zone' or 'Remote/Zone') — the point of this
    // assertion is just that it's neither side's raw payload value.
    expect(plan.notificationSettings.timezone).not.toBe('Remote/Zone');
    expect(plan.notificationSettings.timezone).not.toBe('Local/Zone');
  });

  it('skipTasksBlocks path: leaves tasks/blocks unset, applies every other field, and leaves the fingerprint unstamped', () => {
    const plan = planRemoteDataMerge(remoteData, localState, { skipTasksBlocks: true });
    expect(plan.tasksBlocks).toBeUndefined();
    expect('tasks' in plan).toBe(false);
    expect('blocks' in plan).toBe(false);
    // Every other field still applies normally.
    expect(plan.sections).toBe(remoteData.sections);
    expect(plan.projects).toBe(remoteData.projects);
    expect(plan.labels).toBe(remoteData.labels);
    expect(plan.routines).toBe(remoteData.routines);
    expect(plan.rules).toBe(remoteData.rules);
    expect(plan.soundEnabled).toBe(true);
    expect(plan.notes).toBe(remoteData.notes);
    expect(plan.shortcutBindings).toBe(remoteData.shortcutBindings);
    // Deliberately left unstamped so the next schedulePush still pushes the
    // newer local edit instead of assuming this state is already synced.
    expect(plan.stampFingerprint).toBe(false);
  });

  it('never applies events, even when remoteData carries a stray/legacy events field', () => {
    // Google Calendar is the authoritative source for events day-to-day, and
    // an automatic, continuously-reconciled live sync of them re-opens the
    // exact "stale snapshot resurrects a deleted event" risk that got them
    // excluded here (see backupService.js's BACKUP_FIELDS doc comment) — this
    // exclusion is specific to the LIVE Firestore doc `planRemoteDataMerge`
    // reconciles against, NOT to point-in-time backups, which DO include
    // events now (a one-directional, user-initiated restore is a different
    // risk profile — see backupService.test.js).
    const plan = planRemoteDataMerge(remoteData, localState, { skipTasksBlocks: false });
    expect('events' in plan).toBe(false);
  });

  it('a malformed remote field falls back to the local value instead of being applied as-is', () => {
    const tamperedRemote = { ...remoteData, sections: 'not-an-array' };
    const plan = planRemoteDataMerge(tamperedRemote, localState, { skipTasksBlocks: false });
    expect(plan.sections).toBe(localState.sections);
  });

  it('a field missing from remoteData is left out of the plan entirely (older/partial doc leaves it untouched)', () => {
    const { labels, ...partialRemote } = remoteData;
    const plan = planRemoteDataMerge(partialRemote, localState, { skipTasksBlocks: false });
    expect('labels' in plan).toBe(false);
  });

  it('migrates a legacy pinnedLinks field into notes when notes itself is absent', () => {
    const { notes, ...rest } = remoteData;
    const legacyRemote = {
      ...rest,
      pinnedLinks: { folders: [], links: [{ id: 'l1', label: 'Example', url: 'https://example.com', createdAt: 1 }] },
    };
    const plan = planRemoteDataMerge(legacyRemote, localState, { skipTasksBlocks: false });
    expect(plan.notes).toBeDefined();
    expect(plan.notes.notes.some((n) => n.body === 'https://example.com')).toBe(true);
  });
});

describe('planAutoBackupPrune', () => {
  // Firestore Timestamps expose `.toMillis()`; plain numbers (used here for
  // brevity) are supported too — see the real function's `toMillis` helper.
  function backup(id, { automatic = true, createdAt } = {}) {
    return { id, automatic, createdAt };
  }

  it('keeps automatic backups within the retention count, deletes none', () => {
    const backups = [
      backup('a1', { createdAt: 5 }),
      backup('a2', { createdAt: 4 }),
      backup('a3', { createdAt: 3 }),
    ];
    expect(planAutoBackupPrune(backups, 14)).toEqual([]);
  });

  it('deletes only the automatic backups beyond the retention count, oldest first', () => {
    const backups = [
      backup('a1', { createdAt: 5 }),
      backup('a2', { createdAt: 4 }),
      backup('a3', { createdAt: 3 }),
      backup('a4', { createdAt: 2 }),
      backup('a5', { createdAt: 1 }),
    ];
    // Keep the 3 most recent (a1, a2, a3); prune the 2 oldest (a4, a5).
    expect(planAutoBackupPrune(backups, 3)).toEqual(['a4', 'a5']);
  });

  it('when given a mixed list, only prunes backups matching the automatic flag it filters on — a manual backup mixed into an automatic-heavy list is never swept up as if it were automatic', () => {
    const backups = [
      backup('manual-old', { automatic: false, createdAt: 0 }),
      ...Array.from({ length: 20 }, (_, i) => backup(`auto-${i}`, { createdAt: 20 - i })),
    ];
    const toDelete = planAutoBackupPrune(backups, 14);
    expect(toDelete).not.toContain('manual-old');
    expect(toDelete).toHaveLength(6); // 20 automatic - 14 retained
  });

  // planAutoBackupPrune takes a third `wantAutomatic` argument (default
  // true) so it can also prune the MANUAL pool — its own independent
  // retention count (MANUAL_BACKUP_RETENTION_COUNT, separate from automatic
  // backups' AUTO_BACKUP_RETENTION_COUNT — see useCloudSync's
  // runAutomaticBackupIfDue/pruneBackupPool) — by passing `false` and a
  // manual-only (or mixed) list.
  it('prunes manual backups beyond the retention count when wantAutomatic is false, oldest first', () => {
    const backups = [
      backup('m1', { automatic: false, createdAt: 5 }),
      backup('m2', { automatic: false, createdAt: 4 }),
      backup('m3', { automatic: false, createdAt: 3 }),
      backup('m4', { automatic: false, createdAt: 2 }),
      backup('m5', { automatic: false, createdAt: 1 }),
    ];
    expect(planAutoBackupPrune(backups, 3, false)).toEqual(['m4', 'm5']);
  });

  it('with wantAutomatic false, a mixed list never treats an automatic backup as a manual deletion candidate', () => {
    const backups = [
      backup('auto-old', { automatic: true, createdAt: 0 }),
      ...Array.from({ length: 20 }, (_, i) => backup(`manual-${i}`, { automatic: false, createdAt: 20 - i })),
    ];
    const toDelete = planAutoBackupPrune(backups, 14, false);
    expect(toDelete).not.toContain('auto-old');
    expect(toDelete).toHaveLength(6); // 20 manual - 14 retained
  });

  it('handles a Firestore Timestamp-shaped createdAt (an object with toMillis())', () => {
    const ts = (ms) => ({ toMillis: () => ms });
    const backups = [
      backup('a1', { createdAt: ts(3000) }),
      backup('a2', { createdAt: ts(2000) }),
      backup('a3', { createdAt: ts(1000) }),
    ];
    expect(planAutoBackupPrune(backups, 2)).toEqual(['a3']);
  });

  it('treats a missing/null createdAt as oldest (sorts last, pruned first when over the limit)', () => {
    const backups = [
      backup('a1', { createdAt: 100 }),
      backup('a2', { createdAt: null }),
      backup('a3', { createdAt: 50 }),
    ];
    expect(planAutoBackupPrune(backups, 2)).toEqual(['a2']);
  });
});

describe('computePushStampPlan', () => {
  const state = {
    tasks: [{ id: '1' }],
    blocks: [],
    sections: [],
    projects: [],
    labels: [],
    routines: [],
    rules: {},
    soundEnabled: true,
    soundVolume: 0.5,
    animationsEnabled: true,
    notificationSettings: {},
    notes: { folders: [], notes: [] },
    shortcutBindings: {},
  };

  it('reports no push needed when the fingerprint matches the last pushed one (no real change)', () => {
    const plan = computePushStampPlan(state, computeFingerprint(state));
    expect(plan.shouldPush).toBe(false);
  });

  it('reports a push is needed and returns the fingerprint to optimistically stamp, plus the rollback value', () => {
    const previousFingerprint = 'some-previous-fingerprint';
    const plan = computePushStampPlan(state, previousFingerprint);
    expect(plan.shouldPush).toBe(true);
    expect(plan.fingerprint).toBe(computeFingerprint(state));
    expect(plan.rollbackFingerprint).toBe(previousFingerprint);
  });

  it('rolls back to null (never pushed before) if that was the prior stamp', () => {
    const plan = computePushStampPlan(state, null);
    expect(plan.shouldPush).toBe(true);
    expect(plan.rollbackFingerprint).toBe(null);
  });
});

describe('hasNewCompletion', () => {
  const incomplete = { id: 't1', title: 'A', isCompleted: false };
  const complete = { id: 't1', title: 'A', isCompleted: true };

  it('detects a task that just became completed', () => {
    expect(hasNewCompletion([incomplete], [complete])).toBe(true);
  });

  it('ignores a task that was already completed before', () => {
    expect(hasNewCompletion([complete], [complete])).toBe(false);
  });

  it('ignores an un-completion (restore), which only risks a missing notification', () => {
    expect(hasNewCompletion([complete], [incomplete])).toBe(false);
  });

  it('detects a newly-added task that arrives already completed', () => {
    expect(hasNewCompletion([incomplete], [incomplete, { id: 't2', isCompleted: true }])).toBe(true);
  });

  it('ignores unrelated edits to an incomplete task', () => {
    expect(hasNewCompletion([incomplete], [{ ...incomplete, title: 'A renamed' }])).toBe(false);
  });

  it('treats the first-ever call (null baseline) as no completion, so mount does not force a push', () => {
    expect(hasNewCompletion(null, [complete])).toBe(false);
    expect(hasNewCompletion(undefined, [complete])).toBe(false);
  });

  it('tolerates missing/empty task arrays', () => {
    expect(hasNewCompletion([], [])).toBe(false);
    expect(hasNewCompletion([], undefined)).toBe(false);
    expect(hasNewCompletion([complete], [])).toBe(false);
  });

  it('detects a completion among many unchanged tasks', () => {
    const before = [
      { id: 'a', isCompleted: true },
      { id: 'b', isCompleted: false },
      { id: 'c', isCompleted: false },
    ];
    const after = before.map((t) => (t.id === 'c' ? { ...t, isCompleted: true } : t));
    expect(hasNewCompletion(before, after)).toBe(true);
  });
});

describe('shouldRestoreEventsFromBackup', () => {
  it('restores when events is empty and Google Calendar is not connected', () => {
    expect(shouldRestoreEventsFromBackup({ events: [], googleConnected: false })).toBe(true);
  });

  it('does not restore when Google Calendar is connected, even with no local events', () => {
    // Google Calendar's own silent reconnect already repopulates events in
    // this case — falling back to a possibly-stale backup here could
    // resurrect an event the user (or Google) already deleted.
    expect(shouldRestoreEventsFromBackup({ events: [], googleConnected: true })).toBe(false);
  });

  it('does not restore when local events already has data, regardless of Google connection', () => {
    expect(shouldRestoreEventsFromBackup({ events: [{ id: '1' }], googleConnected: false })).toBe(false);
  });

  it('treats a missing/undefined events array as empty', () => {
    expect(shouldRestoreEventsFromBackup({ events: undefined, googleConnected: false })).toBe(true);
  });
});

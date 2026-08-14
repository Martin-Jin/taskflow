/**
 * ============================================================================
 * useGoogleCalendarSync.js — retry-schedule coverage
 * ============================================================================
 * The hook itself is mostly effects/callbacks over the live Google Calendar
 * API, which isn't practical to unit test here (see googleCalendarService's
 * own coverage notes for the same reasoning). The mount-time silent re-auth's
 * backoff schedule is the one piece of pure logic worth pinning down: it
 * decides how many times a cold-start fetch retries before the app gives up
 * for that mount pass and flags the sync stale, so an off-by-one here means
 * either a missing retry (the original bug) or a retry loop that never ends.
 *
 * Also covered here are the pure decision helpers behind two duplicate/
 * reliability fixes in the same hook:
 *   - `isBlockSourcedEvent` / `dedupeAuthoritativeItems` — recognizing (and,
 *     as a backstop, collapsing) the block-mirror events that made every
 *     "Rewrite Google Calendar" run re-create a second copy of every synced
 *     block.
 *   - `isUnsyncedPushableEvent` — which events the periodic/manual push sweep
 *     should retry, closing the gap where an event whose one-shot push failed
 *     was stranded unsynced forever while blocks were retried every tick.
 *   - `planOngoingCalendarSync` / `blockSyncSignature` — the ONGOING (everyday)
 *     reconciliation that keeps Google matching TaskFlow as blocks are moved,
 *     re-placed by a rebalance, or deleted. The rewrite feature cleans up
 *     accumulated drift; this is what stops it accumulating between rewrites,
 *     so it carries the same CRITICAL weight and is covered accordingly.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  getSilentReauthRetryDelay,
  SILENT_REAUTH_MAX_ATTEMPTS,
  isUnsyncedPushableEvent,
  dedupeAuthoritativeItems,
  planOngoingCalendarSync,
  blockSyncSignature,
} from '../../src/hooks/useGoogleCalendarSync.js';
import { isBlockSourcedEvent } from '../../src/services/googleCalendarService.js';

describe('getSilentReauthRetryDelay', () => {
  it('runs the first attempt immediately', () => {
    expect(getSilentReauthRetryDelay(0)).toBe(0);
  });

  it('backs off on subsequent attempts', () => {
    expect(getSilentReauthRetryDelay(1)).toBe(2000);
    expect(getSilentReauthRetryDelay(2)).toBe(5000);
  });

  it('increases monotonically across the whole schedule', () => {
    for (let i = 1; i < SILENT_REAUTH_MAX_ATTEMPTS; i += 1) {
      expect(getSilentReauthRetryDelay(i)).toBeGreaterThan(getSilentReauthRetryDelay(i - 1));
    }
  });

  it('allows exactly SILENT_REAUTH_MAX_ATTEMPTS attempts', () => {
    expect(SILENT_REAUTH_MAX_ATTEMPTS).toBe(3);
    expect(getSilentReauthRetryDelay(SILENT_REAUTH_MAX_ATTEMPTS - 1)).not.toBeNull();
  });

  it('returns null past the last attempt, so the caller stops retrying', () => {
    expect(getSilentReauthRetryDelay(SILENT_REAUTH_MAX_ATTEMPTS)).toBeNull();
    expect(getSilentReauthRetryDelay(99)).toBeNull();
  });

  it('returns null for invalid indices rather than retrying forever', () => {
    expect(getSilentReauthRetryDelay(-1)).toBeNull();
    expect(getSilentReauthRetryDelay(1.5)).toBeNull();
    expect(getSilentReauthRetryDelay(undefined)).toBeNull();
  });
});

describe('isBlockSourcedEvent — recognizing TaskFlow own block mirrors', () => {
  // THE push-side duplicate root cause. TaskFlow pushes a ScheduledBlock to
  // Google; the next poll pulls that same event back as an ordinary
  // `source: 'google'` CalendarEvent. Local state then holds BOTH the block
  // and a mirror event of it. "Rewrite Google Calendar to match TaskFlow"
  // treats blocks and events as authoritative and pushes both — creating a
  // second real Google event for every synced block, on every run. That is
  // why duplicates appeared DURING the push phase even when the delete phase
  // had correctly cleared the calendar first.

  it('recognizes a mirror by its private extended property', () => {
    expect(isBlockSourcedEvent({ title: 'Anything', taskflowBlockId: 'blk_1' })).toBe(true);
  });

  it('recognizes a legacy mirror pushed before the marker existed, by its title prefix', () => {
    // Events pushed by older builds carry no extended property at all, so the
    // "📋 " prefix this app has always written is the only signal available.
    expect(isBlockSourcedEvent({ title: '📋 Write report', source: 'google' })).toBe(true);
  });

  it('does NOT treat an ordinary user event as a mirror', () => {
    expect(isBlockSourcedEvent({ title: 'Dentist', source: 'google' })).toBe(false);
  });

  it('does NOT treat a same-titled user event without the prefix as a mirror', () => {
    expect(isBlockSourcedEvent({ title: 'Write report', source: 'google' })).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isBlockSourcedEvent(null)).toBe(false);
    expect(isBlockSourcedEvent(undefined)).toBe(false);
  });
});

describe('isUnsyncedPushableEvent — the retry sweep for events', () => {
  // Events had no retry path at all: addManualEvent/updateEvent each fire ONE
  // best-effort push and only log/toast on failure, so an event whose push
  // failed (offline, not yet connected, tab closed mid-flight) was stranded
  // with googleEventId: null forever. Blocks were swept every poll tick;
  // events simply weren't. This predicate is what makes the sweep symmetric.
  const base = { id: 'e1', title: 'Coffee', date: '2026-08-20', startTime: '09:00', endTime: '10:00' };

  it('selects a manual event that has never been pushed', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'manual', googleEventId: null })).toBe(true);
  });

  it('skips an event that already has a googleEventId', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', googleEventId: 'gcal_1' })).toBe(false);
  });

  it('CRITICAL SAFETY: never pushes a copy of a subscribed/foreign-calendar event', () => {
    // Pushing this would duplicate someone else's event onto the user's own
    // primary calendar — the same boundary the rewrite's authoritative set
    // enforces.
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', calendarId: 'team@example.com', googleEventId: null })).toBe(false);
  });

  it('allows an unsynced event sourced from the user own primary calendar', () => {
    expect(isUnsyncedPushableEvent({ ...base, source: 'google', calendarId: 'primary', googleEventId: null })).toBe(true);
  });

  it('skips a block-mirror row, since the block itself is what gets pushed', () => {
    expect(isUnsyncedPushableEvent({ ...base, title: '📋 Write report', source: 'manual', googleEventId: null })).toBe(false);
  });

  it('skips an event missing date/time, which could not build a valid resource', () => {
    expect(isUnsyncedPushableEvent({ id: 'e2', title: 'Broken', source: 'manual', googleEventId: null })).toBe(false);
    expect(isUnsyncedPushableEvent({ ...base, startTime: undefined, source: 'manual', googleEventId: null })).toBe(false);
  });
});

describe('dedupeAuthoritativeItems — last-resort guard against pushing duplicates', () => {
  // Defence in depth for the one place in the app that can mint permanent
  // duplicates on a real calendar. A duplicate that reaches Google survives
  // every later sync, so this collapses anything that would render as the
  // same event at the same time regardless of how local state got that way.
  const block = (taskTitle, date, startTime, id = `${taskTitle}-${startTime}`) => ({
    kind: 'block',
    block: { id, date, startTime, endTime: '10:00' },
    task: { title: taskTitle },
  });
  const event = (title, date, startTime, id = `${title}-${startTime}`) => ({
    kind: 'event',
    event: { id, title, date, startTime, endTime: '10:00' },
  });

  it('keeps a single copy when two rows would create the same Google event', () => {
    const items = [block('Piano', '2026-08-20', '09:00', 'a'), block('Piano', '2026-08-20', '09:00', 'b')];
    const { items: kept, duplicates } = dedupeAuthoritativeItems(items);
    expect(kept).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it('reports the duplicates it dropped, so local-state corruption can be surfaced rather than hidden', () => {
    const items = [event('Copilot', '2026-08-21', '14:00', 'x'), event('Copilot', '2026-08-21', '14:00', 'y')];
    const { duplicates } = dedupeAuthoritativeItems(items);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].event.id).toBe('y'); // first occurrence wins, later ones reported
  });

  it('keeps genuinely different placements of the same task', () => {
    const items = [block('Piano', '2026-08-20', '09:00'), block('Piano', '2026-08-21', '09:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('keeps same-titled items at different times on the same day', () => {
    const items = [block('Piano', '2026-08-20', '09:00'), block('Piano', '2026-08-20', '15:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('does not collapse a block and an event that merely share a title', () => {
    // Different kinds produce different Google events (a block is pushed with
    // the "📋 " prefix and its own resource shape), so they are not duplicates.
    const items = [block('Piano', '2026-08-20', '09:00'), event('Piano', '2026-08-20', '09:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('treats differing recurrence rules as distinct events', () => {
    const weekly = { kind: 'event', event: { id: 'w', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00', recurrenceRule: 'FREQ=WEEKLY' } };
    const oneOff = { kind: 'event', event: { id: 'o', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00' } };
    expect(dedupeAuthoritativeItems([weekly, oneOff]).items).toHaveLength(2);
  });

  it('is a no-op on already-clean input', () => {
    const items = [block('A', '2026-08-20', '09:00'), event('B', '2026-08-20', '11:00')];
    const { items: kept, duplicates } = dedupeAuthoritativeItems(items);
    expect(kept).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('handles an empty list', () => {
    expect(dedupeAuthoritativeItems([])).toEqual({ items: [], duplicates: [] });
  });
});

describe('planOngoingCalendarSync — keeping Google in step during ORDINARY use', () => {
  // This is the everyday counterpart to the one-off "Rewrite Google Calendar"
  // action. The rewrite cleans up accumulated mess; this is what stops mess
  // accumulating in the first place.
  //
  // The gap it closes: pushBlockToCalendar was only ever called for blocks
  // with NO googleEventId. So a block that was already synced and then MOVED
  // (drag/resize in WeekView, an edit in BlockDetailModal, or a rebalance
  // re-placing a recurring task) still had its id, looked "already synced",
  // and was never pushed again — its Google event just stayed behind at the
  // old time forever. And a block that vanished (deleteBlock, or a rebalance
  // dropping it) left its Google event orphaned with nothing referencing it.

  const task = (id, title) => ({ id, title });
  const block = (id, taskId, date, startTime, endTime, googleEventId = null) => ({
    id, taskId, date, startTime, endTime, googleEventId,
  });

  it('creates a Google event for a block that has never been synced', () => {
    const blocks = [block('b1', 't1', '2026-08-20', '09:00', '10:00')];
    const plan = planOngoingCalendarSync(blocks, [task('t1', 'Write report')], {});
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('does nothing for a synced block that has not changed', () => {
    // The steady state — most sync ticks must be completely silent, or every
    // poll would re-push the entire calendar.
    const b = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const t = task('t1', 'Write report');
    const record = { b1: { googleEventId: 'gcal_1', signature: blockSyncSignature(b, t) } };
    const plan = planOngoingCalendarSync([b], [t], record);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('CRITICAL: updates (not duplicates) the existing Google event when a block is dragged to a new time', () => {
    // The WeekView drag/resize path. Before this, the moved block kept its
    // googleEventId, looked synced, and was never pushed — so Google kept
    // showing the OLD time indefinitely.
    const t = task('t1', 'Write report');
    const before = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const record = { b1: { googleEventId: 'gcal_1', signature: blockSyncSignature(before, t) } };
    const moved = block('b1', 't1', '2026-08-20', '14:00', '15:00', 'gcal_1');

    const plan = planOngoingCalendarSync([moved], [t], record);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0].googleEventId).toBe('gcal_1'); // updates in place
    expect(plan.toCreate).toHaveLength(0); // must NOT create a second event
    expect(plan.toDelete).toHaveLength(0); // must NOT orphan the original
  });

  it('CRITICAL: a rebalance-relocated block (new id, googleEventId stripped) updates in place instead of duplicating', () => {
    // The worst case, and the one that silently accumulated duplicates during
    // ordinary use. A block's id encodes its placement
    // (blk_${taskId}_${date}_${startTime}), so a rebalance that moves it mints
    // a NEW id. preserveGoogleEventIds matches on exact id, finds no
    // predecessor, and does NOT carry the googleEventId over — so the block
    // looks brand new (push -> duplicate) while the original Google event is
    // orphaned. Note the record here is filed ONLY under the old block id,
    // exactly as it would be in reality; the planner has to find it by task.
    const t = task('t1', 'Piano');
    const oldBlock = block('blk_t1_2026-08-20_09:00', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const record = {
      'blk_t1_2026-08-20_09:00': { googleEventId: 'gcal_1', signature: blockSyncSignature(oldBlock, t), taskId: 't1' },
    };
    // Rebalance re-placed it: new id AND googleEventId stripped to null.
    const relocated = block('blk_t1_2026-08-20_11:00', 't1', '2026-08-20', '11:00', '12:00', null);

    const plan = planOngoingCalendarSync([relocated], [t], record);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0].googleEventId).toBe('gcal_1'); // moves the SAME event
    expect(plan.toUpdate[0].inheritedFromBlockId).toBe('blk_t1_2026-08-20_09:00');
    expect(plan.toCreate).toHaveLength(0); // no duplicate created
    expect(plan.toDelete).toHaveLength(0); // no orphan left behind
  });

  it('infers the task from the block id when a legacy record has no taskId stored', () => {
    // Records written before taskId was stamped must still resolve, or the
    // first sweep after upgrading would duplicate every relocated block.
    const t = task('t1', 'Piano');
    const record = { 'blk_t1_2026-08-20_09:00': { googleEventId: 'gcal_1', signature: 'stale' } };
    const relocated = block('blk_t1_2026-08-20_11:00', 't1', '2026-08-20', '11:00', '12:00', null);
    const plan = planOngoingCalendarSync([relocated], [t], record);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
  });

  it('gives each relocated block a DISTINCT inherited event, never the same one twice', () => {
    // A recurring task with several blocks all re-minted at once must not have
    // every one of them claim the same Google event — that would collapse them
    // onto a single event and orphan the rest.
    const t = task('t1', 'Piano');
    const record = {
      'blk_t1_2026-08-20_09:00': { googleEventId: 'gcal_1', signature: 's', taskId: 't1' },
      'blk_t1_2026-08-21_09:00': { googleEventId: 'gcal_2', signature: 's', taskId: 't1' },
    };
    const relocatedA = block('blk_t1_2026-08-20_15:00', 't1', '2026-08-20', '15:00', '16:00', null);
    const relocatedB = block('blk_t1_2026-08-21_15:00', 't1', '2026-08-21', '15:00', '16:00', null);
    const plan = planOngoingCalendarSync([relocatedA, relocatedB], [t], record);
    const claimed = plan.toUpdate.map((u) => u.googleEventId).sort();
    expect(claimed).toEqual(['gcal_1', 'gcal_2']);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('deletes only the surplus event when a task drops from two blocks to one', () => {
    // One relocated block inherits one event; the leftover record has no live
    // block to claim it, so it is correctly swept as an orphan.
    const t = task('t1', 'Piano');
    const record = {
      'blk_t1_2026-08-20_09:00': { googleEventId: 'gcal_1', signature: 's', taskId: 't1' },
      'blk_t1_2026-08-21_09:00': { googleEventId: 'gcal_2', signature: 's', taskId: 't1' },
    };
    const remaining = block('blk_t1_2026-08-20_15:00', 't1', '2026-08-20', '15:00', '16:00', null);
    const plan = planOngoingCalendarSync([remaining], [t], record);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toDelete).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
  });

  it('CRITICAL: deletes the orphaned Google event when its block is gone', () => {
    // deleteBlock, or a rebalance dropping a block entirely. Nothing
    // referenced the Google event anymore, so nothing could ever clean it up
    // and it sat on the calendar permanently.
    const record = { b1: { googleEventId: 'gcal_orphan', signature: 'whatever' } };
    const plan = planOngoingCalendarSync([], [task('t1', 'Gone')], record);
    expect(plan.toDelete).toEqual([{ blockId: 'b1', googleEventId: 'gcal_orphan' }]);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it('re-pushes when the task title changes, since the title is written into the Google event summary', () => {
    const b = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const record = { b1: { googleEventId: 'gcal_1', signature: blockSyncSignature(b, task('t1', 'Old name')) } };
    const plan = planOngoingCalendarSync([b], [task('t1', 'New name')], record);
    expect(plan.toUpdate).toHaveLength(1);
  });

  it('refreshes a synced block that has no record yet (e.g. synced by an older build) exactly once', () => {
    // Idempotent: an update writes the same values the event already has, and
    // afterwards the record exists so it goes quiet.
    const b = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const plan = planOngoingCalendarSync([b], [task('t1', 'Write report')], {});
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
  });

  it('does not delete an event that is still claimed by a live block under a different block id', () => {
    // Guards against the relocation case turning into delete + create. The
    // event is still referenced, so it must never be swept as an orphan.
    const t = task('t1', 'Piano');
    const relocated = block('b2', 't1', '2026-08-21', '09:00', '10:00', 'gcal_1');
    const record = { b1: { googleEventId: 'gcal_1', signature: 'stale' } };
    const plan = planOngoingCalendarSync([relocated], [t], record);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('skips a block whose task no longer exists, leaving the task-delete path to clean up', () => {
    const blocks = [block('b1', 'gone', '2026-08-20', '09:00', '10:00')];
    const plan = planOngoingCalendarSync(blocks, [], {});
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it('never plans the same Google event for deletion twice', () => {
    // Two stale records can point at one event after re-mints; issuing two
    // deletes would make the second fail noisily for no reason.
    const record = {
      b1: { googleEventId: 'gcal_1', signature: 's' },
      b2: { googleEventId: 'gcal_1', signature: 's' },
    };
    const plan = planOngoingCalendarSync([], [], record);
    expect(plan.toDelete).toHaveLength(1);
  });

  it('handles a mixed tick: one create, one move, one orphan, one unchanged', () => {
    const t1 = task('t1', 'A');
    const t2 = task('t2', 'B');
    const t3 = task('t3', 'C');
    const unchanged = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const movedBefore = block('b2', 't2', '2026-08-20', '11:00', '12:00', 'gcal_2');
    const movedAfter = block('b2', 't2', '2026-08-22', '11:00', '12:00', 'gcal_2');
    const fresh = block('b3', 't3', '2026-08-23', '13:00', '14:00', null);
    const record = {
      b1: { googleEventId: 'gcal_1', signature: blockSyncSignature(unchanged, t1) },
      b2: { googleEventId: 'gcal_2', signature: blockSyncSignature(movedBefore, t2) },
      bGone: { googleEventId: 'gcal_orphan', signature: 's' },
    };
    const plan = planOngoingCalendarSync([unchanged, movedAfter, fresh], [t1, t2, t3], record);
    expect(plan.toCreate.map((c) => c.block.id)).toEqual(['b3']);
    expect(plan.toUpdate.map((u) => u.block.id)).toEqual(['b2']);
    expect(plan.toDelete.map((d) => d.googleEventId)).toEqual(['gcal_orphan']);
  });

  it('is stable across repeated runs once everything has converged', () => {
    // After a sweep applies its plan, the next sweep over the same state must
    // be a complete no-op — otherwise the poll would push on every tick.
    const t = task('t1', 'Write report');
    const b = block('b1', 't1', '2026-08-20', '09:00', '10:00', 'gcal_1');
    const converged = { b1: { googleEventId: 'gcal_1', signature: blockSyncSignature(b, t) } };
    for (let i = 0; i < 3; i += 1) {
      const plan = planOngoingCalendarSync([b], [t], converged);
      expect(plan.toCreate.length + plan.toUpdate.length + plan.toDelete.length).toBe(0);
    }
  });
});

describe('blockSyncSignature', () => {
  it('changes when the block moves to a different day or time', () => {
    const t = { id: 't1', title: 'A' };
    const base = { date: '2026-08-20', startTime: '09:00', endTime: '10:00' };
    const sig = blockSyncSignature(base, t);
    expect(blockSyncSignature({ ...base, date: '2026-08-21' }, t)).not.toBe(sig);
    expect(blockSyncSignature({ ...base, startTime: '09:30' }, t)).not.toBe(sig);
    expect(blockSyncSignature({ ...base, endTime: '11:00' }, t)).not.toBe(sig);
  });

  it('changes when the task title changes, since it is written into the event summary', () => {
    const base = { date: '2026-08-20', startTime: '09:00', endTime: '10:00' };
    expect(blockSyncSignature(base, { title: 'Old' })).not.toBe(blockSyncSignature(base, { title: 'New' }));
  });

  it('is stable for an identical block/task pair', () => {
    const t = { id: 't1', title: 'A' };
    const base = { date: '2026-08-20', startTime: '09:00', endTime: '10:00' };
    expect(blockSyncSignature(base, t)).toBe(blockSyncSignature({ ...base }, { ...t }));
  });
});

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
 * Also covered here are the pure decision helpers behind the hook's
 * reliability fixes:
 *   - `isUnsyncedPushableEvent` — which events the periodic/manual push sweep
 *     should retry. This closes the gap where an event whose one-shot push
 *     failed was stranded unsynced forever, and it is also what re-pushes an
 *     event restored from a backup whose googleEventId no longer exists on
 *     Google (see the restore-then-push tests at the bottom of this file).
 *   - `isBlockSourcedEvent` — recognizing LEGACY block-mirror events. TaskFlow
 *     no longer pushes ScheduledBlocks to Google at all, but events pushed by
 *     older builds can still sit on a user's real calendar, and must never be
 *     imported as phantom local events or re-pushed.
 *   - `dedupeAuthoritativeItems` — the rewrite's last-resort backstop against
 *     inserting two identical Google events in one run.
 *   - `isPastCalendarItem` — the "history is frozen" rule gating every
 *     outbound write.
 *   - `isBlockEligibleForTodaysPush` / `computeTodaysAuthoritativeBlocks` /
 *     `computeTodaysBlockPushSignature` — the pure decisions behind
 *     pushTodaysTasksToCalendar (see this file's module doc), the one-way,
 *     delete-all-then-recreate push of today's ScheduledBlocks. These decide
 *     WHAT belongs in a push and WHEN the trigger effect should schedule one;
 *     the actual delete/insert plan (planTodaysBlockPush) is covered in
 *     googleCalendarService.test.js alongside its sibling planCalendarRewrite.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  getSilentReauthRetryDelay,
  SILENT_REAUTH_MAX_ATTEMPTS,
  isUnsyncedPushableEvent,
  isPastCalendarItem,
  dedupeAuthoritativeItems,
  isBlockEligibleForTodaysPush,
  computeTodaysAuthoritativeBlocks,
  computeTodaysBlockPushSignature,
} from '../../src/hooks/useGoogleCalendarSync.js';
import { isBlockSourcedEvent } from '../../src/services/googleCalendarService.js';
import { toISODate } from '../../src/utils/dateUtils.js';
import { mergePulledGoogleEvents } from '../../src/services/eventSyncService.js';

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

describe('isBlockSourcedEvent — recognizing LEGACY block mirrors', () => {
  // TaskFlow no longer pushes ScheduledBlocks to Google at all (that
  // mechanism manufactured duplicate/missing events and was removed). But
  // block events pushed by older builds can still be sitting on a user's real
  // calendar — deliberately left there rather than mass-deleted — so they must
  // still be recognized on pull, or they'd be imported as phantom local events
  // and become candidates for being re-pushed.

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
  // These dates MUST stay relative to today. The predicate refuses to push
  // anything already in the past (isPastCalendarItem — "history is frozen"),
  // so a hardcoded date silently rots: every expect(true) here started
  // failing once the date passed, and — worse — every expect(false) kept
  // passing for the wrong reason, so the safety cases below were no longer
  // testing the rule they name.
  const tomorrow = toISODate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const base = { id: 'e1', title: 'Coffee', date: tomorrow, startTime: '09:00', endTime: '10:00' };

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

  it('skips a legacy block-mirror row rather than re-pushing it as a new event', () => {
    expect(isUnsyncedPushableEvent({ ...base, title: '📋 Write report', source: 'manual', googleEventId: null })).toBe(false);
  });

  it('skips an event missing date/time, which could not build a valid resource', () => {
    expect(isUnsyncedPushableEvent({ id: 'e2', title: 'Broken', source: 'manual', googleEventId: null })).toBe(false);
    expect(isUnsyncedPushableEvent({ ...base, startTime: undefined, source: 'manual', googleEventId: null })).toBe(false);
  });

  it('skips an event whose day is already over, since history is frozen', () => {
    const yesterday = toISODate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(isUnsyncedPushableEvent({ ...base, date: yesterday, source: 'manual', googleEventId: null })).toBe(false);
  });

  it('still pushes a past-dated RECURRING event, whose rule outlives its start date', () => {
    const yesterday = toISODate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(
      isUnsyncedPushableEvent({ ...base, date: yesterday, recurrenceRule: 'FREQ=WEEKLY', source: 'manual', googleEventId: null })
    ).toBe(true);
  });

  it('CRITICAL SAFETY: never pushes a deleted-event tombstone, which would recreate the event the user just deleted', () => {
    // A manual event tombstoned before it was ever pushed to Google (no
    // googleEventId yet) still has a future date/start/end at delete time —
    // without excluding deletedAt here, this predicate would select it and
    // the push sweep would create a brand-new Google event for something
    // that no longer exists in TaskFlow. See utils/eventTombstones.js.
    expect(
      isUnsyncedPushableEvent({ ...base, source: 'manual', googleEventId: null, deletedAt: '2026-08-12T00:00:00.000Z' })
    ).toBe(false);
  });
});

describe('dedupeAuthoritativeItems — last-resort guard against pushing duplicates', () => {
  // Defence in depth for the one place in the app that can mint permanent
  // duplicates on a real calendar. A duplicate that reaches Google survives
  // every later sync, so this collapses anything that would render as the
  // same event at the same time regardless of how local state got that way.
  const event = (title, date, startTime, id = `${title}-${startTime}`) => ({
    kind: 'event',
    event: { id, title, date, startTime, endTime: '10:00' },
  });

  it('keeps a single copy when two rows would create the same Google event', () => {
    const items = [event('Piano', '2026-08-20', '09:00', 'a'), event('Piano', '2026-08-20', '09:00', 'b')];
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

  it('keeps the same event on genuinely different days', () => {
    const items = [event('Piano', '2026-08-20', '09:00'), event('Piano', '2026-08-21', '09:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('keeps same-titled events at different times on the same day', () => {
    const items = [event('Piano', '2026-08-20', '09:00'), event('Piano', '2026-08-20', '15:00')];
    expect(dedupeAuthoritativeItems(items).items).toHaveLength(2);
  });

  it('treats differing recurrence rules as distinct events', () => {
    const weekly = { kind: 'event', event: { id: 'w', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00', recurrenceRule: 'FREQ=WEEKLY' } };
    const oneOff = { kind: 'event', event: { id: 'o', title: 'Gym', date: '2026-08-20', startTime: '07:00', endTime: '08:00' } };
    expect(dedupeAuthoritativeItems([weekly, oneOff]).items).toHaveLength(2);
  });

  it('is a no-op on already-clean input', () => {
    const items = [event('A', '2026-08-20', '09:00'), event('B', '2026-08-20', '11:00')];
    const { items: kept, duplicates } = dedupeAuthoritativeItems(items);
    expect(kept).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('handles an empty list', () => {
    expect(dedupeAuthoritativeItems([])).toEqual({ items: [], duplicates: [] });
  });
});

describe('past items are frozen out of every outbound Google write', () => {
  // Product decision (explicit): once an item's day is over, TaskFlow stops
  // writing it to Google entirely — no create, no update, no delete. The bug
  // this fixes: past events were still being pushed/rewritten onto the user's
  // real calendar even though TaskFlow's own forward-looking views never
  // showed them, so the two sides visibly disagreed.
  //
  // Dates are relative to today so these keep testing "past vs future" rather
  // than silently becoming meaningless as the hardcoded dates above age.
  const iso = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const YESTERDAY = iso(-1);
  const TODAY = iso(0);
  const TOMORROW = iso(1);

  describe('isPastCalendarItem', () => {
    it('treats yesterday as past but today and tomorrow as live', () => {
      expect(isPastCalendarItem({ date: YESTERDAY })).toBe(true);
      expect(isPastCalendarItem({ date: TODAY })).toBe(false);
      expect(isPastCalendarItem({ date: TOMORROW })).toBe(false);
    });

    it('never treats a recurring master as past — its date is only the series DTSTART', () => {
      expect(isPastCalendarItem({ date: iso(-400), recurrenceRule: 'FREQ=WEEKLY' })).toBe(false);
    });

    it('treats a missing date as not-past rather than throwing', () => {
      expect(isPastCalendarItem({})).toBe(false);
      expect(isPastCalendarItem(null)).toBe(false);
    });
  });

  describe('isUnsyncedPushableEvent', () => {
    const base = { id: 'e1', title: 'Coffee', startTime: '09:00', endTime: '10:00', source: 'manual', googleEventId: null };

    it('does NOT push an unsynced event whose day has already passed', () => {
      expect(isUnsyncedPushableEvent({ ...base, date: YESTERDAY })).toBe(false);
    });

    it('still pushes an event today or in the future, unaffected by the freeze', () => {
      expect(isUnsyncedPushableEvent({ ...base, date: TODAY })).toBe(true);
      expect(isUnsyncedPushableEvent({ ...base, date: TOMORROW })).toBe(true);
    });

    it('still pushes a recurring series whose DTSTART is in the past', () => {
      expect(isUnsyncedPushableEvent({ ...base, date: iso(-30), recurrenceRule: 'FREQ=WEEKLY' })).toBe(true);
    });
  });
});

describe('restore-then-push: a backup-restored Google event reaches Google again', () => {
  // The concrete user-reported gap, traced end to end across the two modules
  // that have to agree for it to work. Restoring a backup brings back events
  // whose stored `googleEventId` describes a calendar state that no longer
  // exists (the user cleared their calendar, or it was rebuilt since). The
  // next poll pulls Google's actual events, which can't possibly echo those
  // ids back.
  //
  // Two separate decisions have to line up, and each is unit-tested in its own
  // file — but nothing pinned down the HANDOFF between them, which is exactly
  // where this silently broke before:
  //   1. mergePulledGoogleEvents must NOT delete the restored event just
  //      because it's in scope and absent from the pull. It distinguishes
  //      "never confirmed live by this instance" (restored -> keep, clear the
  //      stale id) from a genuine Google-side delete (id WAS confirmed live,
  //      now gone -> drop it).
  //   2. The row it hands back must then satisfy isUnsyncedPushableEvent, or
  //      the push sweep skips it and the event is stranded locally forever —
  //      kept, but never actually re-created on Google.
  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';
  // Future-dated so the past-item freeze can't be what makes this pass/fail.
  const futureDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const restoredFromBackup = {
    id: 'local_restored',
    source: 'google',
    calendarId: 'primary',
    googleEventId: 'id-from-an-old-backup',
    googleUpdatedAt: '2026-07-01T00:00:00Z',
    date: futureDate,
    startTime: '09:00',
    endTime: '10:00',
    title: 'Shopping',
  };

  it('survives the merge and is then eligible for the push sweep', () => {
    // A pull that returns nothing for this id — Google has never heard of it.
    // confirmedGoogleEventIds holds only ids this instance really saw live.
    const merged = mergePulledGoogleEvents(
      [restoredFromBackup],
      [],
      rangeStart,
      rangeEnd,
      new Map(),
      new Map(),
      Date.now(),
      rangeStart,
      new Set(['a-genuinely-live-id'])
    );

    // Step 1: kept, not deleted, with the stale id cleared.
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Shopping');
    expect(merged[0].googleEventId).toBeNull();

    // Step 2: THE HANDOFF — the merged row must now be pushable, so the poll's
    // sweep re-creates it on Google with a fresh id.
    expect(isUnsyncedPushableEvent(merged[0])).toBe(true);
  });

  it('does NOT re-push an event Google genuinely deleted', () => {
    // The mirror-image case, so the fix above can't be "keep everything".
    const confirmedLive = new Set([restoredFromBackup.googleEventId]);
    const merged = mergePulledGoogleEvents(
      [restoredFromBackup],
      [],
      rangeStart,
      rangeEnd,
      new Map(),
      new Map(),
      Date.now(),
      rangeStart,
      confirmedLive
    );
    expect(merged).toEqual([]); // dropped locally, nothing left to push
  });

  it('does not re-push a restored event from a calendar the user does not own', () => {
    // Re-creating a subscribed/shared calendar's event on the user's own
    // primary calendar would duplicate someone else's event.
    const foreign = { ...restoredFromBackup, calendarId: 'team@example.com', googleEventId: null };
    expect(isUnsyncedPushableEvent(foreign)).toBe(false);
  });
});

describe('poll tick handoff: the demotion and the push sweep must agree WITHIN one tick', () => {
  // The regression that made the restore-then-push fix above look correct in
  // tests while still failing for real, twice over.
  //
  // The tests above prove each half in isolation: the merge demotes a restored
  // event (googleEventId -> null), and a demoted event is pushable. What they
  // never modelled is WHEN the poll's push sweep gets to see that demotion.
  // In the hook, the merge result reaches component state through setEvents,
  // whose updater React does NOT run synchronously — it's queued until the
  // next commit. The push sweep runs in the SAME synchronous tick, immediately
  // after, and used to read `eventsRef.current`, which is assigned in the
  // render body and therefore still held the LAST COMMITTED events: the
  // restored event with its stale, dead googleEventId intact. So
  // isUnsyncedPushableEvent's first check (`if (event.googleEventId) return
  // false`) skipped the very event the merge had just demoted — every tick,
  // indefinitely. Only a manual edit ever pushed it, because
  // SchedulerContext's edit path pushes unconditionally without consulting
  // googleEventId.
  //
  // These tests model that deferred commit explicitly (a `committed` array
  // that setEvents only updates on an explicit flush), so the "reads a
  // render-stale list" failure mode is reproducible here rather than only in
  // the browser.
  const futureDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const restoredShopping = {
    id: 'local_restored',
    source: 'google',
    calendarId: 'primary',
    googleEventId: 'id-from-an-old-backup',
    date: futureDate,
    startTime: '09:00',
    endTime: '10:00',
    title: 'Shopping',
  };

  // A miniature of the hook's own state plumbing: `committed` stands in for
  // React state, `eventsRef` for the ref assigned during render (so it only
  // catches up on a commit), and `runPollTick` for the poll's
  // merge-then-push sequence.
  function makeHarness(initialEvents) {
    let committed = initialEvents;
    let pending = null;
    const harness = {
      eventsRef: { current: initialEvents },
      pushed: [],
      setEvents(next) {
        pending = next; // queued, NOT applied — same as React
      },
      commit() {
        if (pending) committed = pending;
        pending = null;
        harness.eventsRef.current = committed; // render body re-assigns the ref
      },
      get committed() {
        return committed;
      },
    };
    return harness;
  }

  // Mirrors the fixed applyPulledEvents: merge synchronously, hand the SAME
  // array to setEvents, keep eventsRef in step, and return it to the caller.
  function applyPulled(harness, fetchedEvents, rangeStart, rangeEnd, confirmedIds) {
    const merged = mergePulledGoogleEvents(
      harness.eventsRef.current,
      fetchedEvents,
      rangeStart,
      rangeEnd,
      new Map(),
      new Map(),
      Date.now(),
      rangeStart,
      confirmedIds
    );
    harness.eventsRef.current = merged;
    harness.setEvents(merged);
    return { events: merged };
  }

  // Mirrors pushUnsyncedItemsToCalendar's override parameter.
  function pushSweep(harness, eventsOverride) {
    const toPush = (eventsOverride || harness.eventsRef.current).filter(isUnsyncedPushableEvent);
    for (const e of toPush) harness.pushed.push(e.title);
    return toPush.length;
  }

  const rangeStart = '2026-08-01';
  const rangeEnd = '2026-08-31';

  it('pushes the restored event on the SAME tick that demotes it, before any re-render', () => {
    const harness = makeHarness([restoredShopping]);
    // One poll tick: Google returns nothing for this id, and this instance has
    // never seen it live, so the merge demotes rather than deletes.
    const { events: merged } = applyPulled(harness, [], rangeStart, rangeEnd, new Set(['some-other-live-id']));
    const pushedCount = pushSweep(harness, merged);

    // The whole point: no commit/re-render happened between the two calls.
    expect(pushedCount).toBe(1);
    expect(harness.pushed).toEqual(['Shopping']);
  });

  it('regression: a sweep reading render-stale state pushes nothing (the original bug)', () => {
    // Same tick, but the sweep reads a ref frozen at the last commit — what
    // the code did before the fix. Proves the test above is actually testing
    // the handoff and not passing for some incidental reason.
    const harness = makeHarness([restoredShopping]);
    const staleView = harness.eventsRef.current; // captured pre-merge, as the render body had it
    applyPulled(harness, [], rangeStart, rangeEnd, new Set(['some-other-live-id']));
    expect(pushSweep(harness, staleView)).toBe(0);
    expect(harness.pushed).toEqual([]);
  });

  it('does not push the same event twice if a second tick lands before the commit', () => {
    // The sweep stamps the new googleEventId onto eventsRef as well as state,
    // so an overlapping tick can't see the event as unsynced again and mint a
    // duplicate on the user's real calendar.
    const harness = makeHarness([restoredShopping]);
    const { events: merged } = applyPulled(harness, [], rangeStart, rangeEnd, new Set(['some-other-live-id']));
    pushSweep(harness, merged);
    // Push succeeded -> stamp the fresh id, exactly as the hook does.
    harness.eventsRef.current = harness.eventsRef.current.map((e) =>
      e.title === 'Shopping' ? { ...e, googleEventId: 'fresh-google-id', source: 'google' } : e
    );
    // A second tick starting before React committed anything.
    expect(pushSweep(harness)).toBe(0);
    expect(harness.pushed).toEqual(['Shopping']); // still exactly one push
  });

  it('leaves an event Google really deleted alone across the same handoff', () => {
    // Guards against "fix it by pushing everything": an id this instance
    // confirmed live and that Google no longer returns is a genuine remote
    // delete, so the merge drops it and there is nothing to push.
    const harness = makeHarness([restoredShopping]);
    const { events: merged } = applyPulled(
      harness,
      [],
      rangeStart,
      rangeEnd,
      new Set([restoredShopping.googleEventId])
    );
    expect(merged).toEqual([]);
    expect(pushSweep(harness, merged)).toBe(0);
  });

  it('a plain restore is picked up by the next natural poll tick', () => {
    // A plain restoreCloudBackup (not "restore & overwrite") triggers no pull
    // or rewrite of its own — it relies entirely on the next 60s poll. That is
    // fine now that the tick above actually works, but it is the reason the
    // bug looked like "restores never sync": the one mechanism meant to catch
    // them was the one that was broken.
    const harness = makeHarness([]); // nothing yet
    harness.setEvents([restoredShopping]); // restore applies backup state
    harness.commit(); // ...and it renders
    expect(harness.committed).toHaveLength(1);

    const { events: merged } = applyPulled(harness, [], rangeStart, rangeEnd, new Set(['unrelated-live-id']));
    expect(pushSweep(harness, merged)).toBe(1);
    expect(harness.pushed).toEqual(['Shopping']);
  });
});

describe('isBlockEligibleForTodaysPush — what belongs in the today\'s-blocks push', () => {
  const todayIso = '2026-08-16';
  const task = { id: 't1', title: 'Write report', priority: 'high', isCompleted: false };
  const block = { id: 'blk_1', taskId: 't1', date: todayIso, startTime: '09:00', endTime: '10:00' };

  it('is eligible: a plain, not-yet-completed task scheduled for today', () => {
    expect(isBlockEligibleForTodaysPush(block, task, todayIso)).toBe(true);
  });

  it('excludes a block for a different day than today', () => {
    expect(isBlockEligibleForTodaysPush({ ...block, date: '2026-08-15' }, task, todayIso)).toBe(false);
    expect(isBlockEligibleForTodaysPush({ ...block, date: '2026-08-17' }, task, todayIso)).toBe(false);
  });

  it('excludes a block whose task is completed (non-recurring)', () => {
    expect(isBlockEligibleForTodaysPush(block, { ...task, isCompleted: true }, todayIso)).toBe(false);
  });

  it('excludes a dangling block with no owning task', () => {
    expect(isBlockEligibleForTodaysPush(block, null, todayIso)).toBe(false);
    expect(isBlockEligibleForTodaysPush(block, undefined, todayIso)).toBe(false);
  });

  it('handles a missing/null block gracefully', () => {
    expect(isBlockEligibleForTodaysPush(null, task, todayIso)).toBe(false);
  });

  describe('recurring tasks: today\'s occurrence must be excluded once completed, even though isCompleted has already flipped back to false', () => {
    // SchedulerContext.completeTask advances a recurring task to its NEXT due
    // date and flips isCompleted back to false immediately on completion —
    // but deliberately KEEPS today's block around as a crossed-out historical
    // record (see completeTask's own comment). isBlockTaskCompleted answers
    // "was THIS block's occurrence completed" via completedDates instead of
    // the task's current isCompleted, and this eligibility check must defer
    // to it — otherwise a just-completed recurring task's block would read as
    // "not completed" and get pushed right back to Google.
    const recurringTask = { id: 't2', title: 'Water plants', priority: 'low', isRecurring: true, isCompleted: false, completedDates: [todayIso] };
    const recurringBlock = { id: 'blk_2', taskId: 't2', date: todayIso, startTime: '08:00', endTime: '08:15' };

    it('excludes today\'s block once its occurrence is in completedDates', () => {
      expect(isBlockEligibleForTodaysPush(recurringBlock, recurringTask, todayIso)).toBe(false);
    });

    it('still includes a recurring task\'s block whose occurrence is NOT yet completed', () => {
      const notYetDone = { ...recurringTask, completedDates: [] };
      expect(isBlockEligibleForTodaysPush(recurringBlock, notYetDone, todayIso)).toBe(true);
    });

    it('does not exclude based on a DIFFERENT day\'s completedDates entry', () => {
      const completedYesterday = { ...recurringTask, completedDates: ['2026-08-15'] };
      expect(isBlockEligibleForTodaysPush(recurringBlock, completedYesterday, todayIso)).toBe(true);
    });
  });
});

describe('computeTodaysAuthoritativeBlocks — joining blocks to tasks for the push', () => {
  const todayIso = '2026-08-16';
  const tasks = [
    { id: 't1', title: 'Write report', priority: 'high', isCompleted: false },
    { id: 't2', title: 'Done already', priority: 'low', isCompleted: true },
  ];
  const blocks = [
    { id: 'blk_1', taskId: 't1', date: todayIso, startTime: '09:00', endTime: '10:00' },
    { id: 'blk_2', taskId: 't2', date: todayIso, startTime: '11:00', endTime: '11:30' }, // completed task's block
    { id: 'blk_3', taskId: 't1', date: '2026-08-17', startTime: '09:00', endTime: '10:00' }, // tomorrow
  ];

  it('includes only today\'s block for a not-yet-completed task', () => {
    const result = computeTodaysAuthoritativeBlocks(blocks, tasks, todayIso);
    expect(result).toHaveLength(1);
    expect(result[0].block.id).toBe('blk_1');
    expect(result[0].task.id).toBe('t1');
  });

  it('excludes a dangling block whose taskId matches nothing', () => {
    const danglingBlocks = [{ id: 'blk_x', taskId: 'ghost', date: todayIso, startTime: '09:00', endTime: '10:00' }];
    expect(computeTodaysAuthoritativeBlocks(danglingBlocks, tasks, todayIso)).toEqual([]);
  });

  it('handles empty/missing inputs without throwing', () => {
    expect(computeTodaysAuthoritativeBlocks([], [], todayIso)).toEqual([]);
    expect(computeTodaysAuthoritativeBlocks(null, null, todayIso)).toEqual([]);
    expect(computeTodaysAuthoritativeBlocks(undefined, undefined, todayIso)).toEqual([]);
  });
});

describe('computeTodaysBlockPushSignature — the trigger effect\'s change signal', () => {
  const todayIso = '2026-08-16';
  const tasks = [{ id: 't1', title: 'Write report', priority: 'high', isCompleted: false }];
  const blocks = [{ id: 'blk_1', taskId: 't1', date: todayIso, startTime: '09:00', endTime: '10:00' }];

  it('is stable across calls when nothing changed', () => {
    expect(computeTodaysBlockPushSignature(blocks, tasks, todayIso)).toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('is order-independent — reordering the same blocks/tasks is not a real change', () => {
    const tasksReordered = [...tasks].reverse();
    const blocksReordered = [...blocks].reverse();
    expect(computeTodaysBlockPushSignature(blocks, tasks, todayIso)).toBe(
      computeTodaysBlockPushSignature(blocksReordered, tasksReordered, todayIso)
    );
  });

  it('changes when a block\'s time changes', () => {
    const moved = [{ ...blocks[0], startTime: '10:00', endTime: '11:00' }];
    expect(computeTodaysBlockPushSignature(moved, tasks, todayIso)).not.toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('changes when a task\'s title changes', () => {
    const renamed = [{ ...tasks[0], title: 'Write final report' }];
    expect(computeTodaysBlockPushSignature(blocks, renamed, todayIso)).not.toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('changes when a task\'s priority changes', () => {
    const reprioritized = [{ ...tasks[0], priority: 'urgent' }];
    expect(computeTodaysBlockPushSignature(blocks, reprioritized, todayIso)).not.toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('changes when a task is completed (its block drops out of the authoritative set)', () => {
    const completed = [{ ...tasks[0], isCompleted: true }];
    expect(computeTodaysBlockPushSignature(blocks, completed, todayIso)).not.toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('is unaffected by a change to a block on a DIFFERENT day', () => {
    const withTomorrow = [...blocks, { id: 'blk_2', taskId: 't1', date: '2026-08-17', startTime: '09:00', endTime: '10:00' }];
    expect(computeTodaysBlockPushSignature(withTomorrow, tasks, todayIso)).toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });

  it('rolls over on day change even with identical blocks/tasks — a new day means a new authoritative set', () => {
    // Not literally true today (todayIso is baked into the block dates), but
    // documents the property computeTodaysAuthoritativeBlocks relies on: a
    // signature computed against a DIFFERENT todayIso for the SAME blocks
    // array (none of which are dated for that other day) is empty/distinct.
    expect(computeTodaysBlockPushSignature(blocks, tasks, '2026-08-17')).not.toBe(computeTodaysBlockPushSignature(blocks, tasks, todayIso));
  });
});

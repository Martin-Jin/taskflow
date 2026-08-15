/**
 * ============================================================================
 * googleCalendarService.js — coverage notes
 * ============================================================================
 * Most of this file is a thin wrapper around the live Google Calendar API
 * (`window.gapi`), which isn't practical to unit test without heavy mocking.
 * Two pieces of pure date math were extracted specifically so they could be
 * covered here instead of only by reasoning about a diff:
 *   - `parseExdateToLocalIsoDate` converts one EXDATE value (from a recurring
 *     master event's `recurrence` array) into the local-calendar-date ISO
 *     string `fetchEvents` uses to build that master's `overrides` map,
 *     marking a specific occurrence excluded so expandRecurringEvent doesn't
 *     regenerate a "phantom" occurrence for a date Google has already
 *     cancelled/individually modified.
 *   - `computeFetchTimeRange` converts the inclusive "YYYY-MM-DD" range the
 *     rest of the sync pipeline works in into the `timeMin`/`timeMax`
 *     instants Google's `events.list` expects — see its own doc comment for
 *     a real off-by-one bug this used to have at the inclusive end boundary.
 *   - `instanceMatchesOccurrence` is the pure comparison `resolveInstanceId`
 *     uses to pick the right item out of an `events.instances()` response —
 *     the real, authoritative replacement for a previous client-side-
 *     constructed instance id (`{recurringEventId}_{originalStartTimeUTC}`)
 *     that broke for a master which had itself been split via "this and
 *     following" directly in Google's own UI (a split-off master's own id
 *     already carries a `_R{timestamp}` suffix, so appending a second
 *     constructed suffix on top never matched anything real).
 *   - `planCalendarRewrite` is the pure decision core of "Rewrite Google
 *     Calendar to match TaskFlow" (see its own doc comment in
 *     googleCalendarService.js) — given local authoritative items and
 *     Google's current primary-calendar events, decides what to delete and
 *     what to insert. Covered thoroughly here since it's the single place
 *     this destructive, opt-in feature decides what to delete; the executor
 *     (rewriteGoogleCalendarFromTaskflow in useGoogleCalendarSync.js) that
 *     actually calls the live API isn't unit-testable the same way as the
 *     rest of this file, but its input to this function is.
 *   - `isRateLimitError` is the 429 counterpart to `isAuthError`'s 401 check,
 *     added for this feature's batch executor (see
 *     REWRITE_RATE_LIMIT_BACKOFF_MS in useGoogleCalendarSync.js).
 *   - `chunkForBatch` and `classifyBatchSubResponse` are the pure halves of
 *     that executor's batched Google API path (up to MAX_BATCH_SIZE
 *     operations per HTTP round-trip). The batch plumbing itself is `gapi`-
 *     bound and untestable here, but the size limit that keeps a batch legal
 *     and the per-sub-response success/failure classification the user-facing
 *     result toast is built from are both pure — and both are easy to get
 *     subtly wrong in ways a diff wouldn't reveal.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import {
  parseExdateToLocalIsoDate,
  computeFetchTimeRange,
  isInstanceAlreadyGoneError,
  instanceMatchesOccurrence,
  shouldTreatAsReconnectNeeded,
  isConfirmedGoogleAuthFailure,
  planCalendarRewrite,
  isRateLimitError,
  chunkForBatch,
  classifyBatchSubResponse,
  MAX_BATCH_SIZE,
  buildBlockEventResource,
  planTodaysBlockPush,
  isBlockSourcedEvent,
  TASKFLOW_BLOCK_PROPERTY_KEY,
  priorityToColorId,
} from '../../src/services/googleCalendarService.js';

describe('parseExdateToLocalIsoDate', () => {
  it('parses a UTC ("Z"-suffixed) EXDATE value into its local calendar date', () => {
    // 2026-07-24T20:00:00Z is 2026-07-25 08:00 in a UTC+12 zone, for example —
    // this just asserts it round-trips through Date/toISODate consistently
    // rather than hardcoding a single timezone's expected offset.
    const iso = parseExdateToLocalIsoDate('20260724T200000Z');
    const expected = new Date(Date.UTC(2026, 6, 24, 20, 0, 0));
    const pad2 = (n) => String(n).padStart(2, '0');
    expect(iso).toBe(`${expected.getFullYear()}-${pad2(expected.getMonth() + 1)}-${pad2(expected.getDate())}`);
  });

  it('parses a floating (no "Z") EXDATE value as local wall-clock time', () => {
    expect(parseExdateToLocalIsoDate('20260724T090000')).toBe('2026-07-24');
  });

  it('handles a value with no time component gracefully (defaults to midnight)', () => {
    expect(parseExdateToLocalIsoDate('20260724T000000')).toBe('2026-07-24');
  });

  it('returns null for a value too short to contain a full date', () => {
    expect(parseExdateToLocalIsoDate('202607')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseExdateToLocalIsoDate('not-a-date')).toBeNull();
  });
});

describe('computeFetchTimeRange', () => {
  it('makes timeMax cover all of the inclusive end date, not just its local midnight instant', () => {
    // Regression test: timeMax used to be `fromISODate(endIso).toISOString()`
    // — local midnight at the START of endIso — which is Google's EXCLUSIVE
    // upper bound, so it silently excluded every event actually occurring ON
    // endIso (the horizon's last day). mergePulledGoogleEvents' own
    // `isInScopeForPull` treats that same date as in scope (inclusive), so
    // the mismatch made a still-live event dated exactly on the last day of
    // the sync horizon look Google-side-deleted on every pull.
    const { timeMin, timeMax } = computeFetchTimeRange('2026-08-01', '2026-08-29');
    const localMidnightOfEndIso = new Date(2026, 7, 29, 0, 0, 0).toISOString();
    const localMidnightOfDayAfter = new Date(2026, 7, 30, 0, 0, 0).toISOString();
    expect(timeMax).not.toBe(localMidnightOfEndIso);
    expect(timeMax).toBe(localMidnightOfDayAfter);
    expect(timeMin).toBe(new Date(2026, 7, 1, 0, 0, 0).toISOString());
  });

  it('keeps timeMin/timeMax a single day apart for a one-day range', () => {
    const { timeMin, timeMax } = computeFetchTimeRange('2026-08-01', '2026-08-01');
    expect(new Date(timeMax).getTime() - new Date(timeMin).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('isInstanceAlreadyGoneError', () => {
  // Regression test: an instance delete used to be able to hit a 404 for
  // reasons unrelated to "already deleted" (see instanceMatchesOccurrence's
  // own history below) — a real 410 ("Gone") is the only case that
  // unambiguously confirms a resource existed and was removed.
  it('treats 410 (Gone) as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 410 })).toBe(true);
  });

  it('does NOT treat 404 (Not Found) as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 404 })).toBe(false);
  });

  it('does not treat other errors as already deleted', () => {
    expect(isInstanceAlreadyGoneError({ status: 403 })).toBe(false);
    expect(isInstanceAlreadyGoneError(new Error('network error'))).toBe(false);
  });
});

describe('shouldTreatAsReconnectNeeded', () => {
  // Regression test: the initial silent re-auth effect in
  // useGoogleCalendarSync.js used to disconnect on ANY thrown error from the
  // token refresh step, including transient failures unrelated to a genuine
  // "not connected"/"revoked" state (e.g. a cold-browser-start network
  // hiccup) — this is the extracted decision that now gates that behavior.
  it('treats a confirmed needsReconnect error (Worker 404/409) as reconnect-needed', () => {
    const err = new Error('Google Calendar not yet connected.');
    err.needsReconnect = true;
    expect(shouldTreatAsReconnectNeeded(err)).toBe(true);
  });

  it('does not treat a plain Error (e.g. getFirebaseIdToken throwing) as reconnect-needed', () => {
    expect(shouldTreatAsReconnectNeeded(new Error('Not signed in to Taskflow'))).toBe(false);
  });

  it('does not treat a network failure (TypeError from a failed fetch) as reconnect-needed', () => {
    expect(shouldTreatAsReconnectNeeded(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('does not treat a Worker error without needsReconnect set (e.g. 500) as reconnect-needed', () => {
    const err = new Error('Calendar auth worker refresh failed (HTTP 500).');
    err.needsReconnect = false;
    expect(shouldTreatAsReconnectNeeded(err)).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(shouldTreatAsReconnectNeeded(null)).toBe(false);
    expect(shouldTreatAsReconnectNeeded(undefined)).toBe(false);
  });
});

describe('isConfirmedGoogleAuthFailure — the combined "reconnect, don\'t silently retry" signal', () => {
  // Regression test for the "Google Calendar entry never catches up after a
  // reschedule" bug: computeTodaysBlockPushPlan/executeBatch mark a live 401
  // (a token that expired mid-session, since nothing else ever revalidates
  // the in-memory access token) with `isGoogleAuthError`, while
  // refreshAccessTokenFromWorker marks a confirmed revoked/not-connected
  // refresh token with `needsReconnect` — every caller that decides between
  // "keep silently retrying" and "disconnect and prompt reconnect" needs to
  // treat both the same way, which is what this combined check exists for.
  it('treats a live gapi 401 (isGoogleAuthError) as a confirmed auth failure', () => {
    const err = new Error('Google Calendar authorization expired — please reconnect.');
    err.isGoogleAuthError = true;
    expect(isConfirmedGoogleAuthFailure(err)).toBe(true);
  });

  it('treats a confirmed needsReconnect error as a confirmed auth failure', () => {
    const err = new Error('Google Calendar not yet connected.');
    err.needsReconnect = true;
    expect(isConfirmedGoogleAuthFailure(err)).toBe(true);
  });

  it('does not treat a transient network/error as a confirmed auth failure', () => {
    expect(isConfirmedGoogleAuthFailure(new TypeError('Failed to fetch'))).toBe(false);
    expect(isConfirmedGoogleAuthFailure(new Error('some other failure'))).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isConfirmedGoogleAuthFailure(null)).toBe(false);
    expect(isConfirmedGoogleAuthFailure(undefined)).toBe(false);
  });
});

describe('instanceMatchesOccurrence', () => {
  it('matches an unmodified instance by its plain `start` time', () => {
    const instance = { start: { dateTime: '2026-08-01T20:00:00Z' } };
    // Compare against what that UTC instant actually resolves to locally,
    // rather than hardcoding a single timezone's expected wall-clock time.
    const local = new Date('2026-08-01T20:00:00Z');
    const pad2 = (n) => String(n).padStart(2, '0');
    const localIso = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
    const localHHMM = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
    expect(instanceMatchesOccurrence(instance, localIso, localHHMM)).toBe(true);
  });

  it('matches a moved instance by its ORIGINAL start time, not its new one', () => {
    const instance = {
      originalStartTime: { dateTime: '2026-08-01T20:00:00Z' },
      start: { dateTime: '2026-08-02T09:00:00Z' }, // moved elsewhere
    };
    const local = new Date('2026-08-01T20:00:00Z');
    const pad2 = (n) => String(n).padStart(2, '0');
    const localIso = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
    const localHHMM = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
    expect(instanceMatchesOccurrence(instance, localIso, localHHMM)).toBe(true);
    // And does NOT match the moved-to slot, since that's not this occurrence's original date/time.
    expect(instanceMatchesOccurrence(instance, '2026-08-02', '09:00')).toBe(false);
  });

  it('returns false for a non-matching date/time', () => {
    const instance = { start: { dateTime: '2026-08-01T20:00:00Z' } };
    expect(instanceMatchesOccurrence(instance, '2026-08-03', '08:00')).toBe(false);
  });

  it('returns false when the instance has neither originalStartTime nor start', () => {
    expect(instanceMatchesOccurrence({}, '2026-08-01', '08:00')).toBe(false);
  });
});

describe('planCalendarRewrite — delete-all rewrite', () => {
  // "Rewrite Google Calendar to match TaskFlow" (see googleCalendarService.js's
  // own module doc above planCalendarRewrite) — TaskFlow's local blocks/events
  // become authoritative and Google's PRIMARY calendar is reconciled to match.
  //
  // This is deliberately NOT a diff: every in-range primary-calendar event is
  // deleted unconditionally and every local item re-inserted fresh. The old
  // diff-based design spared any Google event still claimed by a local
  // googleEventId, which is exactly what let duplicates survive — two local
  // rows for one logical event, each with its own genuinely-valid id, claimed
  // (and therefore protected) both Google-side copies forever.
  //
  // The single most important property to get right is unchanged: a
  // subscribed/foreign calendar's events must NEVER be deleted. That's now
  // carried ENTIRELY by this function only ever being handed already-primary-
  // filtered `googleEventsInRange` input (the caller's job, see
  // computeCalendarRewritePlan), since no per-event protection remains — so
  // every test here constructs that input as if it already went through that
  // filter.

  it('deletes every in-range primary-calendar Google event, even one still claimed by a local item', () => {
    // The core behavior change. Under the old diff-based plan `gcal_1` was
    // spared because a local item claimed it; now it is deleted like anything
    // else and the local item is re-inserted fresh.
    const local = [{ id: 'task-1', googleEventId: 'gcal_1' }];
    const google = [{ id: 'gcal_1' }];
    const { toDelete, toInsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual(['gcal_1']);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0]).toMatchObject({ item: local[0] });
  });

  it('REGRESSION: duplicate local rows with distinct valid ids no longer protect their Google copies', () => {
    // The exact shape of the bug this redesign exists to fix: two local rows
    // for one logical "Piano" event, each carrying its own real googleEventId
    // because Google genuinely has two physical copies. The old plan matched
    // both ids and kept both copies, reporting complete success while the
    // duplicate remained. Now both Google copies are deleted outright.
    const local = [
      { id: 'piano-a', googleEventId: 'gcal_piano_1' },
      { id: 'piano-b', googleEventId: 'gcal_piano_2' },
    ];
    const google = [{ id: 'gcal_piano_1' }, { id: 'gcal_piano_2' }];
    const { toDelete } = planCalendarRewrite(local, google);
    expect([...toDelete].sort()).toEqual(['gcal_piano_1', 'gcal_piano_2']);
  });

  it('CRITICAL SAFETY: a Google event absent from the pre-filtered primary-calendar input never appears in toDelete', () => {
    // This simulates the caller having already excluded a non-primary/
    // read-only subscribed-calendar event from `googleEventsInRange` (its
    // job, per this function's own doc comment). planCalendarRewrite never
    // even sees a foreign calendar's event, so it structurally cannot plan a
    // delete for one. This matters MORE under delete-all than it did before:
    // the caller's primary-only filter is now the sole safety boundary, since
    // nothing is spared by matching a local id anymore.
    const local = [];
    const googlePrimaryOnly = [{ id: 'gcal_primary_event' }]; // the foreign-calendar event is NOT in this list
    const { toDelete } = planCalendarRewrite(local, googlePrimaryOnly);
    expect(toDelete).toEqual(['gcal_primary_event']);
    expect(toDelete).not.toContain('gcal_subscribed_calendar_event_should_never_appear');
  });

  it('CRITICAL SAFETY: toDelete never contains an id that was not in the primary-calendar input', () => {
    // Guards the inverse direction of the boundary: no id may be synthesized
    // from local state. Everything deleted must have come from the (already
    // primary-filtered) Google-side list.
    const local = [{ id: 'l1', googleEventId: 'gcal_local_claims_this' }];
    const google = [{ id: 'gcal_from_primary' }];
    const { toDelete } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual(['gcal_from_primary']);
    const googleIds = new Set(google.map((e) => e.id));
    expect(toDelete.every((id) => googleIds.has(id))).toBe(true);
  });

  it('plans every local item as an insert regardless of whether it has a googleEventId', () => {
    // No isUpdate distinction exists anymore — the deletes run first, so
    // there is nothing left on Google to update against.
    const local = [{ id: 'a', googleEventId: null }, { id: 'b', googleEventId: 'gcal_stale' }];
    const { toDelete, toInsert } = planCalendarRewrite(local, []);
    expect(toDelete).toEqual([]);
    expect(toInsert.map((u) => u.item.id)).toEqual(['a', 'b']);
    expect(toInsert.every((u) => u.isUpdate === undefined)).toBe(true);
  });

  it('an event previously pulled FROM Google is re-inserted, not skipped', () => {
    // Under the old plan these were marked needsPush: false and skipped,
    // since their Google copy already existed and was protected. Delete-all
    // removes that copy, so they must be re-created.
    const local = [{ id: 'already-synced-event', googleEventId: 'gcal_1' }];
    const google = [{ id: 'gcal_1' }];
    const { toDelete, toInsert } = planCalendarRewrite(local, google);
    expect(toDelete).toEqual(['gcal_1']);
    expect(toInsert).toHaveLength(1);
  });

  it('an empty local set still deletes every in-range primary-calendar Google event', () => {
    const google = [{ id: 'a' }, { id: 'b' }];
    const { toDelete, toInsert } = planCalendarRewrite([], google);
    expect([...toDelete].sort()).toEqual(['a', 'b']);
    expect(toInsert).toEqual([]);
  });

  it('an empty Google-side set plans every local item as an insert and nothing to delete', () => {
    const local = [{ googleEventId: null }, { googleEventId: 'gcal_stale' }];
    const { toDelete, toInsert } = planCalendarRewrite(local, []);
    expect(toDelete).toEqual([]);
    expect(toInsert).toHaveLength(2);
  });
});

describe('buildBlockEventResource — the Google event shape for a pushed ScheduledBlock', () => {
  // Same shape the earlier, removed block-push feature used (title prefix,
  // extended-property tag, priority colorId) — only the id-preserving
  // identity tracking built on top of it was ever the problem (see this
  // function's own doc comment).
  const task = { id: 't1', title: 'Write report', notes: 'Chapter 3', priority: 'high' };
  const block = { id: 'blk_t1_2026-08-16_0900', date: '2026-08-16', startTime: '09:00', endTime: '10:30' };

  it('prefixes the title with the 📋 marker so isBlockSourcedEvent recognizes it even without the tag', () => {
    const resource = buildBlockEventResource(block, task);
    expect(resource.summary).toBe('📋 Write report');
    expect(isBlockSourcedEvent({ title: resource.summary, source: 'google' })).toBe(true);
  });

  it('uses the task notes as description, falling back to an auto-generated one', () => {
    expect(buildBlockEventResource(block, task).description).toBe('Chapter 3');
    const noNotesTask = { ...task, notes: '' };
    expect(buildBlockEventResource(block, noNotesTask).description).toContain('Auto-scheduled by TaskFlow');
    expect(buildBlockEventResource(block, noNotesTask).description).toContain('high');
  });

  it('maps start/end from the block, not the task', () => {
    const resource = buildBlockEventResource(block, task);
    expect(resource.start.dateTime).toBe('2026-08-16T09:00:00');
    expect(resource.end.dateTime).toBe('2026-08-16T10:30:00');
  });

  it('sets colorId from the task priority', () => {
    expect(buildBlockEventResource(block, task).colorId).toBe(priorityToColorId('high'));
  });

  it('tags the resource with TASKFLOW_BLOCK_PROPERTY_KEY, keyed by the block id', () => {
    const resource = buildBlockEventResource(block, task);
    expect(resource.extendedProperties.private[TASKFLOW_BLOCK_PROPERTY_KEY]).toBe(block.id);
  });

  it('never includes a googleEventId field — delete-all-then-recreate tracks no identity across a push', () => {
    const resource = buildBlockEventResource(block, task);
    expect(resource).not.toHaveProperty('googleEventId');
  });
});

describe('planTodaysBlockPush — delete-all push of today\'s scheduled task blocks', () => {
  // Same delete-all-then-recreate shape as planCalendarRewrite above, but
  // scoped by the TASKFLOW_BLOCK_PROPERTY_KEY tag rather than by "everything
  // in range on the primary calendar" — see this function's own doc comment
  // for why the tag is the sole safety boundary here.
  const authoritativeBlock = { block: { id: 'blk_1' }, task: { id: 't1', title: 'X' } };

  it('deletes every Google event tagged as TaskFlow block-sourced for today, unconditionally', () => {
    const googleEventsToday = [
      { id: 'gcal_tagged_1', extendedProperties: { private: { [TASKFLOW_BLOCK_PROPERTY_KEY]: 'blk_old_1' } } },
      { id: 'gcal_tagged_2', extendedProperties: { private: { [TASKFLOW_BLOCK_PROPERTY_KEY]: 'blk_old_2' } } },
    ];
    const { toDelete } = planTodaysBlockPush([authoritativeBlock], googleEventsToday);
    expect([...toDelete].sort()).toEqual(['gcal_tagged_1', 'gcal_tagged_2']);
  });

  it('CRITICAL SAFETY: never deletes an untagged event, even one that happens to fall on today', () => {
    // A user's own real meeting, or an ordinary synced CalendarEvent, must
    // never be swept up just because it's on today's date.
    const googleEventsToday = [
      { id: 'gcal_users_own_meeting', summary: 'Dentist' },
      { id: 'gcal_synced_calendar_event', summary: 'Standup' },
    ];
    const { toDelete } = planTodaysBlockPush([authoritativeBlock], googleEventsToday);
    expect(toDelete).toEqual([]);
  });

  it('plans every authoritative block as a fresh insert regardless of Google state', () => {
    const { toInsert } = planTodaysBlockPush([authoritativeBlock], []);
    expect(toInsert).toEqual([authoritativeBlock]);
  });

  it('does NOT match a tagged Google event against an authoritative block by id — pure delete-all, no diffing', () => {
    // The exact bug class this feature must never reintroduce: even if a
    // tagged Google event's marker value happens to equal a CURRENT block's
    // id, it is still deleted (and the block still fresh-inserted), never
    // "matched and spared".
    const block = { id: 'blk_1' };
    const googleEventsToday = [{ id: 'gcal_1', extendedProperties: { private: { [TASKFLOW_BLOCK_PROPERTY_KEY]: 'blk_1' } } }];
    const { toDelete, toInsert } = planTodaysBlockPush([{ block, task: { id: 't1' } }], googleEventsToday);
    expect(toDelete).toEqual(['gcal_1']);
    expect(toInsert).toHaveLength(1);
  });

  it('an empty authoritative set still deletes every tagged event (all of today\'s blocks were completed/removed)', () => {
    const googleEventsToday = [{ id: 'gcal_stale', extendedProperties: { private: { [TASKFLOW_BLOCK_PROPERTY_KEY]: 'blk_x' } } }];
    const { toDelete, toInsert } = planTodaysBlockPush([], googleEventsToday);
    expect(toDelete).toEqual(['gcal_stale']);
    expect(toInsert).toEqual([]);
  });

  it('no Google events and no authoritative blocks plans nothing', () => {
    expect(planTodaysBlockPush([], [])).toEqual({ toDelete: [], toInsert: [] });
  });
});

describe('chunkForBatch', () => {
  // Google's batch endpoint accepts at most MAX_BATCH_SIZE (50) sub-requests
  // per HTTP call; exceeding it rejects the whole batch, so this split is
  // load-bearing rather than cosmetic.
  it('splits into chunks of at most MAX_BATCH_SIZE by default', () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const chunks = chunkForBatch(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(MAX_BATCH_SIZE);
    expect(chunks[1]).toHaveLength(MAX_BATCH_SIZE);
    expect(chunks[2]).toHaveLength(20);
    expect(chunks.flat()).toEqual(items); // nothing dropped or reordered
  });

  it('never produces a chunk larger than the limit', () => {
    const items = Array.from({ length: 501 }, (_, i) => i);
    expect(chunkForBatch(items).every((c) => c.length <= MAX_BATCH_SIZE)).toBe(true);
  });

  it('returns an empty list for no items rather than one empty chunk', () => {
    expect(chunkForBatch([])).toEqual([]);
  });

  it('returns a single short chunk when there are fewer items than the limit', () => {
    expect(chunkForBatch([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('guards against a zero/invalid size instead of looping forever', () => {
    expect(chunkForBatch([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('classifyBatchSubResponse', () => {
  // A gapi batch resolves as ONE promise regardless of whether individual
  // sub-requests failed — each sub-response carries its own status. Per-item
  // success/failure reporting in the rewrite hangs entirely off this.
  it('treats a 2xx sub-response as success and passes the result through', () => {
    const res = classifyBatchSubResponse({ status: 200, result: { id: 'gcal_new' } });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ id: 'gcal_new' });
  });

  it('treats a 201 Created as success', () => {
    expect(classifyBatchSubResponse({ status: 201, result: { id: 'x' } }).ok).toBe(true);
  });

  it('treats a 4xx sub-response as a failure and surfaces its message', () => {
    const res = classifyBatchSubResponse({ status: 403, result: { error: { message: 'Forbidden' } } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toBe('Forbidden');
  });

  it('reports a 429 sub-response with its status so it can be retried specifically', () => {
    const res = classifyBatchSubResponse({ status: 429, result: { error: { message: 'Rate Limit Exceeded' } } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
  });

  it('falls back to the nested gapi error code when no top-level status is present', () => {
    const res = classifyBatchSubResponse({ result: { error: { code: 404, message: 'Not Found' } } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('treats a MISSING sub-response as a failure, never as silent success', () => {
    // A dropped sub-request must not be counted as done — that would silently
    // under-report failures and leave a local item wrongly marked as synced.
    const res = classifyBatchSubResponse(undefined);
    expect(res.ok).toBe(false);
  });

  it('synthesizes a message when the error carries no message field', () => {
    expect(classifyBatchSubResponse({ status: 500 }).error).toBe('HTTP 500');
  });
});

describe('isRateLimitError', () => {
  it('treats a 429 status as a rate limit error', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it('treats a nested gapi error code of 429 as a rate limit error', () => {
    expect(isRateLimitError({ result: { error: { code: 429 } } })).toBe(true);
  });

  it('does not treat other statuses (e.g. 401, 404, 500) as rate limit errors', () => {
    expect(isRateLimitError({ status: 401 })).toBe(false);
    expect(isRateLimitError({ status: 404 })).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

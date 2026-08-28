/**
 * ============================================================================
 * useGoogleCalendarSync
 * ============================================================================
 * Extracted from SchedulerContext.jsx to reduce that file's size (~2000 lines).
 * Owns all Google Calendar connection state, silent re-auth, periodic polling,
 * visibility-change refresh, and event push/patch/delete orchestration.
 *
 * SCOPE: CalendarEvents sync both ways, exactly as before (unaffected by
 * anything below). ScheduledBlocks (TaskFlow's own scheduled task work) are
 * pushed ONE-WAY (TaskFlow -> Google, never read back) via
 * `pushTodaysTasksToCalendar` below — but ONLY today's blocks, and only via
 * DELETE-ALL-THEN-RECREATE, never by matching an old Google event to a
 * specific block. A full identity-tracked version of this (persisted
 * `googleEventId` per block, preserved across rebalances) was tried and
 * removed (see 499783d): a block's id encodes its placement and is re-minted
 * on every rebalance that moves it, so id-based matching could never reliably
 * tell "this block moved" from "this is a new block", which manufactured
 * duplicate/orphaned Google events across several rounds of attempted fixes.
 * `pushTodaysTasksToCalendar` sidesteps that class of bug entirely by never
 * tracking identity across a push at all — every run deletes everything it
 * (or an earlier run) tagged for today and reinserts fresh from current
 * state, the same fix already proven for `rewriteGoogleCalendarFromTaskflow`'s
 * CalendarEvent rewrite (see computeCalendarRewritePlan's doc comment in
 * googleCalendarService.js).
 *
 * Returns the Google-specific state and callbacks that SchedulerContext merges
 * into its own context value — nothing here talks to Firestore or manages
 * non-Google state.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedState } from './usePersistedState';
import { toISODate, addDays, timeToMinutes, minutesToTime, isPast } from '../utils/dateUtils';
import { RETENTION_DAYS_CALENDAR_EVENTS, CLOUD_SYNC_DEBOUNCE_MS } from '../services/dataRetention';
import { resolveEventId, truncateRuleUntil, rebaseRuleForSplit } from '../utils/recurrenceExpansion';
import { isBlockTaskCompleted } from '../utils/missedTasks';
import { computePushSingleFlightDecision } from './useCloudSync';
import {
  fetchEvents as fetchGoogleEvents,
  pushEventToCalendar,
  deleteCalendarEvent,
  pushEventInstanceUpdate,
  deleteCalendarEventInstance,
  initGoogleCalendar,
  requestAccessToken,
  disconnectGoogleCalendar as disconnectGoogleCalendarService,
  shouldTreatAsReconnectNeeded,
  isConfirmedGoogleAuthFailure,
  computeCalendarRewritePlan,
  computeTodaysBlockPushPlan,
  isRateLimitError,
  chunkForBatch,
  batchDeleteCalendarEvents,
  batchInsertCalendarEvents,
  buildCalendarEventResource,
  buildBlockEventResource,
  isBlockSourcedEvent,
} from '../services/googleCalendarService';
import {
  mergePulledGoogleEvents,
  hardResetEventsFromGoogle,
  expandSyncedBounds,
  computeOnDemandFetchRange,
  computeEffectivePurgeBoundary,
  RECENTLY_DELETED_TTL_MS,
} from '../services/eventSyncService';

/**
 * Cheap signature of the subset of an event's fields that could actually
 * affect scheduling (id, start/end time, recurrence) — used by
 * applyPulledEvents below to decide whether a pull actually changed anything
 * worth auto-rebalancing over. Deliberately excludes fields like title/
 * description/color that a Google-side edit could change without affecting
 * any task's scheduled block. Order-independent (sorted by id) since a
 * differently-ordered but otherwise-identical array isn't a real change.
 */
function eventsSignature(events) {
  return events
    .map((e) => `${e.id}|${e.date || ''}|${e.startTime || ''}|${e.endTime || ''}|${e.recurrenceRule ? JSON.stringify(e.recurrenceRule) : ''}`)
    .sort()
    .join('\n');
}

// The ROUTINE background sync window (silent re-auth on mount, the periodic
// poll, connect, and manual pull/rebuild) — a small window centered on
// TODAY, not on whatever the user happens to be viewing. Kept modest on
// purpose: every poll tick (every 60s, see below) re-fetches this whole
// range, and a full year each time (an earlier version of this constant)
// meant a much larger/paginated fetch on every single tick for a window the
// user usually isn't even looking at. Widening beyond this now happens
// on-demand instead — see ensureGoogleRangeSynced below, which fetches
// additional range only when the calendar VIEW actually scrolls outside
// what's already synced, and folds it into `googleSyncedRangeBounds` so it
// stays synced for the rest of the session rather than being re-fetched (or
// wrongly purged, see eventSyncService's module doc) every time the routine
// window's own narrower range comes back around.
const ROUTINE_SYNC_WINDOW_DAYS = 30;

function getRoutineSyncRange() {
  return {
    rangeStartIso: toISODate(new Date(Date.now() - ROUTINE_SYNC_WINDOW_DAYS * 86400000)),
    rangeEndIso: toISODate(new Date(Date.now() + ROUTINE_SYNC_WINDOW_DAYS * 86400000)),
  };
}

// The RETENTION ceiling — separate from ROUTINE_SYNC_WINDOW_DAYS above. An
// on-demand fetch (see ensureGoogleRangeSynced) can widen what's synced far
// beyond the routine 30-day window and that widened range is deliberately
// never purged just for falling outside the routine window (see
// eventSyncService's module doc) — but retention still isn't meant to be
// UNBOUNDED. A non-recurring event older than RETENTION_DAYS_CALENDAR_EVENTS
// is purged regardless of whether it was once on-demand-fetched. Rolls forward
// with real time (recomputed fresh on every call, not pinned to whenever a
// far-back fetch happened to occur) — see how it's combined with the synced-
// bounds union in applyPulledEvents below.

// Backoff schedule for the mount-time silent re-auth (see the effect below):
// 3 total attempts — immediate, then ~2s, then ~5s — before this mount pass
// gives up and leaves it to the periodic poll. Short on purpose: this is
// covering a cold-start blip (auth.currentUser not warm yet, DNS/TCP cold),
// not a sustained outage, and the 60s poll is the real long-run retry.
const SILENT_REAUTH_RETRY_DELAYS_MS = [0, 2000, 5000];
export const SILENT_REAUTH_MAX_ATTEMPTS = SILENT_REAUTH_RETRY_DELAYS_MS.length;

/**
 * Delay (ms) to wait BEFORE the attempt at `attemptIndex` (0-based). Attempt 0
 * runs immediately; later attempts back off. Anything past the last configured
 * attempt returns null, which callers read as "stop retrying". Pure and
 * exported purely so the schedule is unit-testable without driving the hook.
 */
export function getSilentReauthRetryDelay(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) return null;
  if (attemptIndex >= SILENT_REAUTH_RETRY_DELAYS_MS.length) return null;
  return SILENT_REAUTH_RETRY_DELAYS_MS[attemptIndex];
}

// Single short retry delay for the periodic poll and the on-demand range
// fetch. Both already have a natural next trigger (the 60s interval / the next
// calendar navigation), so one extra attempt is enough to ride out a momentary
// network blip without building a full backoff ladder for them.
const TRANSIENT_RETRY_DELAY_MS = 2000;

// How long `googleSyncStale` has to stay true before it escalates from a
// quiet Settings-only badge to a proactive toast. Every individual stale
// fetch is still just as likely to be a momentary blip (see googleSyncStale's
// own doc comment) — but a blip that hasn't cleared after this many minutes
// of 60s-interval polling stops looking transient and starts looking like a
// connection the user actually needs to know about, since nothing else here
// prompts them unless they happen to open Settings. Long enough that normal
// brief hiccups (a few missed poll ticks) never trigger it.
const STALE_SYNC_WARNING_THRESHOLD_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Debounce for pushTodaysTasksToCalendar's trigger effect (see below). A
// rebalance, a completion, or a cloud-merge can each touch several blocks in
// one commit, and each is its own React state update — without debouncing,
// the effect would fire (and the delete-all-then-recreate push run) once per
// intermediate update instead of once for the settled result. Reuses
// CLOUD_SYNC_DEBOUNCE_MS's own value rather than inventing a new constant:
// this push is, like that one, "settle a burst of local edits, then do one
// network round-trip" — no reason for a different wait here.
const BLOCK_PUSH_DEBOUNCE_MS = CLOUD_SYNC_DEBOUNCE_MS;

// ---- "Rewrite Google Calendar to match TaskFlow" pacing/retry -------------
// A rewrite is by far the heaviest burst of Google API traffic this app ever
// produces — a delete-all rewrite (see planCalendarRewrite in
// googleCalendarService.js) issues one delete per event on the primary
// calendar plus one insert per authoritative local item, easily several
// hundred operations. Those operations are bundled into batches of up to
// MAX_BATCH_SIZE (50) sub-requests per HTTP call, so this delay is paid once
// per BATCH rather than once per event — the same guard against bursting past
// Google's per-user rate limit, at ~50x fewer round-trips. Slightly longer
// than the old per-call value since each batch is itself ~50 operations
// arriving at once.
const REWRITE_BATCH_PACING_MS = 300;
// Backoff before retrying a batch that got a 429 — longer than the pacing
// delay above since a 429 means the limit was already hit, not just
// approached. One retry is enough for the burst this feature itself causes to
// settle; a second consecutive 429 on the same batch is treated as a real
// failure rather than retried again indefinitely.
const REWRITE_RATE_LIMIT_BACKOFF_MS = 2000;

/**
 * Runs `callFn` (one batched Google Calendar API call) with a single retry
 * specifically for a 429 (rate limit) response — everything else in this
 * codebase treats a failed API call as a hard per-item failure (see
 * pushUnsyncedItemsToCalendar), which is fine for a single occasional call
 * but too eager to give up for a rewrite, where a 429 midway through is an
 * expected/recoverable condition, not a real error.
 *
 * This covers a 429 (or network failure) against the BATCH endpoint itself,
 * which rejects the whole call. A 429 on an individual SUB-request inside an
 * otherwise-successful batch doesn't reject at all — it comes back as that
 * sub-response's own status, and is retried separately by
 * runBatchesWithRetry's failed-sub-request follow-up pass below.
 */
async function withRateLimitRetry(callFn) {
  try {
    return await callFn();
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    await sleep(REWRITE_RATE_LIMIT_BACKOFF_MS);
    return callFn(); // let a second failure (429 or otherwise) propagate to the caller
  }
}

/**
 * True if a block or event is far enough in the past that TaskFlow should stop
 * writing it to Google Calendar entirely — no create, no update, no delete.
 *
 * Product decision (explicit): once an item's day is over it's history, and
 * history is frozen. TaskFlow is a forward-looking scheduler, so re-pushing or
 * rewriting yesterday's events is never something the user asked for — it just
 * churns their real calendar's past with edits (or duplicates) they can't see
 * in TaskFlow's own forward-looking views. This only gates OUTBOUND writes;
 * pulling past events in for display, and the separate retention/purge policy
 * for how long they're kept (see eventSyncService.js), are untouched.
 *
 * Compared by local CALENDAR DAY, not exact time-of-day (isPast) — an event
 * earlier today is still part of today and stays syncable, which avoids a
 * running clock silently changing sync eligibility mid-session.
 *
 * A recurring master is never past: its stored `date` is only the series'
 * DTSTART, which can be arbitrarily old while the series itself is still
 * active (same reasoning as eventSyncService's isTooOldToRetain).
 */
export function isPastCalendarItem(item) {
  if (!item?.date) return false;
  if (item.recurrenceRule) return false;
  return isPast(item.date);
}

/**
 * True if a local CalendarEvent still needs pushing to Google — i.e. it has
 * no googleEventId yet AND it's one this app is allowed to create there.
 *
 * Excluded deliberately:
 *   - anything sourced from a calendar the user doesn't own (`source:
 *     'google'` with a non-primary calendarId): pushing a copy of a
 *     subscribed/shared event onto the user's own primary calendar would
 *     duplicate someone else's event. Same rule the rewrite's authoritative
 *     set applies.
 *   - legacy block-mirror rows (see isBlockSourcedEvent): leftovers on Google
 *     from when TaskFlow still pushed ScheduledBlocks. Blocks are TaskFlow-only
 *     now, so nothing recreates these — but an old one still sitting on the
 *     user's calendar must not be re-pushed as a fresh event either.
 *   - anything without a date/start/end, which can't build a valid resource.
 *   - anything already in the PAST (see isPastCalendarItem): once a day is
 *     over, TaskFlow stops writing it to Google at all — history is frozen,
 *     not part of the live sync loop.
 *   - a deleted-event tombstone (see utils/eventTombstones.js). A manual
 *     event that was tombstoned before ever being pushed to Google (no
 *     `googleEventId` yet) still has a future date/start/end at delete time —
 *     without this check, the very tombstone whose whole job is to carry a
 *     deletion across devices would instead get pushed to Google as a
 *     brand-new event, recreating the thing the user just deleted.
 *
 * `primaryCalendarId` (default `'primary'`, matching the pre-existing
 * behavior for any caller that doesn't pass one, e.g. an older test) is the
 * raw calendarId googleCalendarService.fetchEvents most recently resolved
 * the user's OWN default calendar to. That id is commonly the account's real
 * email address, NOT the literal string "primary" — Google's calendarList
 * reports the primary calendar that way (see fetchEvents' own comment), while
 * every event this app itself PUSHES to Google always targets the literal
 * `calendarId: 'primary'` (see pushEventToCalendar). Comparing only against
 * the literal string therefore misclassified the user's OWN primary-calendar
 * events (pulled with calendarId set to their email) as foreign/subscribed —
 * which meant a `source: 'google'` event demoted back to unsynced (see
 * eventSyncService.demoteToUnsyncedLocalEvent, e.g. after its recurrence was
 * edited on Google into a new series with a different id) could never
 * actually be re-pushed here: it just sat at `googleEventId: null` forever,
 * while the new series it was replaced by arrived as a separate row on the
 * next pull — two rows for the same real thing. See this fix's own
 * regression test for the concrete duplicate-event bug this caused.
 */
export function isUnsyncedPushableEvent(event, primaryCalendarId = 'primary') {
  if (!event || event.googleEventId) return false;
  if (event.deletedAt) return false;
  if (event.source === 'google' && event.calendarId !== 'primary' && event.calendarId !== primaryCalendarId) return false;
  if (isBlockSourcedEvent(event)) return false;
  if (isPastCalendarItem(event)) return false;
  return !!(event.date && event.startTime && event.endTime);
}

/**
 * ============================================================================
 * "Push today's scheduled task blocks to Google Calendar" — pure decisions
 * ============================================================================
 * See pushTodaysTasksToCalendar below for the full feature. These three pure
 * functions compute WHAT belongs in today's push without touching any API or
 * hook state, so they're unit-testable on their own.
 * ============================================================================
 */

/**
 * True if `block` (joined with its owning `task`) belongs in today's
 * authoritative Google Calendar push.
 *
 * Excluded:
 *   - `block.date !== todayIso`: only TODAY's blocks are ever pushed — this
 *     feature has no notion of a wider sync window the way CalendarEvents do.
 *   - no owning task found (a dangling block — shouldn't happen, but nothing
 *     to build a resource from).
 *   - `isBlockTaskCompleted(block, task)`: reuses the SAME completion check
 *     TodayAgenda/DashboardStats already use (see missedTasks.js) to decide
 *     whether a block is a live, still-scheduled item or a completed
 *     historical record. This matters most for a RECURRING task: completing
 *     today's occurrence advances the task to its NEXT due date and flips
 *     `isCompleted` back to false (see SchedulerContext.completeTask), but
 *     deliberately keeps today's block around, crossed out, as a completed
 *     record for the calendar/agenda views — `task.completedDates` (not
 *     `task.isCompleted`) is what actually marks THIS occurrence done, which
 *     is exactly what isBlockTaskCompleted checks. Without reusing it here, a
 *     completed recurring task's block would still read as "not completed"
 *     (isCompleted is already false again) and get pushed to Google right
 *     after the user just finished it — the opposite of what completing a
 *     task should do to its calendar entry.
 */
export function isBlockEligibleForTodaysPush(block, task, todayIso) {
  if (!block || block.date !== todayIso) return false;
  if (!task) return false;
  if (isBlockTaskCompleted(block, task)) return false;
  return true;
}

/**
 * Every `{ block, task }` pair that belongs in today's push — the
 * authoritative set `computeTodaysBlockPushPlan`'s `toInsert` half is built
 * from. Pure join + filter, exported so it (and the filter it applies) is
 * unit-testable without needing the hook or a fetch.
 */
export function computeTodaysAuthoritativeBlocks(blocks, tasks, todayIso) {
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  return (blocks || [])
    .map((block) => ({ block, task: taskById.get(block.taskId) }))
    .filter(({ block, task }) => isBlockEligibleForTodaysPush(block, task, todayIso));
}

/**
 * Cheap signature of "everything that could change what today's push should
 * look like" — the trigger effect below watches this instead of raw
 * blocks/tasks arrays, so a change to an unrelated field (e.g. a task's
 * description, or a block for a DIFFERENT day) never fires an unnecessary
 * push. Mirrors eventsSignature's own reasoning above: order-independent
 * (sorted) since a differently-ordered but otherwise-identical set isn't a
 * real change, and deliberately narrow — only the fields that actually
 * surface on the pushed Google event (title/priority/time) or gate
 * eligibility (completion) are included.
 */
export function computeTodaysBlockPushSignature(blocks, tasks, todayIso) {
  return computeTodaysAuthoritativeBlocks(blocks, tasks, todayIso)
    .map(({ block, task }) => `${block.id}|${block.date}|${block.startTime}|${block.endTime}|${task.title}|${task.priority}`)
    .sort()
    .join('\n');
}

/**
 * Collapses authoritative rewrite items that would create INDISTINGUISHABLE
 * Google events — same title, date, start/end time and recurrence rule. The
 * first occurrence of each signature wins; the rest are dropped.
 *
 * A defence-in-depth backstop for the rewrite's push phase. The push phase is
 * the one place in the app that can mint permanent duplicates on a user's real
 * calendar, and a duplicate that reaches Google survives every subsequent
 * sync; so it's worth one cheap O(n) pass to guarantee no single rewrite run
 * can ever insert the same event twice, whatever new way local state finds to
 * disagree with itself.
 *
 * Returns `{ items, duplicates }` so the caller can log the duplicates —
 * anything caught here means local state genuinely holds redundant rows,
 * which is a bug worth surfacing rather than silently absorbing.
 *
 * Keyed on the user-visible identity of the resulting event rather than on
 * local ids: two rows with different ids that would render as the same event
 * at the same time ARE the duplicate case this exists to catch.
 */
export function dedupeAuthoritativeItems(items) {
  const signatureOf = ({ event }) =>
    ['event', event.title || '', event.date, event.startTime, event.endTime, event.recurrenceRule || ''].join('|');

  const seen = new Set();
  const kept = [];
  const duplicates = [];
  for (const item of items) {
    const signature = signatureOf(item);
    if (seen.has(signature)) {
      duplicates.push(item);
      continue;
    }
    seen.add(signature);
    kept.push(item);
  }
  return { items: kept, duplicates };
}

/**
 * Drives a list of items through batched API calls, with per-item result
 * tracking and a retry pass for individually-rate-limited sub-requests.
 *
 * @param {Array} items - the units of work (event ids to delete, or insert
 *   descriptors), chunked internally into MAX_BATCH_SIZE-sized batches.
 * @param {Function} runBatch - `(chunk) => Promise<Map<key, {ok, status, error, ...}>>`
 *   — one batched API call (batchDeleteCalendarEvents / batchInsertCalendarEvents).
 * @param {Function} keyOf - `(item) => key` matching how `runBatch` keys its
 *   returned map, so a failed sub-request can be mapped back to its item.
 * @param {Function} onBatchDone - called with the number of items just
 *   finished, for progress reporting (advances a batch at a time — a batched
 *   call gives no per-item timing to report within it).
 * @returns {Promise<Map<key, {ok, status, error, ...}>>} merged results for
 *   every item, whether it succeeded, failed, or failed its whole batch.
 */
async function runBatchesWithRetry(items, runBatch, keyOf, onBatchDone) {
  const results = new Map();
  const chunks = chunkForBatch(items);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    try {
      const chunkResults = await withRateLimitRetry(() => runBatch(chunk));
      for (const [key, res] of chunkResults) results.set(key, res);

      // Individually rate-limited sub-requests: the batch as a whole
      // succeeded, but some entries inside it came back 429. Retry exactly
      // those in one smaller follow-up batch rather than re-running the whole
      // original (which would re-issue the already-succeeded ones — for
      // deletes that's merely wasteful, but for INSERTS it would create
      // duplicate events, which is the precise bug this feature exists to fix).
      const rateLimited = chunk.filter((item) => {
        const res = results.get(keyOf(item));
        return res && !res.ok && res.status === 429;
      });
      if (rateLimited.length > 0) {
        await sleep(REWRITE_RATE_LIMIT_BACKOFF_MS);
        try {
          const retryResults = await runBatch(rateLimited);
          for (const [key, res] of retryResults) results.set(key, res);
        } catch (retryErr) {
          // Leave the original 429 results in place — they're already
          // recorded as failures, which is the correct outcome here.
          console.warn('[useGoogleCalendarSync] Rewrite: rate-limit retry batch failed', retryErr);
        }
      }
    } catch (err) {
      // A CONFIRMED auth expiry (see executeBatch/computeTodaysBlockPushPlan's
      // own doc comments) is not "this one batch/chunk failed" — it means
      // every remaining chunk in this loop, and every future call until the
      // user reconnects, would fail identically against the same dead token.
      // Recording it as a per-item failure and continuing would silently burn
      // through the rest of `items` making the same doomed call over and
      // over, and — worse, for the silent block-push feature this also drives
      // — leave the caller with no signal beyond a per-item {ok:false} to
      // notice that it's actually disconnected. Abort the whole run and let
      // it propagate so the caller can disconnect/prompt reconnect instead.
      if (isConfirmedGoogleAuthFailure(err)) throw err;
      // Otherwise the whole batch call failed for a non-auth reason (network,
      // or a 429 that survived the retry above) — mark every item in it as
      // failed so the per-item success/failure totals stay accurate rather
      // than silently dropping this chunk.
      console.warn('[useGoogleCalendarSync] Rewrite: batch call failed', err);
      const message = err?.message || String(err);
      for (const item of chunk) {
        results.set(keyOf(item), { ok: false, status: err?.status ?? 0, error: message, googleEventId: null });
      }
    }
    onBatchDone(chunk.length);
    // Pace BETWEEN batches only (never within one) — see REWRITE_BATCH_PACING_MS.
    if (i < chunks.length - 1) await sleep(REWRITE_BATCH_PACING_MS);
  }

  return results;
}

/**
 * @param {Object} deps
 * @param {Array} deps.events - Current events array (from useState in SchedulerContext)
 * @param {Function} deps.setEvents - Setter for events
 * @param {Array} deps.tasks - Current tasks array — read-only here, only to
 *   join against `blocks` for pushTodaysTasksToCalendar's authoritative set.
 * @param {Array} deps.blocks - Current ScheduledBlocks array — same read-only
 *   use as `tasks`. Neither is ever written back to; this hook has no other
 *   reason to know about tasks/blocks at all (see this file's module doc).
 * @param {Function} deps.setNotification - Toast notification setter
 * @param {boolean} deps.authLoading - True while Firebase is still restoring auth state
 * @param {Function} deps.onEventsChanged - Called when a pull changed something schedule-relevant
 * @returns {Object} Google Calendar state and callbacks
 */
export function useGoogleCalendarSync({
  events,
  setEvents,
  tasks,
  blocks,
  setNotification,
  authLoading,
  onEventsChanged,
}) {
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  const [isPullingGoogleEvents, setIsPullingGoogleEvents] = useState(false);

  // Shared by every call site that confirms Google's grant is actually
  // revoked/expired (mount-time silent re-auth, periodic poll, on-demand
  // range fetch) — same state flip and message repeated at all three, so
  // it's factored into one function rather than left copy-pasted. The
  // notification's action button re-triggers connectGoogleCalendar directly
  // via connectGoogleCalendarRef (see that ref's own doc comment for why a
  // ref indirection is needed here) — clicking it IS the user gesture Google
  // requires to show the re-consent popup, so this closes the loop without
  // the user needing to go find the button in Settings themselves.
  const notifyGoogleCalendarDisconnected = useCallback(() => {
    setGoogleConnected(false);
    setGoogleNeedsReconnect(true);
    setNotification({
      type: 'warning',
      message: 'Google Calendar disconnected — reconnect to resume syncing.',
      actionLabel: 'Reconnect',
      onAction: () => connectGoogleCalendarRef.current(),
    });
  }, [setGoogleConnected, setGoogleNeedsReconnect, setNotification]);

  // ---- Sync health -----------------------------------------------------------
  // `googleSyncStale` is true when the most recent fetch attempt (mount silent
  // re-auth, periodic poll, or on-demand range fetch) ultimately failed after
  // exhausting its retries for a TRANSIENT reason — i.e. Google is nominally
  // connected but nothing is actually coming back. A confirmed
  // reconnect-needed/auth failure deliberately does NOT set it: that path
  // already flips googleConnected/googleNeedsReconnect and has its own, more
  // urgent messaging, and showing two indicators for one underlying cause is
  // just noise.
  //
  // Deliberately plain useState, NOT usePersistedState/BACKUP_FIELDS: it's a
  // live health signal about right-now connectivity, meaningless to restore
  // from a backup or mirror to another device (whose own fetches succeed or
  // fail independently). Every successful fetch clears it and stamps
  // `lastGoogleSyncAt`.
  //
  // Also consumed outside the UI: SchedulerContext passes it into useCloudSync,
  // where it broadens the events-fallback-from-backup effect from "Google is
  // disconnected" to "no live source is currently working" — see that effect's
  // doc comment.
  const [googleSyncStale, setGoogleSyncStale] = useState(false);
  const [lastGoogleSyncAt, setLastGoogleSyncAt] = useState(null);

  const markGoogleSyncSucceeded = useCallback(() => {
    setGoogleSyncStale(false);
    setLastGoogleSyncAt(Date.now());
  }, []);

  // Timestamp the sync FIRST went stale, so the escalation effect below can
  // tell "just went stale this tick" from "has been stale for a while" without
  // re-deriving it from lastGoogleSyncAt (which doesn't update while stale).
  // Cleared whenever a fetch succeeds or the connection is confirmed lost —
  // see the two effects that touch it.
  const staleSinceRef = useRef(null);
  const staleWarningShownRef = useRef(false);

  // Shared by EVERY fetch-and-apply path below — the periodic poll, the
  // visibility/focus refresh (which just calls the poll), the manual "Pull"
  // button, "Rebuild from Google Calendar", the initial silent re-auth on
  // mount, and connectGoogleCalendar's own first fetch. Originally only the
  // periodic poll guarded itself against re-entrancy; the other paths each
  // did their own independent fetchGoogleEvents() + applyPulledEvents() with
  // no coordination, so two of them could run concurrently (e.g. clicking
  // "Pull" while a poll tick was already in flight) and whichever HTTP
  // round-trip happened to RESOLVE last would win and overwrite state —
  // regardless of which one actually reflected fresher server data. A
  // slower, earlier-started fetch resolving after a faster, later-started
  // one could silently clobber a just-applied Google-side delete with stale
  // data, making a deleted event appear to "come back" a few minutes later.
  // Serializing every fetch-and-apply cycle behind this one flag closes that
  // race outright (out-of-order application can't happen if only one fetch
  // is ever in flight at a time) — simpler than a request-generation counter
  // while a single flag is enough to fully prevent overlap.
  const googleFetchInFlightRef = useRef(false);

  // Set synchronously inside applyPulledEvents' setEvents updater when a
  // pull actually changed something schedule-relevant (see eventsSignature),
  // then read+cleared right after — a plain local variable wouldn't survive
  // across the async setEvents update boundary reliably. Only in this
  // narrow signal state; not a general "did anything change" API.
  const eventsChangedRef = useRef(false);
  const lastGooglePollAtRef = useRef(0);
  const pollGoogleEventsRef = useRef(null);

  // Set true to suppress the periodic poll (and the visibility/focus refresh
  // that calls the same poll function) without touching googleFetchInFlightRef
  // — that ref only guards against overlapping IN-PROGRESS fetches, it can't
  // stop a NEW poll tick from starting once a previous one has finished.
  // rewriteGoogleCalendarFromTaskflow holds this for its entire duration: the
  // routine sync policy is "Google always wins" (see eventSyncService.js),
  // which is exactly backwards for a rewrite — a poll landing mid-rewrite
  // would re-pull whatever's still on Google (including events the rewrite
  // just deleted, or hasn't yet reached) and undo the rewrite's own work as
  // it goes. This also covers restore -> rewrite: SchedulerContext's
  // restoreCloudBackupAndRewriteCalendar/importBackupFromFileAndRewriteCalendar
  // chain a restore directly into this function with no gap for a poll to
  // land in between (an earlier design offered a separate opt-in follow-up
  // toast after restore instead, which left exactly that gap open — replaced
  // for this reason). A plain boolean ref (not state) since nothing needs to
  // re-render off it — only the poll/visibility-refresh effect's closures
  // read it.
  const pollPausedRef = useRef(false);

  // Latest `events` prop, mirrored into a ref for the same reason
  // stateRef exists for tasks/blocks: the periodic-poll effect only re-runs
  // on `googleConnected`, so its interval closure would otherwise keep
  // reading whatever `events` array existed at that render and sweep a stale
  // list forever (see pushUnsyncedItemsToCalendar's event pass). Assigned in
  // render rather than an effect so it's already current for any call made
  // during this same commit.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Latest tasks/blocks, mirrored the same way as eventsRef above — read only
  // by pushTodaysTasksToCalendar's trigger effect and the function itself, so
  // a debounced/queued push always computes against CURRENT state rather than
  // whatever was closed over when it was scheduled.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Populated below (near "Push events to Google Calendar") with a function
  // that pushes every CalendarEvent lacking a googleEventId — kept in a ref,
  // same reasoning as pollGoogleEventsRef, so the periodic-poll effect (which
  // only depends on googleConnected) can call the latest version without
  // needing to be redefined whenever state changes.
  const pushUnsyncedItemsRef = useRef(async () => ({ events: 0 }));

  // Populated below (near "Push today's scheduled task blocks to Google
  // Calendar") with runTodaysTaskBlockPushNow — same ref-indirection reasoning
  // as pushUnsyncedItemsRef above. Called directly (not debounced) by the
  // periodic poll and the visibility/focus refresh below: those are already
  // throttled by their own interval/REFRESH_THROTTLE_MS, and an immediate call
  // (rather than routing through the debounced scheduleTodaysTaskBlockPush) is
  // what makes day-rollover reliable — see this ref's call sites for why.
  const blockPushTriggerRef = useRef(async () => {});

  // Populated below (near "connectGoogleCalendar") once that callback exists —
  // every "disconnected" warning notification fires from an effect defined
  // BEFORE connectGoogleCalendar in this file, so they can't close over it
  // directly. Same "declare the ref early, assign .current once the real
  // function exists" pattern as pollGoogleEventsRef/pushUnsyncedItemsRef
  // above, used here so those warnings can offer a one-click "Reconnect"
  // action instead of just telling the user to go find it in Settings.
  const connectGoogleCalendarRef = useRef(() => {});

  // googleEventId -> timestamp this app instance issued a delete for it.
  // Consulted (and pruned of expired entries) by every mergePulledGoogleEvents
  // call below so a poll/pull that lands before Google's own delete has
  // propagated can't resurrect an event we just deleted (see
  // eventSyncService.mergePulledGoogleEvents and SchedulerContext.deleteEvent).
  const recentlyDeletedGoogleEventIdsRef = useRef(new Map());

  // The raw calendarId googleCalendarService.fetchEvents most recently
  // resolved the user's own default calendar to — see isUnsyncedPushableEvent's
  // own doc comment for why this can legitimately be the account's email
  // address rather than the literal string 'primary', and why comparing only
  // against that literal string left a demoted event permanently un-pushable.
  // Updated after every fetch below; starts at the literal 'primary' so the
  // very first push sweep (before any fetch has run this session) still uses
  // the same default isUnsyncedPushableEvent always had.
  const primaryCalendarIdRef = useRef('primary');

  // Thin wrapper around fetchGoogleEvents used at every call site in this
  // file, so primaryCalendarIdRef always reflects the most recent fetch
  // without each of the 7 call sites needing to remember to update it
  // themselves — same shape/return as fetchGoogleEvents itself.
  const fetchGoogleEventsTracked = useCallback(async (startIso, endIso) => {
    const result = await fetchGoogleEvents(startIso, endIso);
    if (result.primaryCalendarId) primaryCalendarIdRef.current = result.primaryCalendarId;
    return result;
  }, []);

  // googleEventIds this app instance has actually seen live on Google since
  // load — every id a pull returned, plus every id one of our own pushes was
  // given back. Consulted by mergePulledGoogleEvents to tell a genuine
  // Google-side delete (id was confirmed live, now gone -> Google wins, drop
  // it) from an event that was never really on Google at all (id restored from
  // a backup taken before the user cleared their calendar -> TaskFlow wins,
  // re-push it). Without this, restoring a backup and syncing silently deleted
  // every restored event, since no pull could ever echo back ids Google had
  // never heard of.
  //
  // Session-scoped by design, NOT a persisted field on the event: the whole
  // point is that it records what THIS instance verified against the live API,
  // and a flag stored on the event would be restored from the backup right
  // alongside the stale googleEventId it's supposed to distrust.
  const confirmedGoogleEventIdsRef = useRef(new Set());

  // `${masterGoogleEventId}::${occurrenceDateIso}` -> timestamp this app
  // instance issued a deleteCalendarEventInstance call for that single
  // occurrence (SchedulerContext.deleteEvent's scope 'this'). Parallel to
  // recentlyDeletedGoogleEventIdsRef above but per-occurrence rather than
  // per-event: deleting one occurrence never changes the master's own
  // googleEventId, so the whole-event suppression above doesn't cover it —
  // without this, a poll landing before Google's EXDATE update propagates
  // would silently overwrite the master's local `overrides` and resurrect
  // the just-deleted occurrence (see eventSyncService.mergePulledGoogleEvents).
  const recentlyDeletedGoogleEventInstancesRef = useRef(new Map());

  // Guards the one-time hardResetEventsFromGoogle cleanup below so it only
  // ever runs once per device — see hardResetEventsFromGoogle's own doc
  // comment for what it's cleaning up and why it's a deliberate one-time
  // full wipe (explicitly authorized by the user) rather than a general
  // merge policy. Named distinctly (and stored under a fresh persisted key)
  // from an earlier, narrower "reconcile" pass this replaces, so it still
  // fires even for a device where that earlier pass already ran. Mirrored
  // into a ref (kept in sync below) rather than read directly from state
  // inside applyPulledEvents, because the periodic-poll effect further down
  // only re-runs on `googleConnected` changing — its `poll` closure captures
  // whatever `applyPulledEvents` existed at that render, so if that callback
  // closed over the boolean by value it would keep re-deciding "not done
  // yet" on every poll tick forever, re-running the wipe indefinitely
  // instead of exactly once. Reading a ref instead means every captured
  // closure still observes the flag flipping.
  const [googleEventsHardResetDone, setGoogleEventsHardResetDone] = usePersistedState('googleEventsHardResetDone', false);
  const googleEventsHardResetDoneRef = useRef(googleEventsHardResetDone);
  useEffect(() => {
    googleEventsHardResetDoneRef.current = googleEventsHardResetDone;
  }, [googleEventsHardResetDone]);

  // Outer bounds (`{ startIso, endIso }`) of the UNION of every range ever
  // fetched — starts at whatever the routine window covered, then grows
  // whenever ensureGoogleRangeSynced below fetches further out because the
  // calendar view scrolled past it. Persisted (not just session-local) so a
  // reload doesn't forget an on-demand-widened range and let the very next
  // routine poll purge what it fetched — see eventSyncService's module doc
  // for that bug. Mirrored into a ref for the same reason
  // googleEventsHardResetDoneRef is: closures captured by the polling
  // effect's interval need to see updates without that effect re-running.
  const [googleSyncedRangeBounds, setGoogleSyncedRangeBounds] = usePersistedState('googleSyncedRangeBounds', null);
  const googleSyncedRangeBoundsRef = useRef(googleSyncedRangeBounds);
  useEffect(() => {
    googleSyncedRangeBoundsRef.current = googleSyncedRangeBounds;
  }, [googleSyncedRangeBounds]);

  // Shared by every fetch call site below (initial silent re-auth, periodic
  // poll, connect, manual pull) — applies the one-time hard reset instead of
  // the normal incremental merge for exactly the first pull after this fix
  // ships, then flips the flag so every subsequent call uses the normal
  // merge.
  //
  // Returns `{ didHardReset, events }`: whether this call was the reset pass
  // (so callers can tell the user their calendar was just wiped and rebuilt),
  // and — importantly — the MERGED event array itself, computed synchronously
  // rather than only inside the setEvents updater.
  //
  // Why the merge is computed out here instead of inside the updater: the
  // merge is what DEMOTES an event restored from a backup whose stored
  // googleEventId no longer exists on Google back to unsynced
  // (googleEventId: null), and the poll's push sweep immediately afterwards is
  // what re-creates it on Google. A setEvents updater doesn't run
  // synchronously — React queues it and only applies it on the next commit —
  // so a same-tick push sweep reading `eventsRef.current` (assigned in the
  // render body, i.e. the LAST COMMITTED render) still saw the event with its
  // stale, dead googleEventId intact, and isUnsyncedPushableEvent's first
  // check skipped it. The demotion and the push decision disagreed by exactly
  // one render, every tick, forever: the event was never pushed until the user
  // manually edited it (SchedulerContext's edit path pushes unconditionally,
  // without consulting googleEventId — which is why a manual edit always
  // worked and a passive poll never did). Returning the merged array lets the
  // poll hand the FRESH list straight to the push sweep, so the same tick that
  // demotes an event also pushes it.
  const applyPulledEvents = useCallback(
    (fetchedEvents, rangeStartIso, rangeEndIso) => {
      const didHardReset = !googleEventsHardResetDoneRef.current;
      // Union this fetch's own range into everything synced so far BEFORE
      // merging, so the purge check below uses the union's outer edge
      // rather than just this call's own (possibly narrower) rangeStartIso
      // — see eventSyncService's module doc for the bug this avoids.
      const expandedBounds = expandSyncedBounds(googleSyncedRangeBoundsRef.current, rangeStartIso, rangeEndIso);
      // Cap retention at RETENTION_DAYS_CALENDAR_EVENTS regardless of how far
      // back the synced-bounds union reaches — see computeEffectivePurgeBoundary's
      // own doc comment.
      const purgeBoundaryIso = computeEffectivePurgeBoundary(expandedBounds.startIso, RETENTION_DAYS_CALENDAR_EVENTS);
      // Everything this pull returned is now confirmed to exist on Google, so
      // a LATER pull finding one of these ids missing is a real Google-side
      // delete — see confirmedGoogleEventIdsRef's own doc comment.
      for (const e of fetchedEvents) {
        if (e.googleEventId) confirmedGoogleEventIdsRef.current.add(e.googleEventId);
      }
      // The merge itself: a pure function of (previous events, fetched
      // events), so it can be run eagerly here AND again inside the updater
      // below without the two disagreeing.
      const mergeAgainst = (prev) =>
        didHardReset
          ? hardResetEventsFromGoogle(fetchedEvents, recentlyDeletedGoogleEventIdsRef.current, recentlyDeletedGoogleEventInstancesRef.current)
          : mergePulledGoogleEvents(
              prev,
              fetchedEvents,
              rangeStartIso,
              rangeEndIso,
              recentlyDeletedGoogleEventIdsRef.current,
              recentlyDeletedGoogleEventInstancesRef.current,
              Date.now(),
              purgeBoundaryIso,
              confirmedGoogleEventIdsRef.current
            );

      // Merge once, eagerly, against the latest events this component has been
      // given (eventsRef.current is assigned in the render body). Doing it here
      // rather than only inside the setEvents updater is the whole fix: it
      // makes the result available to this same synchronous tick, instead of a
      // render behind it — see this callback's doc comment above.
      const prevEvents = eventsRef.current || [];
      const mergedEvents = mergeAgainst(prevEvents);
      // Most poll ticks pull back the exact same events unchanged — only
      // worth queuing an auto-rebalance when the merge actually altered
      // something a task's scheduled block could conflict with (an event
      // added/removed/moved in time), not on every 60s poll or tab-focus
      // refresh regardless of whether anything changed. See
      // eventsSignature's own doc comment for what counts as "changed".
      eventsChangedRef.current = eventsSignature(prevEvents) !== eventsSignature(mergedEvents);
      // Keep eventsRef in step immediately: the push sweep below (and any
      // other same-tick reader) must not see the pre-merge list again before
      // React commits this update.
      eventsRef.current = mergedEvents;
      // Still a FUNCTIONAL update, even though the merged value is already
      // known: reuse it when `prev` is what we merged against (the normal
      // case), and otherwise re-merge against whatever React actually holds.
      // A plain setEvents(mergedEvents) would silently discard any other
      // setEvents that landed in between — the poll awaits between fetch and
      // merge, so that window is real, if narrow.
      setEvents((prev) => (prev === prevEvents ? mergedEvents : mergeAgainst(prev)));
      // A hard reset wipes and replaces `events` wholesale — anything
      // outside THIS fetch's own range is gone regardless of what was synced
      // before, so the bounds reset to exactly this fetch's range rather than
      // unioning with (now-stale) prior bounds.
      const nextBounds = didHardReset ? { startIso: rangeStartIso, endIso: rangeEndIso } : expandedBounds;
      googleSyncedRangeBoundsRef.current = nextBounds;
      setGoogleSyncedRangeBounds(nextBounds);
      if (didHardReset) {
        googleEventsHardResetDoneRef.current = true; // synchronous — covers any other already-in-flight closure too
        setGoogleEventsHardResetDone(true);
      }
      // Only queue an auto-rebalance if this pull actually changed something
      // schedule-relevant (see eventsSignature) — most poll ticks/tab-focus
      // refreshes pull back an identical event set, and rebalancing on every
      // one of those would silently re-trigger without the user doing
      // anything. A hard reset always counts as changed (nothing to diff
      // against meaningfully — see hardResetEventsFromGoogle's own doc for
      // why that's a one-time full replace).
      if (didHardReset || eventsChangedRef.current) onEventsChanged?.();
      return { didHardReset, events: mergedEvents };
    },
    [setEvents, setGoogleEventsHardResetDone, setGoogleSyncedRangeBounds, onEventsChanged]
  );

  const markGoogleEventDeleted = useCallback((googleEventId) => {
    if (!googleEventId) return;
    const map = recentlyDeletedGoogleEventIdsRef.current;
    const cutoff = Date.now() - RECENTLY_DELETED_TTL_MS;
    for (const [id, ts] of map) {
      if (ts < cutoff) map.delete(id);
    }
    map.set(googleEventId, Date.now());
  }, []);

  // Called if the Google-side delete call itself fails — stop suppressing
  // pulls for this id so the next poll/pull can correctly reflect that the
  // event is (still) live on Google, rather than silently hiding it from the
  // user for up to RECENTLY_DELETED_TTL_MS after a delete that never happened.
  const unmarkGoogleEventDeleted = useCallback((googleEventId) => {
    if (!googleEventId) return;
    recentlyDeletedGoogleEventIdsRef.current.delete(googleEventId);
  }, []);

  // Per-occurrence equivalents of the pair above — see
  // recentlyDeletedGoogleEventInstancesRef's own doc comment.
  const markGoogleEventInstanceDeleted = useCallback((masterGoogleEventId, occurrenceDateIso) => {
    if (!masterGoogleEventId || !occurrenceDateIso) return;
    const map = recentlyDeletedGoogleEventInstancesRef.current;
    const cutoff = Date.now() - RECENTLY_DELETED_TTL_MS;
    for (const [key, ts] of map) {
      if (ts < cutoff) map.delete(key);
    }
    map.set(`${masterGoogleEventId}::${occurrenceDateIso}`, Date.now());
  }, []);

  // Called if the Google-side delete-instance call itself fails — see
  // unmarkGoogleEventDeleted's own comment for why this matters (an
  // undetected failure would otherwise hide the still-live occurrence from
  // the user for up to RECENTLY_DELETED_TTL_MS).
  const unmarkGoogleEventInstanceDeleted = useCallback((masterGoogleEventId, occurrenceDateIso) => {
    if (!masterGoogleEventId || !occurrenceDateIso) return;
    recentlyDeletedGoogleEventInstancesRef.current.delete(`${masterGoogleEventId}::${occurrenceDateIso}`);
  }, []);

  // ---- Initial silent re-auth on mount ------------------------------------
  // Waits for Firebase's own auth state restore (authLoading) before running
  // — on a plain page refresh, onAuthStateChanged resolves asynchronously,
  // so firing this immediately on mount would often hit auth.currentUser as
  // still null (see getFirebaseIdToken in googleCalendarService.js), throw,
  // and disconnect the user even though they were never actually logged out
  // of Google Calendar — forcing a manual "Connect Calendar" click every
  // refresh for no reason.
  //
  // A full cold browser start (closing and reopening the browser, not just
  // refreshing the page) is plausibly slower/flakier than an in-process
  // refresh — extensions initializing, DNS/TCP cold, IndexedDB not yet warm
  // — so the silent re-auth + first fetch here get a short backoff ladder
  // (SILENT_REAUTH_RETRY_DELAYS_MS: immediate, ~2s, ~5s) before this
  // mount-time pass gives up. The whole attempt sequence runs INSIDE one
  // googleFetchInFlightRef hold — releasing it between attempts would let a
  // poll/pull start concurrently mid-ladder and reintroduce exactly the
  // out-of-order-application race that ref exists to prevent (see its doc
  // comment).
  //
  // Only a CONFIRMED "needs reconnect" failure (the Worker's 404/409 — see
  // shouldTreatAsReconnectNeeded) is treated as proof the user is actually
  // disconnected, and it's checked on EVERY attempt's error, not just the
  // last: retrying a revoked grant can only ever fail again, so it bails out
  // of the ladder immediately. Any other error (transient network failure,
  // getFirebaseIdToken() throwing, etc.) is retried, and if the ladder is
  // exhausted it's logged and flagged stale rather than flipping
  // googleConnected — the periodic poll (60s) and the visibility/focus
  // refresh keep retrying, so a cold-start blip never shows as "disconnected".
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (authLoading || !googleConnected) return;
      // Guard the whole attempt sequence — see googleFetchInFlightRef's own
      // doc comment. Unlikely to overlap anything this early, but a manual
      // "Pull" click landing during this initial load is possible.
      if (googleFetchInFlightRef.current) return;
      googleFetchInFlightRef.current = true;
      // "Connecting to Google Calendar..." loading toast (see Toast.jsx's
      // new `loading` type) — covers the app-open case this whole ladder
      // exists for for: the user opens the app and Google's silent re-auth
      // is working in the background rather than nothing visibly happening
      // for however long the retry ladder takes. Shown once the attempt
      // sequence actually starts (not e.g. while waiting on `authLoading`),
      // and ALWAYS replaced or cleared below on every terminal path of this
      // function — never left on screen once the fetch has settled one way
      // or another.
      let shownLoadingToast = false;
      try {
        for (let attempt = 0; attempt < SILENT_REAUTH_MAX_ATTEMPTS; attempt += 1) {
          const delay = getSilentReauthRetryDelay(attempt);
          if (delay) await sleep(delay);
          if (cancelled) return;
          try {
            const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
            const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
            const { enabled } = await initGoogleCalendar(clientId, apiKey);
            if (cancelled) return;
            if (!enabled) {
              setGoogleConnected(false);
              return;
            }

            // Only shown once we know Google Calendar is actually configured
            // (past the `!enabled` check above) — otherwise a device with no
            // VITE_GOOGLE_CLIENT_ID configured would flash a "connecting..."
            // toast for a connection attempt that was never going anywhere.
            if (!shownLoadingToast) {
              shownLoadingToast = true;
              setNotification({ type: 'loading', message: 'Connecting to Google Calendar…' });
            }

            await requestAccessToken(true); // silent — no consent popup
            if (cancelled) return;

            const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
            const { events: fetchedEvents, failedCalendars } = await fetchGoogleEventsTracked(rangeStartIso, rangeEndIso);
            if (cancelled) return;
            applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
            markGoogleSyncSucceeded();
            if (failedCalendars.length > 0) {
              console.warn(`[useGoogleCalendarSync] Couldn't load events from: ${failedCalendars.join(', ')}`);
            } else if (shownLoadingToast) {
              // Replace the loading toast with a quiet success rather than
              // leaving it on screen — see this effect's own doc comment.
              setNotification({ type: 'success', message: 'Connected to Google Calendar.' });
            }
            return;
          } catch (err) {
            if (cancelled) return;
            // Confirmed revoked/not-connected — retrying can't help, so bail
            // out of the ladder now rather than after the remaining attempts.
            if (shouldTreatAsReconnectNeeded(err)) {
              console.warn('[useGoogleCalendarSync] Silent re-auth confirmed not-connected/revoked, falling back to disconnected.', err);
              notifyGoogleCalendarDisconnected();
              return;
            }
            const isLastAttempt = attempt === SILENT_REAUTH_MAX_ATTEMPTS - 1;
            if (!isLastAttempt) {
              console.warn(`[useGoogleCalendarSync] Initial silent re-auth attempt ${attempt + 1} failed, retrying.`, err);
              continue;
            }
            // Transient failure (network hiccup, auth.currentUser not ready
            // yet, etc.) — don't disconnect; flag the sync as stale and let
            // the periodic poll/visibility refresh keep retrying. Replaces
            // the loading toast (if shown) so it doesn't linger — this is a
            // quieter message than the disconnected/reconnect warning above
            // since the connection itself is still nominally fine.
            console.warn('[useGoogleCalendarSync] Initial silent re-auth failed after all retries; leaving connection state as-is for the next background retry.', err);
            setGoogleSyncStale(true);
            if (shownLoadingToast) {
              setNotification({ type: 'warning', message: "Couldn't reach Google Calendar — will keep retrying in the background." });
            }
          }
        }
      } finally {
        googleFetchInFlightRef.current = false;
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // ---- Periodic polling ----------------------------------------------------
  useEffect(() => {
    if (!googleConnected) return undefined;

    // One extra attempt after a short delay covers a momentary network blip
    // without waiting a full interval; the in-flight ref stays held across
    // both attempts (see its doc comment) so nothing else can interleave.
    const poll = async () => {
      if (googleFetchInFlightRef.current || pollPausedRef.current) return;
      googleFetchInFlightRef.current = true;
      lastGooglePollAtRef.current = Date.now();
      const MAX_ATTEMPTS = 2;
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          if (attempt > 0) await sleep(TRANSIENT_RETRY_DELAY_MS);
          try {
            // Silently refresh the access token first (mirrors the initial
            // mount-time silent re-auth at requestAccessToken(true) above) —
            // without this, fetchGoogleEvents alone can't distinguish "no
            // access token yet" from "genuinely revoked": fetchEvents() just
            // falls back to mock data with no error at all when accessToken
            // is null (e.g. the mount-time silent re-auth exhausted its
            // retries on a transient failure and never obtained one), so a
            // refresh token revoked in the meantime would otherwise never
            // surface here — the poll would keep "succeeding" against mock
            // events forever. Routing through requestAccessToken(true) puts
            // any confirmed Worker 404/409 into THIS catch, where it's now
            // checked below alongside the existing isGoogleAuthError case.
            await requestAccessToken(true);
            const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
            const { events: fetchedEvents } = await fetchGoogleEventsTracked(rangeStartIso, rangeEndIso);
            const { events: mergedEvents } = applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
            markGoogleSyncSucceeded();
            // Also push any event still unsynced since the last tick — one
            // whose one-shot push at create/edit time failed, or one restored
            // from a backup and demoted back to unsynced by the merge above
            // (see pushUnsyncedItemsToCalendar's doc comment; the other push
            // sites are the manual "Push to Google Calendar" button and
            // addManualEvent/updateEvent's own immediate pushes, none of which
            // retry). The merged list is passed in explicitly rather than left
            // to be re-read from eventsRef: the demotion that makes a restored
            // event pushable happened microseconds ago in the call above, and
            // React hasn't committed it yet — see applyPulledEvents' doc
            // comment. Failures here are non-fatal to the poll itself — the
            // next tick just retries whatever is still unsynced, so they're
            // logged rather than flagged stale/disconnected.
            try {
              await pushUnsyncedItemsRef.current(mergedEvents);
            } catch (pushErr) {
              console.warn('[useGoogleCalendarSync] Auto-push of unsynced events failed; will retry next poll.', pushErr);
            }
            // Also re-run today's task-block push on every poll tick — this is
            // what makes day rollover work even if the tab has been sitting
            // open/backgrounded across midnight and no local block/task change
            // ever fires the debounced trigger effect on its own:
            // runTodaysTaskBlockPushNow always recomputes `todayIso` fresh, so
            // a tick that lands after midnight naturally deletes yesterday's
            // now-stale tagged events and pushes today's. Goes through the
            // SAME single-flight guard as every other trigger, so this can
            // never overlap the debounced effect's own run — it just no-ops
            // (and queues a follow-up) if one is already in flight. Failures
            // are logged, not surfaced — same "next tick retries" reasoning as
            // the unsynced-events push just above.
            try {
              await blockPushTriggerRef.current();
            } catch (blockPushErr) {
              console.warn('[useGoogleCalendarSync] Auto-push of today\'s task blocks failed; will retry next poll.', blockPushErr);
            }
            return;
          } catch (err) {
            // Confirmed auth failure — fail fast, no retry benefit, and its
            // own disconnected/reconnect messaging replaces the stale flag.
            // Covers both a live gapi 401 (isGoogleAuthError) and a confirmed
            // revoked/not-connected refresh token from the requestAccessToken
            // call above (needsReconnect) — see this function's own comment.
            if (isConfirmedGoogleAuthFailure(err)) {
              console.warn('[useGoogleCalendarSync] Auth expired during poll, disconnecting.', err);
              notifyGoogleCalendarDisconnected();
              return;
            }
            if (attempt < MAX_ATTEMPTS - 1) {
              console.warn('[useGoogleCalendarSync] Periodic poll failed, retrying once.', err);
              continue;
            }
            console.warn('[useGoogleCalendarSync] Periodic poll failed after retry', err);
            setGoogleSyncStale(true);
          }
        }
      } finally {
        googleFetchInFlightRef.current = false;
      }
    };
    pollGoogleEventsRef.current = poll;

    // 1 minute — down from an earlier 5 minutes, per explicit user request to
    // close the gap toward "instant" sync without building real push-based
    // sync (a webhook receiver Google notifies on change, which needs actual
    // backend infrastructure — see this hook's own module doc). A 1-minute
    // poll is a plain client-side interval change with no new moving parts,
    // at the cost of more Google API calls (still well within personal-use
    // quota) — see also the visibility/focus refresh below, which covers the
    // common "switched away and came back" case faster than waiting for this
    // interval to land.
    const handle = setInterval(poll, 60 * 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConnected]);

  // ---- Stale-sync escalation --------------------------------------------------
  // Every individual stale fetch (poll/on-demand/mount ladder exhausting its
  // retries) only sets googleSyncStale + a console.warn — deliberately quiet,
  // since most are a momentary network blip that clears on the next 60s tick
  // (see googleSyncStale's own doc comment). But if it DOESN'T clear, the user
  // has no way to find out short of opening Settings and noticing the "hasn't
  // synced recently" badge. This effect watches for staleness outlasting
  // STALE_SYNC_WARNING_THRESHOLD_MS and, if so, surfaces exactly one proactive
  // toast — re-armed only once the connection recovers (or is confirmed lost,
  // at which point the disconnect toast already covers it) — so a prolonged
  // outage doesn't spam a fresh toast on every subsequent poll tick.
  useEffect(() => {
    if (!googleConnected || !googleSyncStale) {
      staleSinceRef.current = null;
      staleWarningShownRef.current = false;
      return undefined;
    }
    if (staleSinceRef.current === null) staleSinceRef.current = Date.now();

    const checkEscalation = () => {
      if (staleWarningShownRef.current || staleSinceRef.current === null) return;
      if (Date.now() - staleSinceRef.current >= STALE_SYNC_WARNING_THRESHOLD_MS) {
        staleWarningShownRef.current = true;
        setNotification({
          type: 'warning',
          message: "Google Calendar hasn't synced in a while — check your connection or reconnect in Settings.",
        });
      }
    };
    checkEscalation();
    const handle = setInterval(checkEscalation, 60 * 1000);
    return () => clearInterval(handle);
  }, [googleConnected, googleSyncStale, setNotification]);

  // ---- Visibility/focus refresh ----------------------------------------------
  // Pulls immediately when the user comes back to the app — covers both
  // switching back to this browser tab (visibilitychange) and clicking back
  // into this window when it was merely unfocused rather than hidden, e.g.
  // two windows side by side (focus) — either alone can miss the other case.
  // `refreshIfDue` below calls the SAME `poll` function the periodic-poll
  // effect defines (via pollGoogleEventsRef), which now also re-runs today's
  // task-block push on every call — so this refresh is what makes day
  // rollover reliable for a tab that was backgrounded/asleep across midnight
  // and only comes back to the foreground well after the 60s poll would have
  // caught it on its own; no separate wiring needed here.
  //
  // ALSO listens for `pageshow` — neither `visibilitychange` nor `focus` is
  // guaranteed to fire at all for an iOS "Add to Home Screen" standalone PWA
  // returning from the background (a documented WebKit limitation, present in
  // every iOS browser regardless of engine skin — Firefox/Chrome for iOS are
  // WebKit under the hood and inherit it too), which left this whole refresh
  // silently unreachable on that platform: reopening the app looked like
  // "nothing happened" because none of the three events this effect relied on
  // ever fired. `pageshow` is the one event iOS reliably fires both on a
  // genuinely fresh launch AND when restoring a suspended page from the
  // back/forward cache — covering exactly the gap. Not gated on
  // `event.persisted` (which would tell "restored from bfcache" apart from
  // "fresh navigation"): a redundant refresh on a fresh load is harmless and
  // already absorbed by refreshIfDue's own throttle, so the extra branch
  // would only add complexity without changing behavior.
  useEffect(() => {
    if (!googleConnected) return undefined;

    // Short enough that "switch away for a few seconds, come back" still
    // refreshes, but still guards against a refresh storm from rapid
    // tab/window switching landing right on top of the periodic poll above.
    const REFRESH_THROTTLE_MS = 20 * 1000;
    const refreshIfDue = () => {
      if (Date.now() - lastGooglePollAtRef.current < REFRESH_THROTTLE_MS) return;
      pollGoogleEventsRef.current?.();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      refreshIfDue();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', refreshIfDue);
    window.addEventListener('pageshow', refreshIfDue);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', refreshIfDue);
      window.removeEventListener('pageshow', refreshIfDue);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConnected]);

  // ---- Connect Google Calendar ---------------------------------------------
  const connectGoogleCalendar = useCallback(async () => {
    try {
      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
      const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
      const { enabled } = await initGoogleCalendar(clientId, apiKey);
      if (!enabled) {
        setNotification({ type: 'info', message: 'Google Calendar not configured — see README for setup. Using mock events.' });
        return;
      }
      await requestAccessToken(false);
      setGoogleConnected(true);
      setGoogleNeedsReconnect(false);
      // See googleFetchInFlightRef's doc comment — guard this fetch too so it
      // can't overlap a poll/pull/rebuild that happens to land at the same
      // moment (unlikely right after connecting, but not impossible).
      if (googleFetchInFlightRef.current) {
        setNotification({ type: 'info', message: 'Connected. Already syncing with Google Calendar — events will appear shortly.' });
        return;
      }
      googleFetchInFlightRef.current = true;
      try {
        const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
        const { events: fetchedEvents, failedCalendars } = await fetchGoogleEventsTracked(rangeStartIso, rangeEndIso);
        applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
        markGoogleSyncSucceeded();
        if (failedCalendars.length > 0) {
          setNotification({
            type: 'warning',
            message: `Connected, but couldn't load events from: ${failedCalendars.join(', ')}.`,
          });
        } else {
          setNotification({ type: 'success', message: 'Google Calendar connected.' });
        }
      } finally {
        googleFetchInFlightRef.current = false;
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Google Calendar connection failed: ${reason}` });
    }
  }, [setGoogleConnected, setNotification, applyPulledEvents, markGoogleSyncSucceeded]);

  // ---- Pull from Google Calendar (manual) ----------------------------------
  const pullFromGoogleCalendar = useCallback(async () => {
    if (!googleConnected) return;
    // A user-clicked action shouldn't silently no-op if it happens to
    // overlap a background poll — surface why nothing happened instead of
    // leaving the button looking like it did nothing (see
    // googleFetchInFlightRef's doc comment for the race this prevents).
    if (googleFetchInFlightRef.current) {
      setNotification({ type: 'info', message: 'Already syncing with Google Calendar — try again in a moment.' });
      return;
    }
    googleFetchInFlightRef.current = true;
    setIsPullingGoogleEvents(true);
    try {
      const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEventsTracked(rangeStartIso, rangeEndIso);
      applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
      markGoogleSyncSucceeded();
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Pulled, but couldn't load events from: ${failedCalendars.join(', ')}.`,
        });
      } else {
        setNotification({ type: 'success', message: 'Pulled latest events from Google Calendar.' });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Pull from Google Calendar failed: ${reason}` });
    } finally {
      setIsPullingGoogleEvents(false);
      googleFetchInFlightRef.current = false;
    }
  }, [googleConnected, setNotification, applyPulledEvents, markGoogleSyncSucceeded]);

  // ---- Force a full rebuild from Google Calendar (manual, repeatable) ------
  // Unlike the one-time hardResetEventsFromGoogle pass above (which only
  // ever fires once automatically, guarded by googleEventsHardResetDone),
  // this is an explicit user action from Settings ("Rebuild from Google
  // Calendar") that ALWAYS does the full wipe-and-rebuild, no matter how
  // many times it's been run before — for exactly the case where the
  // one-time pass already consumed itself (possibly before some other sync
  // fix shipped) and stale/orphaned local events are stuck with no
  // automatic way to clear them again.
  //
  // Deliberately rebuilds only the ROUTINE 30/30 window, not the full union
  // of every range ever on-demand-fetched this session — this button is
  // meant to be a quick full-refresh/cleanup, not a mechanism for re-walking
  // every date range the user has ever scrolled the calendar to. Any
  // on-demand-fetched older/further-out events are wiped along with
  // everything else (same tradeoff this already made for purely-local manual
  // events — see this function's own doc comment above) and the synced
  // bounds reset to exactly the routine window; a subsequent calendar-view
  // scroll outside it will simply re-fetch on demand again.
  const rebuildEventsFromGoogle = useCallback(async () => {
    if (!googleConnected) return;
    // See googleFetchInFlightRef's doc comment / pullFromGoogleCalendar's
    // identical guard above.
    if (googleFetchInFlightRef.current) {
      setNotification({ type: 'info', message: 'Already syncing with Google Calendar — try again in a moment.' });
      return;
    }
    googleFetchInFlightRef.current = true;
    setIsPullingGoogleEvents(true);
    try {
      const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEventsTracked(rangeStartIso, rangeEndIso);
      setEvents((prev) =>
        hardResetEventsFromGoogle(fetchedEvents, recentlyDeletedGoogleEventIdsRef.current, recentlyDeletedGoogleEventInstancesRef.current)
      );
      googleEventsHardResetDoneRef.current = true;
      setGoogleEventsHardResetDone(true);
      const rebuiltBounds = { startIso: rangeStartIso, endIso: rangeEndIso };
      googleSyncedRangeBoundsRef.current = rebuiltBounds;
      setGoogleSyncedRangeBounds(rebuiltBounds);
      markGoogleSyncSucceeded();
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Rebuilt, but couldn't load events from: ${failedCalendars.join(', ')}.`,
        });
      } else {
        setNotification({ type: 'success', message: 'Rebuilt your calendar events from Google Calendar.' });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Rebuild from Google Calendar failed: ${reason}` });
    } finally {
      setIsPullingGoogleEvents(false);
      googleFetchInFlightRef.current = false;
    }
  }, [googleConnected, setEvents, setNotification, setGoogleEventsHardResetDone, setGoogleSyncedRangeBounds, markGoogleSyncSucceeded]);

  // ---- On-demand fetch for calendar-view navigation -------------------------
  // Called by CalendarPage (debounced) whenever the viewed date range
  // scrolls outside what's currently synced. Reuses googleFetchInFlightRef
  // rather than a second guard, so an on-demand fetch can't race a routine
  // poll/pull/connect — if one's already in flight this just no-ops; the
  // debounce upstream means rapid navigation clicks don't pile up calls
  // anyway, and the next settled navigation will trigger its own check.
  const ensureGoogleRangeSynced = useCallback(
    async (viewStartIso, viewEndIso) => {
      if (!googleConnected) return;
      if (googleFetchInFlightRef.current) return;
      // Never bother on-demand-fetching further back than the retention ceiling —
      // anything from further back than that would just get purged again on the
      // very next routine poll anyway, so fetching it at all would be wasted API
      // calls/bandwidth for data that can't stick around. Reuses computeEffectivePurgeBoundary
      // for the same "later of the two" comparison, just with `viewStartIso` in place
      // of a synced-bounds union.
      const clampedViewStartIso = computeEffectivePurgeBoundary(viewStartIso, RETENTION_DAYS_CALENDAR_EVENTS);
      const needed = computeOnDemandFetchRange(googleSyncedRangeBoundsRef.current, clampedViewStartIso, viewEndIso);
      if (!needed) return; // already fully covered by what's synced so far
      googleFetchInFlightRef.current = true;
      // Same one-extra-attempt policy as the periodic poll above, with the
      // in-flight ref held across both attempts.
      const MAX_ATTEMPTS = 2;
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          if (attempt > 0) await sleep(TRANSIENT_RETRY_DELAY_MS);
          try {
            // See the periodic poll's identical call above for why this is
            // needed: fetchGoogleEvents alone can't surface a confirmed
            // revoked/not-connected refresh token (fetchEvents() silently
            // falls back to mock data when there's no access token yet,
            // rather than throwing) — refreshing first routes that signal
            // into this catch instead.
            await requestAccessToken(true);
            const { events: fetchedEvents } = await fetchGoogleEventsTracked(needed.startIso, needed.endIso);
            applyPulledEvents(fetchedEvents, needed.startIso, needed.endIso);
            markGoogleSyncSucceeded();
            return;
          } catch (err) {
            if (isConfirmedGoogleAuthFailure(err)) {
              console.warn('[useGoogleCalendarSync] Auth expired during on-demand range fetch, disconnecting.', err);
              notifyGoogleCalendarDisconnected();
              return;
            }
            if (attempt < MAX_ATTEMPTS - 1) {
              console.warn('[useGoogleCalendarSync] On-demand range fetch failed, retrying once.', err);
              continue;
            }
            console.warn('[useGoogleCalendarSync] On-demand range fetch failed after retry', err);
            setGoogleSyncStale(true);
          }
        }
      } finally {
        googleFetchInFlightRef.current = false;
      }
    },
    [googleConnected, applyPulledEvents, setGoogleConnected, setNotification, markGoogleSyncSucceeded]
  );

  // ---- Push events to Google Calendar --------------------------------------
  // Sweeps every CalendarEvent that still lacks a googleEventId and pushes it.
  // Mirrored into pushUnsyncedItemsRef so the periodic poll above can call the
  // latest version silently on every successful tick, in addition to this
  // being the manual "Push to Google Calendar" button's own action.
  //
  // Why this sweep exists: addManualEvent/updateEvent (SchedulerContext.jsx)
  // each fire a single best-effort push at create/edit time and only log or
  // toast on failure. If that one push failed — offline, not connected yet,
  // tab closed before the fire-and-forget promise resolved — the event was
  // left with googleEventId: null and nothing ever looked at it again. It also
  // covers events RESTORED FROM A BACKUP whose stored googleEventId no longer
  // exists on Google: mergePulledGoogleEvents demotes those back to unsynced
  // (googleEventId: null, source 'manual') rather than deleting them, and this
  // sweep is what then re-creates them on Google — see
  // confirmedGoogleEventIdsRef and eventSyncService's isGoogleConfirmed.
  //
  // ScheduledBlocks are NOT part of this sweep — they have their own separate,
  // one-way, delete-all-then-recreate push (pushTodaysTasksToCalendar below),
  // which follows a fundamentally different policy (today-only, no
  // per-item retry-if-unsynced state) and must not be conflated with this
  // CalendarEvent sweep.
  //
  // `eventsOverride` lets a caller that JUST computed a fresh merged event
  // list pass it in directly instead of having this sweep re-read
  // eventsRef.current. The poll does exactly that: its applyPulledEvents call
  // is what demotes a restored-but-not-really-on-Google event back to
  // unsynced, and without the override this sweep would run against the list
  // as it stood BEFORE that demotion (see applyPulledEvents' doc comment for
  // the full render-lag explanation). Callers with no fresher list to offer
  // (the manual "Push to Google Calendar" button) omit it and get the ref.
  const pushUnsyncedItemsToCalendar = useCallback(async (eventsOverride) => {
    // Events eligible to push: never one sourced from a subscribed/foreign
    // calendar (pushing that would create a duplicate copy of someone else's
    // event on the user's own primary calendar — the same rule the rewrite's
    // authoritative set uses), and never a legacy block-mirror row left over
    // from when blocks were still pushed (see isBlockSourcedEvent).
    const toPushEvents = (eventsOverride || eventsRef.current || []).filter((e) =>
      isUnsyncedPushableEvent(e, primaryCalendarIdRef.current)
    );
    const pushedByEventId = new Map();
    // Per-item try/catch so one failure never aborts the sweep — the next tick
    // simply retries whatever is still out of sync.
    for (const event of toPushEvents) {
      try {
        const result = await pushEventToCalendar(event);
        if (result?.id) {
          pushedByEventId.set(event.id, result);
          // Google just handed us this id, so it's confirmed live even before
          // any pull echoes it back — otherwise the very next pull (which can
          // land before Google's own indexing catches up) would treat the
          // freshly-pushed event as unconfirmed and push it a second time.
          confirmedGoogleEventIdsRef.current.add(result.id);
        }
      } catch (err) {
        console.warn('[useGoogleCalendarSync] Failed to push event to Google Calendar; will retry next sync.', event.id, err);
      }
    }
    if (pushedByEventId.size > 0) {
      // Same fields addManualEvent/updateEvent stamp on their own successful
      // push, including flipping source to 'google' — a row left at 'manual'
      // after it exists on Google is permanently exempt from pull-driven
      // updates and deletion detection (see addManualEvent's own comment).
      const stampPushedIds = (list) =>
        list.map((e) => {
          const result = pushedByEventId.get(e.id);
          return result ? { ...e, googleEventId: result.id, googleUpdatedAt: result.updated, source: 'google' } : e;
        });
      setEvents((prev) => stampPushedIds(prev));
      // Mirror the stamp onto eventsRef immediately, for the same reason
      // applyPulledEvents does: this sweep is async (a push per event), so
      // another poll tick can start before React commits the update above. If
      // eventsRef still held the pre-stamp list, that tick's sweep would see
      // these events as unsynced again and push a SECOND copy of each to the
      // user's real calendar — a duplicate that survives every later sync.
      eventsRef.current = stampPushedIds(eventsRef.current || []);
    }

    // Reflects what actually succeeded, not what was attempted — a failed push
    // stays out of the total and is retried on the next tick.
    return { events: pushedByEventId.size };
  }, [setEvents]);
  pushUnsyncedItemsRef.current = pushUnsyncedItemsToCalendar;

  const pushToGoogleCalendar = useCallback(async () => {
    setIsPullingGoogleEvents(true);
    try {
      const { events: pushedEvents } = await pushUnsyncedItemsToCalendar();
      setNotification({
        type: 'success',
        message:
          pushedEvents > 0
            ? `Synced ${pushedEvents} event(s) to Google Calendar.`
            : 'Everything is already synced to Google Calendar.',
      });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: `Push to Google Calendar failed: ${err.message || err}` });
    } finally {
      setIsPullingGoogleEvents(false);
    }
  }, [pushUnsyncedItemsToCalendar, setNotification]);

  // ---- Push today's scheduled task blocks to Google Calendar ---------------
  // One-way (TaskFlow -> Google, never read back), automatic, silent — no
  // manual button, per explicit product decision. See this file's module doc
  // for why this is DELETE-ALL-THEN-RECREATE rather than the id-tracked
  // version that was removed: a block's id is re-minted on every rebalance
  // that moves it, so nothing here ever tries to match an old Google event to
  // a specific block. Every run deletes every Google event on the primary
  // calendar, for TODAY, tagged with TASKFLOW_BLOCK_PROPERTY_KEY (whether
  // created by this run's predecessor or an earlier one), then re-inserts
  // fresh from whatever `computeTodaysAuthoritativeBlocks` currently says
  // belongs there. Recomputing `todayIso` fresh on every call (rather than
  // once at mount) is also what makes day rollover work for free — see the
  // trigger effect and the visibility/poll hookups below for what actually
  // re-invokes this AFTER midnight while the tab is sitting open.
  //
  // SINGLE-FLIGHT + QUEUE-ONE-FOLLOW-UP, structurally identical to
  // useCloudSync's runPushNow/computePushSingleFlightDecision (imported
  // directly rather than re-implemented — same decision, same shape: "is a
  // push already on the wire?"). This is the ONLY trigger path for this
  // feature (the debounced effect below), but the guard still matters: the
  // effect can fire again (a fresh block change) while a previous push's
  // several batched delete/insert calls are still in flight, and without
  // this guard two concurrent delete-all-then-recreate runs could interleave
  // their phases (e.g. run B's delete phase removing events run A's insert
  // phase just created moments before, or both runs inserting their own copy
  // of the same block) — exactly the "duplicate/orphan" failure class this
  // whole feature exists to avoid. Coalescing into exactly one guaranteed
  // follow-up (rather than dropping a skipped call) is what avoids the
  // "have to trigger twice for it to stick" risk: the follow-up re-reads
  // tasksRef/blocksRef fresh, so it necessarily reflects every change made
  // while the wire was busy.
  const blockPushInFlightRef = useRef(false);
  const blockPushQueuedRef = useRef(false);
  const runBlockPushNowRef = useRef(null);
  const blockPushDebounceTimeoutRef = useRef(null);

  const runTodaysTaskBlockPushNow = useCallback(async () => {
    if (!googleConnected) return;
    const { proceed, queue } = computePushSingleFlightDecision(blockPushInFlightRef.current);
    if (!proceed) {
      if (queue) blockPushQueuedRef.current = true;
      return;
    }
    blockPushInFlightRef.current = true;
    try {
      const todayIso = toISODate(new Date());
      const authoritativeBlocks = computeTodaysAuthoritativeBlocks(blocksRef.current || [], tasksRef.current || [], todayIso);
      const { toDelete, toInsert } = await computeTodaysBlockPushPlan(authoritativeBlocks, todayIso);

      if (toDelete.length === 0 && toInsert.length === 0) return; // nothing on Google, nothing to push — common case

      // Same batched delete/insert primitives the CalendarEvent rewrite uses
      // (see runBatchesWithRetry above) — no reason to reimplement pacing/
      // retry/chunking for a second delete-all-then-recreate feature.
      await runBatchesWithRetry(toDelete, (chunk) => batchDeleteCalendarEvents(chunk), (googleEventId) => googleEventId, () => {});

      const insertEntries = toInsert
        .map(({ block, task }) => ({ id: `block:${block.id}`, resource: buildBlockEventResource(block, task) }))
        .filter((entry) => entry.resource.start?.dateTime && entry.resource.end?.dateTime);
      await runBatchesWithRetry(insertEntries, (chunk) => batchInsertCalendarEvents(chunk), (entry) => entry.id, () => {});
      // No local state to stamp: ScheduledBlocks deliberately carry no
      // googleEventId (see this file's module doc) — the next push's
      // tag-filtered fetch is what finds these again, not any id kept here.
    } catch (err) {
      // A CONFIRMED auth expiry (see computeTodaysBlockPushPlan/executeBatch's
      // own doc comments, and runBatchesWithRetry's matching check above) is
      // NOT a transient failure this feature's own silent-retry-on-next-
      // trigger design can shrug off: the in-memory access token stays dead
      // until something explicitly invalidates it, and nothing else in this
      // feature's own call path (unlike the poll/mount/on-demand fetches)
      // ever called requestAccessToken to refresh it first. Left uncaught
      // here, EVERY future trigger — the debounced effect on every later
      // edit, AND the periodic poll's own direct call — would keep hitting
      // the same dead token and silently no-op forever with nothing but a
      // console.warn, which is exactly the "stale Google Calendar entry that
      // never catches up" bug this handles: disconnect and prompt reconnect,
      // the same reaction every other fetch path in this hook already has for
      // this exact error shape.
      if (isConfirmedGoogleAuthFailure(err)) {
        console.warn('[useGoogleCalendarSync] Auth expired during today\'s task-block push, disconnecting.', err);
        notifyGoogleCalendarDisconnected();
      } else {
        // Best-effort and silent by design otherwise (no manual button, no
        // toast) — the next trigger (another block change, a poll tick, or a
        // visibility refresh) simply retries against then-current state.
        // Logged so a persistent non-auth failure is still visible in the console.
        console.warn('[useGoogleCalendarSync] Push today\'s task blocks to Google Calendar failed; will retry on next trigger.', err);
      }
    } finally {
      blockPushInFlightRef.current = false;
      if (blockPushQueuedRef.current) {
        blockPushQueuedRef.current = false;
        runBlockPushNowRef.current?.();
      }
    }
  }, [googleConnected, notifyGoogleCalendarDisconnected]);
  runBlockPushNowRef.current = runTodaysTaskBlockPushNow;
  blockPushTriggerRef.current = runTodaysTaskBlockPushNow;

  // Debounced entry point — see BLOCK_PUSH_DEBOUNCE_MS's own comment. Exposed
  // via a ref (pollGoogleEventsRef's own pattern) so the periodic poll and the
  // visibility/focus refresh below can trigger an immediate (non-debounced)
  // run for day-rollover, while the signature-watching effect below uses the
  // debounced path for ordinary same-day edits.
  const scheduleTodaysTaskBlockPush = useCallback(() => {
    if (blockPushDebounceTimeoutRef.current) clearTimeout(blockPushDebounceTimeoutRef.current);
    blockPushDebounceTimeoutRef.current = setTimeout(() => {
      blockPushDebounceTimeoutRef.current = null;
      runTodaysTaskBlockPushNow();
    }, BLOCK_PUSH_DEBOUNCE_MS);
  }, [runTodaysTaskBlockPushNow]);

  // Trigger: watches a cheap signature of "today's blocks + the task fields
  // that affect what's pushed" (see computeTodaysBlockPushSignature) instead
  // of needing to be called from every individual mutation site (rebalance,
  // completion, cloud-merge, drag-drop, manual edit all naturally change this
  // signature on their own). Recomputed on every render — cheap relative to
  // the network call it may schedule — and only actually schedules a push
  // when the signature changed, via the ref-compare below (mirrors
  // eventsSignature's own "only queue when something changed" reasoning).
  const lastBlockPushSignatureRef = useRef(null);
  useEffect(() => {
    if (!googleConnected) return;
    const todayIso = toISODate(new Date());
    const signature = computeTodaysBlockPushSignature(blocks || [], tasks || [], todayIso);
    if (signature === lastBlockPushSignatureRef.current) return;
    lastBlockPushSignatureRef.current = signature;
    scheduleTodaysTaskBlockPush();
  }, [googleConnected, blocks, tasks, scheduleTodaysTaskBlockPush]);

  // Cancel any pending debounced push the moment Google Calendar disconnects
  // (runTodaysTaskBlockPushNow's own `if (!googleConnected) return` guard
  // would otherwise still let an already-scheduled timer fire and no-op late,
  // which is harmless but pointless), and unconditionally on unmount so a
  // stray timer never fires after the component using this hook is gone.
  useEffect(() => {
    if (!googleConnected && blockPushDebounceTimeoutRef.current) {
      clearTimeout(blockPushDebounceTimeoutRef.current);
      blockPushDebounceTimeoutRef.current = null;
    }
  }, [googleConnected]);
  useEffect(() => {
    return () => {
      if (blockPushDebounceTimeoutRef.current) clearTimeout(blockPushDebounceTimeoutRef.current);
    };
  }, []);

  const [isRewritingCalendar, setIsRewritingCalendar] = useState(false);
  // { done, total } | null — live progress through the rewrite's delete+insert
  // work, surfaced by CalendarRewriteOverlay/SettingsPanel so a long-running
  // rewrite never looks indistinguishable from a hang. Both numbers count
  // individual EVENTS (the unit a user actually recognizes), but `done`
  // advances one BATCH at a time (up to MAX_BATCH_SIZE events per step) since
  // a batched call returns all its results at once with no per-item timing —
  // so the bar moves in visible jumps rather than smoothly. Reset to null once
  // the rewrite finishes (success or failure) or hasn't started.
  const [rewriteProgress, setRewriteProgress] = useState(null);

  // ---- "Rewrite Google Calendar to match TaskFlow" (explicit, opt-in) ------
  // The reverse of the app's normal sync direction: instead of Google always
  // winning (eventSyncService.js's documented policy for the routine pull),
  // this makes TaskFlow's OWN current calendar events authoritative and
  // overwrites Google's primary calendar to match. ScheduledBlocks are NOT
  // part of this — they're TaskFlow-only and have no Google Calendar presence
  // (see this file's module doc). Never runs automatically;
  // only from an explicit Settings button or the combined restore-and-
  // overwrite action (see SchedulerContext.jsx/SettingsPanel.jsx), and always
  // behind a strong confirmation the caller shows before invoking this.
  //
  // DELETE-ALL, THEN INSERT-ALL. Phase 1 deletes every event in range on the
  // primary calendar unconditionally; phase 2 re-inserts every authoritative
  // local item fresh. It does NOT diff local state against Google's and spare
  // the matches — that older design is precisely what let duplicates survive
  // (see planCalendarRewrite's own doc comment in googleCalendarService.js
  // for the full reasoning). Consequences, both accepted deliberately: an
  // event created directly in Google Calendar on the primary calendar is
  // wiped too, and every surviving event is recreated with a NEW id.
  //
  // SAFETY BOUNDARY (see googleCalendarService.js's own module doc on
  // planCalendarRewrite for the full reasoning): scoped to the PRIMARY
  // calendar only, and only to the date range the authoritative items
  // actually span — computeCalendarRewritePlan does the primary-calendar
  // filtering, so nothing here ever sees (and therefore can never touch) a
  // subscribed/shared/foreign calendar's events. That filter now carries the
  // whole boundary on its own, since no per-event protection remains.
  //
  // Reads the live `events` prop so this always reconciles against the
  // CURRENT local state at the moment it's clicked — including a backup that
  // was just restored, since applyBackupPayload sets events synchronously
  // before the chained rewrite runs.
  //
  // Both phases go through Google's BATCH endpoint (up to MAX_BATCH_SIZE
  // operations per HTTP round-trip) rather than one call per event, which is
  // what keeps a several-hundred-event rewrite to seconds instead of minutes.
  // Per-item success/failure is read back out of each batch's sub-responses
  // and accumulated into succeeded/failed, so one bad event never aborts the
  // rest — see runBatchesWithRetry above for the retry/pacing policy.
  const rewriteGoogleCalendarFromTaskflow = useCallback(async () => {
    // Unlike every other caller of googleFetchInFlightRef, a rewrite
    // DELIBERATELY TAKES OVER the guard immediately instead of bailing out
    // when a poll/pull/push is already mid-flight — it doesn't wait, and it
    // doesn't ask the in-flight work to finish first. This is safe SPECIFICALLY
    // for this function (not a precedent for the other guarded call sites,
    // which still correctly bail rather than race an in-flight fetch's
    // out-of-order-application risk — see googleFetchInFlightRef's own doc
    // comment): a rewrite is about to unconditionally delete every event on
    // the primary calendar and rebuild it fresh from TaskFlow's current
    // state, so whatever an in-flight poll was fetching/reconciling FROM
    // GOOGLE is about to be superseded regardless of how it resolves — there's
    // nothing left for it to "win" a race against. The only residual risk is
    // reading `stateRef`/`events` a moment before the interrupted poll's own
    // local-state write would have landed (e.g. its reconciliation sweep
    // stamping a freshly-pushed googleEventId) — narrow, self-correcting on
    // the very next poll tick, and preferable to leaving the user stuck
    // behind a routine sync tick they have no way to interrupt otherwise.
    //
    // pollPausedRef still matters for the rest of THIS call's own duration —
    // it actively blocks any NEW poll tick from starting until the rewrite
    // finishes, so the very next 60s tick (policy: "Google always wins")
    // can't re-pull Google's mid-rewrite state or race the rewrite's own
    // pushes once it's underway.
    googleFetchInFlightRef.current = true;
    pollPausedRef.current = true;
    // A rewrite deletes every event in range and re-inserts under fresh ids, so
    // every previously-confirmed id is about to become stale. Clearing here
    // means the set only ever holds ids the rewrite's own inserts confirm.
    confirmedGoogleEventIdsRef.current = new Set();
    setIsRewritingCalendar(true);
    try {
      // `events` arrives fresh as a prop on every render, so the closed-over
      // value here is already current. Since blocks no longer take part in the
      // rewrite at all, this is the only local state it reads.
      const latestEvents = events;

      // ScheduledBlocks are NOT part of the authoritative set — they're
      // TaskFlow-only and have no Google Calendar presence, so a rewrite never
      // creates, updates, deletes, or even reads their (vestigial)
      // googleEventId. Only CalendarEvents are rewritten.
      //
      // Events sourced from a calendar the user doesn't own (a subscribed
      // timetable, a shared calendar merely shared WITH them, etc. — i.e.
      // anything with calendarId !== 'primary') are excluded from the
      // authoritative set ENTIRELY, not just protected from delete — this
      // feature must never create a duplicate copy of someone else's event
      // on the user's primary calendar just because it's absent there. Only
      // a manual event or one already sourced from the user's OWN primary
      // calendar belongs in TaskFlow's notion of "what should be on primary".
      // Past events are frozen too — a rewrite must leave already-elapsed days
      // on Google exactly as they are (see isPastCalendarItem).
      //
      // Legacy block-mirror rows are dropped as well: those are leftovers from
      // when TaskFlow still pushed ScheduledBlocks, and re-pushing one would
      // recreate a block-shaped event this app no longer manages at all.
      //
      // A deleted-event tombstone (see utils/eventTombstones.js) is dropped
      // too, for the same reason isUnsyncedPushableEvent excludes one from the
      // ordinary push sweep: `events` here is the raw, unfiltered array (this
      // hook receives it that way, not the tombstone-hidden `visibleEvents`
      // view), so without this check a rewrite would re-create on Google the
      // exact event the user just deleted.
      const primaryEvents = latestEvents.filter(
        (e) => (e.source !== 'google' || e.calendarId === 'primary') && !isPastCalendarItem(e) && !isBlockSourcedEvent(e) && !e.deletedAt
      );

      // Every primary-scoped local event is re-pushed, including ones
      // originally pulled FROM Google (`source: 'google'`): a delete-all
      // rewrite deletes that Google copy along with everything else, so it
      // genuinely does need re-creating.
      const eventItems = primaryEvents.map((e) => ({
        kind: 'event',
        event: e,
        googleEventId: e.googleEventId,
      }));
      // Final safety net: collapse anything that would still push two
      // identical Google events (same title+date+time+recurrence). A non-empty
      // result is a smoking gun that local state itself contains genuine
      // duplicate rows, and is logged loudly as such rather than silently
      // swallowed. Cheap insurance either way: the cost of a wrong drop is one
      // missing event that the next poll re-pushes, versus a permanent
      // duplicate on the user's real calendar.
      const { items: authoritativeItems, duplicates: localDuplicates } = dedupeAuthoritativeItems(eventItems);
      if (localDuplicates.length > 0) {
        console.warn(
          `[useGoogleCalendarSync] Rewrite: local state contains ${localDuplicates.length} redundant event(s) that would have created duplicate Google events — collapsed before pushing:`,
          localDuplicates.map((d) => `event:${d.event.title} ${d.event.date} ${d.event.startTime}`)
        );
      }

      if (authoritativeItems.length === 0) {
        setNotification({ type: 'info', message: 'Nothing to rewrite — TaskFlow has no calendar events.' });
        return { succeeded: [], failed: [] };
      }

      // Date range: exactly what the authoritative items span — never a
      // wider range than that (see this feature's own safety requirements).
      const dates = authoritativeItems.map((item) => item.event.date).filter(Boolean);
      const startIso = dates.reduce((min, d) => (d < min ? d : min));
      const endIso = dates.reduce((max, d) => (d > max ? d : max));

      const { toDelete, toInsert } = await computeCalendarRewritePlan(authoritativeItems, startIso, endIso);

      const succeeded = [];
      const failed = [];
      const stampedGoogleEventIdsByEventId = new Map();

      // Live progress — see rewriteProgress's own comment. `total` counts
      // individual EVENTS (not batches), which is what's meaningful to a user
      // watching the overlay; `done` simply advances a whole batch at a time
      // once each batched call returns, since a batch gives no per-item timing
      // to report within it.
      const totalCalls = toDelete.length + toInsert.length;
      let doneCalls = 0;
      setRewriteProgress({ done: 0, total: totalCalls });
      const advanceProgress = (n) => {
        doneCalls += n;
        setRewriteProgress({ done: doneCalls, total: totalCalls });
      };

      // ---- Phase 1: delete EVERYTHING in range on the primary calendar ----
      // Unconditional — nothing is protected by matching a local
      // googleEventId anymore (see planCalendarRewrite's own doc comment for
      // why that protection was the bug). The primary-calendar scoping in
      // computeCalendarRewritePlan is the sole remaining safety boundary.
      const deleteResults = await runBatchesWithRetry(
        toDelete,
        (chunk) => batchDeleteCalendarEvents(chunk),
        (googleEventId) => googleEventId,
        advanceProgress
      );
      for (const googleEventId of toDelete) {
        const res = deleteResults.get(googleEventId);
        if (res?.ok) {
          succeeded.push({ type: 'delete', googleEventId });
        } else {
          console.warn('[useGoogleCalendarSync] Rewrite: failed to delete Google event', googleEventId, res?.error);
          failed.push({ type: 'delete', googleEventId, error: res?.error || 'Unknown error' });
        }
      }

      // ---- Phase 2: insert every authoritative local item fresh -----------
      // All inserts, never updates: phase 1 just removed everything there was
      // to update against. Each item's local id keys the batch so the fresh
      // googleEventId Google returns can be stamped back onto the right record.
      const insertEntries = toInsert
        .map(({ item }) => ({ id: `event:${item.event.id}`, source: item, resource: buildCalendarEventResource(item.event) }))
        // A non-primary event can't reach here (primaryEvents filtered them
        // out above), but an event with no date/time would build an invalid
        // resource — skip rather than send Google a malformed insert.
        .filter((entry) => entry.resource.start?.dateTime && entry.resource.end?.dateTime);

      const insertResults = await runBatchesWithRetry(
        insertEntries,
        (chunk) => batchInsertCalendarEvents(chunk.map(({ id, resource }) => ({ id, resource }))),
        (entry) => entry.id,
        advanceProgress
      );
      for (const entry of insertEntries) {
        const res = insertResults.get(entry.id);
        const { source } = entry;
        const label = source.event.title || source.event.id;
        if (res?.ok) {
          if (res.googleEventId) {
            stampedGoogleEventIdsByEventId.set(source.event.id, res.googleEventId);
            // Confirmed live the moment Google returns the id — see
            // confirmedGoogleEventIdsRef's doc comment.
            confirmedGoogleEventIdsRef.current.add(res.googleEventId);
          }
          succeeded.push({ type: 'insert', id: source.event.id });
        } else {
          console.warn('[useGoogleCalendarSync] Rewrite: failed to push local item to Google', label, res?.error);
          failed.push({ type: 'insert', label, error: res?.error || 'Unknown error' });
        }
      }
      // Anything filtered out above as unpushable still needs accounting for,
      // or the totals would silently under-report.
      if (insertEntries.length < toInsert.length) {
        advanceProgress(toInsert.length - insertEntries.length);
        for (const { item } of toInsert) {
          if (insertEntries.some((e) => e.id === `event:${item.event.id}`)) continue;
          failed.push({ type: 'insert', label: item.event.title || item.event.id, error: 'Missing or invalid start/end time' });
        }
      }

      // Re-stamp googleEventIds across local events. Under delete-all EVERY
      // pre-existing googleEventId is now stale by construction — the event
      // it pointed at was deleted in phase 1 — so this rewrites the id for
      // successfully-inserted events and CLEARS it (null) for everything else,
      // rather than only touching the successes. Leaving a stale id behind
      // would be actively harmful: the event would look "already synced", so
      // pushUnsyncedItemsToCalendar would never re-push it, and any later
      // update/delete would target an id Google no longer knows — the event
      // would silently never reappear on the calendar. Nulling it instead
      // makes the very next poll's auto-push pick it up and recreate it.
      //
      // ScheduledBlocks are untouched here: they have no Google presence, so
      // there is nothing to stamp and no commit() to make.
      //
      // Legacy block-mirror rows are DROPPED rather than re-stamped. Their
      // Google copies were deleted in phase 1 and deliberately not re-created
      // (blocks are no longer pushed at all), so keeping them would leave
      // phantom local rows pointing at nothing.
      //
      // A non-primary (subscribed/foreign) event was never part of the
      // rewrite at all — its Google copy still exists untouched, so it's
      // returned completely unmodified.
      setEvents((prev) =>
        prev
          .filter((e) => !((e.source !== 'google' || e.calendarId === 'primary') && isBlockSourcedEvent(e)))
          .map((e) => {
            if (e.source === 'google' && e.calendarId !== 'primary') return e;
            // Past events were excluded from the rewrite, so their Google
            // copies survive untouched and their ids stay valid — same
            // reasoning as updatedBlocks above.
            if (isPastCalendarItem(e)) return e;
            const fresh = stampedGoogleEventIdsByEventId.get(e.id) ?? null;
            return e.googleEventId === fresh ? e : { ...e, googleEventId: fresh };
          })
      );

      const deletedCount = succeeded.filter((s) => s.type === 'delete').length;
      const insertedCount = succeeded.filter((s) => s.type === 'insert').length;
      if (failed.length === 0) {
        setNotification({
          type: 'success',
          message: `Rewrote Google Calendar: ${deletedCount} deleted, ${insertedCount} created.`,
        });
      } else {
        setNotification({
          type: 'warning',
          message: `Rewrote Google Calendar with some failures: ${deletedCount} deleted, ${insertedCount} created, ${failed.length} failed — see console for details.`,
        });
      }
      return { succeeded, failed };
    } catch (err) {
      // A confirmed auth expiry now propagates up through runBatchesWithRetry
      // (see its own doc comment) instead of being absorbed into a pile of
      // generic per-item failures — react to it the same way every other
      // fetch path in this hook does: invalidate the connection and prompt
      // reconnect, rather than just a generic error toast the user has no
      // clear next step for.
      if (isConfirmedGoogleAuthFailure(err)) {
        console.warn('[useGoogleCalendarSync] Auth expired during rewrite, disconnecting.', err);
        notifyGoogleCalendarDisconnected();
        return { succeeded: [], failed: [{ type: 'fatal', error: err?.message || String(err) }] };
      }
      console.error('[useGoogleCalendarSync] Rewrite Google Calendar failed', err);
      setNotification({ type: 'error', message: `Rewrite Google Calendar failed: ${err.message || err}` });
      return { succeeded: [], failed: [{ type: 'fatal', error: err?.message || String(err) }] };
    } finally {
      setIsRewritingCalendar(false);
      setRewriteProgress(null);
      pollPausedRef.current = false;
      googleFetchInFlightRef.current = false;
    }
  }, [events, setEvents, setNotification, notifyGoogleCalendarDisconnected]);

  // ---- Disconnect Google Calendar (user-initiated) -------------------------
  const disconnectGoogleCalendar = useCallback(async () => {
    try {
      await disconnectGoogleCalendarService();
    } catch (err) {
      console.error(err);
      // Still treat the app as disconnected even if revoking server-side
      // failed (e.g. Worker unreachable) — see disconnectGoogleCalendar's own
      // finally-block for why the local token state is cleared regardless.
    } finally {
      setGoogleConnected(false);
      setGoogleNeedsReconnect(false);
      // Deliberately disconnected — a leftover "hasn't synced recently"
      // warning about a connection the user just removed would be nonsense.
      setGoogleSyncStale(false);
      setNotification({ type: 'success', message: 'Disconnected Google Calendar.' });
    }
  }, [setGoogleConnected, setNotification]);

  return {
    googleConnected,
    setGoogleConnected,
    googleNeedsReconnect,
    googleSyncStale,
    lastGoogleSyncAt,
    isPullingGoogleEvents,
    connectGoogleCalendar,
    pullFromGoogleCalendar,
    pushToGoogleCalendar,
    rebuildEventsFromGoogle,
    disconnectGoogleCalendar,
    ensureGoogleRangeSynced,
    markGoogleEventDeleted,
    unmarkGoogleEventDeleted,
    markGoogleEventInstanceDeleted,
    unmarkGoogleEventInstanceDeleted,
    isRewritingCalendar,
    rewriteProgress,
    rewriteGoogleCalendarFromTaskflow,
  };
}

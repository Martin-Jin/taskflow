/**
 * ============================================================================
 * useGoogleCalendarSync
 * ============================================================================
 * Extracted from SchedulerContext.jsx to reduce that file's size (~2000 lines).
 * Owns all Google Calendar connection state, silent re-auth, periodic polling,
 * visibility-change refresh, and event push/patch/delete orchestration.
 *
 * Returns the Google-specific state and callbacks that SchedulerContext merges
 * into its own context value — nothing here talks to Firestore or manages
 * non-Google state.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedState } from './usePersistedState';
import { toISODate, addDays, timeToMinutes, minutesToTime, isPast } from '../utils/dateUtils';
import { RETENTION_DAYS_CALENDAR_EVENTS } from '../services/dataRetention';
import { resolveEventId, truncateRuleUntil, rebaseRuleForSplit } from '../utils/recurrenceExpansion';
import {
  fetchEvents as fetchGoogleEvents,
  pushBlockToCalendar,
  pushEventToCalendar,
  deleteCalendarEvent,
  pushEventInstanceUpdate,
  deleteCalendarEventInstance,
  initGoogleCalendar,
  requestAccessToken,
  disconnectGoogleCalendar as disconnectGoogleCalendarService,
  shouldTreatAsReconnectNeeded,
  computeCalendarRewritePlan,
  isRateLimitError,
  chunkForBatch,
  batchDeleteCalendarEvents,
  batchInsertCalendarEvents,
  buildBlockEventResource,
  buildCalendarEventResource,
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
 *   - block-mirror rows (see isBlockSourcedEvent): the ScheduledBlock is what
 *     gets pushed for those; pushing the mirror too would create a duplicate.
 *   - anything without a date/start/end, which can't build a valid resource.
 *   - anything already in the PAST (see isPastCalendarItem): once a day is
 *     over, TaskFlow stops writing it to Google at all — history is frozen,
 *     not part of the live sync loop.
 *
 * Pure and exported so the "which events are still unsynced" decision — the
 * gap that let a failed one-shot push strand an event forever — is unit
 * testable without driving the hook.
 */
export function isUnsyncedPushableEvent(event) {
  if (!event || event.googleEventId) return false;
  if (event.source === 'google' && event.calendarId !== 'primary') return false;
  if (isBlockSourcedEvent(event)) return false;
  if (isPastCalendarItem(event)) return false;
  return !!(event.date && event.startTime && event.endTime);
}

/**
 * The scheduling-relevant signature of a block as it exists on Google — the
 * exact fields pushBlockToCalendar writes into the event resource. If this
 * changes, the Google event is stale and needs an update pushed.
 *
 * `title` is included because pushBlockToCalendar writes it into the event's
 * summary, so renaming a task must also refresh Google — but nothing else
 * from the task (notes/priority) is, since those only affect
 * description/colour and aren't worth a re-push storm on every minor edit.
 */
export function blockSyncSignature(block, task) {
  return [block.date, block.startTime, block.endTime, task?.title || ''].join('|');
}

/**
 * Absolute minutes since epoch-ish for a `YYYY-MM-DD` + `HH:MM` pair — a
 * single comparable scalar for "how far apart are these two placements". Only
 * used for relative distance, so the arbitrary date origin doesn't matter.
 * Returns null when either part is missing/malformed, which callers read as
 * "no usable placement to measure against".
 */
function placementMinutes(dateIso, startTime) {
  if (typeof dateIso !== 'string' || typeof startTime !== 'string') return null;
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hh, mm] = startTime.split(':').map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 60000) + hh * 60 + mm;
}

/**
 * The placement a sync record was last pushed at, recovered from the record's
 * own signature (`date|startTime|endTime|title`, see blockSyncSignature) and
 * falling back to the block id it's filed under (`blk_${taskId}_${date}_
 * ${startTime}`, see allocator.js) for legacy records written before
 * signatures were stored in this shape.
 */
function recordPlacementMinutes(blockId, signature) {
  if (typeof signature === 'string') {
    const [date, startTime] = signature.split('|');
    const fromSignature = placementMinutes(date, startTime);
    if (fromSignature !== null) return fromSignature;
  }
  if (typeof blockId === 'string' && blockId.startsWith('blk_')) {
    const parts = blockId.split('_');
    // blk_<taskId>_<date>_<startTime>
    const fromId = placementMinutes(parts[2], parts[3]);
    if (fromId !== null) return fromId;
  }
  return null;
}

/**
 * Pairs each rebalance-relocated block with the orphaned sync record it most
 * likely came from, for ONE task's worth of blocks and records.
 *
 * Why this can't just be "first unclaimed record wins": a recurring task
 * (Piano, a weekly review) typically has several blocks relocated in the SAME
 * rebalance, and the records are keyed by a block id that no longer exists,
 * iterated in whatever order the persisted JSON object happens to hold. So
 * first-available matching would hand Monday's new block whichever record came
 * out of the object first — quite possibly Thursday's. The consequences are
 * both visible on the user's real calendar: Thursday's Google event gets MOVED
 * onto Monday's slot, and Thursday's own new block finds no record left, falls
 * through to `toCreate`, and inserts a brand-new duplicate event. That is the
 * "overlapping chips at the same time slot right after rescheduling" symptom.
 *
 * Matching by nearest placement instead makes the pairing deterministic and
 * intuitively correct: a rebalance nudges a block by hours, not weeks, so the
 * record closest in date/time to a block's new placement is overwhelmingly the
 * one that block actually came from. Ties (and records with no recoverable
 * placement) fall back to a stable ordering so the result never depends on
 * object iteration order.
 *
 * Greedy over globally-sorted (block, record) pairs — with at most a handful
 * of blocks per task this is well under the complexity a proper assignment
 * algorithm would justify, and it produces the same answer for every realistic
 * case (see the unit tests' multi-block relocation scenarios).
 *
 * @returns {Map<string, string>} new block id -> orphaned record's block id
 */
function assignOrphanedRecords(blocksNeedingRecord, orphanRecords) {
  const pairs = [];
  for (const block of blocksNeedingRecord) {
    const blockAt = placementMinutes(block.date, block.startTime);
    for (const record of orphanRecords) {
      const recordAt = recordPlacementMinutes(record.blockId, record.signature);
      pairs.push({
        blockId: block.id,
        recordBlockId: record.blockId,
        // Unmeasurable placement on either side sorts last (Infinity) but is
        // still eligible — a legacy record with no recoverable placement must
        // remain claimable, or its block would duplicate rather than move.
        distance: blockAt === null || recordAt === null ? Infinity : Math.abs(blockAt - recordAt),
      });
    }
  }

  // Stable tiebreak on ids so equidistant candidates resolve identically on
  // every device and every run, rather than by insertion order.
  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0) ||
      (a.recordBlockId < b.recordBlockId ? -1 : a.recordBlockId > b.recordBlockId ? 1 : 0)
  );

  const assignment = new Map();
  const claimedRecords = new Set();
  for (const pair of pairs) {
    if (assignment.has(pair.blockId) || claimedRecords.has(pair.recordBlockId)) continue;
    assignment.set(pair.blockId, pair.recordBlockId);
    claimedRecords.add(pair.recordBlockId);
  }
  return assignment;
}

/**
 * Decides what the ongoing (non-rewrite) reconciliation sweep must send to
 * Google so the calendar keeps matching TaskFlow during ORDINARY use — the
 * everyday counterpart to the one-off "Rewrite Google Calendar" action.
 *
 * The gap this closes: `pushBlockToCalendar` used to be called from exactly
 * one place, and only for blocks with NO googleEventId. So a block that was
 * already synced and then MOVED — by a drag/resize in WeekView, an edit in
 * BlockDetailModal, or a rebalance re-placing it — kept its googleEventId,
 * looked "already synced", and was never pushed again. Its Google event just
 * stayed behind at the old time, permanently. And a block that disappeared
 * (deleteBlock, or a rebalance dropping/relocating it) left its Google event
 * orphaned with nothing referencing it, so nothing could ever clean it up.
 *
 * Relocation is the worst case, because a block's id encodes its placement
 * (`blk_${taskId}_${date}_${startTime}`, see allocator.js). A rebalance that
 * moves a block mints a NEW id, so `preserveGoogleEventIds`' exact-id match
 * finds no predecessor and the googleEventId is not carried over: the new
 * block looks unsynced (push -> a fresh duplicate event) while the old
 * Google event is orphaned. That is one duplicate plus one orphan per moved
 * recurring block, accumulating silently on every rebalance — which no
 * amount of fixing the rewrite button prevents, since it happens between
 * rewrites.
 *
 * Matching is therefore by `lastSyncedById` (a persisted record of what each
 * block was last pushed as) rather than by block identity alone, so a block
 * that changed id but is still the same underlying work is recognized as a
 * MOVE (update the existing Google event in place) rather than as a
 * delete + create pair.
 *
 * Blocks (and sync records) whose day has already passed are excluded from all
 * three lists — see isPastCalendarItem for why past items are frozen.
 *
 * @param {Array} blocks - current ScheduledBlocks
 * @param {Array} tasks - current tasks (for titles / orphan detection)
 * @param {Object<string, {googleEventId: string, signature: string}>} lastSyncedById
 *   - what each block id was last successfully pushed as
 * @returns {{ toCreate: Array, toUpdate: Array, toDelete: Array }}
 */
export function planOngoingCalendarSync(blocks, tasks, lastSyncedById = {}) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const toCreate = [];
  const toUpdate = [];

  // googleEventIds still claimed by a live block — anything in the synced
  // record but absent here is an orphan whose block is gone.
  const liveGoogleEventIds = new Set();

  // Records whose block id no longer exists, grouped by taskId. A rebalance
  // that relocates a block mints a NEW id (the id encodes the placement), so
  // the record filed under the OLD id is the only remaining pointer to that
  // block's Google event. Without this, a relocated block would look brand
  // new (create a duplicate) while its original event became an orphan
  // (deleted, then recreated) — a delete+create churn on every rebalance
  // instead of a single in-place move. Keyed by task since that is what
  // survives the re-mint.
  const liveBlockIds = new Set(blocks.map((b) => b.id));
  const orphanedRecordsByTask = new Map();
  for (const [blockId, record] of Object.entries(lastSyncedById)) {
    if (!record?.googleEventId || liveBlockIds.has(blockId)) continue;
    // The block id embeds its taskId (`blk_${taskId}_...`, see allocator.js);
    // fall back to the record's own taskId when present.
    const taskId = record.taskId || (blockId.startsWith('blk_') ? blockId.split('_')[1] : null);
    if (!taskId) continue;
    if (!orphanedRecordsByTask.has(taskId)) orphanedRecordsByTask.set(taskId, []);
    orphanedRecordsByTask.get(taskId).push({ blockId, ...record });
  }

  // Which blocks actually need an orphaned record, grouped by task — computed
  // in a FIRST pass over all blocks so the pairing below can consider every
  // competing block at once. Matching one block at a time (first unclaimed
  // record wins) let an early block claim a later block's record purely by
  // iteration order — see assignOrphanedRecords for why that manufactured
  // both misplaced and duplicate Google events.
  const blocksNeedingRecordByTask = new Map();
  for (const block of blocks) {
    if (!taskById.has(block.taskId)) continue;
    if (block.googleEventId || lastSyncedById[block.id]?.googleEventId) continue;
    if (!orphanedRecordsByTask.has(block.taskId)) continue;
    if (!blocksNeedingRecordByTask.has(block.taskId)) blocksNeedingRecordByTask.set(block.taskId, []);
    blocksNeedingRecordByTask.get(block.taskId).push(block);
  }
  const inheritedRecordByBlockId = new Map();
  for (const [taskId, needy] of blocksNeedingRecordByTask) {
    const assignment = assignOrphanedRecords(needy, orphanedRecordsByTask.get(taskId));
    for (const [blockId, recordBlockId] of assignment) inheritedRecordByBlockId.set(blockId, recordBlockId);
  }
  const orphanRecordByBlockId = new Map();
  for (const records of orphanedRecordsByTask.values()) {
    for (const record of records) orphanRecordByBlockId.set(record.blockId, record);
  }

  for (const block of blocks) {
    const task = taskById.get(block.taskId);
    if (!task) continue; // orphaned block; the task-delete path handles its Google cleanup

    // A block whose day is over is frozen — never created, moved, or deleted on
    // Google (see isPastCalendarItem). Its googleEventId still counts as live so
    // the orphan pass below doesn't delete the event it points at.
    if (isPastCalendarItem(block)) {
      const pastId = block.googleEventId || lastSyncedById[block.id]?.googleEventId;
      if (pastId) liveGoogleEventIds.add(pastId);
      continue;
    }

    const signature = blockSyncSignature(block, task);

    // Prefer the block's own googleEventId, then whatever this block id was
    // last synced as, then — for a block a rebalance just re-minted under a
    // new id — the orphaned record it was paired with above.
    const record = lastSyncedById[block.id];
    let googleEventId = block.googleEventId || record?.googleEventId || null;
    let inheritedFromBlockId = null;
    if (!googleEventId) {
      const inheritedBlockId = inheritedRecordByBlockId.get(block.id);
      const inherited = inheritedBlockId ? orphanRecordByBlockId.get(inheritedBlockId) : null;
      if (inherited) {
        googleEventId = inherited.googleEventId;
        inheritedFromBlockId = inherited.blockId;
      }
    }

    if (!googleEventId) {
      toCreate.push({ block, task, signature });
      continue;
    }
    liveGoogleEventIds.add(googleEventId);
    // Unchanged since its last successful push -> nothing to send. Without a
    // record (e.g. synced by an older build) assume it needs refreshing once,
    // which is idempotent: an update writes the same values it already has.
    if (record && record.signature === signature) continue;
    toUpdate.push({ block, task, googleEventId, signature, inheritedFromBlockId });
  }

  // Orphans: previously-synced Google events no live block claims anymore.
  // Deleting these is what stops stale events piling up after every
  // deleteBlock / rebalance drop.
  const toDelete = [];
  const seenForDelete = new Set();
  for (const [blockId, record] of Object.entries(lastSyncedById)) {
    if (!record?.googleEventId) continue;
    if (liveGoogleEventIds.has(record.googleEventId)) continue;
    if (seenForDelete.has(record.googleEventId)) continue;
    // The record describes a placement whose day is already over — leave the
    // Google event alone (see isPastCalendarItem). Deleting a block in TaskFlow
    // today must not erase yesterday's calendar history.
    const recordedDate = (record.signature || '').split('|')[0];
    if (recordedDate && isPast(recordedDate)) continue;
    seenForDelete.add(record.googleEventId);
    toDelete.push({ blockId, googleEventId: record.googleEventId });
  }

  return { toCreate, toUpdate, toDelete };
}

/**
 * Collapses authoritative rewrite items that would create INDISTINGUISHABLE
 * Google events — same kind, title, date, start/end time and recurrence rule.
 * The first occurrence of each signature wins; the rest are dropped.
 *
 * This is a defence-in-depth backstop for the rewrite's push phase, not the
 * primary fix. The real duplicate source was structural (every block's own
 * Google mirror event being pushed alongside the block — see
 * isBlockSourcedEvent and the mirror filter in
 * rewriteGoogleCalendarFromTaskflow), and that's handled upstream. But the
 * push phase is the one place in the app that can mint permanent duplicates
 * on a user's real calendar, and a duplicate that reaches Google survives
 * every subsequent sync; so it's worth one cheap O(n) pass to guarantee no
 * single rewrite run can ever insert the same event twice, whatever new way
 * local state finds to disagree with itself.
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
  const signatureOf = (item) => {
    if (item.kind === 'block') {
      const { block, task } = item;
      return ['block', task?.title || '', block.date, block.startTime, block.endTime].join('|');
    }
    const { event } = item;
    return ['event', event.title || '', event.date, event.startTime, event.endTime, event.recurrenceRule || ''].join('|');
  };

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
      // The whole batch call failed (network/auth, or a 429 that survived the
      // retry above) — mark every item in it as failed so the per-item
      // success/failure totals stay accurate rather than silently dropping
      // this chunk.
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
 * @param {Function} deps.setNotification - Toast notification setter
 * @param {Array} deps.blocks - Current scheduled blocks
 * @param {Array} deps.tasks - Current tasks
 * @param {Function} deps.commit - useHistoryState's commit
 * @param {React.MutableRefObject} deps.stateRef - Ref to latest state
 * @param {Function} deps.pushActionToast - Queues a toast with undo support
 * @returns {Object} Google Calendar state and callbacks
 */
export function useGoogleCalendarSync({
  events,
  setEvents,
  setNotification,
  blocks,
  tasks,
  commit,
  stateRef,
  pushActionToast,
  authLoading,
  onEventsChanged,
}) {
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  const [isPullingGoogleEvents, setIsPullingGoogleEvents] = useState(false);

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

  // blockId -> { googleEventId, signature } for every block this device has
  // successfully pushed — the memory that makes ongoing reconciliation
  // possible (see planOngoingCalendarSync). Without it the sweep can't tell
  // "already correct on Google" from "moved since it was pushed", and can't
  // recognize a Google event whose block has since been deleted or re-minted
  // under a new id.
  //
  // Persisted rather than session-only: a rebalance/drag can happen in one
  // session and the next sync tick land in another, and a forgotten record
  // means a permanently orphaned Google event nothing can clean up.
  // Deliberately device-local (not in BACKUP_FIELDS/cloud sync): it describes
  // what THIS device has pushed, and each device's own sweep converges on the
  // same Google state independently — mirroring it across devices would just
  // let a stale snapshot issue deletes for events another device had legitimately
  // just re-created.
  const [lastSyncedBlocks, setLastSyncedBlocks] = usePersistedState('googleLastSyncedBlocks', {});
  const lastSyncedBlocksRef = useRef(lastSyncedBlocks);
  useEffect(() => {
    lastSyncedBlocksRef.current = lastSyncedBlocks;
  }, [lastSyncedBlocks]);

  // Populated below (near "Push blocks to Google Calendar") with a function
  // that pushes every block AND event lacking a googleEventId — kept in a
  // ref, same reasoning as pollGoogleEventsRef, so the periodic-poll effect
  // (which only depends on googleConnected) can call the latest version
  // without needing to be redefined whenever state changes. Safe to call
  // automatically because SchedulerContext's runRebalance now carries a
  // block's googleEventId forward across rebalance runs whenever its id is
  // unchanged (see that function's own comment) — without that, every
  // rebalance would make already-synced blocks look brand new and this would
  // create a duplicate Google Calendar event on every poll tick.
  const pushUnsyncedItemsRef = useRef(async () => ({ blocks: 0, events: 0 }));

  // googleEventId -> timestamp this app instance issued a delete for it.
  // Consulted (and pruned of expired entries) by every mergePulledGoogleEvents
  // call below so a poll/pull that lands before Google's own delete has
  // propagated can't resurrect an event we just deleted (see
  // eventSyncService.mergePulledGoogleEvents and SchedulerContext.deleteEvent).
  const recentlyDeletedGoogleEventIdsRef = useRef(new Map());

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
  // merge. Returns whether this call was the reset pass, so callers can let
  // the user know their calendar was just wiped and rebuilt.
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
      eventsChangedRef.current = false;
      setEvents((prev) => {
        const next = didHardReset
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
        // Most poll ticks pull back the exact same events unchanged — only
        // worth queuing an auto-rebalance when the merge actually altered
        // something a task's scheduled block could conflict with (an event
        // added/removed/moved in time), not on every 60s poll or tab-focus
        // refresh regardless of whether anything changed. See
        // eventsSignature's own doc comment for what counts as "changed".
        if (eventsSignature(prev) !== eventsSignature(next)) eventsChangedRef.current = true;
        return next;
      });
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
      return didHardReset;
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
            const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
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
              setGoogleConnected(false);
              setGoogleNeedsReconnect(true);
              setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
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
            const { events: fetchedEvents } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
            applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
            markGoogleSyncSucceeded();
            // Also push anything unsynced since the last tick — blocks
            // scheduled with no googleEventId yet, AND events whose one-shot
            // push at create/edit time failed (see
            // pushUnsyncedItemsToCalendar's doc comment; the other push sites
            // are the manual "Push to Google Calendar" button and
            // addManualEvent/updateEvent's own immediate pushes, none of
            // which retry). Without this, a task auto-scheduled by Re-balance
            // (including one created via AI quick-add) or manually scheduled
            // via scheduleTaskAt would never reach Google Calendar until the
            // user opened Settings and clicked that button — and an event
            // whose push failed would never reach it at all. Failures here
            // are non-fatal to the poll itself — the next tick just retries
            // whatever is still unsynced, so they're logged rather than
            // flagged stale/disconnected.
            try {
              await pushUnsyncedItemsRef.current();
            } catch (pushErr) {
              console.warn('[useGoogleCalendarSync] Auto-push of unsynced blocks failed; will retry next poll.', pushErr);
            }
            return;
          } catch (err) {
            // Confirmed auth failure — fail fast, no retry benefit, and its
            // own disconnected/reconnect messaging replaces the stale flag.
            // Covers both a live gapi 401 (isGoogleAuthError) and a confirmed
            // revoked/not-connected refresh token from the requestAccessToken
            // call above (needsReconnect) — see this function's own comment.
            if (err?.isGoogleAuthError || shouldTreatAsReconnectNeeded(err)) {
              console.warn('[useGoogleCalendarSync] Auth expired during poll, disconnecting.', err);
              setGoogleConnected(false);
              setGoogleNeedsReconnect(true);
              setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
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
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', refreshIfDue);
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
        const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
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
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
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
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
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
            const { events: fetchedEvents } = await fetchGoogleEvents(needed.startIso, needed.endIso);
            applyPulledEvents(fetchedEvents, needed.startIso, needed.endIso);
            markGoogleSyncSucceeded();
            return;
          } catch (err) {
            if (err?.isGoogleAuthError || shouldTreatAsReconnectNeeded(err)) {
              console.warn('[useGoogleCalendarSync] Auth expired during on-demand range fetch, disconnecting.', err);
              setGoogleConnected(false);
              setGoogleNeedsReconnect(true);
              setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
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

  // ---- Push blocks and events to Google Calendar ---------------------------
  // Pushes every block that doesn't yet have a googleEventId, i.e. every
  // block scheduled since the last push, regardless of how it was created
  // (manual scheduleTaskAt, a Re-balance placing a newly-added task, or an AI
  // quick-add task that got auto-scheduled) — none of those creation sites
  // push individually, unlike addManualEvent's immediate push for a directly-
  // created calendar event. Mirrored into pushUnsyncedItemsRef so the
  // periodic poll below can call the latest version silently on every
  // successful tick (see that effect), in addition to this being the
  // manual "Push to Google Calendar" button's own action. Reads live
  // tasks/blocks off stateRef rather than the closed-over values so neither
  // call site ever pushes against stale block data.
  //
  // Relies on runRebalance (SchedulerContext.jsx) carrying a block's
  // googleEventId forward across rebalance runs whenever its id survives
  // unchanged — otherwise every block a rebalance merely re-confirmed in
  // place (not a genuinely new placement) would look unsynced here and get
  // pushed again as a duplicate Google Calendar event on every poll tick.
  //
  // It also sweeps unsynced EVENTS, not just blocks. Events used to have no
  // retry path at all: addManualEvent/updateEvent (SchedulerContext.jsx) each
  // fire a single best-effort push at create/edit time and only log or toast
  // on failure. If that one push failed — offline, not connected yet, tab
  // closed before the fire-and-forget promise resolved — the event was left
  // with googleEventId: null and nothing ever looked at it again, so it never
  // reached Google no matter how many times the app synced afterward. Blocks
  // were swept on every poll tick; events simply weren't. Sweeping both here
  // makes the retry behavior symmetric, and is why this returns per-kind
  // counts rather than a single number.
  const pushUnsyncedItemsToCalendar = useCallback(async () => {
    const latestTasks = stateRef.current.tasks;
    const latestBlocks = stateRef.current.blocks;

    // Full reconciliation, not just "push what has no id yet" — creates,
    // UPDATES for blocks that moved since their last push, and DELETES for
    // Google events whose block is gone. See planOngoingCalendarSync for why
    // each of those three is required to stop drift accumulating.
    const syncRecord = { ...(lastSyncedBlocksRef.current || {}) };
    const { toCreate, toUpdate, toDelete } = planOngoingCalendarSync(latestBlocks, latestTasks, syncRecord);

    const pushedEventIdsByBlockId = new Map();
    // Per-item try/catch throughout so one failure never aborts the sweep —
    // the next tick simply retries whatever is still out of sync.
    for (const { block, task, signature } of toCreate) {
      try {
        const eventId = await pushBlockToCalendar(block, task);
        if (eventId) {
          pushedEventIdsByBlockId.set(block.id, eventId);
          syncRecord[block.id] = { googleEventId: eventId, signature, taskId: block.taskId };
        }
      } catch (err) {
        console.warn('[useGoogleCalendarSync] Failed to push block to Google Calendar; will retry next sync.', block.id, err);
      }
    }

    for (const { block, task, googleEventId, signature, inheritedFromBlockId } of toUpdate) {
      try {
        // Passing the googleEventId makes pushBlockToCalendar issue an
        // `update` against the existing event rather than creating a second
        // one — this is what moves the Google event instead of duplicating it.
        const resultId = await pushBlockToCalendar({ ...block, googleEventId }, task);
        const effectiveId = resultId || googleEventId;
        // A relocated block has a different id than the one that was synced,
        // so re-stamp it onto the block and retire the record filed under the
        // old id — otherwise that entry would look like an orphan next tick
        // and this event would be deleted right after being moved.
        if (block.googleEventId !== effectiveId) pushedEventIdsByBlockId.set(block.id, effectiveId);
        if (inheritedFromBlockId) delete syncRecord[inheritedFromBlockId];
        syncRecord[block.id] = { googleEventId: effectiveId, signature, taskId: block.taskId };
      } catch (err) {
        console.warn('[useGoogleCalendarSync] Failed to update moved block on Google Calendar; will retry next sync.', block.id, err);
      }
    }

    for (const { blockId, googleEventId } of toDelete) {
      try {
        // Suppress the pull that would otherwise race this delete and
        // resurrect the event locally — same guard deleteEvent/task-delete use.
        markGoogleEventDeleted(googleEventId);
        await deleteCalendarEvent(googleEventId, 'primary');
        delete syncRecord[blockId];
      } catch (err) {
        unmarkGoogleEventDeleted(googleEventId);
        console.warn('[useGoogleCalendarSync] Failed to delete orphaned block event from Google Calendar; will retry next sync.', googleEventId, err);
      }
    }

    // Drop records for block ids that no longer exist, so the record can't
    // grow without bound as blocks are re-minted across rebalances.
    //
    // Pruned against the blocks live NOW (re-read at commit time), not the
    // snapshot this sweep started from: the awaits above take real time, and a
    // rebalance landing mid-sweep re-mints block ids. Pruning against the stale
    // snapshot would delete the record for a block that still exists under its
    // new id, so the next tick would see no record and no googleEventId and
    // CREATE a duplicate instead of moving the existing event — the same class
    // of duplicate this whole sync record exists to prevent. Records written by
    // this sweep are kept regardless, since their Google events definitely
    // exist and dropping them would strand those events as un-cleanable orphans.
    const liveBlockIds = new Set((stateRef.current.blocks || []).map((b) => b.id));
    const writtenThisSweep = new Set([...pushedEventIdsByBlockId.keys(), ...toCreate.map(({ block }) => block.id), ...toUpdate.map(({ block }) => block.id)]);
    for (const blockId of Object.keys(syncRecord)) {
      if (!liveBlockIds.has(blockId) && !writtenThisSweep.has(blockId)) delete syncRecord[blockId];
    }
    lastSyncedBlocksRef.current = syncRecord;
    setLastSyncedBlocks(syncRecord);

    if (pushedEventIdsByBlockId.size > 0) {
      const updated = stateRef.current.blocks.map((b) =>
        pushedEventIdsByBlockId.has(b.id) ? { ...b, googleEventId: pushedEventIdsByBlockId.get(b.id) } : b
      );
      commit({ tasks: stateRef.current.tasks, blocks: updated }, `Pushed ${pushedEventIdsByBlockId.size} block(s) to Google Calendar`);
    }

    // Events eligible to push: never one sourced from a subscribed/foreign
    // calendar (pushing that would create a duplicate copy of someone else's
    // event on the user's own primary calendar — the same rule the rewrite's
    // authoritative set uses), and never a block-mirror row (the block itself
    // is what gets pushed — see isBlockSourcedEvent).
    const toPushEvents = (eventsRef.current || []).filter(isUnsyncedPushableEvent);
    const pushedByEventId = new Map();
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
      setEvents((prev) =>
        prev.map((e) => {
          const result = pushedByEventId.get(e.id);
          return result ? { ...e, googleEventId: result.id, googleUpdatedAt: result.updated, source: 'google' } : e;
        })
      );
    }

    // Counts reflect what actually succeeded (the sync record is only written
    // on success), not what was attempted — a failed item stays out of the
    // totals and is retried on the next tick.
    const createdCount = toCreate.filter(({ block }) => syncRecord[block.id]).length;
    const updatedCount = toUpdate.filter(({ block, signature }) => syncRecord[block.id]?.signature === signature).length;
    const deletedCount = toDelete.filter(({ blockId }) => !syncRecord[blockId]).length;
    return { blocks: createdCount, events: pushedByEventId.size, updated: updatedCount, deleted: deletedCount };
  }, [stateRef, commit, setEvents, setLastSyncedBlocks, markGoogleEventDeleted, unmarkGoogleEventDeleted]);
  pushUnsyncedItemsRef.current = pushUnsyncedItemsToCalendar;

  const pushToGoogleCalendar = useCallback(async () => {
    setIsPullingGoogleEvents(true);
    try {
      const { blocks: pushedBlocks, events: pushedEvents, updated, deleted } = await pushUnsyncedItemsToCalendar();
      // Name only what actually happened, so the message never claims
      // "block(s)" for a run that only pushed events (or vice versa). Updates
      // and cleanups are reported too — those are the ongoing reconciliation
      // steps that keep Google matching TaskFlow between rewrites.
      const parts = [];
      if (pushedBlocks > 0) parts.push(`${pushedBlocks} block(s)`);
      if (pushedEvents > 0) parts.push(`${pushedEvents} event(s)`);
      if (updated > 0) parts.push(`${updated} moved`);
      if (deleted > 0) parts.push(`${deleted} removed`);
      setNotification({
        type: 'success',
        message: parts.length > 0 ? `Synced ${parts.join(', ')} to Google Calendar.` : 'Everything is already synced to Google Calendar.',
      });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: `Push to Google Calendar failed: ${err.message || err}` });
    } finally {
      setIsPullingGoogleEvents(false);
    }
  }, [pushUnsyncedItemsToCalendar, setNotification]);

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
  // this makes TaskFlow's OWN current tasks/blocks/events authoritative and
  // overwrites Google's primary calendar to match. Never runs automatically;
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
  // Reads live tasks/blocks/events off stateRef (same reasoning as
  // pushUnsyncedItemsToCalendar above) so this always reconciles against
  // the CURRENT local state at the moment it's clicked — including a backup
  // that was just restored, since applyBackupPayload commits synchronously
  // before the post-restore follow-up prompt can be clicked.
  //
  // Both phases go through Google's BATCH endpoint (up to MAX_BATCH_SIZE
  // operations per HTTP round-trip) rather than one call per event, which is
  // what keeps a several-hundred-event rewrite to seconds instead of minutes.
  // Per-item success/failure is read back out of each batch's sub-responses
  // and accumulated into succeeded/failed, so one bad event never aborts the
  // rest — see runBatchesWithRetry above for the retry/pacing policy.
  const rewriteGoogleCalendarFromTaskflow = useCallback(async ({ blocksOverride } = {}) => {
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
      const latestTasks = stateRef.current.tasks;
      // `blocksOverride` lets a caller that just mutated blocks via its OWN
      // synchronous commit() updater (see restoreCloudBackupAndRewriteCalendar
      // in SchedulerContext.jsx) pass the truly-current post-mutation blocks
      // straight through, rather than this hook re-reading stateRef.current —
      // stateRef is only refreshed by a useEffect keyed on `state` (see its
      // own comment in SchedulerContext.jsx), so it can still be one render
      // behind a commit() that resolved moments ago with no gap for React to
      // flush in between. Every other caller (the plain Settings button)
      // omits this and gets the normal stateRef.current.blocks.
      const latestBlocks = blocksOverride || stateRef.current.blocks;
      // Unlike tasks/blocks (mirrored into stateRef, see its own comment in
      // SchedulerContext.jsx), `events` is a plain useState outside the
      // {tasks, blocks} history-tracked bundle — this hook already receives
      // it fresh as a prop on every render, so the closed-over `events` here
      // is exactly as current as stateRef.current.tasks/blocks are.
      const latestEvents = events;

      // Flatten blocks (paired with their owning task, needed for the event
      // summary/description the push builds) and manual/Google-sourced events
      // into one authoritative list, each tagged with which kind it is and
      // enough to push it back individually below. Each item IS the
      // planCalendarRewrite input directly (not rebuilt/re-matched afterward)
      // so the plan's `toInsert` entries carry these same rich objects
      // straight through.
      const blockItems = latestBlocks
        // Past blocks are frozen (see isPastCalendarItem) — excluded from the
        // authoritative set so the rewrite neither re-creates them nor, via the
        // date range derived from it below, deletes what's already on Google
        // for days that are over.
        .filter((block) => !isPastCalendarItem(block))
        .map((block) => ({ kind: 'block', block, task: latestTasks.find((t) => t.id === block.taskId), googleEventId: block.googleEventId }))
        .filter((item) => item.task); // an orphaned block with no owning task can't be pushed (mirrors pushUnsyncedItemsToCalendar's own skip)
      // Events sourced from a calendar the user doesn't own (a subscribed
      // timetable, a shared calendar merely shared WITH them, etc. — i.e.
      // anything with calendarId !== 'primary') are excluded from the
      // authoritative set ENTIRELY, not just protected from delete — this
      // feature must never create a duplicate copy of someone else's event
      // on the user's primary calendar just because it's absent there. Only
      // a manual event or one already sourced from the user's OWN primary
      // calendar belongs in TaskFlow's notion of "what should be on primary".
      // Past events are frozen too (same rule as blockItems above) — a rewrite
      // must leave already-elapsed days on Google exactly as they are.
      const primaryEvents = latestEvents.filter(
        (e) => (e.source !== 'google' || e.calendarId === 'primary') && !isPastCalendarItem(e)
      );

      // THE push-side duplicate fix. Every block TaskFlow pushes comes back on
      // the next poll as an ordinary `source: 'google'` CalendarEvent, so
      // local state holds both the ScheduledBlock AND a mirror event of it.
      // Pushing both — which is what "blocks and events are both
      // authoritative" literally means — manufactures a second real Google
      // event for every synced block on EVERY run. That's why duplicates kept
      // reappearing during the push phase itself even after the delete phase
      // correctly cleared the calendar: the rewrite was creating them, not
      // failing to remove them. Dropping mirror rows here lets the block be
      // the single source of truth for its own event. See
      // isBlockSourcedEvent for how a mirror is recognized (and why the
      // legacy title-prefix fallback is safe).
      const mirrorEvents = primaryEvents.filter(isBlockSourcedEvent);
      const authoritativeEvents = primaryEvents.filter((e) => !isBlockSourcedEvent(e));
      if (mirrorEvents.length > 0) {
        console.info(
          `[useGoogleCalendarSync] Rewrite: skipping ${mirrorEvents.length} block-mirror event(s) — their ScheduledBlocks are pushed instead.`
        );
      }

      // Every remaining primary-scoped local event is re-pushed, including
      // ones originally pulled FROM Google (`source: 'google'`). Under the old
      // diff-based plan those were marked `needsPush: false` — their Google
      // copy already existed and was protected from deletion, so re-pushing
      // was a wasted call. A delete-all rewrite deletes that copy along with
      // everything else, so it genuinely does need re-creating.
      const eventItems = authoritativeEvents.map((e) => ({
        kind: 'event',
        event: e,
        googleEventId: e.googleEventId,
      }));
      // Final safety net: collapse anything that would still push two
      // identical Google events (same kind+title+date+time+recurrence). This
      // should be a no-op once the mirror filter above has done its job — so
      // a non-empty result is a smoking gun that local state itself contains
      // genuine duplicate rows, and is logged loudly as such rather than
      // silently swallowed. Cheap insurance either way: the cost of a wrong
      // drop is one missing event that the next poll re-pushes, versus a
      // permanent duplicate on the user's real calendar.
      const { items: authoritativeItems, duplicates: localDuplicates } = dedupeAuthoritativeItems([...blockItems, ...eventItems]);
      if (localDuplicates.length > 0) {
        console.warn(
          `[useGoogleCalendarSync] Rewrite: local state contains ${localDuplicates.length} redundant item(s) that would have created duplicate Google events — collapsed before pushing. This indicates duplicate rows in local blocks/events:`,
          localDuplicates.map((d) => (d.kind === 'block' ? `block:${d.task?.title} ${d.block.date} ${d.block.startTime}` : `event:${d.event.title} ${d.event.date} ${d.event.startTime}`))
        );
      }

      if (authoritativeItems.length === 0) {
        setNotification({ type: 'info', message: 'Nothing to rewrite — TaskFlow has no scheduled blocks or events.' });
        return { succeeded: [], failed: [] };
      }

      // Date range: exactly what the authoritative items span — never a
      // wider range than that (see this feature's own safety requirements).
      const dates = authoritativeItems.map((item) => (item.kind === 'block' ? item.block.date : item.event.date)).filter(Boolean);
      const startIso = dates.reduce((min, d) => (d < min ? d : min));
      const endIso = dates.reduce((max, d) => (d > max ? d : max));

      const { toDelete, toInsert } = await computeCalendarRewritePlan(authoritativeItems, startIso, endIso);

      const succeeded = [];
      const failed = [];
      const stampedGoogleEventIdsByBlockId = new Map();
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
        .map(({ item }) => {
          if (item.kind === 'block') {
            return { id: `block:${item.block.id}`, source: item, resource: buildBlockEventResource(item.block, item.task) };
          }
          return { id: `event:${item.event.id}`, source: item, resource: buildCalendarEventResource(item.event) };
        })
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
        const label = source.kind === 'block' ? source.task?.title || source.block.id : source.event.title || source.event.id;
        if (res?.ok) {
          if (res.googleEventId) {
            if (source.kind === 'block') stampedGoogleEventIdsByBlockId.set(source.block.id, res.googleEventId);
            else stampedGoogleEventIdsByEventId.set(source.event.id, res.googleEventId);
            // Confirmed live the moment Google returns the id — see
            // confirmedGoogleEventIdsRef's doc comment.
            confirmedGoogleEventIdsRef.current.add(res.googleEventId);
          }
          succeeded.push({ type: 'insert', kind: source.kind, id: source.kind === 'block' ? source.block.id : source.event.id });
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
          const id = item.kind === 'block' ? `block:${item.block.id}` : `event:${item.event.id}`;
          if (insertEntries.some((e) => e.id === id)) continue;
          const label = item.kind === 'block' ? item.task?.title || item.block.id : item.event.title || item.event.id;
          failed.push({ type: 'insert', label, error: 'Missing or invalid start/end time' });
        }
      }

      // Re-stamp googleEventIds across local state. Under delete-all EVERY
      // pre-existing googleEventId is now stale by construction — the event
      // it pointed at was deleted in phase 1 — so this rewrites the id for
      // successfully-inserted items and CLEARS it (null) for everything else,
      // rather than only touching the successes. Leaving a stale id behind
      // would be actively harmful: the block would look "already synced", so
      // pushUnsyncedItemsToCalendar would never re-push it, and any later
      // update/delete would target an id Google no longer knows — the block
      // would silently never reappear on the calendar. Nulling it instead
      // makes the very next poll's auto-push pick it up and recreate it.
      const updatedBlocks = stateRef.current.blocks.map((b) => {
        // A past block was never part of this rewrite (see isPastCalendarItem),
        // so its Google event still exists and its id is still valid — nulling
        // it would strand that event as an un-cleanable orphan.
        if (isPastCalendarItem(b)) return b;
        const fresh = stampedGoogleEventIdsByBlockId.get(b.id) ?? null;
        return b.googleEventId === fresh ? b : { ...b, googleEventId: fresh };
      });
      commit({ tasks: stateRef.current.tasks, blocks: updatedBlocks }, 'Rewrote Google Calendar from TaskFlow');

      // Rebuild the ongoing-sync record from scratch to match what the
      // rewrite just created. Every id it previously held was deleted in
      // phase 1, so carrying it forward would make the next reconciliation
      // sweep (see planOngoingCalendarSync) issue deletes for events that are
      // already gone and mis-read fresh inserts as "moved". Rebuilding here
      // keeps the two paths consistent: after a rewrite, the record describes
      // exactly the events now on Google.
      const rewrittenRecord = {};
      const tasksById = new Map(stateRef.current.tasks.map((t) => [t.id, t]));
      for (const b of updatedBlocks) {
        if (!b.googleEventId) continue;
        const task = tasksById.get(b.taskId);
        if (!task) continue;
        rewrittenRecord[b.id] = { googleEventId: b.googleEventId, signature: blockSyncSignature(b, task), taskId: b.taskId };
      }
      lastSyncedBlocksRef.current = rewrittenRecord;
      setLastSyncedBlocks(rewrittenRecord);
      // Same for events, with one extra step: block-mirror rows are DROPPED
      // rather than re-stamped. Their Google copies were deleted in phase 1
      // and deliberately not re-created from the event side (the block was
      // pushed instead — see the mirror filter above), so keeping them would
      // leave phantom local rows pointing at nothing, which would render as
      // ghost events until the next pull happened to clear them. Deleting
      // them here makes the block the single source of truth immediately.
      // The next pull re-creates a fresh mirror row for each block, which is
      // harmless and now correctly tagged/recognized.
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
      console.error('[useGoogleCalendarSync] Rewrite Google Calendar failed', err);
      setNotification({ type: 'error', message: `Rewrite Google Calendar failed: ${err.message || err}` });
      return { succeeded: [], failed: [{ type: 'fatal', error: err?.message || String(err) }] };
    } finally {
      setIsRewritingCalendar(false);
      setRewriteProgress(null);
      pollPausedRef.current = false;
      googleFetchInFlightRef.current = false;
    }
  }, [stateRef, events, commit, setEvents, setNotification, setLastSyncedBlocks]);

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

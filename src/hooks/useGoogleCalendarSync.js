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
import { toISODate, addDays, timeToMinutes, minutesToTime } from '../utils/dateUtils';
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
} from '../services/googleCalendarService';
import {
  mergePulledGoogleEvents,
  hardResetEventsFromGoogle,
  expandSyncedBounds,
  computeOnDemandFetchRange,
  computeEffectivePurgeBoundary,
  RECENTLY_DELETED_TTL_MS,
} from '../services/eventSyncService';

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
// UNBOUNDED. A non-recurring event older than a year is purged regardless of
// whether it was once on-demand-fetched, same as this app already treats a
// year as the outer edge of "recent history" elsewhere (backups, etc.).
// Rolls forward with real time (recomputed fresh on every call, not pinned
// to whenever a far-back fetch happened to occur) — see how it's combined
// with the synced-bounds union in applyPulledEvents below.
const MAX_RETENTION_DAYS = 365;

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
  onEventsChanged,
}) {
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  const [isPullingGoogleEvents, setIsPullingGoogleEvents] = useState(false);

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
  const lastGooglePollAtRef = useRef(0);
  const pollGoogleEventsRef = useRef(null);

  // googleEventId -> timestamp this app instance issued a delete for it.
  // Consulted (and pruned of expired entries) by every mergePulledGoogleEvents
  // call below so a poll/pull that lands before Google's own delete has
  // propagated can't resurrect an event we just deleted (see
  // eventSyncService.mergePulledGoogleEvents and SchedulerContext.deleteEvent).
  const recentlyDeletedGoogleEventIdsRef = useRef(new Map());

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
      // Cap retention at MAX_RETENTION_DAYS regardless of how far back the
      // synced-bounds union reaches — see MAX_RETENTION_DAYS' and
      // computeEffectivePurgeBoundary's own doc comments.
      const purgeBoundaryIso = computeEffectivePurgeBoundary(expandedBounds.startIso, MAX_RETENTION_DAYS);
      setEvents((prev) =>
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
              purgeBoundaryIso
            )
      );
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
      // Events just changed (poll/pull/import/rebuild) — any task blocks
      // scheduled around the old event set may now overlap or leave newly
      // freed capacity unused, so queue the same auto-rebalance a due-date
      // change triggers.
      onEventsChanged?.();
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
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!googleConnected) return;
      try {
        const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
        const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
        const { enabled } = await initGoogleCalendar(clientId, apiKey);
        if (enabled) {
          await requestAccessToken(true); // silent — no consent popup
          // Guard this fetch too — see googleFetchInFlightRef's own doc
          // comment. Unlikely to overlap anything this early, but a manual
          // "Pull" click landing during this initial load is possible.
          if (googleFetchInFlightRef.current) return;
          googleFetchInFlightRef.current = true;
          try {
            const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
            const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
            if (!cancelled) {
              const didHardReset = applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
              if (didHardReset) {
                setNotification({
                  type: 'info',
                  message: 'Rebuilt your synced events from Google Calendar to clean up a past sync issue.',
                });
              }
              if (failedCalendars.length > 0) {
                console.warn(`[useGoogleCalendarSync] Couldn't load events from: ${failedCalendars.join(', ')}`);
              }
            }
          } finally {
            googleFetchInFlightRef.current = false;
          }
        } else if (!cancelled) {
          setGoogleConnected(false);
        }
      } catch (err) {
        console.warn('[useGoogleCalendarSync] Silent re-auth failed, falling back to disconnected.', err);
        if (!cancelled) {
          setGoogleConnected(false);
          setGoogleNeedsReconnect(true);
          setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
        }
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Periodic polling ----------------------------------------------------
  useEffect(() => {
    if (!googleConnected) return undefined;

    const poll = async () => {
      if (googleFetchInFlightRef.current) return;
      googleFetchInFlightRef.current = true;
      lastGooglePollAtRef.current = Date.now();
      try {
        const { rangeStartIso, rangeEndIso } = getRoutineSyncRange();
        const { events: fetchedEvents } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
        const didHardReset = applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
        if (didHardReset) {
          setNotification({
            type: 'info',
            message: 'Rebuilt your synced events from Google Calendar to clean up a past sync issue.',
          });
        }
      } catch (err) {
        if (err?.isGoogleAuthError) {
          console.warn('[useGoogleCalendarSync] Auth expired during poll, disconnecting.', err);
          setGoogleConnected(false);
          setGoogleNeedsReconnect(true);
          setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
          return;
        }
        console.warn('[useGoogleCalendarSync] Periodic poll failed', err);
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
        const didHardReset = applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
        const resetSuffix = didHardReset ? ' Rebuilt your synced events from Google Calendar to clean up a past sync issue.' : '';
        if (failedCalendars.length > 0) {
          setNotification({
            type: 'warning',
            message: `Connected, but couldn't load events from: ${failedCalendars.join(', ')}.${resetSuffix}`,
          });
        } else {
          setNotification({ type: 'success', message: `Connected to Google Calendar.${resetSuffix}` });
        }
      } finally {
        googleFetchInFlightRef.current = false;
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Google Calendar connection failed: ${reason}` });
    }
  }, [setGoogleConnected, setNotification, applyPulledEvents]);

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
      const didHardReset = applyPulledEvents(fetchedEvents, rangeStartIso, rangeEndIso);
      const resetSuffix = didHardReset ? ' Rebuilt your synced events from Google Calendar to clean up a past sync issue.' : '';
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Pulled, but couldn't load events from: ${failedCalendars.join(', ')}.${resetSuffix}`,
        });
      } else {
        setNotification({ type: 'success', message: `Pulled latest events from Google Calendar.${resetSuffix}` });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Pull from Google Calendar failed: ${reason}` });
    } finally {
      setIsPullingGoogleEvents(false);
      googleFetchInFlightRef.current = false;
    }
  }, [googleConnected, setNotification, applyPulledEvents]);

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
  }, [googleConnected, setEvents, setNotification, setGoogleEventsHardResetDone, setGoogleSyncedRangeBounds]);

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
      // Never bother on-demand-fetching further back than the retention
      // ceiling (MAX_RETENTION_DAYS) — anything from further back than that
      // would just get purged again on the very next routine poll anyway
      // (see the purgeBoundaryIso clamp in applyPulledEvents), so fetching it
      // at all would be pure wasted API calls/bandwidth for data that can't
      // stick around regardless. Reuses computeEffectivePurgeBoundary for the
      // same "later of the two" comparison, just with `viewStartIso` in place
      // of a synced-bounds union.
      const clampedViewStartIso = computeEffectivePurgeBoundary(viewStartIso, MAX_RETENTION_DAYS);
      const needed = computeOnDemandFetchRange(googleSyncedRangeBoundsRef.current, clampedViewStartIso, viewEndIso);
      if (!needed) return; // already fully covered by what's synced so far
      googleFetchInFlightRef.current = true;
      try {
        const { events: fetchedEvents } = await fetchGoogleEvents(needed.startIso, needed.endIso);
        applyPulledEvents(fetchedEvents, needed.startIso, needed.endIso);
      } catch (err) {
        if (err?.isGoogleAuthError) {
          console.warn('[useGoogleCalendarSync] Auth expired during on-demand range fetch, disconnecting.', err);
          setGoogleConnected(false);
          setGoogleNeedsReconnect(true);
          setNotification({ type: 'warning', message: 'Google Calendar disconnected — reconnect in Settings to resume syncing.' });
          return;
        }
        console.warn('[useGoogleCalendarSync] On-demand range fetch failed', err);
      } finally {
        googleFetchInFlightRef.current = false;
      }
    },
    [googleConnected, applyPulledEvents, setGoogleConnected, setNotification]
  );

  // ---- Push blocks to Google Calendar --------------------------------------
  const pushToGoogleCalendar = useCallback(async () => {
    setIsPullingGoogleEvents(true);
    try {
      const toPush = blocks.filter((b) => !b.googleEventId);
      const pushedEventIdsByBlockId = new Map();
      for (const block of toPush) {
        const task = tasks.find((t) => t.id === block.taskId);
        if (!task) continue;
        const eventId = await pushBlockToCalendar(block, task);
        if (eventId) pushedEventIdsByBlockId.set(block.id, eventId);
      }
      const latestBlocks = stateRef.current.blocks;
      const updated = latestBlocks.map((b) =>
        pushedEventIdsByBlockId.has(b.id) ? { ...b, googleEventId: pushedEventIdsByBlockId.get(b.id) } : b
      );
      commit({ tasks: stateRef.current.tasks, blocks: updated }, `Pushed ${pushedEventIdsByBlockId.size} block(s) to Google Calendar`);
      setNotification({ type: 'success', message: `Pushed ${pushedEventIdsByBlockId.size} block(s) to Google Calendar.` });
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: `Push to Google Calendar failed: ${err.message || err}` });
    } finally {
      setIsPullingGoogleEvents(false);
    }
  }, [blocks, tasks, commit, stateRef, setNotification]);

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
      setNotification({ type: 'success', message: 'Disconnected Google Calendar.' });
    }
  }, [setGoogleConnected, setNotification]);

  return {
    googleConnected,
    setGoogleConnected,
    googleNeedsReconnect,
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
  };
}

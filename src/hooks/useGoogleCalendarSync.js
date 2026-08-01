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
import { mergePulledGoogleEvents, hardResetEventsFromGoogle, RECENTLY_DELETED_TTL_MS } from '../services/eventSyncService';

const EVENTS_HORIZON_DAYS = 28;

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
export function useGoogleCalendarSync({ events, setEvents, setNotification, blocks, tasks, commit, stateRef, pushActionToast }) {
  const [googleConnected, setGoogleConnected] = usePersistedState('googleConnected', false);
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  const [isPullingGoogleEvents, setIsPullingGoogleEvents] = useState(false);

  const googlePollInFlightRef = useRef(false);
  const lastGooglePollAtRef = useRef(0);
  const pollGoogleEventsRef = useRef(null);

  // googleEventId -> timestamp this app instance issued a delete for it.
  // Consulted (and pruned of expired entries) by every mergePulledGoogleEvents
  // call below so a poll/pull that lands before Google's own delete has
  // propagated can't resurrect an event we just deleted (see
  // eventSyncService.mergePulledGoogleEvents and SchedulerContext.deleteEvent).
  const recentlyDeletedGoogleEventIdsRef = useRef(new Map());

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
  // yet" on every 5-minute tick forever, re-running the wipe indefinitely
  // instead of exactly once. Reading a ref instead means every captured
  // closure still observes the flag flipping.
  const [googleEventsHardResetDone, setGoogleEventsHardResetDone] = usePersistedState('googleEventsHardResetDone', false);
  const googleEventsHardResetDoneRef = useRef(googleEventsHardResetDone);
  useEffect(() => {
    googleEventsHardResetDoneRef.current = googleEventsHardResetDone;
  }, [googleEventsHardResetDone]);

  // Shared by every fetch call site below (initial silent re-auth, periodic
  // poll, connect, manual pull) — applies the one-time hard reset instead of
  // the normal incremental merge for exactly the first pull after this fix
  // ships, then flips the flag so every subsequent call uses the normal
  // merge. Returns whether this call was the reset pass, so callers can let
  // the user know their calendar was just wiped and rebuilt.
  const applyPulledEvents = useCallback(
    (fetchedEvents, rangeStartIso, rangeEndIso) => {
      const didHardReset = !googleEventsHardResetDoneRef.current;
      setEvents((prev) =>
        didHardReset
          ? hardResetEventsFromGoogle(fetchedEvents, recentlyDeletedGoogleEventIdsRef.current)
          : mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso, recentlyDeletedGoogleEventIdsRef.current)
      );
      if (didHardReset) {
        googleEventsHardResetDoneRef.current = true; // synchronous — covers any other already-in-flight closure too
        setGoogleEventsHardResetDone(true);
      }
      return didHardReset;
    },
    [setEvents, setGoogleEventsHardResetDone]
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
          const rangeStartIso = toISODate(new Date());
          const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
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
      if (googlePollInFlightRef.current) return;
      googlePollInFlightRef.current = true;
      lastGooglePollAtRef.current = Date.now();
      try {
        const rangeStartIso = toISODate(new Date());
        const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
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
        googlePollInFlightRef.current = false;
      }
    };
    pollGoogleEventsRef.current = poll;

    const handle = setInterval(poll, 5 * 60 * 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConnected]);

  // ---- Visibility-change refresh -------------------------------------------
  useEffect(() => {
    if (!googleConnected) return undefined;

    const VISIBILITY_REFRESH_THROTTLE_MS = 60 * 1000;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastGooglePollAtRef.current < VISIBILITY_REFRESH_THROTTLE_MS) return;
      pollGoogleEventsRef.current?.();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
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
      const rangeStartIso = toISODate(new Date());
      const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
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
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Google Calendar connection failed: ${reason}` });
    }
  }, [setGoogleConnected, setNotification, applyPulledEvents]);

  // ---- Pull from Google Calendar (manual) ----------------------------------
  const pullFromGoogleCalendar = useCallback(async () => {
    if (!googleConnected) return;
    setIsPullingGoogleEvents(true);
    try {
      const rangeStartIso = toISODate(new Date());
      const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
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
    }
  }, [googleConnected, setNotification, applyPulledEvents]);

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
    disconnectGoogleCalendar,
    markGoogleEventDeleted,
    unmarkGoogleEventDeleted,
  };
}

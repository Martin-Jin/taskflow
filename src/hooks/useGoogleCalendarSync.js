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
} from '../services/googleCalendarService';
import { mergePulledGoogleEvents } from '../services/eventSyncService';

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
            setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
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
        setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
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
      setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
      if (failedCalendars.length > 0) {
        setNotification({
          type: 'warning',
          message: `Connected, but couldn't load events from: ${failedCalendars.join(', ')}.`,
        });
      } else {
        setNotification({ type: 'success', message: 'Connected to Google Calendar.' });
      }
    } catch (err) {
      console.error(err);
      const reason = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      setNotification({ type: 'error', message: `Google Calendar connection failed: ${reason}` });
    }
  }, [setGoogleConnected, setNotification, setEvents]);

  // ---- Pull from Google Calendar (manual) ----------------------------------
  const pullFromGoogleCalendar = useCallback(async () => {
    if (!googleConnected) return;
    setIsPullingGoogleEvents(true);
    try {
      const rangeStartIso = toISODate(new Date());
      const rangeEndIso = toISODate(new Date(Date.now() + EVENTS_HORIZON_DAYS * 86400000));
      const { events: fetchedEvents, failedCalendars } = await fetchGoogleEvents(rangeStartIso, rangeEndIso);
      setEvents((prev) => mergePulledGoogleEvents(prev, fetchedEvents, rangeStartIso, rangeEndIso));
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
    }
  }, [googleConnected, setEvents, setNotification]);

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

  return {
    googleConnected,
    setGoogleConnected,
    googleNeedsReconnect,
    isPullingGoogleEvents,
    connectGoogleCalendar,
    pullFromGoogleCalendar,
    pushToGoogleCalendar,
  };
}

/**
 * ============================================================================
 * GOOGLE CALENDAR SERVICE
 * ============================================================================
 * Wraps the Google Calendar API v3 using the Google Identity Services (GIS)
 * token client for OAuth2 (implicit flow, appropriate for a client-only SPA).
 *
 * SETUP (see README.md for full walkthrough):
 *   1. Create a project in Google Cloud Console, enable the Calendar API.
 *   2. Create an OAuth 2.0 Client ID (type: Web application).
 *   3. Add your dev/prod origin to "Authorized JavaScript origins".
 *   4. Put the Client ID in `.env` as VITE_GOOGLE_CLIENT_ID.
 *
 * Without a configured Client ID, all functions here transparently fall
 * back to mock data / no-ops so the rest of the app remains fully usable.
 * ============================================================================
 */

import { getMockEvents } from './mockData';
import { fromISODate, toISODate, timeToMinutes } from '../utils/dateUtils';

const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
// calendar.events: read/write events on calendars the user can edit (needed for push).
// calendarlist.readonly: list which calendars (incl. subscribed ones, e.g. a shared
// lecture timetable) the user has, so we know which calendarIds to pull events from.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

let tokenClient = null;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

/**
 * Dynamically load the Google API + Identity Services scripts. Safe to call
 * multiple times — subsequent calls resolve immediately once loaded.
 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Initialize the Google API client + auth token client. Must be called once
 * before any other function, typically on app mount. No-ops gracefully if
 * no Client ID is configured. Safe to call again on an already-initialized
 * client (e.g. from a manual "Refresh" action) — it resolves immediately.
 */
export async function initGoogleCalendar(clientId, apiKey) {
  if (!clientId) {
    console.info('[googleCalendarService] No VITE_GOOGLE_CLIENT_ID configured — Google Calendar sync disabled, using mock events.');
    return { enabled: false };
  }

  if (gapiInited && gisInited) return { enabled: true };

  await loadScript('https://apis.google.com/js/api.js');
  await loadScript('https://accounts.google.com/gsi/client');

  await new Promise((resolve) => window.gapi.load('client', resolve));
  try {
    await window.gapi.client.init({ apiKey, discoveryDocs: [DISCOVERY_DOC] });
  } catch (err) {
    throw new Error(err?.result?.error?.message || err?.message || JSON.stringify(err));
  }
  gapiInited = true;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: '', // set dynamically per-request in requestAccessToken()
    error_callback: (err) => tokenClient.callback?.({ error: err?.type || 'unknown_error', error_description: err?.message }),
  });
  gisInited = true;

  return { enabled: true };
}

/**
 * Trigger the OAuth flow and resolve once we have an access token.
 *
 * @param {boolean} silent - If true, ask Google Identity Services to reuse
 *   an existing grant without showing the consent popup (`prompt: ''`).
 *   Used on app load (and on manual refresh) to restore/renew a Google
 *   Calendar connection the user already approved in a previous session,
 *   so they don't have to click through the consent screen every time. If
 *   the user never consented, or has since revoked access, GIS will
 *   reject and the caller should fall back to treating the connection as
 *   inactive rather than forcing a popup.
 */
export function requestAccessToken(silent = false) {
  return new Promise((resolve, reject) => {
    if (!gapiInited || !gisInited) return reject(new Error('Google Calendar client not initialized'));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: silent || accessToken ? '' : 'consent' });
  });
}

/**
 * List every calendar in the user's "My calendars" list — this includes
 * calendars the user has SUBSCRIBED to (e.g. a university-published
 * lecture timetable ICS/Google calendar), not just their primary one.
 * `selected: false` calendars are ones the user has hidden in the Google
 * Calendar UI, so we skip those too (matches what they'd see on
 * calendar.google.com).
 * @returns {Promise<Array<{id:string,summary:string,accessRole:string}>>}
 */
async function listSubscribedCalendars() {
  const resp = await window.gapi.client.calendar.calendarList.list({
    minAccessRole: 'freeBusyReader',
  });
  return (resp.result.items || [])
    .filter((c) => c.selected !== false)
    // accessRole is one of 'owner'|'writer'|'reader'|'freeBusyReader' — carried
    // through to each event below so we know whether the user can push edits
    // back to Google (e.g. a subscribed read-only lecture timetable can't be).
    .map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
}

/**
 * Fetch events in a date range, across the user's PRIMARY calendar and
 * every other calendar they subscribe to (e.g. a lecture timetable shared
 * with them). Falls back to mock events if Calendar API isn't
 * configured/authorized.
 *
 * TWO TIMEZONE BUGS FIXED HERE (both were causing subscribed-calendar
 * events — e.g. a university lecture timetable — to render at the wrong
 * time, or not at all):
 *
 *   1. `timeMin`/`timeMax` are plain "YYYY-MM-DD" date strings. They must
 *      be converted to Dates using LOCAL midnight (via `fromISODate`), not
 *      `new Date(isoString)` — the latter parses a date-only ISO string as
 *      UTC midnight per the JS spec, which in a timezone ahead of UTC
 *      shifts the whole query window forward and can silently exclude
 *      morning events.
 *
 *   2. Google Calendar returns each event's `start.dateTime` with the
 *      offset of the *event's own original timezone* by default — which
 *      is not guaranteed to match the viewer's browser timezone (a shared
 *      timetable calendar is commonly configured in a different zone than
 *      the subscriber's own). Naively slicing the HH:MM substring out of
 *      that string assumes the offset already equals local time, which is
 *      wrong whenever it doesn't — producing an event box at the wrong
 *      time (or, given the day-column's fixed 06:00–24:00 render window,
 *      sometimes shifted clean out of the visible range entirely, making
 *      it look like the event "didn't show up").
 *
 *      Fixed two ways, belt-and-suspenders: (a) we explicitly request
 *      `timeZone: <browser's IANA zone>` on the API call, which tells
 *      Google to return dateTime values already normalized to that zone;
 *      and (b) we parse the returned string via `new Date(...)` (which
 *      correctly resolves ANY embedded offset into an absolute instant)
 *      and then read the local wall-clock time back off that Date object,
 *      rather than trusting the string's substring positions — so the
 *      result is correct even if (a) is ever bypassed or misconfigured.
 *
 * @returns {Promise<{ events: import('../types').CalendarEvent[], failedCalendars: string[] }>}
 */
export async function fetchEvents(startIso, endIso) {
  if (!gapiInited || !accessToken) {
    return { events: getMockEvents(startIso, endIso), failedCalendars: [] };
  }

  let calendars;
  try {
    calendars = await listSubscribedCalendars();
  } catch (err) {
    console.warn('[googleCalendarService] Failed to list subscribed calendars, falling back to primary only.', err);
    calendars = [{ id: 'primary', summary: 'primary', accessRole: 'owner' }];
  }
  // Always include primary even if the calendarList call above somehow omitted it.
  // Note: calendarList normally lists the primary calendar under its REAL id
  // (the account's email address) with `primary: true`, not the literal
  // string "primary" — checking only `c.id === 'primary'` missed that and
  // caused the primary calendar to be queried a second time under the
  // 'primary' alias, duplicating every one of its events on the agenda.
  if (!calendars.some((c) => c.id === 'primary' || c.primary)) calendars.unshift({ id: 'primary', summary: 'primary', accessRole: 'owner' });

  const timeMin = fromISODate(startIso).toISOString();
  const timeMax = fromISODate(endIso).toISOString();
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const failedCalendars = [];

  const perCalendarResults = await Promise.all(
    calendars.map(async (cal) => {
      try {
        // singleEvents: false — a recurring series comes back as ONE item
        // (the master event, carrying a `recurrence: [...]` RRULE/EXDATE
        // array) instead of being pre-expanded into N individual instances.
        // This is what lets a recurring event be stored as a single record
        // instead of importing "100 duplicate events" for something that
        // just repeats (see recurrenceExpansion.js, which expands it back
        // out for display only). Google's API only allows `orderBy:
        // 'startTime'` when singleEvents is true (it throws otherwise), so
        // ordering is done client-side after flattening/deduping below.
        const resp = await window.gapi.client.calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          timeZone: localTimeZone,
          singleEvents: false,
        });
        return (resp.result.items || []).map((e) => ({ ...e, __calendarId: cal.id, __calendarName: cal.summary, __accessRole: cal.accessRole }));
      } catch (err) {
        // A single subscribed calendar failing (e.g. revoked share, or only
        // shared at a lower access role than needed) shouldn't take down
        // the whole fetch — skip it, keep the rest, and report it back to
        // the caller so the UI can surface *which* calendar didn't load
        // instead of silently showing an incomplete calendar.
        console.warn(`[googleCalendarService] Failed to fetch events for calendar "${cal.summary}" (${cal.id})`, err);
        failedCalendars.push(cal.summary || cal.id);
        return [];
      }
    })
  );

  // Dedupe across calendars: the same logical event commonly has a copy on
  // more than one calendar the user can see (e.g. an event on a shared
  // family/team calendar that's also mirrored onto their primary calendar
  // as an attendee), which otherwise shows the same event twice on the
  // agenda. Google gives every calendar's copy of the same event the same
  // `iCalUID`, so that (plus the occurrence's start time, since a
  // recurring series' instances share one iCalUID) reliably identifies
  // "same event" regardless of which calendarId it came from — unlike
  // `id`, which Google mints separately per calendar.
  const seenEventKeys = new Set();

  const events = perCalendarResults
    .flat()
    .filter((e) => e.start?.dateTime) // skip all-day events for time-blocking purposes
    .filter((e) => {
      const key = `${e.iCalUID || e.id}::${e.start.dateTime}`;
      if (seenEventKeys.has(key)) return false;
      seenEventKeys.add(key);
      return true;
    })
    .map((e) => {
      // Parse via Date objects rather than string-slicing — see the
      // function doc comment above for why this matters.
      const start = new Date(e.start.dateTime);
      const end = new Date(e.end.dateTime);
      const pad2 = (n) => String(n).padStart(2, '0');

      const id = `gcal_${e.__calendarId}_${e.id}`;

      // With singleEvents:false, a recurring event's `recurringEventId`
      // field is NOT present (that only appears on pre-expanded
      // instances) — the master event's own id doubles as its seriesId,
      // matching the convention used elsewhere for manually-created
      // recurring events (see recurrenceExpansion.js / SchedulerContext).
      const seriesId = e.recurrence ? id : null;

      // e.recurrence is an array of RRULE/EXDATE/RDATE/EXRULE lines. Only
      // the RRULE line is used — EXDATE/RDATE/EXRULE are an out-of-scope
      // subset, same limitation documented in recurrenceExpansion.js.
      let recurrenceRule = null;
      if (e.recurrence) {
        const rruleLine = e.recurrence.find((line) => line.startsWith('RRULE:'));
        if (rruleLine) recurrenceRule = rruleLine.slice('RRULE:'.length);
      }

      return {
        id,
        title: e.summary || '(no title)',
        date: toISODate(start),
        startTime: `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
        endTime: `${pad2(end.getHours())}:${pad2(end.getMinutes())}`,
        isFreeTime: false,
        isRecurring: !!e.recurrence,
        googleEventId: e.id,
        calendarId: e.__calendarId,
        calendarName: e.__calendarName,
        source: 'google',
        description: e.description || '',
        location: e.location || '',
        recurrenceRule,
        // Whether the user can push edits/deletes back to Google for this
        // event — 'owner'/'writer' calendars only. Subscribed calendars
        // shared as 'reader'/'freeBusyReader' (e.g. a university timetable)
        // are view-only on Google's side, so TaskFlow must not offer full
        // edit controls for events sourced from them either.
        canEdit: e.__accessRole === 'owner' || e.__accessRole === 'writer',
        googleUpdatedAt: e.updated,
        localUpdatedAt: null,
        // Google's shared master-event id for every instance of a recurring
        // event — lets "ignore this event" be applied to just this
        // instance, this-and-following, or the whole series. See
        // SchedulerContext.setEventIgnored.
        seriesId,
      };
    })
    // Google only allows orderBy:'startTime' when singleEvents:true (see
    // above), so sort client-side instead. Dates are "YYYY-MM-DD" ISO
    // strings, so plain string comparison sorts correctly; times go through
    // timeToMinutes for consistency with the rest of the codebase's
    // "HH:MM" comparisons.
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    });

  return { events: withSyntheticSeries(events), failedCalendars };
}

/**
 * Some events repeat by convention (same title/time booked weekly, e.g. a
 * tutoring session or a booking-system timetable slot) without actually
 * being a Google-native RRULE series — Google never returns a
 * `recurringEventId` for these, so they'd otherwise fall through the
 * "Ignore this event" scope picker and the bulk "ignore all repeating
 * events" action, which both key off `seriesId`. This groups any
 * still-unlinked events (within the same calendar) that share a title and
 * time-of-day, and — if 2+ occurrences show up in the fetched window —
 * assigns them a synthetic seriesId so they're treated as a series too.
 */
function withSyntheticSeries(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.seriesId) continue;
    const key = `${e.calendarId} ${e.title} ${e.startTime} ${e.endTime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const syntheticId = `synthetic_${key}`;
    for (const e of group) {
      e.seriesId = syntheticId;
      e.isRecurring = true;
    }
  }

  return events;
}

/**
 * Push a single ScheduledBlock to Google Calendar as an event. Returns the
 * created event's id (to store on the block for future updates/deletes).
 */
export async function pushBlockToCalendar(block, task) {
  if (!gapiInited || !accessToken) {
    console.info('[googleCalendarService] Not authorized — skipping push (mock mode).');
    return null;
  }

  const event = {
    summary: `📋 ${task.title}`,
    description: task.notes || `Auto-scheduled by TaskFlow · Priority: ${task.priority}`,
    start: { dateTime: `${block.date}T${block.startTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: `${block.date}T${block.endTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    colorId: priorityToColorId(task.priority),
  };

  const resp = block.googleEventId
    ? await window.gapi.client.calendar.events.update({ calendarId: 'primary', eventId: block.googleEventId, resource: event })
    : await window.gapi.client.calendar.events.insert({ calendarId: 'primary', resource: event });

  return resp.result.id;
}

/**
 * Push a single CalendarEvent (manual or a locally-edited Google-sourced
 * one) to Google Calendar — creates it if it has no googleEventId yet,
 * otherwise updates the existing one. Returns { id, updated } (Google's
 * event id and its fresh `updated` timestamp) so the caller can stamp
 * googleEventId/googleUpdatedAt back onto the local record, or null if
 * not authorized (mock/offline mode).
 */
export async function pushEventToCalendar(event) {
  if (!gapiInited || !accessToken) {
    console.info('[googleCalendarService] Not authorized — skipping event push (mock mode).');
    return null;
  }

  const calendarId = event.calendarId || 'primary';
  const resource = {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: { dateTime: `${event.date}T${event.startTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: `${event.date}T${event.endTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    recurrence: event.recurrenceRule ? [`RRULE:${event.recurrenceRule}`] : undefined,
  };

  const resp = event.googleEventId
    ? await window.gapi.client.calendar.events.update({ calendarId, eventId: event.googleEventId, resource })
    : await window.gapi.client.calendar.events.insert({ calendarId, resource });

  return { id: resp.result.id, updated: resp.result.updated };
}

/**
 * Delete a pushed event (e.g. when a block is rescheduled/removed, or a
 * CalendarEvent is deleted locally). `calendarId` defaults to 'primary' but
 * must be passed explicitly for anything sourced from a non-primary (e.g.
 * subscribed) calendar, or the delete call targets the wrong calendar.
 */
export async function deleteCalendarEvent(googleEventId, calendarId = 'primary') {
  if (!gapiInited || !accessToken || !googleEventId) return;
  await window.gapi.client.calendar.events.delete({ calendarId, eventId: googleEventId });
}

function priorityToColorId(priority) {
  // Google Calendar colorId palette (1-11). Chosen for intuitive severity mapping.
  switch (priority) {
    case 'urgent':
      return '11'; // red (Tomato)
    case 'high':
      return '6'; // orange (Tangerine)
    case 'medium':
      return '5'; // yellow (Banana)
    default:
      return '7'; // blue (Peacock)
  }
}

export function isGoogleCalendarConnected() {
  return !!accessToken;
}
/**
 * ============================================================================
 * GOOGLE CALENDAR SERVICE
 * ============================================================================
 * Wraps the Google Calendar API v3 using the Google Identity Services (GIS)
 * *authorization-code* flow (`initCodeClient`, `access_type: 'offline'`)
 * instead of the older implicit token flow — that used to mean Google only
 * ever issued a short-lived (~1hr) access token with no refresh token, so
 * once it expired the app depended on the browser still holding a live
 * Google session to silently re-auth, and fell back to a visible login
 * popup whenever that didn't hold (e.g. after a plain page refresh).
 *
 * Now: the one-time consent grant exchanges its authorization `code` (via
 * the companion Cloudflare Worker, see cloudflare-worker/src/
 * googleCalendarAuthRoutes.js) for a genuine Google refresh token, which the
 * Worker stores server-side in Firestore (never sent back to the client).
 * Every subsequent "silent" token request instead asks the Worker to mint a
 * fresh access token from that stored refresh token — no popup, no
 * dependency on browser session state. A popup is only ever shown again for
 * the original one-time consent, or after the user revokes access at
 * myaccount.google.com (see `requestAccessToken` below).
 *
 * SETUP (see README.md and cloudflare-worker/README.md for full walkthroughs):
 *   1. Create a project in Google Cloud Console, enable the Calendar API.
 *   2. Create an OAuth 2.0 Client ID (type: Web application).
 *   3. Add your dev/prod origin to "Authorized JavaScript origins".
 *   4. Put the Client ID in `.env` as VITE_GOOGLE_CLIENT_ID.
 *   5. Deploy/configure the calendar-auth routes on the Cloudflare Worker
 *      (GOOGLE_CLIENT_SECRET + a Firestore-scoped service account — see
 *      cloudflare-worker/README.md) and put its URL in `.env` as
 *      VITE_CALENDAR_AUTH_WORKER_URL.
 *
 * Without a configured Client ID, all functions here transparently fall
 * back to mock data / no-ops so the rest of the app remains fully usable.
 * ============================================================================
 */

import { getMockEvents } from './mockData';
import { fromISODate, toISODate, timeToMinutes, addDays } from '../utils/dateUtils';
import { loadPersisted, savePersisted, clearPersisted } from '../utils/persistence';
import { loadScript } from '../utils/loadScript';
import { auth } from '../firebase';

const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
// calendar.events: read/write events on calendars the user can edit (needed for push).
// calendarlist.readonly: list which calendars (incl. subscribed ones, e.g. a shared
// lecture timetable) the user has, so we know which calendarIds to pull events from.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

let codeClient = null;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Google's `description` field is HTML when an event was composed with Google
// Calendar's rich-text editor (e.g. via Gmail invites) — TaskFlow only has a
// plain <textarea> for it, so render tags down to readable plain text rather
// than showing raw markup. DOMParser is the simplest correct way to decode
// HTML entities (e.g. `&amp;`) without a manual entity table.
function htmlToPlainText(html) {
  if (!html || !/[<&]/.test(html)) return html || '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  const text = doc.body.textContent || '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// The access token this module holds is still short-lived (~1hr) and lives
// only in memory, wiped on every page reload/reopen — but unlike the old
// implicit flow, refreshing it no longer requires GIS or a popup at all: see
// `refreshAccessTokenFromWorker` below, which mints a fresh one from the
// refresh token the Worker stored server-side on first consent. Caching the
// still-valid token in localStorage just avoids an unnecessary Worker round
// trip on every repeat app open within the same ~1hr window.
// Stored via the app's own persistence layer (utils/persistence.js) rather
// than a hand-rolled localStorage key — this piggybacks on its existing
// try/catch-wrapped read/write AND, importantly, means "Settings → Reset
// local data" (which wipes every taskflow:-namespaced key) also clears this
// token cache instead of leaving a stale one orphaned behind a reset.
const TOKEN_STORAGE_KEY = 'googleAccessToken';
// Treat a token as expired slightly before its real expiry so an in-flight
// API call started right before the deadline doesn't get a token that dies
// mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

function cacheAccessToken(token, expiresInSec) {
  savePersisted(TOKEN_STORAGE_KEY, { token, expiresAt: Date.now() + (expiresInSec || 3600) * 1000 });
}

function readCachedAccessToken() {
  const cached = loadPersisted(TOKEN_STORAGE_KEY, null);
  if (!cached?.token || Date.now() > cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS) return null;
  return cached.token;
}

function clearCachedAccessToken() {
  clearPersisted(TOKEN_STORAGE_KEY);
}

/**
 * True if a gapi client error is an auth failure (expired/revoked token)
 * rather than a permissions/not-found/network issue on that one call.
 */
function isAuthError(err) {
  const code = err?.status ?? err?.result?.error?.code;
  return code === 401;
}

/**
 * True only for a CONFIRMED "needs reconnect" failure — the Worker's
 * `/calendar/refresh-token` route returning 404 (`not_connected`) or 409
 * (`revoked`), which `refreshAccessTokenFromWorker` above marks by setting
 * `err.needsReconnect = true`. Any other failure from that same call site
 * (a plain network/DNS hiccup, `getFirebaseIdToken()` throwing because
 * `auth.currentUser` isn't ready yet, a Worker 5xx, etc.) is transient and
 * must NOT be treated as proof the user is actually disconnected — see
 * useGoogleCalendarSync.js's initial silent re-auth effect, the one place
 * this distinction previously wasn't made (any thrown error flipped
 * `googleConnected` to false immediately, which is what caused Calendar to
 * wrongly show "disconnected" after a cold browser start whenever the very
 * first silent refresh attempt hit one of these transient failures).
 * Extracted as its own pure function so this decision can be unit tested
 * without mocking the Worker's HTTP responses.
 * @param {unknown} err
 * @returns {boolean}
 */
export function shouldTreatAsReconnectNeeded(err) {
  return err?.needsReconnect === true;
}

/**
 * Drop both the in-memory and cached access token, forcing the next
 * `requestAccessToken` call to actually talk to GIS again instead of
 * re-serving a token Google has already rejected — otherwise a
 * revoked-but-not-yet-"expired" cached token (see cacheAccessToken above)
 * would keep failing silently for up to an hour before self-correcting.
 */
function invalidateAccessToken() {
  accessToken = null;
  clearCachedAccessToken();
  window.gapi.client.setToken(null);
}

/** Invalidate the token and throw a marked error callers can recognize (see `err.isGoogleAuthError`) and react to by disconnecting, instead of retrying with the same now-cleared token. */
function throwAuthExpired() {
  invalidateAccessToken();
  const authErr = new Error('Google Calendar authorization expired — please reconnect.');
  authErr.isGoogleAuthError = true;
  throw authErr;
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

  // access_type: 'offline' + prompt: 'consent' are what make Google actually
  // issue a refresh token on this grant (not just an access token) — without
  // 'consent', Google can skip re-issuing one for a scope already approved
  // in a previous grant. This only fires the popup for the one-time consent
  // grant path (`requestAuthorizationCode` below) — never for the silent
  // Worker-refresh path, which needs no popup at all.
  codeClient = window.google.accounts.oauth2.initCodeClient({
    client_id: clientId,
    scope: SCOPES,
    ux_mode: 'popup',
    access_type: 'offline',
    prompt: 'consent',
    callback: '', // set dynamically per-request in requestAuthorizationCode()
    error_callback: (err) => codeClient.callback?.({ error: err?.type || 'unknown_error', error_description: err?.message }),
  });
  gisInited = true;

  return { enabled: true };
}

/** The current signed-in Taskflow user's Firebase ID token, required by every calendar-auth Worker route to identify whose Firestore doc to read/write. */
async function getFirebaseIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in to Taskflow — Google Calendar sync requires being signed in.');
  return user.getIdToken();
}

/**
 * One-time consent grant: opens the GIS popup and resolves with the
 * one-time authorization `code` once the user approves. Never call this
 * from a silent/background path — see `requestAccessToken` below.
 */
function requestAuthorizationCode() {
  return new Promise((resolve, reject) => {
    if (!gisInited) return reject(new Error('Google Calendar client not initialized'));
    codeClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      resolve(resp.code);
    };
    codeClient.requestCode();
  });
}

/**
 * Exchanges a one-time authorization `code` (from `requestAuthorizationCode`)
 * at the Worker's `/calendar/exchange-code` route for an access token —
 * the Worker redeems it with Google server-side and persists the resulting
 * refresh token in Firestore, returning only the short-lived access token
 * to the client.
 */
async function exchangeCodeForToken(code) {
  const workerUrl = import.meta.env.VITE_CALENDAR_AUTH_WORKER_URL;
  if (!workerUrl) throw new Error('Google Calendar auth worker not configured (VITE_CALENDAR_AUTH_WORKER_URL).');

  const idToken = await getFirebaseIdToken();
  const res = await fetch(`${workerUrl}/calendar/exchange-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, idToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Calendar auth worker code exchange failed (HTTP ${res.status}).`);

  accessToken = body.access_token;
  cacheAccessToken(accessToken, body.expires_in);
  return accessToken;
}

/**
 * The new no-popup "silent" path: asks the Worker's `/calendar/refresh-token`
 * route to mint a fresh access token from the refresh token it stored on
 * this user's first consent grant. Throws with `err.needsReconnect = true`
 * if there's no stored refresh token yet (never connected) or Google
 * reports it revoked — the only cases where a fresh one-time consent grant
 * (a popup) is actually required.
 */
async function refreshAccessTokenFromWorker() {
  const workerUrl = import.meta.env.VITE_CALENDAR_AUTH_WORKER_URL;
  if (!workerUrl) throw new Error('Google Calendar auth worker not configured (VITE_CALENDAR_AUTH_WORKER_URL).');

  const idToken = await getFirebaseIdToken();
  const res = await fetch(`${workerUrl}/calendar/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error === 'not_connected' ? 'Google Calendar not yet connected.' : body.error === 'revoked' ? 'Google Calendar access was revoked.' : body.error || `Calendar auth worker refresh failed (HTTP ${res.status}).`);
    err.needsReconnect = res.status === 404 || res.status === 409;
    throw err;
  }

  accessToken = body.access_token;
  cacheAccessToken(accessToken, body.expires_in);
  return accessToken;
}

/**
 * User-initiated disconnect: tells the Worker to revoke the stored refresh
 * token at Google and delete it from Firestore, then clears all local
 * token state regardless of whether that network call succeeds — an
 * unreachable Worker shouldn't leave the UI stuck showing "connected".
 */
export async function disconnectGoogleCalendar() {
  const workerUrl = import.meta.env.VITE_CALENDAR_AUTH_WORKER_URL;
  try {
    if (workerUrl) {
      const idToken = await getFirebaseIdToken();
      await fetch(`${workerUrl}/calendar/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
    }
  } finally {
    invalidateAccessToken();
  }
}

/**
 * Resolve to a usable access token, preferring — in order — a still-valid
 * cached token, then the silent Worker-refresh path (no popup), and only
 * falling back to a one-time consent grant (a real popup) when the Worker
 * reports there's nothing to refresh (`needsReconnect`) AND this call is an
 * explicit (non-silent) user action. A silent/background call (app load,
 * periodic poll) that fails must propagate the error instead — the existing
 * `googleNeedsReconnect` handling in useGoogleCalendarSync.js treats that as
 * "show the reconnect banner", never as licence to pop a window.
 *
 * @param {boolean} silent - true for background/app-load calls that must
 *   never show a popup; false only for an explicit user "Connect"/"Reconnect"
 *   action, where falling back to the one-time consent grant is acceptable.
 */
export async function requestAccessToken(silent = false) {
  if (!accessToken) {
    const cached = readCachedAccessToken();
    if (cached) accessToken = cached;
  }
  if (accessToken) {
    window.gapi.client.setToken({ access_token: accessToken });
    return accessToken;
  }

  if (!gapiInited || !gisInited) throw new Error('Google Calendar client not initialized');

  let token;
  try {
    token = await refreshAccessTokenFromWorker();
  } catch (err) {
    if (silent || !err.needsReconnect) throw err;
    const code = await requestAuthorizationCode();
    token = await exchangeCodeForToken(code);
  }

  // gapi.client.calendar.* calls (listSubscribedCalendars, fetchGoogleEvents,
  // push/delete, etc.) read their auth token from gapi.client's own internal
  // state, not from this module's `accessToken` variable — without this,
  // every one of those calls gets no token at all and fails with 401,
  // immediately surfacing as "authorization expired" right after connecting.
  window.gapi.client.setToken({ access_token: token });
  return token;
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
 * Parse one EXDATE value (a single comma-separated entry from an `EXDATE`
 * line in `event.recurrence`) into the LOCAL calendar-date ISO string
 * ("YYYY-MM-DD") that `expandRecurringEvent` keys its `overrides` map by —
 * i.e. the same convention `fetchEvents` below uses for every other date it
 * computes (`toISODate` off a real Date object, never string-slicing).
 *
 * Accepts both forms Google emits: `YYYYMMDDTHHMMSSZ` (absolute UTC instant)
 * and `YYYYMMDDTHHMMSS` (floating/local time, paired with a `TZID=` param on
 * the line — not read here since resolving an arbitrary IANA zone name
 * client-side isn't worth it for a value that already reflects wall-clock
 * time almost identically to `buildInstanceEventId`'s own "no trailing
 * Z/offset -> local wall-clock" convention elsewhere in this file).
 * Returns null for anything that doesn't parse (e.g. an all-day `YYYYMMDD`
 * value — never expected here since this app only ever handles timed
 * events, see buildInstanceEventId's own doc comment, but a defensive null
 * is safer than silently excluding the wrong date).
 * @param {string} dtRaw
 * @returns {string|null}
 */
export function parseExdateToLocalIsoDate(dtRaw) {
  const isUtc = dtRaw.endsWith('Z');
  const digits = dtRaw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4);
  const mo = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  const h = digits.slice(8, 10) || '00';
  const mi = digits.slice(10, 12) || '00';
  const s = digits.slice(12, 14) || '00';
  const date = isUtc ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(date.getTime()) ? null : toISODate(date);
}

/**
 * Convert an inclusive `[startIso, endIso]` "YYYY-MM-DD" range into the
 * `timeMin`/`timeMax` instants Google's `events.list` expects. `timeMin` is
 * local midnight AT THE START of `startIso` (Google's lower bound is
 * inclusive, so this is correct as-is). `timeMax` is Google's EXCLUSIVE upper
 * bound, so it must be local midnight at the START of the day AFTER `endIso`
 * — not `endIso` itself — or every event actually occurring ON `endIso`
 * (anything after local midnight that day) is silently excluded from the
 * fetch. That mismatch used to cause a real bug: mergePulledGoogleEvents'
 * `isInScopeForPull` treats `event.date <= rangeEndIso` as in scope (see its
 * own doc comment) — an inclusive contract — so a still-live event dated
 * exactly on the horizon's last day would come back missing from a fetch
 * that (wrongly) excluded it, and get misread as a Google-side deletion.
 * Extracted as its own pure function purely so this date arithmetic can be
 * unit tested without mocking `window.gapi` (see fetchEvents' own doc
 * comment on why the rest of this module mostly can't be).
 * @param {string} startIso - "YYYY-MM-DD", inclusive
 * @param {string} endIso - "YYYY-MM-DD", inclusive
 * @returns {{timeMin: string, timeMax: string}}
 */
export function computeFetchTimeRange(startIso, endIso) {
  return {
    timeMin: fromISODate(startIso).toISOString(),
    timeMax: fromISODate(addDays(endIso, 1)).toISOString(),
  };
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
    if (isAuthError(err)) throwAuthExpired();
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

  const { timeMin, timeMax } = computeFetchTimeRange(startIso, endIso);
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
        //
        // PAGINATION: events.list caps each response at a default 250 items
        // (Google's own `maxResults` default) and signals more are available
        // via `nextPageToken`. This was never followed here — harmless while
        // the fetch window was ~1 month forward-only (well under 250 items
        // for a typical personal calendar), but became a real, silent bug
        // once the window grew to a full year back: a calendar with more
        // than 250 distinct events/masters across that year (easily a busy
        // primary calendar, vs. a lighter subscribed timetable) got silently
        // truncated to whatever Google's unspecified item ordering (there's
        // no `orderBy` available for singleEvents:false) happened to put on
        // the first page — NOT necessarily the most recent/soonest items, so
        // this could drop even the CURRENT week entirely for that calendar
        // while other, smaller calendars kept working fine. Loop until
        // `nextPageToken` is absent so every item in range is actually
        // returned, however many pages that takes.
        const items = [];
        let pageToken;
        do {
          const resp = await window.gapi.client.calendar.events.list({
            calendarId: cal.id,
            timeMin,
            timeMax,
            timeZone: localTimeZone,
            singleEvents: false,
            ...(pageToken ? { pageToken } : {}),
          });
          items.push(...(resp.result.items || []));
          pageToken = resp.result.nextPageToken;
        } while (pageToken);
        return items.map((e) => ({ ...e, __calendarId: cal.id, __calendarName: cal.summary, __accessRole: cal.accessRole }));
      } catch (err) {
        // An expired/revoked token fails identically on every calendar in
        // this Promise.all — reporting each one as a separate "failed
        // calendar" would just spam the user with one warning per calendar
        // on every poll until the (now stale) cached token's clock runs
        // out. Invalidate it and let the rejection propagate instead, so
        // the caller (SchedulerContext) treats this as a connection failure
        // and falls back to "disconnected" the same way an outright silent
        // re-auth failure already does.
        if (isAuthError(err)) throwAuthExpired();
        // Anything else (e.g. revoked share, or only shared at a lower
        // access role than needed) is scoped to this ONE calendar and
        // shouldn't take down the whole fetch — skip it, keep the rest, and
        // report it back to the caller so the UI can surface *which*
        // calendar didn't load instead of silently showing an incomplete one.
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

  const flatItems = perCalendarResults.flat();

  // A cancelled or individually-modified instance of a recurring event comes
  // back from events.list (with singleEvents:false) as its OWN separate item
  // carrying `recurringEventId` (the master's real id) + `originalStartTime`
  // (the occurrence's ORIGINAL, pre-cancellation/pre-move date) — this is
  // Google's actual signal for "this occurrence is excluded from the
  // master's plain RRULE expansion", DISTINCT from (and, in practice, not
  // reliably accompanied by) a textual EXDATE line in the master's own
  // `recurrence` array. The EXDATE-line parsing below this point only
  // catches exclusions Google happens to also mirror into that text — for a
  // single-occurrence delete/move issued via THIS APP'S OWN instance-id API
  // calls (deleteCalendarEventInstance/pushEventInstanceUpdate), Google
  // reliably returns the cancelled/modified instance item but does NOT
  // reliably add a matching EXDATE line to the master's `recurrence` text —
  // so relying on EXDATE text alone left the master's own virtual expansion
  // with no record the occurrence was ever excluded: the "deleted" occurrence
  // would keep reappearing on every fetch (survives even a full
  // hardResetEventsFromGoogle rebuild, since that rebuilds purely from what
  // this function returns). Building `overrides` from these items directly —
  // for BOTH a cancelled instance (deleted) and a live modified instance
  // (moved elsewhere, so its original slot must still be excluded from the
  // master or it would double-render) — closes that gap regardless of
  // whether Google also happens to emit EXDATE text for a given case.
  const excludedOriginalDatesByMaster = new Map(); // `${calendarId}::${recurringEventId}` -> Set<"YYYY-MM-DD">
  for (const e of flatItems) {
    if (!e.recurringEventId) continue;
    const originalStart = e.originalStartTime?.dateTime;
    if (!originalStart) continue; // all-day instance exception — out of scope, this app is timed-events-only (see the filter below)
    const key = `${e.__calendarId}::${e.recurringEventId}`;
    if (!excludedOriginalDatesByMaster.has(key)) excludedOriginalDatesByMaster.set(key, new Set());
    excludedOriginalDatesByMaster.get(key).add(toISODate(new Date(originalStart)));
  }

  const events = flatItems
    // Google's events.list defaults to `showDeleted: false`, which normally
    // means a deleted event is simply absent from the response — that's what
    // mergePulledGoogleEvents' deletion-detection relies on. But per Google's
    // own API docs, a CANCELLED INSTANCE of a recurring event (e.g. the
    // resource left behind after a single-occurrence delete or edit,
    // resolved via `resolveInstanceId` below) can still come back even with showDeleted
    // false, carrying `status: 'cancelled'` but a start/end time inherited
    // from before cancellation. Without this filter, that tombstone slips
    // through as if it were a live, ordinary one-off event (recurrence is
    // absent on the instance resource itself, so it looks exactly like a
    // plain singular event) — a deleted event that never actually disappears
    // no matter how many times it's re-deleted (its own real API delete
    // already returned 404/410 the first time, which deleteCalendarEvent
    // correctly treats as already-gone and stops retrying). Its exclusion
    // date was already captured into excludedOriginalDatesByMaster above,
    // before this filter drops the tombstone itself.
    .filter((e) => e.status !== 'cancelled')
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

      // e.recurrence is an array of RRULE/EXDATE/RDATE/EXRULE lines. RDATE/
      // EXRULE are an out-of-scope subset, same limitation documented in
      // recurrenceExpansion.js — but EXDATE (marking a specific occurrence
      // as cancelled/individually modified, e.g. after a drag-to-reschedule
      // or a single-occurrence delete, done either in TaskFlow or directly
      // in Google Calendar) IS translated into this master's own
      // `overrides` map below, the same shape a local 'this'-scope delete
      // already produces (see SchedulerContext.deleteEvent). Without this,
      // expandRecurringEvent has no way to know that date is excluded and
      // regenerates it from the RRULE alone — a "phantom" occurrence that
      // looks live in TaskFlow but doesn't actually exist on Google's
      // calendar (its real replacement, if the occurrence was moved rather
      // than deleted, shows up separately as its own one-off event with a
      // Google-minted `{seriesId}_{originalStartTimeUTC}`-shaped id).
      let recurrenceRule = null;
      let overrides = null;
      if (e.recurrence) {
        const rruleLine = e.recurrence.find((line) => line.startsWith('RRULE:'));
        if (rruleLine) recurrenceRule = rruleLine.slice('RRULE:'.length);

        const exdateLines = e.recurrence.filter((line) => line.startsWith('EXDATE'));
        for (const line of exdateLines) {
          const valuePart = line.slice(line.indexOf(':') + 1);
          for (const dtRaw of valuePart.split(',')) {
            const excludedIso = parseExdateToLocalIsoDate(dtRaw.trim());
            if (excludedIso) {
              overrides = overrides || {};
              overrides[excludedIso] = { deleted: true };
            }
          }
        }
      }

      // Also fold in exclusions derived from actual cancelled/modified
      // instance items (see excludedOriginalDatesByMaster above) — the more
      // reliable signal, since Google doesn't consistently mirror these into
      // this master's own EXDATE text. Only applies to true-RRULE masters
      // (seriesId === id here); harmless no-op otherwise since a plain
      // one-off event's own real id won't coincidentally match some other
      // event's recurringEventId.
      if (seriesId) {
        const excludedDates = excludedOriginalDatesByMaster.get(`${e.__calendarId}::${e.id}`);
        if (excludedDates) {
          overrides = overrides || {};
          for (const isoDate of excludedDates) {
            overrides[isoDate] = { ...overrides[isoDate], deleted: true };
          }
        }
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
        description: htmlToPlainText(e.description),
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
        // Set only on events this app itself created from a ScheduledBlock —
        // lets the rewrite recognize (and skip) its own mirror rows instead
        // of re-pushing them as duplicates alongside the real block. See
        // TASKFLOW_BLOCK_PROPERTY_KEY.
        ...(e.extendedProperties?.private?.[TASKFLOW_BLOCK_PROPERTY_KEY]
          ? { taskflowBlockId: e.extendedProperties.private[TASKFLOW_BLOCK_PROPERTY_KEY] }
          : {}),
        // Google's shared master-event id for every instance of a recurring
        // event — lets "ignore this event" be applied to just this
        // instance, this-and-following, or the whole series. See
        // SchedulerContext.setEventIgnored.
        seriesId,
        // EXDATE-derived exclusions (see above) — omitted entirely rather
        // than `{}` when there are none, matching expandRecurringEvent's own
        // `masterEvent.overrides || {}` fallback.
        ...(overrides ? { overrides } : {}),
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
 * Marker written into every event this app creates FROM a ScheduledBlock, via
 * Google's private extended properties (visible only to this app, never shown
 * to the user or synced to other clients).
 *
 * LEGACY ONLY. TaskFlow used to push each ScheduledBlock to Google Calendar as
 * an event, tagged with this private extended property (and, in older builds
 * still, only a "📋 " title prefix). That was removed — blocks are TaskFlow-only
 * now and nothing writes this marker anymore (see useGoogleCalendarSync.js's
 * module doc for why block-push was dropped).
 *
 * The marker is still READ, because block-events pushed by those older builds
 * can still be sitting on a user's real Google Calendar. `isBlockSourcedEvent`
 * below recognizes them so the sync never re-pushes one as a fresh event and
 * the rewrite never re-creates one. They are deliberately NOT deleted from
 * Google — they're the user's own calendar data to clean up (or keep) as they
 * see fit.
 */
export const TASKFLOW_BLOCK_PROPERTY_KEY = 'taskflowBlockId';

/**
 * True if an event is a leftover from when TaskFlow pushed ScheduledBlocks
 * (see TASKFLOW_BLOCK_PROPERTY_KEY). Pure/exported for unit testing.
 *
 * Matches both the tagged shape and the older one: events pushed before the
 * marker existed carry no extended property at all, so they're identified by
 * the "📋 " title prefix this app used to write. That fallback is deliberately
 * narrow (prefix only) and only ever used to SKIP pushing — never to delete
 * anything — so a user's own event that happens to start with the same emoji
 * is at worst left alone rather than harmed.
 */
export function isBlockSourcedEvent(event) {
  if (!event) return false;
  if (event.taskflowBlockId) return true;
  return typeof event.title === 'string' && event.title.startsWith('📋 ');
}

/**
 * The Google Calendar event resource for a CalendarEvent. Split out from
 * `pushEventToCalendar` below so the batched rewrite path
 * (`batchInsertCalendarEvents`) builds byte-identical resources instead of
 * maintaining a second, drift-prone copy of this mapping.
 */
export function buildCalendarEventResource(event) {
  return {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: { dateTime: `${event.date}T${event.startTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: `${event.date}T${event.endTime}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    recurrence: event.recurrenceRule ? [`RRULE:${event.recurrenceRule}`] : undefined,
  };
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
  const resource = buildCalendarEventResource(event);

  const resp = event.googleEventId
    ? await window.gapi.client.calendar.events.update({ calendarId, eventId: event.googleEventId, resource })
    : await window.gapi.client.calendar.events.insert({ calendarId, resource });

  // `updated` must never come back as `undefined` — Firestore's addDoc/setDoc
  // reject any field holding it outright, and this return value gets spread
  // straight into a CalendarEvent that can later land in a backup payload
  // (see every call site of this function). Google's API omits `updated` in
  // some response shapes, which without this normalization silently poisoned
  // local state with an `undefined` field until the next cloud backup failed.
  return { id: resp.result.id, updated: resp.result.updated ?? null };
}

/**
 * True if a failed `events.delete` call means the event is already gone on
 * Google's side (410 "Resource has been deleted", or 404 "Not Found" for a
 * delete issued after Google's own 410 window has passed) — i.e. exactly
 * the state a delete is trying to reach anyway. `deleteCalendarEvent` below
 * treats this as success rather than a real failure; without this, a delete
 * retried after it already succeeded (e.g. a duplicate click, or a stale
 * local row left over from an old sync bug whose Google copy is long gone)
 * surfaces as a scary console error for something that isn't actually wrong.
 *
 * `deleteCalendarEventInstance` deliberately does NOT use this — see its own
 * doc comment for why a 404 there needs to surface as a real failure instead.
 */
function isAlreadyGoneError(err) {
  return err?.status === 404 || err?.status === 410;
}

/**
 * True if a failed `events.delete` call against a CLIENT-CONSTRUCTED instance
 * id (see `buildInstanceEventId`) means the occurrence is genuinely already
 * gone. Only a 410 ("Gone") counts — that's Google confirming a real resource
 * it once had is now gone. A 404 ("Not Found") is deliberately NOT treated as
 * success here, unlike `isAlreadyGoneError` above: since `instanceId` is
 * computed client-side rather than a real id Google handed us, a 404 is
 * ambiguous between "already deleted" and "this constructed id never matched
 * anything on Google's side" (e.g. built from a stale/incorrect
 * `googleEventId`/`startTime`) — silently swallowing that second case as
 * success previously masked a real failure: the local optimistic delete
 * would stick, but nothing was actually removed on Google's side, so the
 * occurrence would reappear once the local suppression window elapsed with
 * no error ever shown.
 */
export function isInstanceAlreadyGoneError(err) {
  return err?.status === 410;
}

/**
 * Delete a pushed event (e.g. when a block is rescheduled/removed, or a
 * CalendarEvent is deleted locally). `calendarId` defaults to 'primary' but
 * must be passed explicitly for anything sourced from a non-primary (e.g.
 * subscribed) calendar, or the delete call targets the wrong calendar.
 */
export async function deleteCalendarEvent(googleEventId, calendarId = 'primary') {
  if (!gapiInited || !accessToken || !googleEventId) return;
  try {
    await window.gapi.client.calendar.events.delete({ calendarId, eventId: googleEventId });
  } catch (err) {
    if (isAlreadyGoneError(err)) return;
    throw err;
  }
}

/**
 * True if a recurring event's `events.instances()` result item IS the
 * occurrence originally scheduled for `occurrenceDateIso`/`masterStartTime`.
 * Google's `events.instances` returns each instance's *original* scheduled
 * start under `originalStartTime` whenever it's been individually moved/
 * edited (absent for an untouched instance, whose `start` still equals its
 * original slot) — checking `originalStartTime` first, falling back to
 * `start`, is what lets this match an occurrence by its ORIGINAL slot
 * regardless of whether that occurrence has since been moved elsewhere.
 *
 * Extracted as its own pure function (no `window.gapi` dependency) purely so
 * this comparison can be unit tested — see this file's own doc comment on why
 * the rest of the `events.instances` flow can't be.
 * @param {object} instance - one item from `events.instances()`'s `result.items`
 * @param {string} occurrenceDateIso - "YYYY-MM-DD", the occurrence's ORIGINAL date
 * @param {string} masterStartTime - "HH:MM", the MASTER's own (pre-override) start time
 * @returns {boolean}
 */
export function instanceMatchesOccurrence(instance, occurrenceDateIso, masterStartTime) {
  const dt = instance?.originalStartTime?.dateTime || instance?.start?.dateTime;
  if (!dt) return false;
  const date = new Date(dt);
  if (Number.isNaN(date.getTime())) return false;
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return toISODate(date) === occurrenceDateIso && hhmm === masterStartTime;
}

/**
 * Resolve the REAL Google Calendar id of a single occurrence of a recurring
 * event, via `events.instances()` — the documented, authoritative way to look
 * up an occurrence's actual id, rather than guessing it client-side (see this
 * function's own history: a prior client-side construction,
 * `{recurringEventId}_{originalStartTimeUTC}`, broke for a master that had
 * itself been split via "this and following" in Google's own UI, since a
 * split-off master's OWN id already carries a `_R{timestamp}` suffix and
 * appending a second suffix on top never matches anything Google has).
 *
 * Costs one extra read round-trip per single-occurrence delete/edit — an
 * acceptable, deliberate tradeoff for correctness over the old zero-round-trip
 * guess.
 *
 * @param {import('../types').CalendarEvent} master - the series' master row
 * @param {string} occurrenceDateIso - "YYYY-MM-DD", the occurrence's ORIGINAL date
 * @returns {Promise<string|null>} the real instance id, or null if no
 *   instance matching this date was found (e.g. already deleted on Google's side)
 */
async function resolveInstanceId(master, occurrenceDateIso) {
  const calendarId = master.calendarId || 'primary';
  const { timeMin, timeMax } = computeFetchTimeRange(occurrenceDateIso, occurrenceDateIso);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const resp = await window.gapi.client.calendar.events.instances({
    calendarId,
    eventId: master.googleEventId,
    timeMin,
    timeMax,
    timeZone,
  });
  const instances = resp.result.items || [];
  const match = instances.find((inst) => instanceMatchesOccurrence(inst, occurrenceDateIso, master.startTime));
  return match ? match.id : null;
}

/**
 * Push an edit to a SINGLE occurrence of a recurring Google event (scope
 * 'this' in SchedulerContext.updateEvent), resolving the occurrence's real id
 * via `resolveInstanceId` first. Uses `events.patch` (partial update) rather
 * than `.update` (full replace) so the instance's implicit link back to the
 * series is left untouched.
 *
 * `master` is the series' master row (carries `googleEventId`/`calendarId`);
 * `occurrenceDateIso` is the occurrence's ORIGINAL date (the overrides map
 * key); `fields` is the occurrence's full current field set AFTER merging in
 * whatever changed (title/description/location/date/startTime/endTime) — the
 * caller is expected to have already merged any pre-existing override with
 * the new edit, since a PATCH here still needs complete start/end dateTimes.
 *
 * Returns `{ id, updated }` like `pushEventToCalendar`, or null if not
 * connected or the master has no `googleEventId` yet (never pushed to
 * Google, so there's no series/instance to patch). Throws if no instance
 * matching `occurrenceDateIso` could be found — editing an occurrence that
 * doesn't exist (anymore) on Google's side is a real problem the caller
 * should surface, not silently swallow.
 * @param {import('../types').CalendarEvent} master
 * @param {string} occurrenceDateIso
 * @param {Partial<import('../types').CalendarEvent>} fields
 * @returns {Promise<{id: string, updated: string}|null>}
 */
export async function pushEventInstanceUpdate(master, occurrenceDateIso, fields) {
  if (!gapiInited || !accessToken || !master?.googleEventId) return null;

  const instanceId = await resolveInstanceId(master, occurrenceDateIso);
  if (!instanceId) {
    throw new Error(`Couldn't find this occurrence (${occurrenceDateIso}) on Google Calendar to update — it may have already been deleted or moved there.`);
  }

  const calendarId = master.calendarId || 'primary';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const resource = {
    summary: fields.title,
    description: fields.description || undefined,
    location: fields.location || undefined,
    start: { dateTime: `${fields.date}T${fields.startTime}:00`, timeZone },
    end: { dateTime: `${fields.date}T${fields.endTime}:00`, timeZone },
  };

  const resp = await window.gapi.client.calendar.events.patch({ calendarId, eventId: instanceId, resource });
  // See pushEventToCalendar's identical normalization above for why `?? null`
  // is required here.
  return { id: resp.result.id, updated: resp.result.updated ?? null };
}

/**
 * Delete a SINGLE occurrence of a recurring Google event (scope 'this' in
 * SchedulerContext.deleteEvent), resolving the occurrence's real id via
 * `resolveInstanceId` first. No-ops if not connected, the master has no
 * `googleEventId` yet, or no matching instance was found for this date (that
 * last case means there's nothing left to delete — treated the same as
 * already-deleted, mirroring `deleteCalendarEvent`'s 404/410 handling). If a
 * matching instance WAS found but the delete call itself still 410s (a race
 * between the lookup and the delete), that's also treated as success — see
 * `isInstanceAlreadyGoneError` above.
 * @param {import('../types').CalendarEvent} master
 * @param {string} occurrenceDateIso
 */
export async function deleteCalendarEventInstance(master, occurrenceDateIso) {
  if (!gapiInited || !accessToken || !master?.googleEventId) return;

  let instanceId;
  try {
    instanceId = await resolveInstanceId(master, occurrenceDateIso);
  } catch (err) {
    if (isAlreadyGoneError(err)) return; // the whole series is already gone on Google's side
    throw err;
  }
  if (!instanceId) return; // no matching occurrence found — already gone, nothing to delete

  const calendarId = master.calendarId || 'primary';
  try {
    await window.gapi.client.calendar.events.delete({ calendarId, eventId: instanceId });
  } catch (err) {
    if (isInstanceAlreadyGoneError(err)) return;
    throw err;
  }
}

/**
 * ============================================================================
 * "Rewrite Google Calendar to match TaskFlow" — planning
 * ============================================================================
 * A new, explicit, opt-in action (Settings, and an optional post-restore
 * follow-up) that flips the normal sync direction: instead of Google Calendar
 * always winning (see eventSyncService.js's module doc — the routine pull
 * policy), TaskFlow's own local data becomes authoritative and Google is
 * overwritten to match it. This is the one place in the app that deletes real
 * Google Calendar events on the user's behalf without them clicking delete on
 * each one individually, so the safety boundary below is deliberately
 * conservative and load-bearing:
 *
 * SAFETY BOUNDARY — PRIMARY CALENDAR ONLY, NEVER A SUBSCRIBED/FOREIGN ONE.
 * This app's own writes (pushEventToCalendar for the
 * common case) only ever target `calendarId: 'primary'` — TaskFlow has never
 * written to any other calendar the user can see (e.g. a subscribed lecture
 * timetable, or a shared team calendar they merely have writer/reader access
 * to). So the only calendar this feature is allowed to reconcile is 'primary'
 * — `planCalendarRewrite` below takes `googleEventsInRange` already
 * pre-filtered by the caller to `calendarId === 'primary'` (see its own
 * `@param` doc), and never even inspects `calendarId` itself; the filtering
 * happens one layer up so it's impossible for this function to accidentally
 * fold a non-primary event into `toDelete` even if a caller passed the wrong
 * variable. `computeCalendarRewritePlan` (the caller-facing wrapper) is the
 * only entry point that talks to `fetchEvents`, and it does the filtering.
 *
 * DELETE-ALL, NOT DIFF-BASED (changed deliberately — read before "optimizing"
 * it back). The original design was a diff: keep any Google event whose id was
 * still claimed by some local item's `googleEventId`, delete the rest, and
 * update-in-place the claimed ones. That protection rule is exactly what made
 * the feature unable to fix the problem it exists for. A historical
 * duplicate-push bug left users with TWO local rows for one logical event,
 * each carrying its own distinct-but-genuinely-valid `googleEventId` (because
 * Google really did have two physical copies). Both ids matched, so both
 * copies were "claimed", so both survived a rewrite that reported full success
 * — the duplicates were structurally immune to the very action meant to clear
 * them. Deduplicating local rows first only patched the CalendarEvent half of
 * that and left duplicate ScheduledBlocks (and any other unforeseen way local
 * state can disagree with itself) still able to protect a duplicate.
 *
 * So the rewrite no longer matches local state against Google's at all: it
 * deletes EVERY event in range on the primary calendar unconditionally, then
 * re-inserts every authoritative local item fresh. Nothing survives to be
 * wrongly protected, so no amount of local duplication or stale-id confusion
 * can leak a duplicate through. The costs of this are real and accepted:
 * an event created directly in Google Calendar on the primary calendar (never
 * synced from TaskFlow) is wiped too, and every kept event is re-created with
 * a brand-new id rather than updated in place. Both were explicitly accepted
 * by the user — this action already announces itself as "TaskFlow overwrites
 * Google", and it's opt-in behind a strong confirmation.
 * ============================================================================
 */

/**
 * Pure planning step: given the items TaskFlow considers authoritative for a
 * date range (already flattened to one list by the caller — see
 * rewriteGoogleCalendarFromTaskflow in useGoogleCalendarSync.js, which builds
 * this from current blocks+tasks and manual/already-synced events) and the
 * events Google's PRIMARY calendar currently has in that same range, compute
 * what to delete and what to insert to make Google match.
 *
 * Every in-range primary-calendar event goes into `toDelete`, unconditionally
 * — `authoritativeItems`' own `googleEventId`s are deliberately NOT consulted
 * to spare anything (see the DELETE-ALL note in the module doc above). Every
 * authoritative item then goes into `toInsert` as a fresh create, since after
 * the deletes there is by definition nothing left on Google to update against.
 *
 * @param {Array<Object>} authoritativeItems - local blocks/events to treat as
 *   truth, already filtered to the relevant date range by the caller. Passed
 *   through to `toInsert` untouched; no field on them affects the plan (in
 *   particular `googleEventId` no longer protects anything from deletion, and
 *   the old `needsPush: false` opt-out is gone — an event previously pulled
 *   from Google's primary calendar is about to be deleted along with
 *   everything else, so it genuinely does need re-inserting).
 * @param {Array<{id: string}>} googleEventsInRange - Google's OWN raw
 *   `events.list` items (not the app's mapped CalendarEvent shape) for the
 *   PRIMARY calendar only, in the same range — caller MUST have already
 *   filtered out every non-primary calendar's events before calling this;
 *   this function has no calendarId of its own to check and trusts its input.
 *   This is the ONLY thing standing between a subscribed/foreign calendar and
 *   deletion now that nothing else is protected, so it matters more than ever.
 * @returns {{ toDelete: string[], toInsert: Array<{item: Object}> }}
 */
export function planCalendarRewrite(authoritativeItems, googleEventsInRange) {
  // The destructive half: everything Google's primary calendar has in range,
  // with no "claimed by a local item" escape hatch. Only ever sees
  // pre-filtered primary-calendar input (see module doc above) — that filter
  // is now the sole safety boundary, since no per-event protection remains.
  const toDelete = googleEventsInRange.map((e) => e.id);

  // Everything local is a fresh insert. No isUpdate distinction exists
  // anymore: the deletes above run first and clear the calendar, so there is
  // nothing left to update against by the time these are pushed.
  const toInsert = authoritativeItems.map((item) => ({ item }));

  return { toDelete, toInsert };
}

/**
 * Fetch Google's current PRIMARY-calendar events in `[startIso, endIso]` and
 * compute a rewrite plan against `authoritativeItems` (already-flattened
 * local blocks/events, or a backup payload's equivalents, for that same
 * range). This is the only function that actually talks to Google's
 * `events.list` for this feature — the primary-calendar scoping happens here,
 * once, so `planCalendarRewrite` itself never needs to re-derive or trust a
 * `calendarId` check. Falls back to an empty Google-side list (mock/offline
 * mode) rather than throwing, so the caller can still preview/no-op safely
 * when not connected.
 *
 * The range stays bounded to what the authoritative items span rather than
 * fetching all history: a delete-all rewrite over an unbounded multi-year
 * window would quietly destroy years of primary-calendar history the user
 * never had in view, which is a far bigger blast radius than this feature
 * advertises. Bounded delete-all is already enough to fix the duplicate
 * problem this exists for (the duplicates always fall inside the range the
 * items themselves span).
 *
 * @param {Array<Object>} authoritativeItems
 * @param {string} startIso
 * @param {string} endIso
 * @returns {Promise<{ toDelete: string[], toInsert: Array<{item: Object}> }>}
 */
export async function computeCalendarRewritePlan(authoritativeItems, startIso, endIso) {
  if (!gapiInited || !accessToken) {
    // Not connected — nothing on Google to reconcile against. Every local
    // item just becomes an insert; nothing to delete.
    return planCalendarRewrite(authoritativeItems, []);
  }

  const { timeMin, timeMax } = computeFetchTimeRange(startIso, endIso);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const items = [];
  let pageToken;
  do {
    const resp = await window.gapi.client.calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      timeZone: localTimeZone,
      singleEvents: false,
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(resp.result.items || []));
    pageToken = resp.result.nextPageToken;
  } while (pageToken);
  // Same cancelled-instance exclusion as fetchEvents above — a tombstone
  // resource is already gone, so issuing a delete for it would just be a
  // wasted (and noisily-failing) API call.
  const liveItems = items.filter((e) => e.status !== 'cancelled');

  return planCalendarRewrite(authoritativeItems, liveItems);
}

/**
 * True if a gapi client error is a rate-limit (429) response — Google's
 * Calendar API returns this under sustained bursts (exactly what a rewrite's
 * batch of deletes+upserts can produce, unlike any existing single-item push
 * in this file). Distinct from `isAuthError` (401) above; checked the same
 * way (`err.status` first, falling back to the nested gapi error shape) for
 * consistency with the rest of this file's error handling.
 */
export function isRateLimitError(err) {
  const code = err?.status ?? err?.result?.error?.code;
  return code === 429;
}

/**
 * ============================================================================
 * Batched rewrite execution
 * ============================================================================
 * A delete-all rewrite (see planCalendarRewrite above) issues one API call per
 * event on the primary calendar plus one per authoritative local item — easily
 * several hundred calls for a real calendar. Done one at a time with the
 * pacing delay the executor needs to stay under Google's per-user rate limit,
 * that runs for minutes behind a blocking overlay.
 *
 * Google Calendar supports batching (`gapi.client.newBatch()`), which bundles
 * up to 50 sub-requests into ONE HTTP round-trip. That's the whole win here:
 * ~50x fewer round-trips, and the pacing delay is paid once per batch rather
 * than once per event.
 *
 * Two gapi batch behaviours drive the shape of the code below:
 *   - A batch resolves as a SINGLE promise whose `result` is keyed by the id
 *     given to `batch.add(request, { id })`. It does NOT reject when an
 *     individual sub-request fails — a failed sub-request just carries its own
 *     non-2xx `status`/`result.error` in that map. So per-item success/failure
 *     has to be read out of the map, not caught.
 *   - The batch as a WHOLE can still reject (network failure, auth, or a
 *     429 against the batch endpoint itself). That's handled one level up by
 *     the caller, which retries the whole batch.
 */

// Google's documented maximum sub-requests per batch request. Exceeding it
// makes the batch endpoint reject the whole call, so nothing here should ever
// build a bigger batch than this.
export const MAX_BATCH_SIZE = 50;

/**
 * Split `items` into consecutive chunks of at most `size`. Pure and exported
 * for unit testing (and so the executor's progress math can use the same chunk
 * count the executor actually iterates).
 */
export function chunkForBatch(items, size = MAX_BATCH_SIZE) {
  const safeSize = Math.max(1, Math.floor(size) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

/**
 * Normalize one gapi batch sub-response into a plain
 * `{ ok, status, error, result }`. Pure/exported for unit testing, since the
 * per-item success/failure tracking the rewrite reports to the user hangs
 * entirely off getting this classification right.
 *
 * A missing sub-response (id absent from the batch result map — shouldn't
 * happen, but a silently-dropped sub-request would otherwise read as success)
 * is treated as a failure rather than assumed fine.
 */
export function classifyBatchSubResponse(subResponse) {
  if (!subResponse) return { ok: false, status: 0, error: 'No response returned for this batch entry', result: null };
  const status = subResponse.status ?? subResponse.result?.error?.code ?? 0;
  // A delete whose target is already gone (404/410) is the state the delete
  // was trying to reach — same reasoning as isAlreadyGoneError for the
  // single-call path, applied here to a batch sub-response's own status.
  if (status >= 200 && status < 300) return { ok: true, status, error: null, result: subResponse.result };
  const message = subResponse.result?.error?.message || `HTTP ${status}`;
  return { ok: false, status, error: message, result: subResponse.result || null };
}

/**
 * True if a batch sub-response's status means "already gone" for a DELETE —
 * see `isAlreadyGoneError`'s doc comment for the single-call equivalent. A
 * delete-all rewrite hits this routinely (e.g. a recurring master and one of
 * its own instances both appearing in the fetched list, where deleting the
 * master already removed the instance), so it must count as success or a
 * normal rewrite would report dozens of phantom failures.
 */
function isBatchDeleteAlreadyGone(status) {
  return status === 404 || status === 410;
}

/**
 * Run one gapi batch of already-built request objects.
 * `entries` is `[{ id, request }]`; resolves to a Map of id -> the normalized
 * `{ ok, status, error, result }` from `classifyBatchSubResponse`.
 *
 * Rejects only if the batch call ITSELF fails (network/auth/429 on the batch
 * endpoint) — per-sub-request failures come back in the map, see the module
 * note above.
 */
async function executeBatch(entries) {
  const batch = window.gapi.client.newBatch();
  for (const { id, request } of entries) {
    batch.add(request, { id });
  }
  const response = await batch;
  const byId = response?.result || {};
  const out = new Map();
  for (const { id } of entries) {
    out.set(id, classifyBatchSubResponse(byId[id]));
  }
  return out;
}

/**
 * Delete up to MAX_BATCH_SIZE primary-calendar events in one batched HTTP
 * call. `googleEventIds` must already be scoped to the primary calendar by
 * the caller (see planCalendarRewrite's safety boundary) — this hardcodes
 * `calendarId: 'primary'` so a batch can never reach another calendar even if
 * a caller passed the wrong list.
 *
 * @param {string[]} googleEventIds
 * @returns {Promise<Map<string, {ok: boolean, status: number, error: string|null}>>}
 *   keyed by googleEventId.
 */
export async function batchDeleteCalendarEvents(googleEventIds) {
  if (!gapiInited || !accessToken) return new Map(googleEventIds.map((id) => [id, { ok: true, status: 200, error: null }]));

  const entries = googleEventIds.map((googleEventId) => ({
    id: googleEventId,
    // PRIMARY ONLY — hardcoded, never taken from the item. See above.
    request: window.gapi.client.calendar.events.delete({ calendarId: 'primary', eventId: googleEventId }),
  }));
  const results = await executeBatch(entries);
  // Fold "already gone" into success — see isBatchDeleteAlreadyGone.
  for (const [id, res] of results) {
    if (!res.ok && isBatchDeleteAlreadyGone(res.status)) results.set(id, { ...res, ok: true, error: null });
  }
  return results;
}

/**
 * Insert up to MAX_BATCH_SIZE events onto the PRIMARY calendar in one batched
 * HTTP call. Every entry is a fresh insert (the rewrite deleted everything
 * first, so there is nothing to update against — see planCalendarRewrite).
 *
 * @param {Array<{id: string, resource: Object}>} inserts - `id` is the
 *   CALLER's own local id for the item (block id / event id), used to key the
 *   returned map so the caller can stamp the resulting googleEventId back onto
 *   the right local record.
 * @returns {Promise<Map<string, {ok: boolean, status: number, error: string|null, googleEventId: string|null}>>}
 */
export async function batchInsertCalendarEvents(inserts) {
  if (!gapiInited || !accessToken) {
    console.info('[googleCalendarService] Not authorized — skipping batch insert (mock mode).');
    return new Map(inserts.map(({ id }) => [id, { ok: true, status: 200, error: null, googleEventId: null }]));
  }

  const entries = inserts.map(({ id, resource }) => ({
    id,
    // PRIMARY ONLY — the rewrite's authoritative set is by definition what
    // belongs on the user's own primary calendar (see the caller's own
    // primaryEvents filter), so this is hardcoded rather than per-item.
    request: window.gapi.client.calendar.events.insert({ calendarId: 'primary', resource }),
  }));
  const results = await executeBatch(entries);
  const out = new Map();
  for (const [id, res] of results) {
    out.set(id, { ...res, googleEventId: res.ok ? res.result?.id ?? null : null });
  }
  return out;
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
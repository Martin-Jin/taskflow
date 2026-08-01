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
        const resp = await window.gapi.client.calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          timeZone: localTimeZone,
          singleEvents: false,
        });
        return (resp.result.items || []).map((e) => ({ ...e, __calendarId: cal.id, __calendarName: cal.summary, __accessRole: cal.accessRole }));
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

  const events = perCalendarResults
    .flat()
    // Google's events.list defaults to `showDeleted: false`, which normally
    // means a deleted event is simply absent from the response — that's what
    // mergePulledGoogleEvents' deletion-detection relies on. But per Google's
    // own API docs, a CANCELLED INSTANCE of a recurring event (e.g. the
    // Google-minted `{recurringEventId}_{originalStartTimeUTC}` resource left
    // behind after a single-occurrence delete or edit — see
    // buildInstanceEventId above) can still come back even with showDeleted
    // false, carrying `status: 'cancelled'` but a start/end time inherited
    // from before cancellation. Without this filter, that tombstone slips
    // through as if it were a live, ordinary one-off event (recurrence is
    // absent on the instance resource itself, so it looks exactly like a
    // plain singular event) — a deleted event that never actually disappears
    // no matter how many times it's re-deleted (its own real API delete
    // already returned 404/410 the first time, which deleteCalendarEvent
    // correctly treats as already-gone and stops retrying).
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
 * True if a failed `events.delete` call means the event is already gone on
 * Google's side (410 "Resource has been deleted", or 404 "Not Found" for a
 * delete issued after Google's own 410 window has passed) — i.e. exactly
 * the state a delete is trying to reach anyway. Both callers below treat
 * this as success rather than a real failure; without this, a delete
 * retried after it already succeeded (e.g. a duplicate click, or a stale
 * local row left over from an old sync bug whose Google copy is long gone)
 * surfaces as a scary console error for something that isn't actually wrong.
 */
function isAlreadyGoneError(err) {
  return err?.status === 404 || err?.status === 410;
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
 * Build the deterministic Google Calendar id for a SINGLE modified instance
 * of a recurring event: `{recurringEventId}_{originalStartTimeUTC}`, where
 * `originalStartTimeUTC` is that occurrence's ORIGINAL (pre-override)
 * scheduled start time in combined UTC basic format — "YYYYMMDDTHHMMSSZ", no
 * dashes/colons. Google mints this id once, from the instance's *original*
 * time, and it never changes even after the instance is later moved/edited —
 * so it can be constructed client-side without first listing instances via
 * `singleEvents: true`.
 *
 * `occurrenceDateIso` + `masterStartTime` MUST be the occurrence's ORIGINAL
 * date/time (the RRULE-generated date, and the MASTER row's own DTSTART
 * time-of-day) — never a moved/overridden date or time — or the constructed
 * id won't match the instance Google actually has on file.
 *
 * Assumes a timed (non-all-day) occurrence: `fetchEvents` above filters out
 * all-day events entirely (`.filter((e) => e.start?.dateTime)`), so every
 * CalendarEvent in this app always has a startTime and this app never needs
 * the date-only ("YYYYMMDD", no time/Z suffix) id variant Google uses for
 * all-day recurring instances.
 *
 * @param {string} masterGoogleEventId - the recurring series' own (real) Google event id
 * @param {string} occurrenceDateIso - "YYYY-MM-DD", the occurrence's ORIGINAL date
 * @param {string} masterStartTime - "HH:MM", the MASTER's own (pre-override) start time
 * @returns {string}
 */
export function buildInstanceEventId(masterGoogleEventId, occurrenceDateIso, masterStartTime) {
  // No trailing 'Z'/offset -> parsed as LOCAL wall-clock time (matches how
  // every other dateTime string in this file is built, e.g. pushEventToCalendar
  // below), then read back off the Date object in UTC for the id — Google
  // always encodes the instance id's time component in UTC regardless of the
  // event's own timezone.
  const localDate = new Date(`${occurrenceDateIso}T${masterStartTime}:00`);
  const pad2 = (n) => String(n).padStart(2, '0');
  const utcStamp =
    `${localDate.getUTCFullYear()}${pad2(localDate.getUTCMonth() + 1)}${pad2(localDate.getUTCDate())}` +
    `T${pad2(localDate.getUTCHours())}${pad2(localDate.getUTCMinutes())}${pad2(localDate.getUTCSeconds())}Z`;
  return `${masterGoogleEventId}_${utcStamp}`;
}

/**
 * Push an edit to a SINGLE occurrence of a recurring Google event (scope
 * 'this' in SchedulerContext.updateEvent) via the deterministic instance-id
 * mechanism above, instead of the local-only fallback this used to require.
 * Uses `events.patch` (partial update) rather than `.update` (full replace)
 * so the instance's implicit link back to the series is left untouched.
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
 * Google, so there's no series/instance to patch).
 * @param {import('../types').CalendarEvent} master
 * @param {string} occurrenceDateIso
 * @param {Partial<import('../types').CalendarEvent>} fields
 * @returns {Promise<{id: string, updated: string}|null>}
 */
export async function pushEventInstanceUpdate(master, occurrenceDateIso, fields) {
  if (!gapiInited || !accessToken || !master?.googleEventId) return null;

  const instanceId = buildInstanceEventId(master.googleEventId, occurrenceDateIso, master.startTime);
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
  return { id: resp.result.id, updated: resp.result.updated };
}

/**
 * Delete a SINGLE occurrence of a recurring Google event (scope 'this' in
 * SchedulerContext.deleteEvent) via the same deterministic instance-id
 * mechanism as `pushEventInstanceUpdate` above. No-ops if not connected or
 * the master has no `googleEventId` yet, mirroring `deleteCalendarEvent`.
 * @param {import('../types').CalendarEvent} master
 * @param {string} occurrenceDateIso
 */
export async function deleteCalendarEventInstance(master, occurrenceDateIso) {
  if (!gapiInited || !accessToken || !master?.googleEventId) return;
  const instanceId = buildInstanceEventId(master.googleEventId, occurrenceDateIso, master.startTime);
  const calendarId = master.calendarId || 'primary';
  try {
    await window.gapi.client.calendar.events.delete({ calendarId, eventId: instanceId });
  } catch (err) {
    if (isAlreadyGoneError(err)) return;
    throw err;
  }
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
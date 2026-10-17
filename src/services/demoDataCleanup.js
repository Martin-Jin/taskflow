/**
 * ============================================================================
 * DEMO DATA CLEANUP
 * ============================================================================
 * Finds the sample events and tasks (mockData.js) that a signed-in account
 * should never hold.
 *
 * **Why it exists.** A browser with no saved TaskFlow data (a new device, a
 * new browser profile, cleared site data) starts with sample data so a
 * signed-out visitor has something to look at. The app seeds it before it
 * knows whether someone is signed in. When that person then signs in:
 *   - cross-device sync merges the sample rows into their real account, since
 *     it keeps any row that only one side has;
 *   - the Google Calendar push then copies the sample events (a "Design
 *     Conference", a "Dentist Appointment", ...) onto their real calendar.
 *
 * **What it does.** Returns the ids of live sample rows, so the caller can
 * delete them the ordinary way (as tombstones — rows marked deleted rather
 * than removed — that sync to every other device).
 *
 * **Why this approach.** Not seeding sample data at all for a signed-in
 * user would be cleaner, but sign-in is only known after the app has
 * already loaded its starting data. Cleaning up afterwards also repairs
 * accounts the sample data already reached.
 *
 * A row counts as sample data only when BOTH its id and its title still
 * match the sample — a sample row the user renamed and kept using is
 * treated as theirs and left alone. Sample projects and sections are not
 * touched for the same reason: someone may have filed real tasks in "Work".
 *
 * **Limitations.** A sample event that reached Google and was then pulled
 * back under Google's id is matched through that id, which TaskFlow chose
 * itself when pushing it (see taskflowGoogleEventId), so it is never a real
 * event the user created on Google.
 * ============================================================================
 */

import { getMockEvents, getMockTasks } from './mockData';
import { taskflowGoogleEventId } from './googleCalendarService';

/**
 * Ids of live (not deleted) events in `events` that are sample events.
 * @param {import('../types').CalendarEvent[]} events
 * @returns {string[]}
 */
export function findDemoEventIds(events) {
  const titleByKey = new Map();
  for (const demo of getMockEvents()) {
    titleByKey.set(demo.id, demo.title);
    titleByKey.set(taskflowGoogleEventId(demo.id), demo.title);
  }
  return events
    .filter((e) => !e.deletedAt)
    .filter((e) => {
      const title = titleByKey.get(e.id) ?? titleByKey.get(e.googleEventId);
      return title !== undefined && e.title === title;
    })
    .map((e) => e.id);
}

/**
 * Ids of live (not deleted) tasks in `tasks` that are sample tasks.
 * @param {import('../types').Task[]} tasks
 * @returns {string[]}
 */
export function findDemoTaskIds(tasks) {
  const titleById = new Map(getMockTasks().map((t) => [t.id, t.title]));
  return tasks.filter((t) => !t.deletedAt && titleById.get(t.id) === t.title).map((t) => t.id);
}

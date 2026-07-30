/**
 * Notes are organized the same way the old bookmark-style pinned links were:
 * a flat list of user-defined folders plus notes that each belong to exactly
 * one folder. Kept as plain data (no class) so it round-trips through
 * usePersistedState/localStorage with no extra (de)serialization step.
 *
 * A note is just a title + freeform text body — no separate URL field. If a
 * user pastes a link as the body, it renders as a clickable link inline via
 * the same auto-linkify path used for task descriptions (see
 * Common/Linkified.jsx + utils/linkify.js) rather than a dedicated "link"
 * data shape.
 */

import { nextLabelColor } from '../../utils/labelColor';

export const DEFAULT_FOLDER_ID = 'default';

export const DEFAULT_NOTES = {
  folders: [{ id: DEFAULT_FOLDER_ID, name: 'Notes' }],
  notes: [],
};

export function faviconUrl(url) {
  try {
    const { hostname } = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return null;
  }
}

export function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Loose equality key for de-duping a note's URL body against other notes'
 * bodies — ignores protocol, trailing slash, and case, so "http://x.com" and
 * "https://x.com/" are treated as the same bookmark. Only meaningful for
 * notes whose whole body is a URL (imports/migration); harmless (just an
 * unlikely-to-collide string) otherwise.
 */
export function dedupeKey(url) {
  try {
    const u = new URL(normalizeUrl(url));
    return `${u.hostname}${u.pathname}${u.search}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Parses a browser-exported bookmarks HTML file (Netscape Bookmark File
 * Format, used by both Firefox and Chrome). The format is a loose <DL>/<DT>
 * tree where each folder is introduced by a <DT><H3> before its own <DL>,
 * but browsers don't parse it as strict, well-formed HTML — rather than
 * relying on exact <dl>/<dt> nesting (which varies subtly between
 * exporters), this walks every <h3>/<a> element in document order and
 * assigns each link to the most recently seen folder heading, which holds
 * regardless of how the tree actually nests.
 */
export function parseBookmarksHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body || doc;
  const nodes = root.querySelectorAll('h3, a');
  let currentFolder = null;
  const results = [];
  nodes.forEach((el) => {
    if (el.tagName === 'H3') {
      currentFolder = el.textContent.trim() || null;
      return;
    }
    const href = el.getAttribute('href');
    if (!href) return; // separators and other non-link <a> tags
    const label = el.textContent.trim() || href;
    results.push({ label, url: href, folderName: currentFolder });
  });
  return results;
}

/** Most recently touched notes across all folders, newest first — "touched" is edit time if the note's ever been edited, otherwise creation time. */
export function recentNotes(data, count = 5) {
  return data.notes
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, count);
}

/**
 * ONE-TIME MIGRATION — safe to delete once no user's localStorage/Firestore
 * doc can still hold the old `{ folders, links }` shape (i.e. once every
 * active user has loaded a version with this migration at least once).
 *
 * Converts the old bookmark-style pinned-links data into notes: each link's
 * label becomes the note's title, its url becomes the note's body (so it
 * stays clickable via the same linkify path notes use generally). Folders
 * carry over unchanged, same ids and names.
 */
export function migrateLinksToNotes(oldData) {
  if (!oldData || !Array.isArray(oldData.links)) return null;
  return {
    folders: oldData.folders,
    notes: oldData.links.map((link, i) => ({
      id: link.id,
      title: link.label,
      body: link.url,
      folderId: link.folderId,
      color: nextLabelColor(i),
      createdAt: link.createdAt,
      updatedAt: link.createdAt,
    })),
  };
}

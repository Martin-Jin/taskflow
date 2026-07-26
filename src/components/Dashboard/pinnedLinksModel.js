/**
 * Pinned links are organized like browser bookmarks: a flat list of
 * user-defined folders plus links that each belong to exactly one folder.
 * Kept as plain data (no class) so it round-trips through
 * usePersistedState/localStorage with no extra (de)serialization step.
 */

export const DEFAULT_FOLDER_ID = 'default';

export const DEFAULT_PINNED_LINKS = {
  folders: [{ id: DEFAULT_FOLDER_ID, name: 'Links' }],
  links: [],
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
 * Loose equality key for de-duping links against each other — ignores
 * protocol, trailing slash, and case, so "http://x.com" and "https://x.com/"
 * are treated as the same bookmark.
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

/** Most recently added links across all folders, newest first. */
export function recentLinks(data, count = 5) {
  return data.links
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, count);
}

/** Most recently opened links across all folders, newest first. Links never opened are excluded. */
export function jumpBackInLinks(data, count = 5) {
  return data.links
    .filter((l) => l.lastOpenedAt)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, count);
}

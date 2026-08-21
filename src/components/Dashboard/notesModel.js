/**
 * Notes are organized the same way the old bookmark-style pinned links were:
 * a flat list of user-defined folders plus notes that each belong to exactly
 * one folder. Kept as plain data (no class) so it round-trips through
 * SchedulerContext/Firestore sync with no extra (de)serialization step.
 *
 * A note is a title + a markdown-formatted body (edited via
 * NoteEditorModal's Tiptap instance, see that file), no separate URL field —
 * if a user pastes a link, it still renders as a clickable link via Tiptap's
 * own Link extension (in the editor) or the auto-linkify path (in the
 * collapsed tile preview, see Common/Linkified.jsx + utils/linkify.js).
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

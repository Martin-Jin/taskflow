/**
 * useSharedContentIntent — turns the URL the app was *launched* with into a
 * one-shot "open this modal, prefilled" instruction.
 *
 * Two launch routes feed this, both declared in `public/manifest.json`:
 *   - the **share target**: another app shares text/a link to TaskFlow, which
 *     arrives as `?title=&text=&url=` (GET, so no service worker needed — see
 *     README/docs on why this app deliberately has none).
 *   - the **app shortcuts**: long-pressing the installed icon offers
 *     "Add task"/"Add note", which launch `?add=task` / `?add=note`.
 *
 * The query string is consumed exactly once and then stripped with
 * `history.replaceState`, so a refresh (or the back button) doesn't reopen the
 * same modal with the same content and tempt a duplicate task. That's also why
 * the parse happens in a mount effect keyed on nothing: the intent belongs to
 * the launch, not to any later render.
 */

import { useEffect, useState } from 'react';

/** Longest shared text still treated as a title rather than moved into notes. */
const MAX_TITLE_LENGTH = 120;

/**
 * Pure half, exported for tests: map the launch query string onto an intent.
 * Returns null when there's nothing to act on.
 *
 * @param {string} search - e.g. "?title=Read+this&url=https://example.com"
 * @returns {{kind: 'task', title: string, notes: string} | {kind: 'note'} | null}
 */
export function parseSharedContentIntent(search) {
  const params = new URLSearchParams(search || '');

  // Shortcuts first: an explicit ?add= is unambiguous and carries no payload.
  const add = params.get('add');
  if (add === 'note') return { kind: 'note' };
  if (add === 'task') return { kind: 'task', title: '', notes: '' };

  const sharedTitle = (params.get('title') || '').trim();
  const sharedText = (params.get('text') || '').trim();
  const sharedUrl = (params.get('url') || '').trim();
  if (!sharedTitle && !sharedText && !sharedUrl) return null;

  /* Android fills these inconsistently: sharing a browser tab tends to give
     title + url, sharing from a notes app gives only text, and some apps put
     the link in `text` with no `url` at all. So: prefer a real title, fall
     back to the text's first line, and keep whatever didn't become the title
     as notes rather than discarding it. */
  const [firstLine, ...restLines] = sharedText.split('\n');
  let title = sharedTitle;
  let notes = '';

  if (title) {
    notes = sharedText;
  } else if (firstLine.length <= MAX_TITLE_LENGTH) {
    title = firstLine.trim();
    notes = restLines.join('\n').trim();
  } else {
    // One long blob — a paragraph makes a bad title, so it all becomes notes
    // and the user names the task themselves.
    notes = sharedText;
  }

  /* Appended to the title, not assigned to `link` directly, so smart-parse
     detects it the same way a typed URL is: it strips the URL out of the title
     into the task's own `link` field and shows a removable chip for it. Skipped
     when the text already contains it, which is common — plenty of apps put the
     same URL in both `text` and `url`. */
  if (sharedUrl && !title.includes(sharedUrl) && !notes.includes(sharedUrl)) {
    title = title ? `${title} ${sharedUrl}` : sharedUrl;
  }

  return { kind: 'task', title: title.trim(), notes: notes.trim() };
}

export function useSharedContentIntent() {
  const [intent, setIntent] = useState(null);

  useEffect(() => {
    const parsed = parseSharedContentIntent(window.location.search);
    if (!parsed) return;
    setIntent(parsed);
    // Drop the params so this can't fire twice for one shared item.
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }, []);

  return { intent, clearIntent: () => setIntent(null) };
}

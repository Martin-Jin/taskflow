/**
 * linkify — splits free text into alternating text/link segments so plain
 * URLs typed into notes can be rendered as clickable <a> tags. Deliberately
 * conservative (stops at whitespace and trailing punctuation) rather than a
 * full URL-spec parser — good enough for user-typed notes.
 *
 * BARE DOMAINS (no "http(s)://" or "www." prefix, e.g. a job posting URL
 * copied as "example.com/careers/123"): matched only when a "/" path
 * follows the domain. Requiring a path (rather than linkifying any
 * "word.word"-shaped text) is what keeps this from false-positiving on
 * ordinary prose with no slash after it ("e.g.", "as of Jan. 2025",
 * "version 2.5.1") while still catching the realistic case of a pasted URL
 * whose scheme got stripped by whatever the user copied it from.
 */

// Exported as a source string (not a compiled regex) so other modules —
// namely smartParse.js's findLinkPhrase — can build their own instance with
// different flags instead of copy-pasting the pattern and risking the two
// silently drifting apart.
export const URL_PATTERN_SOURCE =
  "(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?'\"]" +
  "|www\\.[^\\s<>()]+[^\\s<>().,;:!?'\"]" +
  "|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,24}\\/[^\\s<>()]*[^\\s<>().,;:!?'\"])";

const URL_REGEX = new RegExp(URL_PATTERN_SOURCE, 'gi');

/** True for a matched URL that has no explicit scheme yet ("www.…" or a bare "domain.tld/…") and needs one added before it's a valid href. */
export function needsScheme(value) {
  return !/^https?:\/\//i.test(value);
}

export function linkify(text) {
  if (!text) return [];

  const segments = [];
  let lastIndex = 0;
  let match;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const value = match[0];
    const href = needsScheme(value) ? `https://${value}` : value;
    segments.push({ type: 'link', value, href });
    lastIndex = match.index + value.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

export function containsLink(text) {
  if (!text) return false;
  URL_REGEX.lastIndex = 0;
  return URL_REGEX.test(text);
}

/** Short display label for a task's `link` field — the bare hostname reads better than a full URL in a chip/badge. */
export function linkLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

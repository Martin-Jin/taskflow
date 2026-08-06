/**
 * Small display helpers shared by every surface that renders a collaborator/
 * viewer avatar (PresenceAvatars, SharedProjectBadge, ShareProjectModal) —
 * pulled out here after the same two functions were duplicated verbatim in
 * all three.
 */

/**
 * Only http(s) image URLs are ever put in an <img src>; anything else falls
 * back to initials.
 *
 * SECURITY: `photoURL` is user-supplied (an anonymous visitor picks their own
 * name/photo). `firestore.rules` length-caps it but can't check its scheme —
 * a `javascript:`/`data:` URL here is exactly the kind of thing this guards
 * against before it ever reaches an <img src>.
 */
export function isSafePhotoURL(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Initials fallback for an avatar with no (safe) photo — first+last initial, or '?' if empty. */
export function initialsOf(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Thin, defensive wrapper around the browser Notification API (TODO.md #10,
 * Phase 2 — in-app notifications). Every export here guards against the API
 * being unavailable (older/mobile browsers, non-secure contexts) so callers
 * never need their own `typeof Notification` checks — they just get `false`/
 * a no-op back and fall through to the in-app Toast fallback instead.
 */

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission() {
  return isNotificationSupported() ? Notification.permission : 'unsupported';
}

// Requests permission only if the user hasn't already decided ('default').
// Never re-prompts once granted or denied — browsers won't show a second
// prompt anyway once denied, so this just avoids a pointless call. Intended
// to be invoked directly from a user action (e.g. flipping a Settings
// toggle), never on app load, so the permission dialog is never a surprise.
export async function requestNotificationPermission() {
  if (!isNotificationSupported() || typeof Notification.requestPermission !== 'function') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Fires a native Notification if supported and permitted. Returns true if it
// fired, false otherwise — callers use the return value to decide whether to
// fall back to the in-app Toast.
export function fireNotification(title, options) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return false;
  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

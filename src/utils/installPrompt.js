/**
 * Captures the browser's `beforeinstallprompt` event (Chrome/Edge/Android)
 * at module load time — it fires once, early, regardless of whether the
 * Settings panel (the only place that offers an "Install app" button) has
 * mounted yet, so it has to be listened for here rather than in that
 * component. `preventDefault()` suppresses the browser's own mini-infobar
 * so we can trigger the same native prompt later, from our own button.
 * Module-level singleton + plain subscriber list (not a Context) since this
 * needs to start listening before any provider tree exists.
 */

let deferredPrompt = null;
const listeners = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    listeners.forEach((fn) => fn(deferredPrompt));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((fn) => fn(null));
  });
}

export function getInstallPrompt() {
  return deferredPrompt;
}

export function subscribeInstallPrompt(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Consumes the captured event (each `prompt()` can only be used once). */
export async function triggerInstallPrompt() {
  if (!deferredPrompt) return null;
  const promptEvent = deferredPrompt;
  deferredPrompt = null;
  listeners.forEach((fn) => fn(null));
  promptEvent.prompt();
  return promptEvent.userChoice;
}

// iOS has no beforeinstallprompt (Safari never fires it) — the only option
// there is showing users the manual Share-sheet steps instead.
export const IS_IOS =
  typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

export function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/**
 * Dynamically loads an external <script> tag, resolving once it's ready.
 * Safe to call multiple times with the same src — later calls resolve
 * immediately instead of injecting a duplicate tag. Shared by
 * googleCalendarService.js and AuthContext.jsx, which both need the Google
 * Identity Services script (`https://accounts.google.com/gsi/client`).
 *
 * A tag that FAILED to load is removed from the DOM before rejecting, so a
 * later retry re-injects rather than matching the dead tag and resolving
 * immediately against a global that was never defined. Without this, the
 * caller's next attempt "succeeds" at loading and then throws a confusing
 * TypeError on `window.gapi`/`window.google` instead — which made retrying a
 * cold-start script failure (see useGoogleCalendarSync's silent re-auth
 * ladder) pointless.
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

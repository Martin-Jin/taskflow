/**
 * Dynamically loads an external <script> tag, resolving once it's ready.
 * Safe to call multiple times with the same src — later calls resolve
 * immediately instead of injecting a duplicate tag. Shared by
 * googleCalendarService.js and AuthContext.jsx, which both need the Google
 * Identity Services script (`https://accounts.google.com/gsi/client`).
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

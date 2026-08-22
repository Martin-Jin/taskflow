import React, { useEffect, useRef, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  getInstallPrompt,
  subscribeInstallPrompt,
  triggerInstallPrompt,
  IS_IOS,
  isRunningStandalone,
} from '../../utils/installPrompt';

/**
 * One-time (dismissible, then never again) nudge to add TaskFlow to the
 * home screen — see index.html/manifest.json for the standalone-mode setup
 * this unlocks. Only worth showing on mobile web; once actually launched
 * from a home-screen icon (isStandalone), there's nothing left to offer.
 *
 * Unlike its neighbours in .floating-notifications, this one is PERSISTENT —
 * it stays until dismissed rather than timing out. A fixed element that never
 * leaves has to be accounted for in layout, or it permanently covers the
 * bottom of every scrollable page: `.main-content`'s mobile padding only
 * reserves room for the bottom tab bar, so the last ~80px of content (more on
 * iOS, where the longer text wraps) simply could not be scrolled into view
 * while the banner was up. It therefore measures itself into
 * `--install-banner-height` on <html>, which that padding adds on. Measured
 * rather than hardcoded because the text wraps to a different number of lines
 * per platform and viewport width.
 */
export default function InstallAppBanner() {
  const isMobile = useIsMobile();
  const [dismissed, setDismissed] = usePersistedState('addToHomeScreenDismissed', false);
  const [installPromptEvent, setInstallPromptEvent] = useState(() => getInstallPrompt());
  const ref = useRef(null);

  useEffect(() => subscribeInstallPrompt(setInstallPromptEvent), []);

  const isHidden = !isMobile || dismissed || isRunningStandalone();

  /* Publish this banner's real height so `.main-content` can reserve room for
     it (see the class doc above). Kept in an effect that runs even when
     hidden, so dismissing it releases the space rather than stranding the
     padding — the early return below would otherwise skip the cleanup. */
  useEffect(() => {
    const root = document.documentElement;
    if (isHidden) {
      root.style.removeProperty('--install-banner-height');
      return undefined;
    }
    const el = ref.current;
    if (!el) return undefined;

    function measure() {
      root.style.setProperty('--install-banner-height', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--install-banner-height');
    };
  }, [isHidden]);

  if (isHidden) return null;

  async function handleInstall() {
    const choice = await triggerInstallPrompt();
    if (choice) setDismissed(true);
  }

  return (
    <div className="toast install-app-banner" ref={ref}>
      {IS_IOS ? (
        <span style={{ flex: 1 }}>
          Add TaskFlow to your Home Screen (Share <Share size={12} style={{ verticalAlign: -1 }} /> → Add to Home
          Screen) for the full-screen app experience.
        </span>
      ) : (
        <span style={{ flex: 1 }}>Install TaskFlow for the full-screen app experience.</span>
      )}
      {!IS_IOS && installPromptEvent && (
        <button
          className="btn btn-icon"
          onClick={handleInstall}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
        >
          <Download size={14} />
          Install
        </button>
      )}
      <button
        className="btn btn-icon"
        style={{ padding: 2, border: 'none', background: 'none' }}
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
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
 */
export default function InstallAppBanner() {
  const isMobile = useIsMobile();
  const [dismissed, setDismissed] = usePersistedState('addToHomeScreenDismissed', false);
  const [installPromptEvent, setInstallPromptEvent] = useState(() => getInstallPrompt());

  useEffect(() => subscribeInstallPrompt(setInstallPromptEvent), []);

  if (!isMobile || dismissed || isRunningStandalone()) return null;

  async function handleInstall() {
    const choice = await triggerInstallPrompt();
    if (choice) setDismissed(true);
  }

  return (
    <div className="toast install-app-banner">
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

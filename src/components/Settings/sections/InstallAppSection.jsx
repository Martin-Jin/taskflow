/**
 * Settings → Install app — PWA "add to home screen" entry point. Only
 * renders on mobile web that isn't already running standalone (installed);
 * returns null otherwise, so this card simply doesn't appear rather than the
 * parent needing to know that gating logic.
 */

import React, { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { getInstallPrompt, subscribeInstallPrompt, triggerInstallPrompt, IS_IOS, isRunningStandalone } from '../../../utils/installPrompt';

export default function InstallAppSection({ sectionRef }) {
  const isMobile = useIsMobile();
  const [installPromptEvent, setInstallPromptEvent] = useState(() => getInstallPrompt());
  useEffect(() => subscribeInstallPrompt(setInstallPromptEvent), []);

  if (!isMobile || isRunningStandalone()) return null;

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Install app</h3>
      <p className="settings-hint">Add TaskFlow to your home screen to launch it full-screen, without the browser's address bar.</p>
      {IS_IOS ? (
        <p style={{ fontSize: 12, marginBottom: 0 }}>
          Tap the Share icon <Share size={12} style={{ verticalAlign: -1 }} /> in Safari, then "Add to Home Screen".
        </p>
      ) : installPromptEvent ? (
        <button className="btn settings-inline" onClick={() => triggerInstallPrompt()}>
          <Download size={14} />
          Add to home screen
        </button>
      ) : (
        <p style={{ fontSize: 12, marginBottom: 0 }}>Open your browser's menu and look for "Add to Home screen" or "Install app".</p>
      )}
    </div>
  );
}

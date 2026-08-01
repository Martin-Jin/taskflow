/**
 * GoogleSignInButton — shared "Sign in with Google" entry point, used by
 * both AccountButton (sidebar/topbar) and SettingsPanel's Account & sync
 * card. Renders Google's own Identity Services button (see
 * AuthContext.jsx's renderGoogleSignInButton for why: it's the one sign-in
 * mechanism that doesn't rely on window.open() actually producing a real
 * popup, which several mobile browsers don't reliably do), falling back to
 * our own button + a prompt to open TaskFlow in a regular browser in
 * standalone/home-screen mode, where nothing OAuth-related works in-place.
 *
 * The real GIS button is only mounted after the user clicks a plain button
 * of ours first, rather than always-on — Chrome shows its own floating
 * "Sign in as <name>" account-chooser bubble next to any rendered GIS
 * button as soon as it mounts if the browser has an active Google session,
 * which otherwise overlapped nearby sidebar UI on every load while signed out.
 */

import { useEffect, useRef, useState } from 'react';
import { LogIn } from 'lucide-react';
import { useAuth, renderGoogleSignInButton } from '../../context/AuthContext';
import { isRunningStandalone } from '../../utils/installPrompt';
import BrowserSignInPromptModal from '../Modals/BrowserSignInPromptModal';

/**
 * @param {{ compact?: boolean }} props
 */
export default function GoogleSignInButton({ compact = false }) {
  const { handleGoogleCredential } = useAuth();
  const containerRef = useRef(null);
  const standalone = isRunningStandalone();
  const [showBrowserPrompt, setShowBrowserPrompt] = useState(false);
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (standalone || !activated || !containerRef.current) return;
    renderGoogleSignInButton(containerRef.current, handleGoogleCredential, {
      type: compact ? 'icon' : 'standard',
      size: compact ? 'medium' : 'large',
    }).catch((err) => console.error('[GoogleSignInButton] Failed to render', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, standalone, activated]);

  if (standalone) {
    return (
      <>
        <button
          className={`btn ${compact ? 'btn-icon' : ''}`}
          style={compact ? undefined : { width: '100%', justifyContent: 'center' }}
          onClick={() => setShowBrowserPrompt(true)}
          title="Sign in with Google to sync across devices"
        >
          <LogIn size={15} />
          {!compact && 'Sign in with Google'}
        </button>
        {showBrowserPrompt && (
          <BrowserSignInPromptModal onClose={() => setShowBrowserPrompt(false)} />
        )}
      </>
    );
  }

  if (!activated) {
    return (
      <button
        className={`btn ${compact ? 'btn-icon' : ''}`}
        style={compact ? undefined : { width: '100%', justifyContent: 'center' }}
        onClick={() => setActivated(true)}
        title="Sign in with Google to sync across devices"
      >
        <LogIn size={15} />
        {!compact && 'Sign in with Google'}
      </button>
    );
  }

  return <div ref={containerRef} />;
}

/**
 * GoogleSignInButton — shared "Sign in with Google" entry point, used by
 * both AccountButton (sidebar/topbar) and SettingsPanel's Account & sync
 * card. Renders our own fully-stylable button, wired to Google Identity
 * Services' One Tap prompt (see AuthContext.jsx's promptGoogleSignIn for why:
 * it's the one sign-in mechanism that doesn't rely on window.open() actually
 * producing a real popup, which several mobile browsers don't reliably do),
 * falling back to a prompt to open TaskFlow in a regular browser in
 * standalone/home-screen mode, where nothing OAuth-related works in-place.
 */

import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useAuth, promptGoogleSignIn } from '../../context/AuthContext';
import { isRunningStandalone } from '../../utils/installPrompt';
import BrowserSignInPromptModal from '../Modals/BrowserSignInPromptModal';

/**
 * @param {{ compact?: boolean }} props
 */
export default function GoogleSignInButton({ compact = false }) {
  const { handleGoogleCredential } = useAuth();
  const standalone = isRunningStandalone();
  const [showBrowserPrompt, setShowBrowserPrompt] = useState(false);

  function handleClick() {
    if (standalone) {
      setShowBrowserPrompt(true);
      return;
    }
    promptGoogleSignIn(handleGoogleCredential).catch((err) =>
      console.error('[GoogleSignInButton] Failed to prompt', err)
    );
  }

  return (
    <>
      <button
        className={`btn ${compact ? 'btn-icon' : ''}`}
        onClick={handleClick}
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

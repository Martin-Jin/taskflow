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
import { useScheduler } from '../../context/SchedulerContext';
import { isRunningStandalone } from '../../utils/installPrompt';
import BrowserSignInPromptModal from '../Modals/BrowserSignInPromptModal';

/**
 * @param {{ compact?: boolean }} props
 */
export default function GoogleSignInButton({ compact = false }) {
  const { handleGoogleCredential } = useAuth();
  // `sharedProjectIds` (not `sharedProjects`, which only holds projects whose
  // first Firestore snapshot has already arrived) is the list of every
  // project this browser is a member of — read here so a guest's identity
  // migration (see AuthContext.jsx's handleGoogleCredential) knows which
  // projects to attempt migrating if linking their account turns out to be
  // impossible. AuthContext itself sits ABOVE SchedulerContext in the
  // provider tree and has no access to this state, hence passing it down
  // from here rather than having AuthContext read it directly.
  const { sharedProjectIds } = useScheduler();
  const standalone = isRunningStandalone();
  const [showBrowserPrompt, setShowBrowserPrompt] = useState(false);

  function handleClick() {
    if (standalone) {
      setShowBrowserPrompt(true);
      return;
    }
    promptGoogleSignIn((idToken) => handleGoogleCredential(idToken, { projectIds: sharedProjectIds })).catch((err) =>
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

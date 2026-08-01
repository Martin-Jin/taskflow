/**
 * BrowserSignInPromptModal — shown instead of attempting Google sign-in when
 * TaskFlow is running in standalone display mode (launched from a home-screen
 * icon on iOS/Android). Sign-in doesn't work there because the standalone
 * context's storage is isolated from the regular browser — see
 * GoogleSignInButton.jsx. The "Open in browser" link uses target="_blank",
 * which iOS routes to Safari instead of navigating in place, breaking the
 * user out of the isolated context to complete sign-in normally.
 */

import { X, ExternalLink } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

export default function BrowserSignInPromptModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sign in from your browser"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Sign in from your browser</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, margin: '4px 0 14px' }}>
          Google sign-in doesn't work from the installed app icon — its storage is isolated from your
          regular browser, which breaks the sign-in flow. Tap below to open TaskFlow in your browser
          and sign in there, then come back and reopen the app from your home screen.
        </p>
        <a
          href={window.location.href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn"
          style={{ width: '100%', justifyContent: 'center', gap: 6 }}
          onClick={requestClose}
        >
          Open in browser <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}

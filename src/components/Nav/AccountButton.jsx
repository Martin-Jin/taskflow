/**
 * ============================================================================
 * AccountButton
 * ============================================================================
 * Sign-in entry point + signed-in account menu, rendered both in the desktop
 * sidebar (full width, name shown, menu opens upward since it sits at the
 * bottom of the screen) and the mobile topbar (icon-only, menu opens
 * downward). Signing in is what enables cross-device sync — see
 * AuthContext.jsx and the cloud-sync effects in SchedulerContext/ThemeContext.
 * ============================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import { LogOut, Settings as SettingsIcon, UserRound } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useScheduler } from '../../context/SchedulerContext';
import { isGuestUser, findOwnGuestName } from '../../utils/sharedProjectAccess';
import GoogleSignInButton from '../Common/GoogleSignInButton';

/**
 * @param {{ compact?: boolean, menuAlign?: 'up'|'down', onOpenAccountSettings?: () => void }} props
 */
export default function AccountButton({ compact = false, menuAlign = 'down', onOpenAccountSettings }) {
  const { user, authLoading, logout } = useAuth();
  const { sharedProjects } = useScheduler();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  if (authLoading) return null;

  if (!user) {
    return <GoogleSignInButton compact={compact} />;
  }

  // A guest (share-link visitor with no durable account, see isGuestUser's
  // header for why this isn't user.isAnonymous) has no displayName on the
  // Firebase user record at all — their chosen name only exists denormalized
  // onto a shared project's `collaborators` map, so it's read back from
  // there rather than off `user`.
  const isGuest = isGuestUser(user);
  const guestName = isGuest ? findOwnGuestName(user.uid, sharedProjects) : null;
  const label = isGuest ? guestName || 'Guest' : user.displayName || user.email || 'Account';

  return (
    <div className={`account-widget ${compact ? 'compact' : 'full-width'}`} ref={wrapperRef}>
      <button
        className="account-avatar-btn"
        onClick={() => setMenuOpen((v) => !v)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {user.photoURL ? (
          <img src={user.photoURL} alt="" className="account-avatar" referrerPolicy="no-referrer" />
        ) : isGuest ? (
          <span className="account-avatar account-avatar-fallback" aria-hidden="true">
            <UserRound size={16} />
          </span>
        ) : (
          <span className="account-avatar account-avatar-fallback">{label[0].toUpperCase()}</span>
        )}
        {!compact && <span className="account-name">{label}</span>}
      </button>

      {menuOpen && (
        <div className={`account-menu account-menu-${menuAlign}`}>
          <div className="account-menu-header">
            <div className="account-menu-name">{isGuest ? `${label} (guest)` : user.displayName || 'Account'}</div>
            {user.email && <div className="account-menu-email">{user.email}</div>}
            {isGuest && (
              <div className="account-menu-guest-note">
                You're browsing as a guest — this data stays on this device only. Sign in with Google to keep it
                across devices.
              </div>
            )}
          </div>
          <button
            className="account-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenAccountSettings?.();
            }}
          >
            <SettingsIcon size={14} /> {isGuest ? 'Guest settings' : 'Account settings'}
          </button>
          <button
            className="account-menu-item account-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
          >
            <LogOut size={14} /> {isGuest ? 'Leave guest session' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

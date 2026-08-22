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

  // GUEST BY DEFAULT: every signed-out visitor is a guest, whether or not a
  // Firebase Anonymous Auth session actually exists yet — one is only minted
  // lazily, the first time something needs a durable uid (opening a share
  // link, or renaming while already a member of a shared project — see
  // AuthContext.jsx's header comment on why this is lazy, not proactive).
  // `user` can therefore be null (no session at all) OR an anonymous Firebase
  // user (isGuestUser(user) true) for the exact same guest — both render the
  // same UI here. Only a REAL account (a linked Google provider) is not a
  // guest.
  const isRealAccount = !!user && !isGuestUser(user);
  const guestName = !isRealAccount ? findOwnGuestName(user?.uid, sharedProjects) : null;
  const label = isRealAccount ? user.displayName || user.email || 'Account' : guestName || 'Guest';

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
        {isRealAccount && user.photoURL ? (
          <img src={user.photoURL} alt="" className="account-avatar" referrerPolicy="no-referrer" />
        ) : !isRealAccount ? (
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
            <div className="account-menu-name">{!isRealAccount ? `${label} (guest)` : user.displayName || 'Account'}</div>
            {isRealAccount && user.email && <div className="account-menu-email">{user.email}</div>}
            {!isRealAccount && (
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
            <SettingsIcon size={14} /> {!isRealAccount ? 'Guest settings' : 'Account settings'}
          </button>
          <button
            className="account-menu-item account-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
          >
            <LogOut size={14} /> {!isRealAccount ? 'Leave guest session' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

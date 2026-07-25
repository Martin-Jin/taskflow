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
import { LogIn, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

/**
 * @param {{ compact?: boolean, menuAlign?: 'up'|'down', onOpenAccountSettings?: () => void }} props
 */
export default function AccountButton({ compact = false, menuAlign = 'down', onOpenAccountSettings }) {
  const { user, authLoading, login, logout } = useAuth();
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
    return (
      <button
        className={`btn ${compact ? 'btn-icon' : ''}`}
        style={compact ? undefined : { width: '100%', justifyContent: 'center' }}
        onClick={login}
        title="Sign in with Google to sync across devices"
      >
        <LogIn size={15} />
        {!compact && 'Sign in with Google'}
      </button>
    );
  }

  const label = user.displayName || user.email || 'Account';

  return (
    <div className={`account-widget ${compact ? 'compact' : 'full-width'}`} ref={wrapperRef}>
      <button className="account-avatar-btn" onClick={() => setMenuOpen((v) => !v)} title={label}>
        {user.photoURL ? (
          <img src={user.photoURL} alt="" className="account-avatar" referrerPolicy="no-referrer" />
        ) : (
          <span className="account-avatar account-avatar-fallback">{label[0].toUpperCase()}</span>
        )}
        {!compact && <span className="account-name">{label}</span>}
      </button>

      {menuOpen && (
        <div className={`account-menu account-menu-${menuAlign}`}>
          <div className="account-menu-header">
            <div className="account-menu-name">{user.displayName || 'Signed in'}</div>
            {user.email && <div className="account-menu-email">{user.email}</div>}
          </div>
          <button
            className="account-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenAccountSettings?.();
            }}
          >
            <SettingsIcon size={14} /> Account settings
          </button>
          <button
            className="account-menu-item account-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Account & sync — guest vs. real-account identity, guest rename,
 * sign-in/out, and the manual "Sync now" fallback for the live cross-device
 * sync (see useCloudSync.js).
 */

import React, { useState } from 'react';
import { LogOut, CloudCog, User as UserIcon, Pencil } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import GoogleSignInButton from '../../Common/GoogleSignInButton';
import { isGuestUser, findOwnGuestName } from '../../../utils/sharedProjectAccess';

export default function AccountSection({ sectionRef }) {
  const { isSyncing, syncNow, sharedProjects, sharedProjectIds, renameAnonymousSelf, setNotification } = useScheduler();
  const { user, authLoading, logout } = useAuth();
  const confirm = useConfirm();

  // Every signed-out visitor is a guest who can rename themselves here,
  // whether or not a Firebase Anonymous Auth session exists yet — one is
  // only minted lazily (see AuthContext.jsx's header comment), so `user` can
  // be null (no session at all) as well as an anonymous user (isGuestUser
  // true); both are "not a real account" and get the same guest UI. A
  // signed-in Google account's name comes from Google and isn't editable.
  const isRealAccount = !authLoading && !!user && !isGuestUser(user);
  const isGuest = !authLoading && !isRealAccount;
  const [isEditingGuestName, setIsEditingGuestName] = useState(false);
  const [guestNameDraft, setGuestNameDraft] = useState('');
  const [isSavingGuestName, setIsSavingGuestName] = useState(false);
  const guestName = isGuest ? findOwnGuestName(user?.uid, sharedProjects) : null;

  function startEditingGuestName() {
    setGuestNameDraft(guestName || '');
    setIsEditingGuestName(true);
  }

  async function submitGuestName(e) {
    e.preventDefault();
    const trimmed = guestNameDraft.trim();
    if (!trimmed || trimmed === guestName) {
      setIsEditingGuestName(false);
      return;
    }
    setIsSavingGuestName(true);
    try {
      const result = await renameAnonymousSelf(trimmed);
      if (result.ok) {
        setIsEditingGuestName(false);
      } else {
        setNotification({ type: 'error', message: "Couldn't update your name. Please try again." });
      }
    } finally {
      setIsSavingGuestName(false);
    }
  }

  return (
    <div className="card settings-card" data-tour="account-card" ref={sectionRef}>
      <h3>Account &amp; sync</h3>
      <p className="settings-hint">
        Sign in to sync your tasks, boards, and settings across every device you use TaskFlow on. Also optional —
        without signing in, TaskFlow stays exactly as it works today: saved only to this browser.
      </p>
      {isGuest ? (
        <>
          <div className="settings-actions">
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--color-accent-solid-bg)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <UserIcon size={16} />
            </span>
            <div style={{ minWidth: 0 }}>
              {isEditingGuestName ? (
                <form onSubmit={submitGuestName} className="settings-actions">
                  <input
                    type="text"
                    className="input"
                    value={guestNameDraft}
                    onChange={(e) => setGuestNameDraft(e.target.value)}
                    maxLength={120}
                    autoFocus
                    style={{ fontSize: 13, padding: '5px 8px', width: 160 }}
                  />
                  <button type="submit" className="btn" disabled={isSavingGuestName || !guestNameDraft.trim()} style={{ padding: '5px 10px', fontSize: 12 }}>
                    {isSavingGuestName ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setIsEditingGuestName(false)}
                    disabled={isSavingGuestName}
                    style={{ padding: '5px 10px', fontSize: 12 }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="settings-actions">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{guestName || 'Guest'}</div>
                  <button
                    className="btn"
                    onClick={startEditingGuestName}
                    title="Change your name"
                    aria-label="Change your name"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 11.5 }}
                  >
                    <Pencil size={11} /> Rename
                  </button>
                </div>
              )}
              <div className="settings-hint">Guest — no account</div>
            </div>
          </div>
          <p className="settings-hint">
            {sharedProjectIds.length > 0
              ? "You joined a shared project as a guest, so this data lives only on this device — there's no cloud sync or backup for a guest session."
              : "You're using TaskFlow without an account, so this data lives only on this device — there's no cloud sync or backup for a guest session."}{' '}
            Sign in with Google below to get cross-device sync and automatic backups, and to keep your data safe if
            this browser's storage is ever cleared.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <GoogleSignInButton />
            <button
              className="btn settings-inline settings-danger"
              onClick={async () => {
                const confirmMessage =
                  sharedProjectIds.length > 0
                    ? "Leave this guest session? You'll lose access to any shared project you joined as a guest, and any data saved only on this device."
                    : "Leave this guest session? You'll lose any data saved only on this device.";
                if (await confirm(confirmMessage, { confirmLabel: 'Leave' })) {
                  logout();
                }
              }}
            >
              <LogOut size={14} />
              Leave guest session
            </button>
          </div>
        </>
      ) : isRealAccount ? (
        <>
          <div className="settings-actions">
            {user.photoURL ? (
              <img src={user.photoURL} alt="" referrerPolicy="no-referrer" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'var(--color-accent-solid-bg)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {(user.displayName || user.email || '?')[0].toUpperCase()}
              </span>
            )}
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{user.displayName || 'Account'}</div>
              {user.email && <div className="settings-hint">{user.email}</div>}
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn settings-inline" onClick={syncNow} disabled={isSyncing}>
              <CloudCog size={14} />
              {isSyncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn settings-inline settings-danger" onClick={logout}>
              <LogOut size={14} />
              Sign out
            </button>
          </div>
          <p className="settings-hint">
            Tasks, boards, and settings sync automatically in the background — usually within a few seconds — to
            every device signed in with this account, no reload needed. Calendar events aren't part of that live
            sync; your connected Google Calendar account is what carries those across devices, and events are only
            otherwise captured in backups (see below) as a point-in-time safety net, not a way to deliver them to a
            new device. "Sync now" is a manual fallback for the live sync, and also refreshes Google Calendar
            events on demand.
          </p>
        </>
      ) : (
        !authLoading && <GoogleSignInButton />
      )}
    </div>
  );
}

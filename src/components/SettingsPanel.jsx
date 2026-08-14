/**
 * SettingsPanel — configure fixed routines (sleep/meals/commute) and global
 * SchedulingRules (buffer days, work-day window, pacing).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  Upload,
  History,
  Check,
  HelpCircle,
  AlertTriangle,
  KeyRound,
  ExternalLink,
  Trash2,
  Sun,
  Moon,
  LogOut,
  CloudCog,
  Tag,
  Sparkles,
  Keyboard,
  Search,
  Share,
  RefreshCw,
  Clock,
  User as UserIcon,
  Pencil,
} from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import { useTheme } from '../context/ThemeContext';
import { useSound } from '../context/SoundContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { clearAllPersisted, loadPersisted, savePersisted } from '../utils/persistence';
import { getStoredApiKey } from '../services/aiQuickAddService';
import { requestNotificationPermission } from '../services/notificationService';
import {
  getInstallPrompt,
  subscribeInstallPrompt,
  triggerInstallPrompt,
  IS_IOS,
  isRunningStandalone,
} from '../utils/installPrompt';
import GoogleSignInButton from './Common/GoogleSignInButton';
import { isGuestUser, findOwnGuestName } from '../utils/sharedProjectAccess';
import RoutineTimeline from './Settings/RoutineTimeline';
import BackupsModal from './Modals/BackupsModal';
import LabelsModal from './Modals/LabelsModal';
import ChangelogModal from './Modals/ChangelogModal';
import ShortcutsModal from './Modals/ShortcutsModal';
import { CURRENT_VERSION } from '../changelog';

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One entry per `.card` section below, in the same top-to-bottom order —
// drives the settings search dropdown's suggestions and its scroll target
// (see sectionRefs). Keep this in sync if a section is added/renamed/reordered.
const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account & sync' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'scheduling', label: 'Scheduling rules' },
  { id: 'routines', label: 'Fixed routines' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'tags', label: 'Tags' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'installApp', label: 'Install app' },
  { id: 'help', label: 'Help' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'versions', label: 'Versions' },
  { id: 'backups', label: 'Backups' },
  { id: 'dangerZone', label: 'Danger zone' },
];

/** @param {{ onOpenTour: () => void }} props — replays the app-level guided tour (see App.jsx), which needs to be able to switch tabs as it advances. */
export default function SettingsPanel({ onOpenTour, settingsSectionRequest }) {
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  // AI Quick Add keys (BYOK) — read/written directly via persistence.js, same
  // localStorage-only pattern as the Todoist token above, but kept as local
  // component state (re-read live) rather than reloading the page: unlike
  // the Todoist token, these keys are only ever read at the moment an AI
  // Quick Add request is actually submitted (see aiQuickAddService.js), so
  // there's no other hook/effect relying on them at init that a reload would
  // need to refresh.
  const [anthropicKey, setAnthropicKeyState] = useState(() => getStoredApiKey('anthropic'));
  const [geminiKey, setGeminiKeyState] = useState(() => getStoredApiKey('gemini'));
  const [showAnthropicKeyInput, setShowAnthropicKeyInput] = useState(false);
  const [showGeminiKeyInput, setShowGeminiKeyInput] = useState(false);
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState('');
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('');
  const [showBackupsModal, setShowBackupsModal] = useState(false);
  const [showLabelsModal, setShowLabelsModal] = useState(false);
  const [showChangelogModal, setShowChangelogModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [sectionQuery, setSectionQuery] = useState('');
  const [isSectionSearchFocused, setIsSectionSearchFocused] = useState(false);
  const sectionSearchRef = useRef(null);
  const sectionRefs = useRef({});
  const fileInputRef = useRef(null);
  const isMobile = useIsMobile();
  const [installPromptEvent, setInstallPromptEvent] = useState(() => getInstallPrompt());
  useEffect(() => subscribeInstallPrompt(setInstallPromptEvent), []);
  function handleInstallClick() {
    triggerInstallPrompt();
  }
  const { theme, setTheme } = useTheme();
  const { soundEnabled, setSoundEnabled, soundVolume, setSoundVolume, playComplete } = useSound();
  const { user, authLoading, logout } = useAuth();
  const confirm = useConfirm();
  const {
    routines,
    setRoutines,
    rules,
    setRules,
    connectGoogleCalendar,
    googleConnected,
    googleNeedsReconnect,
    googleSyncStale,
    lastGoogleSyncAt,
    pushToGoogleCalendar,
    pullFromGoogleCalendar,
    rebuildEventsFromGoogle,
    disconnectGoogleCalendar,
    isRewritingCalendar,
    rewriteProgress,
    rewriteGoogleCalendarFromTaskflow,
    isSyncing,
    isBackingUp,
    isPullingGoogleEvents,
    cloudBackups,
    lastAutoBackupAt,
    todoistEnabled,
    setTodoistApiToken,
    importFromTodoist,
    lastTodoistImport,
    syncNow,
    exportBackup,
    importBackupFromFile,
    refreshCloudBackups,
    backupToCloud,
    restoreCloudBackup,
    deleteCloudBackup,
    clearAllData,
    animationsEnabled,
    setAnimationsEnabled,
    notificationSettings,
    setNotificationSettings,
    sharedProjects,
    sharedProjectIds,
    renameAnonymousSelf,
    setNotification,
  } = useScheduler();

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

  // Updates a notificationSettings field, requesting browser Notification
  // permission right here if a toggle is being turned ON — this is a direct
  // user action, so prompting now (rather than on some later app load) is
  // never a surprise. requestNotificationPermission itself no-ops if the
  // API is unavailable or the user already granted/denied it previously.
  function updateNotificationSetting(field, value) {
    setNotificationSettings({ ...notificationSettings, [field]: value });
    if (value === true) requestNotificationPermission();
  }

  // Email notifications go to ONE fixed recipient address configured in the
  // notify-worker GitHub Actions secret (see notify-worker/index.js's SENDER
  // comment) — there's no per-user email lookup. Restricted to this single
  // account's uid so other users can't turn on a toggle that would silently
  // email someone else's inbox instead of their own.
  const EMAIL_NOTIFICATIONS_OWNER_UID = 'f053vFPMR1T95KX9WAZGWt9ioAq1';
  const canUseEmailNotifications = user?.uid === EMAIL_NOTIFICATIONS_OWNER_UID;

  function submitToken(e) {
    e.preventDefault();
    if (!tokenDraft.trim()) return;
    setTodoistApiToken(tokenDraft.trim());
  }

  /** Save (or clear, if passed a falsy value) the visitor's own Anthropic/Gemini API key. */
  function setAiApiKey(provider, key) {
    const trimmed = (key || '').trim() || null;
    savePersisted(provider === 'anthropic' ? 'aiAnthropicApiKey' : 'aiGeminiApiKey', trimmed);
    if (provider === 'anthropic') setAnthropicKeyState(trimmed);
    else setGeminiKeyState(trimmed);
  }

  function submitAnthropicKey(e) {
    e.preventDefault();
    if (!anthropicKeyDraft.trim()) return;
    setAiApiKey('anthropic', anthropicKeyDraft.trim());
    setAnthropicKeyDraft('');
    setShowAnthropicKeyInput(false);
  }

  function submitGeminiKey(e) {
    e.preventDefault();
    if (!geminiKeyDraft.trim()) return;
    setAiApiKey('gemini', geminiKeyDraft.trim());
    setGeminiKeyDraft('');
    setShowGeminiKeyInput(false);
  }

  function updateRoutine(id, updates) {
    setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }

  function addRoutine(startTime, endTime) {
    const id = `rt_${Date.now()}`;
    setRoutines((prev) => [
      ...prev,
      { id, label: 'New routine', startTime, endTime, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ]);
    return id;
  }

  function removeRoutine(id) {
    const routine = routines.find((r) => r.id === id);
    if (routine?.isProtected) {
      setNotification({ type: 'error', message: `"${routine.label}" is a protected routine and can't be deleted.` });
      return;
    }
    setRoutines((prev) => prev.filter((r) => r.id !== id));
  }

  // After a successful restore, Google Calendar's periodic pull (every 60s)
  // would otherwise re-pull Google's still-unchanged events and silently undo
  // anything calendar-related the restore brought back — because the normal
  // sync policy is "Google always wins" (see eventSyncService.js's module
  // doc). This offers the SEPARATE, explicit "Rewrite Google Calendar to
  // match TaskFlow" action as a one-click follow-up rather than running it
  // automatically — restore's own behavior/confirmation stays exactly as it
  // was; this is purely an opt-in extra step surfaced via the success toast's
  // action button (see AddTaskFabGroup.jsx for the same actionLabel/onAction
  // pattern). Only offered when Google Calendar is actually connected —
  // nothing to rewrite otherwise.
  function offerRewriteGoogleCalendarFollowUp() {
    if (!googleConnected) return;
    setNotification({
      type: 'info',
      message: 'Restored. Want to also make Google Calendar match what you just restored?',
      actionLabel: 'Rewrite Google Calendar',
      onAction: handleRewriteGoogleCalendar,
    });
  }

  async function handleBackupFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires onChange
    if (!file) return;
    if (
      !(await confirm('Restore from this backup file? This replaces your current tasks, boards, and settings on this device.', {
        confirmLabel: 'Restore',
      }))
    ) {
      return;
    }
    const restored = await importBackupFromFile(file);
    if (restored) offerRewriteGoogleCalendarFollowUp();
  }

  // "Rewrite Google Calendar to match TaskFlow" — the reverse of the app's
  // normal sync direction (Google always wins, day to day). Explicit,
  // opt-in, and MORE destructive than the "Restore from backup"/"Rebuild
  // from Google Calendar" confirms above: it deletes real events on an
  // external system (Google Calendar), not just local app state, so the
  // confirmation spells out exactly what's safe (subscribed/shared
  // calendars are never touched — this app only ever writes to your own
  // primary calendar) and that it can't be undone from within TaskFlow.
  async function handleRewriteGoogleCalendar() {
    const confirmed = await confirm(
      "Rewrite Google Calendar to match TaskFlow?\n\n" +
        "This deletes/overwrites events on your PRIMARY Google Calendar that don't match what TaskFlow currently has, " +
        'and creates or updates events there to match your current tasks, scheduled blocks, and calendar events.\n\n' +
        "Safe: any subscribed or shared calendar you don't own (e.g. a shared team calendar or a university timetable) " +
        'is never touched — only your own primary calendar is ever changed.\n\n' +
        "This can't be undone from within TaskFlow — deleted Google Calendar events are gone for good. Continue?",
      { confirmLabel: 'Rewrite' }
    );
    if (!confirmed) return;
    await rewriteGoogleCalendarFromTaskflow();
  }

  async function openBackupsModal() {
    await refreshCloudBackups();
    setShowBackupsModal(true);
  }

  useEffect(() => {
    function handlePointerDown(e) {
      if (sectionSearchRef.current && !sectionSearchRef.current.contains(e.target)) setIsSectionSearchFocused(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const matchingSections = sectionQuery.trim()
    ? SETTINGS_SECTIONS.filter((s) => s.label.toLowerCase().includes(sectionQuery.trim().toLowerCase()))
    : [];
  const showSectionDropdown = isSectionSearchFocused && matchingSections.length > 0;

  function goToSection(id) {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSectionQuery('');
    setIsSectionSearchFocused(false);
  }

  // Component remounts on every navigation into the Settings tab (see the
  // `{tab === 'settings' && <SettingsPanel ... />}` guard in App.jsx), so this
  // fires fresh each time a caller elsewhere requests a section via
  // requestSettingsSection.
  useEffect(() => {
    if (settingsSectionRequest?.section) goToSection(settingsSectionRequest.section);
  }, [settingsSectionRequest?.requestId]);

  return (
    <>
      <div className="settings-search-bar-wrap">
        <div className="settings-search-bar-backdrop" aria-hidden="true" />
        <div className="search-bar settings-search-bar" ref={sectionSearchRef}>
          <div className="search-bar-field">
            <span className="search-bar-icon">
              <Search size={14} />
            </span>
            <input
              type="text"
              className="search-bar-input"
              value={sectionQuery}
              onChange={(e) => setSectionQuery(e.target.value)}
              onFocus={() => setIsSectionSearchFocused(true)}
              placeholder="Search settings…"
              aria-label="Search settings"
            />
          </div>
          {showSectionDropdown && (
            <div className="search-bar-dropdown">
              <div className="search-bar-dropdown-group">
                {matchingSections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="search-bar-dropdown-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goToSection(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
      <div className="card" data-tour="account-card" ref={(el) => (sectionRefs.current.account = el)}>
        <h3 style={{ marginTop: 0 }}>Account &amp; sync</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 16 }}>
          Sign in to sync your tasks, boards, and settings across every device you use TaskFlow on. Also optional —
          without signing in, TaskFlow stays exactly as it works today: saved only to this browser.
        </p>
        {isGuest ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
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
                  <form onSubmit={submitGuestName} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>Guest — no account</div>
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 12 }}>
              {sharedProjectIds.length > 0
                ? "You joined a shared project as a guest, so this data lives only on this device — there's no cloud sync or backup for a guest session."
                : "You're using TaskFlow without an account, so this data lives only on this device — there's no cloud sync or backup for a guest session."}{' '}
              Sign in with Google below to get cross-device sync and automatic backups, and to keep your data safe if
              this browser's storage is ever cleared.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <GoogleSignInButton />
              <button
                className="btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
                />
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
                {user.email && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{user.email}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={syncNow} disabled={isSyncing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CloudCog size={14} />
                {isSyncing ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                className="btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}
                onClick={logout}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 10, marginBottom: 0 }}>
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

      <div className="card" ref={(el) => (sectionRefs.current.integrations = el)}>
        <div data-tour="integrations-card">
          <h3 style={{ marginTop: 0 }}>Integrations</h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 16 }}>
            TaskFlow works fully standalone with local sample tasks — connecting Todoist and Google Calendar is
            optional. See the tutorial (Help, below) for a step-by-step walkthrough of both.
          </p>
        </div>

        <h4
          style={{
            margin: '0 0 10px',
            fontSize: 12,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--color-text-secondary)',
          }}
        >
          Calendar
        </h4>
        <div className="google-calendar-actions" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={connectGoogleCalendar}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              ...(googleNeedsReconnect ? { color: 'var(--color-warning)', borderColor: 'var(--color-warning)' } : {}),
            }}
          >
            {googleConnected ? (
              <>
                <Check size={13} /> Google Calendar connected
              </>
            ) : googleNeedsReconnect ? (
              <>
                <AlertTriangle size={13} /> Google Calendar disconnected — reconnect
              </>
            ) : (
              'Connect Google Calendar'
            )}
          </button>
          {googleConnected && (
            <button
              className="btn"
              onClick={pullFromGoogleCalendar}
              disabled={isPullingGoogleEvents}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <RefreshCw size={13} />
              {isPullingGoogleEvents ? 'Pulling…' : 'Pull from Google Calendar'}
            </button>
          )}
          {/* "Still connected, but recent fetches have been failing" — a
              deliberately calmer state than the disconnected/reconnect
              warning on the button above, which is why it's only shown while
              googleConnected (the two never appear at once). */}
          {googleConnected && googleSyncStale && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 8px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-warning)',
                border: '1px solid var(--color-warning)',
              }}
            >
              <Clock size={13} /> Hasn't synced recently
            </span>
          )}
        </div>
        {googleConnected && (
          <div className="google-calendar-actions" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn btn-primary" onClick={pushToGoogleCalendar} disabled={isSyncing}>
              {isSyncing ? 'Syncing…' : 'Push'}
            </button>
            <button
              className="btn"
              style={{ color: 'var(--color-danger)' }}
              onClick={async () => {
                if (
                  await confirm(
                    'Rebuild ALL calendar events from Google Calendar? This wipes every local event first — including any purely local "blocked time" that was never pushed to Google — then rebuilds entirely from what Google currently has. Use this if events keep reappearing or you still see events that no longer exist on Google after a normal Pull.',
                    { confirmLabel: 'Rebuild' }
                  )
                ) {
                  rebuildEventsFromGoogle();
                }
              }}
            >
              Rebuild from Google Calendar
            </button>
            <button className="btn" style={{ color: 'var(--color-danger)' }} onClick={handleRewriteGoogleCalendar} disabled={isRewritingCalendar}>
              {isRewritingCalendar
                ? rewriteProgress
                  ? `Rewriting… (${rewriteProgress.done}/${rewriteProgress.total})`
                  : 'Rewriting…'
                : 'Rewrite Google Calendar to match TaskFlow'}
            </button>
            <button
              className="btn"
              style={{ color: 'var(--color-danger)' }}
              onClick={async () => {
                if (
                  await confirm('Disconnect Google Calendar? Synced events stay in TaskFlow, but reconnecting will need a fresh Google sign-in.', {
                    confirmLabel: 'Disconnect',
                  })
                ) {
                  disconnectGoogleCalendar();
                }
              }}
            >
              Disconnect
            </button>
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 10 }}>
          {googleNeedsReconnect
            ? "Google's sign-in expires periodically and can't always silently renew itself in the background — reconnecting takes one click and doesn't lose anything."
            : 'Connect Google Calendar to push scheduled blocks to it with one click — it asks Google directly for permission, TaskFlow never sees your Google password.'}
          {googleConnected && googleSyncStale && (
            <>
              {' '}
              Still connected, but the last few background refreshes didn't get through
              {lastGoogleSyncAt ? ` (last successful sync: ${new Date(lastGoogleSyncAt).toLocaleString()})` : ''} — usually a
              brief network problem that fixes itself. Click "Pull from Google Calendar" to try again right now.
            </>
          )}
          {googleConnected &&
            ' "Pull from Google Calendar" immediately re-fetches your Google events, overwriting any local changes to synced events with what Google currently has. "Rebuild from Google Calendar" goes further — a full wipe-and-rebuild for when stale/duplicate events won\'t go away with a normal Pull.'}
          {googleConnected && (
            <>
              {' '}
              "Rewrite Google Calendar to match TaskFlow" flips that direction — use it after restoring a backup, or
              any time your Google Calendar has drifted out of sync, to make TaskFlow authoritative instead. It only
              ever touches your own primary Google Calendar; a subscribed or shared calendar you don't own is never
              modified.
            </>
          )}
        </p>

        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <h4
            style={{
              margin: '0 0 10px',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--color-text-secondary)',
            }}
          >
            Todoist
          </h4>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span
              className="badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: lastTodoistImport ? 'rgba(79, 191, 139, 0.15)' : 'var(--color-bg-surface-hover)',
                color: lastTodoistImport ? 'var(--color-success)' : 'var(--color-text-secondary)',
              }}
            >
              {lastTodoistImport ? (
                <>
                  <Check size={12} /> Imported {lastTodoistImport.totalCount} task{lastTodoistImport.totalCount === 1 ? '' : 's'} from
                  Todoist
                </>
              ) : todoistEnabled ? (
                <>
                  <KeyRound size={12} /> Connected — not yet imported
                </>
              ) : (
                <>Standalone mode (local sample tasks)</>
              )}
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 10 }}>
            Todoist is a ONE-TIME IMPORT, not a live sync: pulling in tasks/boards/sections never happens
            automatically, and nothing you edit in TaskFlow afterward is ever pushed back to your Todoist account.
            Re-running the import later updates previously-imported items and adds anything new, without touching
            tasks you created directly in TaskFlow.
          </p>
          {todoistEnabled ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <KeyRound size={13} /> Todoist token connected
                </span>
                <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowTokenInput((v) => !v)}>
                  Change token
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 12, color: 'var(--color-danger)' }}
                  onClick={async () => {
                    if (await confirm('Disconnect Todoist? Tasks will fall back to sample data until you reconnect.', { confirmLabel: 'Disconnect' })) {
                      setTodoistApiToken(null);
                    }
                  }}
                >
                  Disconnect
                </button>
              </div>
              {showTokenInput && (
                <form onSubmit={submitToken} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input
                    type="password"
                    placeholder="Paste new Todoist API token"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    style={{ flex: 1 }}
                    autoFocus
                  />
                  <button type="submit" className="btn btn-primary" style={{ fontSize: 12 }}>
                    Save
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: 12.5, marginTop: 0, marginBottom: 8 }}>
                Optional: connect your own Todoist account to import your real tasks in place of the samples.
              </p>
              <form onSubmit={submitToken} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  placeholder="Paste your Todoist API token"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  style={{ flex: 1, minWidth: 220 }}
                />
                <button type="submit" className="btn btn-primary" disabled={!tokenDraft.trim()}>
                  Connect Todoist
                </button>
              </form>
              <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 8, marginBottom: 0 }}>
                Get yours from{' '}
                <a
                  href="https://app.todoist.com/app/settings/integrations/developer"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                >
                  Todoist → Settings → Integrations → Developer <ExternalLink size={11} />
                </a>{' '}
                and copy the "API token" field. It's saved only in this browser (never sent anywhere but directly to
                Todoist) — see the tutorial for a step-by-step walkthrough.
              </p>
            </>
          )}

          {todoistEnabled && (
            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => importFromTodoist()}
                disabled={isSyncing}
              >
                <Download size={14} />
                {isSyncing ? 'Importing…' : lastTodoistImport ? 'Re-import from Todoist' : 'Import from Todoist'}
              </button>
              {lastTodoistImport && (
                <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 8, marginBottom: 0 }}>
                  Last imported {new Date(lastTodoistImport.at).toLocaleString()} — {lastTodoistImport.addedCount} new,{' '}
                  {lastTodoistImport.updatedCount} updated.
                </p>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <h4
            style={{
              margin: '0 0 10px',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--color-text-secondary)',
            }}
          >
            AI Quick Add
          </h4>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 10 }}>
            AI Quick Add (the sparkle button next to Add Task) uses your own Anthropic and/or Gemini API key — bring
            whichever provider(s) you have a key for. Your key is saved only in this browser and sent directly
            through to that provider, never to the app owner.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <span
                  className="badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    background: anthropicKey ? 'rgba(79, 191, 139, 0.15)' : 'var(--color-bg-surface-hover)',
                    color: anthropicKey ? 'var(--color-success)' : 'var(--color-text-secondary)',
                  }}
                >
                  {anthropicKey ? (
                    <>
                      <KeyRound size={12} /> Claude (Anthropic) key connected
                    </>
                  ) : (
                    <>Claude (Anthropic) key not set
                    </>
                  )}
                </span>
              </div>
              {anthropicKey ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowAnthropicKeyInput((v) => !v)}>
                    Change key
                  </button>
                  <button
                    className="btn"
                    style={{ fontSize: 12, color: 'var(--color-danger)' }}
                    onClick={async () => {
                      if (await confirm('Remove your Anthropic API key from this browser?', { confirmLabel: 'Remove' })) setAiApiKey('anthropic', null);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 8 }}>
                  Get one from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    console.anthropic.com <ExternalLink size={11} />
                  </a>
                  .
                </p>
              )}
              {(showAnthropicKeyInput || !anthropicKey) && (
                <form onSubmit={submitAnthropicKey} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: showAnthropicKeyInput ? 10 : 0 }}>
                  <input
                    type="password"
                    placeholder={anthropicKey ? 'Paste new Anthropic API key' : 'Paste your Anthropic API key'}
                    value={anthropicKeyDraft}
                    onChange={(e) => setAnthropicKeyDraft(e.target.value)}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <button type="submit" className="btn btn-primary" style={{ fontSize: 12 }} disabled={!anthropicKeyDraft.trim()}>
                    Save
                  </button>
                </form>
              )}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <span
                  className="badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    background: geminiKey ? 'rgba(79, 191, 139, 0.15)' : 'var(--color-bg-surface-hover)',
                    color: geminiKey ? 'var(--color-success)' : 'var(--color-text-secondary)',
                  }}
                >
                  {geminiKey ? (
                    <>
                      <KeyRound size={12} /> Gemini key connected
                    </>
                  ) : (
                    <>Gemini key not set
                    </>
                  )}
                </span>
              </div>
              {geminiKey ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowGeminiKeyInput((v) => !v)}>
                    Change key
                  </button>
                  <button
                    className="btn"
                    style={{ fontSize: 12, color: 'var(--color-danger)' }}
                    onClick={async () => {
                      if (await confirm('Remove your Gemini API key from this browser?', { confirmLabel: 'Remove' })) setAiApiKey('gemini', null);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 8 }}>
                  Get one from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    aistudio.google.com <ExternalLink size={11} />
                  </a>
                  .
                </p>
              )}
              {(showGeminiKeyInput || !geminiKey) && (
                <form onSubmit={submitGeminiKey} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: showGeminiKeyInput ? 10 : 0 }}>
                  <input
                    type="password"
                    placeholder={geminiKey ? 'Paste new Gemini API key' : 'Paste your Gemini API key'}
                    value={geminiKeyDraft}
                    onChange={(e) => setGeminiKeyDraft(e.target.value)}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <button type="submit" className="btn btn-primary" style={{ fontSize: 12 }} disabled={!geminiKeyDraft.trim()}>
                    Save
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.scheduling = el)}>
        <h3 style={{ marginTop: 0 }}>Scheduling rules</h3>
        <div className="form-row">
          <label>Buffer days (finish this many days before due date)</label>
          <input
            type="number"
            min="0"
            value={rules.bufferDays}
            onChange={(e) => setRules({ ...rules, bufferDays: Number(e.target.value) })}
          />
        </div>
        <div className="form-row-split">
          <div className="form-row" style={{ flex: 1 }}>
            <label>Work day start</label>
            <input type="time" value={rules.workDayStart} onChange={(e) => setRules({ ...rules, workDayStart: e.target.value })} />
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label>Work day end</label>
            <input type="time" value={rules.workDayEnd} onChange={(e) => setRules({ ...rules, workDayEnd: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <label>Max deep-work hours per day</label>
          <input
            type="number"
            min="1"
            max="16"
            value={rules.maxDailyDeepWorkHours}
            onChange={(e) => setRules({ ...rules, maxDailyDeepWorkHours: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>Planning horizon (weeks)</label>
          <input
            type="number"
            min="1"
            max="12"
            value={rules.horizonWeeks}
            onChange={(e) => setRules({ ...rules, horizonWeeks: Number(e.target.value) })}
          />
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="frontload"
            checked={rules.frontLoadUrgent}
            onChange={(e) => setRules({ ...rules, frontLoadUrgent: e.target.checked })}
          />
          <label htmlFor="frontload" style={{ margin: 0 }}>
            Front-load urgent/high-priority tasks near their deadline
          </label>
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="autoRescheduleEnabled"
            checked={rules.autoRescheduleEnabled !== false}
            onChange={(e) => setRules({ ...rules, autoRescheduleEnabled: e.target.checked })}
          />
          <label htmlFor="autoRescheduleEnabled" style={{ margin: 0 }}>
            Automatically reschedule when adding a task with a due date, or when Google Calendar events change
          </label>
        </div>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.routines = el)}>
        <h3 style={{ marginTop: 0 }}>Fixed routines</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6 }}>
          These are subtracted from every day's capacity before tasks are scheduled.
        </p>
        <p className="form-hint" style={{ marginBottom: 8 }}>
          Drag on empty space to block out a new routine, drag a block to move it, drag its top/bottom edge to
          resize — click its dot to pause/resume, click its label to rename.
        </p>
        <RoutineTimeline routines={routines} onAdd={addRoutine} onUpdate={updateRoutine} onRemove={removeRoutine} />
      </div>

      <div className="card" data-tour="appearance-card" ref={(el) => (sectionRefs.current.appearance = el)}>
        <h3 style={{ marginTop: 0 }}>Appearance</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          Switch between a warm off-white and a warm charcoal theme. Your choice is saved on this device.
        </p>
        <div className="theme-toggle" role="group" aria-label="Color theme" data-tour="appearance-toggle">
          <button
            type="button"
            className={`theme-toggle-option ${theme === 'light' ? 'active' : ''}`}
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
          >
            <Sun size={14} />
            Light
          </button>
          <button
            type="button"
            className={`theme-toggle-option ${theme === 'dark' ? 'active' : ''}`}
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
          >
            <Moon size={14} />
            Dark
          </button>
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            id="soundEnabled"
            checked={soundEnabled}
            onChange={(e) => setSoundEnabled(e.target.checked)}
          />
          <label htmlFor="soundEnabled" style={{ margin: 0 }}>
            Sound effects
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 0 }}>
          Short sounds when you add, complete, uncomplete, or delete a task.
        </p>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <label htmlFor="soundVolume" style={{ margin: 0, opacity: soundEnabled ? 1 : 0.5 }}>
            Volume
          </label>
          <input
            type="range"
            id="soundVolume"
            min="0"
            max="1"
            step="0.05"
            value={soundVolume}
            disabled={!soundEnabled}
            onChange={(e) => setSoundVolume(Number(e.target.value))}
            onMouseUp={() => soundEnabled && playComplete()}
            onTouchEnd={() => soundEnabled && playComplete()}
            onKeyUp={() => soundEnabled && playComplete()}
            style={{ flex: 1, opacity: soundEnabled ? 1 : 0.5 }}
          />
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 34, textAlign: 'right', opacity: soundEnabled ? 1 : 0.5 }}>
            {Math.round(soundVolume * 100)}%
          </span>
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            id="animationsEnabled"
            checked={animationsEnabled}
            onChange={(e) => setAnimationsEnabled(e.target.checked)}
          />
          <label htmlFor="animationsEnabled" style={{ margin: 0 }}>
            Interface animations
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 0 }}>
          Motion for modals, toasts, and task transitions.
        </p>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.tags = el)}>
        <h3 style={{ marginTop: 0 }}>Tags</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          See every tag you've created across all tasks, with how many tasks currently carry each one.
        </p>
        <button className="btn" onClick={() => setShowLabelsModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Tag size={14} />
          View all tags
        </button>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.notifications = el)}>
        <h3 style={{ marginTop: 0 }}>Notifications</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          Choose which channels and task events can notify you. In-app notifications fire while TaskFlow
          is open, via your browser's notification popup (falling back to an in-app toast if that's not
          available/permitted). Email notifications require a one-time self-hosted setup of a GitHub
          Actions scheduled workflow (see notify-worker/README.md) — turning this on here does nothing
          until that's set up. That setup is single-recipient by design (no domain purchase needed):
          every email goes to one fixed address configured in the workflow, not to this account's own
          sign-in email.
        </p>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="notifInApp"
            checked={notificationSettings.inAppEnabled}
            onChange={(e) => updateNotificationSetting('inAppEnabled', e.target.checked)}
          />
          <label htmlFor="notifInApp" style={{ margin: 0 }}>
            In-app notifications
          </label>
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            id="notifEmail"
            checked={notificationSettings.emailEnabled}
            disabled={!canUseEmailNotifications}
            onChange={(e) => setNotificationSettings({ ...notificationSettings, emailEnabled: e.target.checked })}
          />
          <label htmlFor="notifEmail" style={{ margin: 0, opacity: canUseEmailNotifications ? 1 : 0.5 }}>
            Email notifications
          </label>
        </div>
        {!canUseEmailNotifications && (
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 0 }}>
            Email notifications aren't available for this account — the self-hosted setup only supports
            sending to a single fixed recipient (see the note above).
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 12, marginBottom: 6 }}>
          Notify me when:
        </p>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="notifStartingSoon"
            checked={notificationSettings.taskStartingSoon}
            onChange={(e) => updateNotificationSetting('taskStartingSoon', e.target.checked)}
          />
          <label htmlFor="notifStartingSoon" style={{ margin: 0 }}>
            A task is starting soon
          </label>
        </div>
        <div className="form-row" style={{ marginTop: 8, maxWidth: 220 }}>
          <label htmlFor="notifStartingSoonMinutes" style={{ opacity: notificationSettings.taskStartingSoon ? 1 : 0.5 }}>
            "Starting soon" threshold (minutes)
          </label>
          <input
            type="number"
            id="notifStartingSoonMinutes"
            min="1"
            max="180"
            value={notificationSettings.startingSoonMinutes}
            disabled={!notificationSettings.taskStartingSoon}
            onChange={(e) =>
              setNotificationSettings({ ...notificationSettings, startingSoonMinutes: Number(e.target.value) })
            }
          />
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input
            type="checkbox"
            id="notifOverdue"
            checked={notificationSettings.taskOverdue}
            onChange={(e) => updateNotificationSetting('taskOverdue', e.target.checked)}
          />
          <label htmlFor="notifOverdue" style={{ margin: 0 }}>
            A task becomes overdue
          </label>
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            id="notifDueToday"
            checked={notificationSettings.taskDueToday}
            onChange={(e) => updateNotificationSetting('taskDueToday', e.target.checked)}
          />
          <label htmlFor="notifDueToday" style={{ margin: 0 }}>
            A task is due today
          </label>
        </div>
      </div>

      {isMobile && !isRunningStandalone() && (
        <div className="card" ref={(el) => (sectionRefs.current.installApp = el)}>
          <h3 style={{ marginTop: 0 }}>Install app</h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
            Add TaskFlow to your home screen to launch it full-screen, without the browser's address bar.
          </p>
          {IS_IOS ? (
            <p style={{ fontSize: 12, marginBottom: 0 }}>
              Tap the Share icon <Share size={12} style={{ verticalAlign: -1 }} /> in Safari, then "Add to Home
              Screen".
            </p>
          ) : installPromptEvent ? (
            <button
              className="btn"
              onClick={handleInstallClick}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Download size={14} />
              Add to home screen
            </button>
          ) : (
            <p style={{ fontSize: 12, marginBottom: 0 }}>
              Open your browser's menu and look for "Add to Home screen" or "Install app".
            </p>
          )}
        </div>
      )}

      <div className="card" ref={(el) => (sectionRefs.current.help = el)}>
        <h3 style={{ marginTop: 0 }}>Help</h3>
        <button className="btn" onClick={onOpenTour} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <HelpCircle size={14} />
          Replay guided tour
        </button>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.shortcuts = el)}>
        <h3 style={{ marginTop: 0 }}>Keyboard shortcuts</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          See every shortcut TaskFlow supports and customize its key combo.
        </p>
        <button
          className="btn"
          onClick={() => setShowShortcutsModal(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Keyboard size={14} />
          View shortcuts
        </button>
      </div>

      <div className="card" ref={(el) => (sectionRefs.current.versions = el)}>
        <h3 style={{ marginTop: 0 }}>Versions</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          See what changed in each update to TaskFlow — currently v{CURRENT_VERSION}.
        </p>
        <button className="btn" onClick={() => setShowChangelogModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={14} />
          What's new
        </button>
      </div>

      <div className="card" data-tour="backups-card" ref={(el) => (sectionRefs.current.backups = el)}>
        <h3 style={{ marginTop: 0 }}>Backups</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          Download a snapshot of your tasks, boards, and settings as a file, or restore one — both work whether or
          not you're signed in. Already-completed one-off tasks aren't included; recurring tasks always are.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={exportBackup} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} />
            Download backup
          </button>
          <button
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Upload size={14} />
            Restore from file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={handleBackupFileSelected}
          />
        </div>

        {user && !isGuest && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
            <h4
              style={{
                margin: '0 0 10px',
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: 'var(--color-text-secondary)',
              }}
            >
              Cloud backups
            </h4>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 10 }}>
              TaskFlow automatically takes a cloud backup once a day while you're signed in, keeping the last 14 —
              older automatic ones are pruned to make room. Backups you take manually with "Back up now" are kept
              separately, also capped at the last 14.
              {lastAutoBackupAt && <> Last automatic backup: {new Date(lastAutoBackupAt).toLocaleString()}.</>}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn"
                onClick={backupToCloud}
                disabled={isBackingUp}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <History size={14} />
                {isBackingUp ? 'Backing up…' : 'Back up now'}
              </button>
              <button className="btn" onClick={openBackupsModal} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CloudCog size={14} />
                View backups{cloudBackups.length > 0 ? ` (${cloudBackups.length})` : ''}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card" data-tour="danger-zone-card" ref={(el) => (sectionRefs.current.dangerZone = el)}>
        <h3 style={{ marginTop: 0 }}>Danger zone</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          Clears every task and board (including the sample "Work / Writing / Personal" data new accounts start
          with) so you can start from a blank slate. Routines, scheduling rules, and your Todoist/Google Calendar
          connections are left untouched.
        </p>
        <button
          className="btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}
          onClick={async () => {
            if (await confirm('Clear all tasks and boards? This cannot be undone.', { confirmLabel: 'Clear all data' })) {
              clearAllData();
            }
          }}
        >
          <Trash2 size={14} />
          Clear all data (tasks & boards)
        </button>

        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 16, marginBottom: -6 }}>
          Wipes every locally-saved TaskFlow setting (tasks, blocks, routines, rules, events) from this browser and
          reloads. Todoist/Google Calendar accounts themselves are untouched — this only clears what's cached here.
        </p>
        <button
          className="btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)', marginTop: 10 }}
          onClick={async () => {
            if (await confirm('Reset all local TaskFlow data? This cannot be undone.', { confirmLabel: 'Reset' })) {
              clearAllPersisted();
              window.location.reload();
            }
          }}
        >
          <AlertTriangle size={14} />
          Reset local data
        </button>
      </div>

      {showBackupsModal && (
        <BackupsModal
          backups={cloudBackups}
          isBusy={isBackingUp}
          onRestore={restoreCloudBackup}
          onRestored={offerRewriteGoogleCalendarFollowUp}
          onDelete={deleteCloudBackup}
          onClose={() => setShowBackupsModal(false)}
        />
      )}
      {showLabelsModal && <LabelsModal onClose={() => setShowLabelsModal(false)} />}
      {showChangelogModal && <ChangelogModal onClose={() => setShowChangelogModal(false)} />}
      {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
      </div>
    </>
  );
}
/**
 * SettingsPanel — configure fixed routines (sleep/meals/commute), global
 * SchedulingRules (buffer days, work-day window, pacing), and toggle
 * "Free Time / Ignore" overrides on recurring calendar events.
 */

import React, { useRef, useState } from 'react';
import {
  Download,
  Upload,
  History,
  Circle,
  Check,
  HelpCircle,
  AlertTriangle,
  KeyRound,
  ExternalLink,
  Trash2,
  Sun,
  Moon,
  LogIn,
  LogOut,
  CloudCog,
  Tag,
  Sparkles,
  Keyboard,
} from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { clearAllPersisted } from '../utils/persistence';
import RoutineTimeline from './Settings/RoutineTimeline';
import BackupsModal from './Modals/BackupsModal';
import LabelsModal from './Modals/LabelsModal';
import ChangelogModal from './Modals/ChangelogModal';
import ShortcutsModal from './Modals/ShortcutsModal';
import { CURRENT_VERSION } from '../changelog';

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** @param {{ onOpenTour: () => void }} props — replays the app-level guided tour (see App.jsx), which needs to be able to switch tabs as it advances. */
export default function SettingsPanel({ onOpenTour }) {
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [showBackupsModal, setShowBackupsModal] = useState(false);
  const [showLabelsModal, setShowLabelsModal] = useState(false);
  const [showChangelogModal, setShowChangelogModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const fileInputRef = useRef(null);
  const { theme, setTheme } = useTheme();
  const { user, authLoading, login, logout } = useAuth();
  const {
    routines,
    setRoutines,
    rules,
    setRules,
    events,
    setEventIgnored,
    setAllRecurringIgnored,
    connectGoogleCalendar,
    googleConnected,
    pushToGoogleCalendar,
    isSyncing,
    isBackingUp,
    cloudBackups,
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
  } = useScheduler();

  function submitToken(e) {
    e.preventDefault();
    if (!tokenDraft.trim()) return;
    setTodoistApiToken(tokenDraft.trim());
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
    setRoutines((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleBackupFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires onChange
    if (!file) return;
    if (!window.confirm('Restore from this backup file? This replaces your current tasks, boards, and settings on this device.')) {
      return;
    }
    await importBackupFromFile(file);
  }

  async function openBackupsModal() {
    await refreshCloudBackups();
    setShowBackupsModal(true);
  }

  const recurringEvents = events.filter((e) => e.seriesId);
  const allRecurringIgnored = recurringEvents.length > 0 && recurringEvents.every((e) => e.isFreeTime);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
      <div className="card" data-tour="account-card">
        <h3 style={{ marginTop: 0 }}>Account &amp; sync</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 16 }}>
          Sign in to sync your tasks, boards, and settings across every device you use TaskFlow on. Also optional —
          without signing in, TaskFlow stays exactly as it works today: saved only to this browser.
        </p>
        {!authLoading && user ? (
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
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{user.displayName || 'Signed in'}</div>
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
              Changes sync automatically in the background — usually within a few seconds — to every device signed
              in with this account, no reload needed. "Sync now" is a manual fallback, and also refreshes Google
              Calendar events, which don't push live.
            </p>
          </>
        ) : (
          <button
            className="btn btn-primary"
            onClick={login}
            disabled={authLoading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <LogIn size={14} />
            Sign in with Google
          </button>
        )}
      </div>

      <div className="card">
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={connectGoogleCalendar} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {googleConnected ? (
              <>
                <Check size={13} /> Google Calendar connected
              </>
            ) : (
              'Connect Google Calendar'
            )}
          </button>
          <button className="btn btn-primary" onClick={pushToGoogleCalendar} disabled={isSyncing}>
            {isSyncing ? 'Syncing…' : 'Push scheduled blocks to Google Calendar'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 10 }}>
          Connect Google Calendar to push scheduled blocks to it with one click — it asks Google directly for
          permission, TaskFlow never sees your Google password.
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
              className={`badge ${lastTodoistImport ? 'low' : 'medium'}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: lastTodoistImport ? 'rgba(79, 191, 139, 0.15)' : undefined,
                color: lastTodoistImport ? 'var(--color-success)' : undefined,
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
                <>
                  <Circle size={12} /> Standalone mode (local sample tasks)
                </>
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
                  onClick={() => {
                    if (window.confirm('Disconnect Todoist? Tasks will fall back to sample data until you reconnect.')) {
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
      </div>

      <div className="card">
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
      </div>

      <div className="card">
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Calendar event overrides</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6 }}>
          Mark recurring events (lectures, optional meetings) as "Free Time" so tasks can be scheduled over them.
          {googleConnected && ' Events are pulled from your primary calendar plus every calendar you subscribe to (e.g. a shared lecture timetable).'}
        </p>
        {recurringEvents.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <button
              className="btn"
              style={{ fontSize: 12 }}
              onClick={() => setAllRecurringIgnored(!allRecurringIgnored)}
            >
              {allRecurringIgnored ? 'Stop ignoring all repeating events' : 'Ignore all repeating events'}
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
              {recurringEvents.length} repeating event{recurringEvents.length === 1 ? '' : 's'} in the current horizon
            </span>
          </div>
        )}
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {[...events]
            .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
            .map((e) => (
              <div key={e.id} className="settings-row" style={{ borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
                  {e.title}{' '}
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    ({e.date} {e.startTime}–{e.endTime}
                    {e.calendarName && e.calendarName !== 'primary' ? ` · ${e.calendarName}` : ''})
                  </span>
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={e.isFreeTime}
                    onChange={() => setEventIgnored(e, !e.isFreeTime, 'this')}
                  />
                  Treat as free time
                </label>
              </div>
            ))}
          {events.length === 0 && (
            <p style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>No calendar events in the current planning horizon.</p>
          )}
        </div>
      </div>

      <div className="card" data-tour="appearance-card">
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
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tags</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          See every tag you've created across all tasks, with how many tasks currently carry each one.
        </p>
        <button className="btn" onClick={() => setShowLabelsModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Tag size={14} />
          View all tags
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Help</h3>
        <button className="btn" onClick={onOpenTour} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <HelpCircle size={14} />
          Replay guided tour
        </button>
      </div>

      <div className="card">
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Versions</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          See what changed in each update to TaskFlow — currently v{CURRENT_VERSION}.
        </p>
        <button className="btn" onClick={() => setShowChangelogModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={14} />
          What's new
        </button>
      </div>

      <div className="card" data-tour="backups-card">
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

        {user && (
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
              TaskFlow quietly takes a cloud backup roughly once a day while you're signed in, on top of whatever
              you back up manually here.
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

      <div className="card" data-tour="danger-zone-card">
        <h3 style={{ marginTop: 0 }}>Danger zone</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -6, marginBottom: 10 }}>
          Clears every task and board (including the sample "Work / Writing / Personal" data new accounts start
          with) so you can start from a blank slate. Routines, scheduling rules, and your Todoist/Google Calendar
          connections are left untouched.
        </p>
        <button
          className="btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}
          onClick={() => {
            if (window.confirm('Clear all tasks and boards? This cannot be undone.')) {
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
          onClick={() => {
            if (window.confirm('Reset all local TaskFlow data? This cannot be undone.')) {
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
          onDelete={deleteCloudBackup}
          onClose={() => setShowBackupsModal(false)}
        />
      )}
      {showLabelsModal && <LabelsModal onClose={() => setShowLabelsModal(false)} />}
      {showChangelogModal && <ChangelogModal onClose={() => setShowChangelogModal(false)} />}
      {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
    </div>
  );
}
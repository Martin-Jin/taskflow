/**
 * SettingsPanel — configure fixed routines (sleep/meals/commute), global
 * SchedulingRules (buffer days, work-day window, pacing), and toggle
 * "Free Time / Ignore" overrides on recurring calendar events.
 */

import React, { useState } from 'react';
import { RefreshCw, Pause, Circle, Check, HelpCircle, AlertTriangle, KeyRound, ExternalLink } from 'lucide-react';
import { useScheduler } from '../context/SchedulerContext';
import { clearAllPersisted } from '../utils/persistence';
import TutorialModal from './Tutorial/TutorialModal';
import RoutineTimeline from './Settings/RoutineTimeline';

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SettingsPanel() {
  const [showTutorial, setShowTutorial] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
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
    todoistEnabled,
    setTodoistApiToken,
    taskSyncEnabled,
    setTaskSyncEnabled,
    syncActive,
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

  const recurringEvents = events.filter((e) => e.seriesId);
  const allRecurringIgnored = recurringEvents.length > 0 && recurringEvents.every((e) => e.isFreeTime);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Integrations</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            className={`badge ${syncActive ? 'low' : 'medium'}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: syncActive ? 'rgba(79, 191, 139, 0.15)' : undefined,
              color: syncActive ? 'var(--success)' : undefined,
            }}
          >
            {syncActive ? (
              <>
                <RefreshCw size={12} /> Todoist two-way sync active
              </>
            ) : todoistEnabled ? (
              <>
                <Pause size={12} /> Todoist sync paused
              </>
            ) : (
              <>
                <Circle size={12} /> Todoist not configured (mock data)
              </>
            )}
          </span>
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
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 10 }}>
          {syncActive
            ? 'Editing a Todoist-sourced task, its subtasks, or a Board section here updates Todoist immediately. Fields with no Todoist equivalent (lock state, chunk sizes) stay app-only.'
            : todoistEnabled
              ? 'Task sync is paused — edits here stay in TaskFlow only and are not pushed to Todoist until you turn sync back on below.'
              : 'Connect Todoist below to replace the sample tasks with your real ones. Google Calendar connects with one click and asks Google directly for permission — TaskFlow never sees your Google password. See the tutorial (Help, below) for a step-by-step walkthrough of both.'}
        </p>

        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
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
                  style={{ fontSize: 12, color: 'var(--danger)' }}
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
                Connect your own Todoist account to replace the sample tasks with your real ones.
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
              <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, marginBottom: 0 }}>
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 14 }}>
              <input
                type="checkbox"
                checked={taskSyncEnabled}
                onChange={(e) => setTaskSyncEnabled(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>
                Keep syncing task changes to Todoist
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 400, marginTop: 2 }}>
                  Turn this off to import your Todoist tasks once and manage everything from TaskFlow afterward — new
                  edits, completions, and deletions stay local and won't touch your Todoist account.
                </div>
              </span>
            </label>
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
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -6 }}>
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
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -6 }}>
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
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {recurringEvents.length} repeating event{recurringEvents.length === 1 ? '' : 's'} in the current horizon
            </span>
          </div>
        )}
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {[...events]
            .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
            .map((e) => (
              <div key={e.id} className="settings-row" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
                  {e.title}{' '}
                  <span style={{ color: 'var(--text-tertiary)' }}>
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
            <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No calendar events in the current planning horizon.</p>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Help</h3>
        <button className="btn" onClick={() => setShowTutorial(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <HelpCircle size={14} />
          Show tutorial
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Danger zone</h3>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -6 }}>
          Wipes every locally-saved TaskFlow setting (tasks, blocks, routines, rules, events) from this browser and
          reloads. Todoist/Google Calendar accounts themselves are untouched — this only clears what's cached here.
        </p>
        <button
          className="btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--danger)' }}
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

      {showTutorial && <TutorialModal onClose={() => setShowTutorial(false)} />}
    </div>
  );
}
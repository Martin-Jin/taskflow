/**
 * Settings → Integrations — Google Calendar (two-way event sync), Todoist
 * (one-time import, never a live sync — see its own note below), and AI
 * Quick Add's bring-your-own-key Anthropic/Gemini setup.
 */

import React, { useState } from 'react';
import { Check, AlertTriangle, KeyRound, ExternalLink, Download, RefreshCw, Clock } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { getStoredApiKey } from '../../../services/aiQuickAddService';
import { savePersisted } from '../../../utils/persistence';

export default function IntegrationsSection({ sectionRef }) {
  const {
    isSyncing,
    isPullingGoogleEvents,
    googleConnected,
    googleNeedsReconnect,
    googleSyncStale,
    lastGoogleSyncAt,
    connectGoogleCalendar,
    pullFromGoogleCalendar,
    pushToGoogleCalendar,
    rebuildEventsFromGoogle,
    disconnectGoogleCalendar,
    todoistEnabled,
    setTodoistApiToken,
    importFromTodoist,
    lastTodoistImport,
  } = useScheduler();
  const confirm = useConfirm();

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

  return (
    <div className="card settings-card" ref={sectionRef}>
      <div data-tour="integrations-card">
        <h3>Integrations</h3>
        <p className="settings-hint">
          TaskFlow works fully standalone with local sample tasks — connecting Todoist and Google Calendar is
          optional. See the tutorial (Help, below) for a step-by-step walkthrough of both.
        </p>
      </div>

      <h4 className="settings-subgroup-title">Calendar</h4>
      <div className="google-calendar-actions settings-actions">
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
          <button className="btn settings-inline" onClick={pullFromGoogleCalendar} disabled={isPullingGoogleEvents}>
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
        <div className="google-calendar-actions settings-actions">
          <button className="btn btn-primary" onClick={pushToGoogleCalendar} disabled={isSyncing}>
            {isSyncing ? 'Syncing…' : 'Push'}
          </button>
          <button
            className="btn settings-danger"
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
          <button
            className="btn settings-danger"
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
      <p className="settings-hint">
        {googleNeedsReconnect
          ? "Google's sign-in expires periodically and can't always silently renew itself in the background — reconnecting takes one click and doesn't lose anything."
          : 'Connect Google Calendar to keep your calendar events in sync both ways with one click — it asks Google directly for permission, TaskFlow never sees your Google password. Scheduled tasks stay in TaskFlow and are never written to your Google Calendar.'}
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
            To flip that direction and make TaskFlow authoritative instead — e.g. after restoring an old backup, or
            any time your Google Calendar has drifted out of sync — use "Restore &amp; overwrite Google Calendar" in
            the Backups section below. It only ever touches your own primary Google Calendar; a subscribed or
            shared calendar you don't own is never modified.
          </>
        )}
      </p>

      <div className="settings-subgroup">
        <h4 className="settings-subgroup-title">Todoist</h4>
        <div className="settings-actions">
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
        <p className="settings-hint">
          Todoist is a ONE-TIME IMPORT, not a live sync: pulling in tasks/boards/sections never happens
          automatically, and nothing you edit in TaskFlow afterward is ever pushed back to your Todoist account.
          Re-running the import later updates previously-imported items and adds anything new, without touching
          tasks you created directly in TaskFlow.
        </p>
        {todoistEnabled ? (
          <>
            <div className="settings-actions">
              <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <KeyRound size={13} /> Todoist token connected
              </span>
              <button className="btn settings-btn-sm" onClick={() => setShowTokenInput((v) => !v)}>
                Change token
              </button>
              <button
                className="btn settings-btn-sm settings-danger"
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
            <form onSubmit={submitToken} className="settings-actions">
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
            <p className="settings-hint">
              Get yours from{' '}
              <a href="https://app.todoist.com/app/settings/integrations/developer" target="_blank" rel="noopener noreferrer" className="settings-inline">
                Todoist → Settings → Integrations → Developer <ExternalLink size={11} />
              </a>{' '}
              and copy the "API token" field. It's saved only in this browser (never sent anywhere but directly to
              Todoist) — see the tutorial for a step-by-step walkthrough.
            </p>
          </>
        )}

        {todoistEnabled && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary settings-inline" onClick={() => importFromTodoist()} disabled={isSyncing}>
              <Download size={14} />
              {isSyncing ? 'Importing…' : lastTodoistImport ? 'Re-import from Todoist' : 'Import from Todoist'}
            </button>
            {lastTodoistImport && (
              <p className="settings-hint">
                Last imported {new Date(lastTodoistImport.at).toLocaleString()} — {lastTodoistImport.addedCount} new,{' '}
                {lastTodoistImport.updatedCount} updated.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="settings-subgroup">
        <h4 className="settings-subgroup-title">AI Quick Add</h4>
        <p className="settings-hint">
          AI Quick Add (the sparkle button next to Add Task) uses your own Anthropic and/or Gemini API key — bring
          whichever provider(s) you have a key for. Your key is saved only in this browser and sent directly
          through to that provider, never to the app owner.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="settings-actions">
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
                  <>Claude (Anthropic) key not set</>
                )}
              </span>
            </div>
            {anthropicKey ? (
              <div className="settings-actions">
                <button className="btn settings-btn-sm" onClick={() => setShowAnthropicKeyInput((v) => !v)}>
                  Change key
                </button>
                <button
                  className="btn settings-btn-sm settings-danger"
                  onClick={async () => {
                    if (await confirm('Remove your Anthropic API key from this browser?', { confirmLabel: 'Remove' })) setAiApiKey('anthropic', null);
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <p className="settings-hint">
                Get one from{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="settings-inline">
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
            <div className="settings-actions">
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
                  <>Gemini key not set</>
                )}
              </span>
            </div>
            {geminiKey ? (
              <div className="settings-actions">
                <button className="btn settings-btn-sm" onClick={() => setShowGeminiKeyInput((v) => !v)}>
                  Change key
                </button>
                <button
                  className="btn settings-btn-sm settings-danger"
                  onClick={async () => {
                    if (await confirm('Remove your Gemini API key from this browser?', { confirmLabel: 'Remove' })) setAiApiKey('gemini', null);
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <p className="settings-hint">
                Get one from{' '}
                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="settings-inline">
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
  );
}

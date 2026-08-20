/**
 * Settings → Backups — local file export/import, plus the cloud
 * automatic/manual backup pools for signed-in real accounts. See
 * backupService.js's BACKUP_FIELDS and CLAUDE.md's Backups section for what's
 * actually captured and the two independent 14-backup retention pools.
 */

import React, { useRef, useState } from 'react';
import { Download, Upload, History, CloudCog } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { isGuestUser } from '../../../utils/sharedProjectAccess';
import BackupsModal from '../../Modals/BackupsModal';

export default function BackupsSection({ sectionRef }) {
  const {
    googleConnected,
    isRewritingCalendar,
    isBackingUp,
    cloudBackups,
    lastAutoBackupAt,
    exportBackup,
    importBackupFromFile,
    importBackupFromFileAndRewriteCalendar,
    refreshCloudBackups,
    backupToCloud,
    restoreCloudBackup,
    restoreCloudBackupAndRewriteCalendar,
    deleteCloudBackup,
  } = useScheduler();
  const { user, authLoading } = useAuth();
  const confirm = useConfirm();

  // Same isGuestUser-based derivation as AccountSection — duplicated rather
  // than threaded down, since it's two lines and this is the only other
  // section that needs it.
  const isRealAccount = !authLoading && !!user && !isGuestUser(user);
  const isGuest = !authLoading && !isRealAccount;

  const fileInputRef = useRef(null);
  const fileInputAndRewriteRef = useRef(null);
  const [showBackupsModal, setShowBackupsModal] = useState(false);

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
    await importBackupFromFile(file);
  }

  // Restore from file, then chain directly into rewriteGoogleCalendarFromTaskflow
  // (via importBackupFromFileAndRewriteCalendar) with no gap in between — see
  // that function's own doc comment in SchedulerContext.jsx for the race this
  // closes (a periodic Google poll landing in the gap between "restore lands"
  // and a separate follow-up action would otherwise pull Google's still-stale
  // state back over the just-restored data before the rewrite ever got a
  // chance to run). MORE destructive than the plain "Restore from file"/
  // "Rebuild from Google Calendar" confirms elsewhere: it deletes real events
  // on an external system (Google Calendar), not just local app state, so the
  // confirmation spells out exactly what's safe (subscribed/shared calendars
  // are never touched — this app only ever writes to your own primary
  // calendar) and that it can't be undone from within TaskFlow.
  async function handleBackupFileSelectedAndRewrite(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const confirmed = await confirm(
      "Restore from this backup file AND make Google Calendar match it?\n\n" +
        'This replaces your current tasks, boards, and settings, then deletes/overwrites events on your PRIMARY ' +
        "Google Calendar that don't match the restored data.\n\n" +
        "Safe: any subscribed or shared calendar you don't own is never touched — only your own primary calendar " +
        'is ever changed.\n\n' +
        "This can't be undone from within TaskFlow — deleted Google Calendar events are gone for good. Continue?",
      { confirmLabel: 'Restore & overwrite' }
    );
    if (!confirmed) return;
    await importBackupFromFileAndRewriteCalendar(file);
  }

  async function openBackupsModal() {
    await refreshCloudBackups();
    setShowBackupsModal(true);
  }

  return (
    <div className="card settings-card" data-tour="backups-card" ref={sectionRef}>
      <h3>Backups</h3>
      <p className="settings-hint">
        Download a snapshot of your tasks, boards, and settings as a file, or restore one — both work whether or
        not you're signed in. Already-completed one-off tasks aren't included; recurring tasks always are.
      </p>
      <div className="settings-actions">
        <button className="btn settings-inline" onClick={exportBackup}>
          <Download size={14} />
          Download backup
        </button>
        <button className="btn settings-inline" onClick={() => fileInputRef.current?.click()} disabled={isRewritingCalendar}>
          <Upload size={14} />
          Restore from file
        </button>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleBackupFileSelected} />
        {googleConnected && (
          <>
            <button
              className="btn settings-inline settings-danger"
              onClick={() => fileInputAndRewriteRef.current?.click()}
              disabled={isRewritingCalendar}
            >
              <Upload size={14} />
              Restore from file &amp; overwrite Google Calendar
            </button>
            <input
              ref={fileInputAndRewriteRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={handleBackupFileSelectedAndRewrite}
            />
          </>
        )}
      </div>

      {user && !isGuest && (
        <div className="settings-subgroup">
          <h4 className="settings-subgroup-title">Cloud backups</h4>
          <p className="settings-hint">
            TaskFlow automatically takes a cloud backup once a day while you're signed in, keeping the last 14 —
            older automatic ones are pruned to make room. Backups you take manually with "Back up now" are kept
            separately, also capped at the last 14.
            {lastAutoBackupAt && <> Last automatic backup: {new Date(lastAutoBackupAt).toLocaleString()}.</>}
          </p>
          <div className="settings-actions">
            <button className="btn settings-inline" onClick={backupToCloud} disabled={isBackingUp}>
              <History size={14} />
              {isBackingUp ? 'Backing up…' : 'Back up now'}
            </button>
            <button className="btn settings-inline" onClick={openBackupsModal}>
              <CloudCog size={14} />
              View backups{cloudBackups.length > 0 ? ` (${cloudBackups.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {showBackupsModal && (
        <BackupsModal
          backups={cloudBackups}
          isBusy={isBackingUp || isRewritingCalendar}
          isGoogleConnected={googleConnected}
          onRestore={restoreCloudBackup}
          onRestoreAndRewrite={restoreCloudBackupAndRewriteCalendar}
          onDelete={deleteCloudBackup}
          onClose={() => setShowBackupsModal(false)}
        />
      )}
    </div>
  );
}

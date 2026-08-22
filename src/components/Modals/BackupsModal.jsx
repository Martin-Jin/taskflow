import React from 'react';
import { RotateCcw, RefreshCw, Trash2 } from 'lucide-react';
import Modal from '../Common/Modal';
import EmptyState from '../Common/EmptyState';
import { useConfirm } from '../../context/ConfirmContext';

/**
 * Lists the signed-in user's recent cloud backups (newest first, capped
 * server-side to the 40 most recent overall — see firestoreSync.listBackups)
 * with Restore/Delete per row. Automatic and manual backups are each capped
 * at their own 14 most recent, independently (see useCloudSync's
 * pruneBackupPool/runAutomaticBackupIfDue/createCloudBackup); this list is
 * display-only and doesn't drive that pruning decision. Picking WHICH
 * snapshot to restore needs a list, so this is a small modal rather than a
 * bare confirm(); restoring/deleting a specific row still confirms via the
 * app's shared in-app confirm modal (useConfirm, see ConfirmContext.jsx),
 * matching the rest of the app's destructive-action convention.
 *
 * Two restore options per row: plain "Restore" (local TaskFlow data only,
 * Google Calendar untouched — unchanged long-standing behavior) and
 * "Restore & overwrite Google Calendar" (onRestoreAndRewrite —
 * SchedulerContext.restoreCloudBackupAndRewriteCalendar), which chains the
 * restore directly into rewriteGoogleCalendarFromTaskflow with no gap for
 * the periodic Google poll to land in between and undo the restore first —
 * see that function's own doc comment for the race this closes. Only shown
 * when Google Calendar is actually connected (isGoogleConnected) — nothing
 * to rewrite otherwise, and showing a button that would silently no-op is
 * worse than not showing it.
 */
export default function BackupsModal({ backups, isBusy, isGoogleConnected, onRestore, onRestoreAndRewrite, onDelete, onClose }) {
  const confirm = useConfirm();

  function formatWhen(backup) {
    const iso = backup.createdAt?.toDate ? backup.createdAt.toDate().toISOString() : backup.exportedAt;
    if (!iso) return 'Just now';
    return new Date(iso).toLocaleString();
  }

  return (
    <Modal onClose={onClose} ariaLabel="Cloud backups" title="Cloud backups">
        {backups.length === 0 ? (
          <EmptyState>No cloud backups yet — use "Back up now" to create one.</EmptyState>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {backups.map((backup) => (
              <div
                key={backup.id}
                className="settings-row"
                style={{ borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}
              >
                <span style={{ flex: 1, fontSize: 13, minWidth: 160, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {formatWhen(backup)}
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: 0.3,
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 4,
                      padding: '1px 5px',
                    }}
                  >
                    {backup.automatic ? 'Automatic' : 'Manual'}
                  </span>
                </span>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    disabled={isBusy}
                    onClick={async () => {
                      if (!(await confirm('Restore this backup? This replaces your current tasks, boards, and settings.', { confirmLabel: 'Restore' })))
                        return;
                      await onRestore(backup.id);
                    }}
                  >
                    <RotateCcw size={12} />
                    Restore
                  </button>
                  {isGoogleConnected && (
                    <button
                      className="btn"
                      style={{ fontSize: 12, color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      disabled={isBusy}
                      onClick={async () => {
                        if (
                          !(await confirm(
                            "Restore this backup AND make Google Calendar match it?\n\n" +
                              'This replaces your current tasks, boards, and settings, then deletes/overwrites events on ' +
                              "your PRIMARY Google Calendar that don't match the restored data.\n\n" +
                              "Safe: any subscribed or shared calendar you don't own is never touched — only your own " +
                              'primary calendar is ever changed.\n\n' +
                              "This can't be undone from within TaskFlow — deleted Google Calendar events are gone for good. Continue?",
                            { confirmLabel: 'Restore & overwrite' }
                          ))
                        )
                          return;
                        await onRestoreAndRewrite(backup.id);
                      }}
                    >
                      <RefreshCw size={12} />
                      Restore & overwrite Google Calendar
                    </button>
                  )}
                  <button
                    className="btn"
                    style={{ fontSize: 12, color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    disabled={isBusy}
                    onClick={async () => {
                      if (await confirm('Delete this backup? This cannot be undone.', { confirmLabel: 'Delete' })) {
                        onDelete(backup.id);
                      }
                    }}
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}

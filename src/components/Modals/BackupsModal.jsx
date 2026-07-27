import React from 'react';
import { X, RotateCcw, Trash2 } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

/**
 * Lists the signed-in user's recent cloud backups (newest first, capped
 * server-side to ~20 — see firestoreSync.listBackups) with Restore/Delete
 * per row. Picking WHICH snapshot to restore needs a list, so this is a
 * small modal rather than a bare confirm(); restoring/deleting a specific
 * row still confirms via window.confirm, matching the rest of the app's
 * destructive-action convention.
 */
export default function BackupsModal({ backups, isBusy, onRestore, onDelete, onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  function formatWhen(backup) {
    const iso = backup.createdAt?.toDate ? backup.createdAt.toDate().toISOString() : backup.exportedAt;
    if (!iso) return 'Just now';
    return new Date(iso).toLocaleString();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cloud backups"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Cloud backups</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {backups.length === 0 ? (
          <div className="now-empty">No cloud backups yet — use "Back up now" to create one.</div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {backups.map((backup) => (
              <div
                key={backup.id}
                className="settings-row"
                style={{ borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}
              >
                <span style={{ flex: 1, fontSize: 13, minWidth: 160 }}>{formatWhen(backup)}</span>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    disabled={isBusy}
                    onClick={() => {
                      if (window.confirm('Restore this backup? This replaces your current tasks, boards, and settings.')) {
                        onRestore(backup.id);
                      }
                    }}
                  >
                    <RotateCcw size={12} />
                    Restore
                  </button>
                  <button
                    className="btn"
                    style={{ fontSize: 12, color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    disabled={isBusy}
                    onClick={() => {
                      if (window.confirm('Delete this backup? This cannot be undone.')) {
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
      </div>
    </div>
  );
}

/**
 * Settings → Recently deleted — put back a project, board section or tag you
 * deleted by mistake (see utils/trash.js).
 *
 * A card rather than a modal, unlike Tags and Templates: those open a picker
 * because the list is something you go and do something WITH. This one is
 * something you scan when something's missing, so the list itself — and how
 * long each entry has left — is the content, and hiding it behind a button
 * would make the app's only recovery affordance one click less visible than the
 * delete that needs it.
 *
 * Each row says what it was, how much comes back with it, and when it expires,
 * because "Restore" is not a promise that everything returns: tasks the user
 * has since deleted or filed elsewhere are deliberately left alone (see the
 * module's restore rule), so the result toast reports what actually happened
 * rather than claiming success.
 */

import React from 'react';
import { Undo2, Trash2, RotateCcw } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useConfirm } from '../../../context/ConfirmContext';
import {
  describeTrashEntry,
  describeTrashExpiry,
  pruneTrash,
  TRASH_RETENTION_DAYS,
} from '../../../utils/trash';

export default function TrashSection({ sectionRef }) {
  const { trash, restoreFromTrash, discardTrashEntry, setNotification } = useScheduler();
  const confirm = useConfirm();
  // Pruned for display as well as on load/delete: an entry can age out while
  // the page sits open, and showing an expired row you can't rely on is worse
  // than not showing it.
  const entries = pruneTrash(trash, Date.now());

  function handleRestore(entry) {
    const result = restoreFromTrash(entry.id);
    if (!result.ok) {
      setNotification({ type: 'error', message: result.error });
      return;
    }
    // Says what came back AND what didn't — a restore that silently skipped
    // half its tasks would look like a bug later.
    const skippedNote =
      result.skipped > 0
        ? result.skipped === 1
          ? ' 1 task was left where it is now.'
          : ` ${result.skipped} tasks were left where they are now.`
        : '';
    setNotification({
      type: 'success',
      message: `Restored "${entry.name}".${result.reattached > 0 ? ` ${result.reattached} task${result.reattached === 1 ? '' : 's'} reconnected.` : ''}${skippedNote}`,
    });
  }

  async function handleDiscard(entry) {
    const ok = await confirm(`Permanently delete "${entry.name}"? It won't be recoverable after this.`, {
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (ok) discardTrashEntry(entry.id);
  }

  return (
    <div className="card settings-card" data-tour="trash-card" ref={sectionRef}>
      <h3>Recently deleted</h3>
      <p className="settings-hint">
        Deleted projects, board sections and tags can be put back for {TRASH_RETENTION_DAYS} days. Their tasks were
        never deleted — they moved to Inbox or lost the tag — so restoring reconnects the ones you haven't since moved
        or deleted yourself. Shared projects can't be restored: their tasks live on the server, and deleting one gives
        up access to it.
      </p>
      {entries.length === 0 ? (
        <p className="settings-hint" style={{ marginTop: 0 }}>
          Nothing deleted recently.
        </p>
      ) : (
        <div className="trash-list">
          {entries.map((entry) => (
            <div className="trash-row" key={entry.id}>
              <div className="trash-row-main">
                <span className="trash-row-name">{entry.name}</span>
                <span className="form-hint trash-row-meta">
                  {describeTrashEntry(entry)} · {describeTrashExpiry(entry, Date.now())}
                </span>
              </div>
              <button type="button" className="btn settings-inline" onClick={() => handleRestore(entry)}>
                <Undo2 size={14} />
                Restore
              </button>
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Permanently delete "${entry.name}"`}
                title="Delete permanently"
                onClick={() => handleDiscard(entry)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {entries.length === 0 && (
        <p className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <RotateCcw size={12} aria-hidden="true" />
          Tasks and scheduled blocks have undo instead (Ctrl+Z).
        </p>
      )}
    </div>
  );
}

/**
 * ============================================================================
 * ShareProjectModal — manage a Collaborative Project's share links and
 * collaborators (Phase 2, Collaborative Projects).
 * ============================================================================
 * Two audiences, one modal:
 *  - OWNER: full control — create/rotate/revoke/delete the view and edit
 *    links (via shareLinkService, the only client allowed to touch them —
 *    see that file's header for why every link operation is a server call),
 *    plus collaborator management (role changes, removal, ownership
 *    transfer) which are ordinary direct Firestore writes authorized by
 *    firestore.rules for the owner (see sharedProjectService.js's new
 *    exports below).
 *  - NON-OWNER: a read-only summary (who owns it, your role, who else is
 *    in it) — no link controls, no collaborator management are rendered at
 *    all (not shown-disabled), since a viewer/editor has no rules-granted
 *    path to any of those writes.
 *
 * SECURITY: a share token is only ever shown inside the owner's own copyable
 * link URL — never logged, never put in a title/data attribute (see the
 * `LinkRow` component below). `fetchShareLinks`/`setShareLink` are the only
 * two ways a token ever reaches the client at all (shareLinkService.js).
 */

import React, { useEffect, useState } from 'react';
import { X, Copy, Check, RotateCcw, Trash2, Ban, Link as LinkIcon, Crown, UserMinus } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { fetchShareLinks, setShareLink, ShareLinkError } from '../../services/shareLinkService';
import { buildShareUrl } from '../../utils/joinFlow';
import {
  SHARE_ROLES,
  getProjectShareState,
  planOwnershipTransfer,
} from '../../utils/sharedProjectAccess';
import { initialsOf, isSafePhotoURL } from '../../utils/avatarDisplay';
import {
  changeCollaboratorRole,
  removeCollaborator,
  transferSharedProjectOwnership,
} from '../../services/sharedProjectService';

/** End-of-day millis for a `<input type="date">` value, or null for "no expiry". */
function endOfDayMillis(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** `<input type="date">`-shaped value for a stored expiresAt (millis), or '' if unset. */
function dateInputValue(expiresAt) {
  if (!expiresAt) return '';
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One link's controls (view or edit). Never receives more than the link
 * state it needs — the raw token lives only in `link.token`, used solely to
 * build the display URL below; it's never spread into a title/data
 * attribute or logged.
 */
function LinkRow({ label, linkType, link, busy, onAction }) {
  const { setNotification } = useScheduler();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState(dateInputValue(link?.expiresAt));

  useEffect(() => {
    setExpiryDraft(dateInputValue(link?.expiresAt));
  }, [link?.expiresAt]);

  const now = Date.now();
  const isExpired = !!link && typeof link.expiresAt === 'number' && link.expiresAt < now;
  const url = link ? buildShareUrl(link.token) : '';

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API rejects on insecure origins / some browser permission
      // states. window.prompt('Copy this link:', url) used to be the
      // fallback here, letting the user Ctrl+C the value out of the
      // browser's own prompt UI — but window.prompt is just as vulnerable to
      // silent browser suppression as window.confirm (see ConfirmContext.jsx),
      // so this now surfaces the same toast notification the rest of the app
      // uses (SchedulerContext's setNotification) with the link in the
      // message text, so the URL is still visible/selectable even though
      // there's no dedicated "copy" UI in a toast.
      setNotification({ type: 'error', message: `Couldn't copy automatically — copy this link manually: ${url}` });
    }
  }

  function applyExpiry() {
    onAction('set-expiry', endOfDayMillis(expiryDraft));
  }

  return (
    <div className="share-link-row">
      <div className="share-link-row-header">
        <span className="share-link-row-label">
          <LinkIcon size={13} />
          {label}
        </span>
        {link && (
          <span className={`share-link-status ${link.enabled && !isExpired ? 'is-active' : 'is-inactive'}`}>
            {!link.enabled ? 'Disabled' : isExpired ? 'Expired' : 'Active'}
          </span>
        )}
      </div>

      {!link ? (
        <button type="button" className="btn" disabled={busy} onClick={() => onAction('create')}>
          Create link
        </button>
      ) : (
        <>
          <div className="share-link-url-row">
            <input type="text" readOnly value={url} className="share-link-url-input" aria-label={`${label} URL`} />
            <button type="button" className="btn btn-icon" disabled={busy} onClick={copyUrl} aria-label="Copy link">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div aria-live="polite" className="visually-hidden">
            {copied ? 'Link copied to clipboard' : ''}
          </div>

          <div className="share-link-expiry-row">
            <label htmlFor={`${linkType}-expiry`}>Expires</label>
            <input
              id={`${linkType}-expiry`}
              type="date"
              value={expiryDraft}
              disabled={busy}
              onChange={(e) => setExpiryDraft(e.target.value)}
            />
            <button type="button" className="btn" disabled={busy} onClick={applyExpiry}>
              {expiryDraft ? 'Set' : 'Clear'}
            </button>
          </div>

          <div className="share-link-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                if (await confirm(`Rotate the ${label.toLowerCase()}? The current link will stop working immediately.`, { confirmLabel: 'Rotate' })) {
                  onAction('rotate');
                }
              }}
            >
              <RotateCcw size={13} />
              Rotate
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => onAction(link.enabled ? 'revoke' : 'enable')}>
              <Ban size={13} />
              {link.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ color: 'var(--color-danger)' }}
              disabled={busy}
              onClick={async () => {
                if (await confirm(`Delete the ${label.toLowerCase()}? The current link will stop working immediately.`, { confirmLabel: 'Delete' })) {
                  onAction('delete');
                }
              }}
            >
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ShareProjectModal({ project, onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const { sharedProjects } = useScheduler();
  const { user } = useAuth();
  const confirm = useConfirm();

  const sharedProjectId = project?.sharedProjectId;
  const sharedProject = sharedProjectId ? sharedProjects[sharedProjectId] : null;

  // For owners, we can determine ownership from project.ownerId alone, without
  // waiting for the shared-project subscription's first snapshot. This fixes a
  // race where the modal opens before the subscription delivers data, leaving
  // the user looking at "Setting up sharing…" indefinitely. Non-owners need the
  // subscription data to read collaborators/role info (getProjectShareState handles that).
  const isOwner = project?.ownerId === user?.uid;
  const shareState = getProjectShareState(project, sharedProject, user?.uid);

  const [links, setLinks] = useState(null); // {view, edit} once loaded
  const [loadError, setLoadError] = useState('');
  const [isLoadingLinks, setIsLoadingLinks] = useState(isOwner);
  const [linkBusy, setLinkBusy] = useState(null); // 'view' | 'edit' | null
  const [collabBusy, setCollabBusy] = useState(null); // uid currently being mutated, or null
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    if (!isOwner || !sharedProjectId) return;
    let cancelled = false;
    setIsLoadingLinks(true);
    setLoadError('');
    fetchShareLinks(sharedProjectId)
      .then((result) => {
        if (cancelled) return;
        setLinks({ view: result.view || null, edit: result.edit || null });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ShareLinkError ? err.message : 'Could not load share links.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLinks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner, sharedProjectId]);

  async function handleLinkAction(linkType, action, expiresAt) {
    setLinkBusy(linkType);
    setActionError('');
    try {
      const result = await setShareLink(sharedProjectId, linkType, action, expiresAt);
      setLinks({ view: result.view || null, edit: result.edit || null });
    } catch (err) {
      setActionError(err instanceof ShareLinkError ? err.message : 'That request failed. Try again.');
    } finally {
      setLinkBusy(null);
    }
  }

  async function handleRoleChange(collabUid, role) {
    setCollabBusy(collabUid);
    setActionError('');
    try {
      await changeCollaboratorRole(sharedProjectId, collabUid, role);
    } catch {
      setActionError("Couldn't change that collaborator's role. Try again.");
    } finally {
      setCollabBusy(null);
    }
  }

  async function handleRemove(collabUid, displayName) {
    if (!(await confirm(`Remove ${displayName} from this project? They'll lose access immediately.`, { confirmLabel: 'Remove' }))) return;
    setCollabBusy(collabUid);
    setActionError('');
    try {
      await removeCollaborator(sharedProjectId, collabUid);
    } catch {
      setActionError("Couldn't remove that collaborator. Try again.");
    } finally {
      setCollabBusy(null);
    }
  }

  async function handleTransfer(collabUid, displayName, photoURL) {
    const plan = planOwnershipTransfer({ sharedProject, actingUid: user?.uid, recipientUid: collabUid });
    if (!plan.allowed) {
      setActionError(transferRejectionMessage(plan.reason));
      return;
    }
    if (
      !(await confirm(
        `Transfer ownership of this project to ${displayName}? You'll become an editor and lose owner-only controls.`,
        { confirmLabel: 'Transfer', danger: false }
      ))
    ) {
      return;
    }
    setCollabBusy(collabUid);
    setActionError('');
    try {
      // The denormalized ownerDisplayName/ownerPhotoURL (see sharedProjectService.js's
      // createSharedProject) must move with ownership, or every reader of them
      // (SharedProjectBadge, the comment mention list) keeps showing the OLD
      // owner's name/photo after a transfer.
      await transferSharedProjectOwnership(sharedProjectId, plan.newOwnerId, plan.collaborators, {
        displayName,
        photoURL,
      });
    } catch {
      setActionError("Couldn't transfer ownership. Try again.");
    } finally {
      setCollabBusy(null);
    }
  }

  function transferRejectionMessage(reason) {
    switch (reason) {
      case 'recipient_anonymous':
        return "Anonymous collaborators can't become the owner — ask them to sign in first.";
      case 'recipient_not_collaborator':
        return 'That person is no longer a collaborator on this project.';
      case 'self_transfer':
        return "You're already the owner.";
      default:
        return "Couldn't transfer ownership.";
    }
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal share-project-modal"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Share project"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Share “{project?.name}”</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {actionError && <p className="share-modal-error">{actionError}</p>}

        {isOwner ? (
          <>
            <section className="share-modal-section">
              <h4>Links</h4>
              {isLoadingLinks ? (
                <div className="now-empty">Loading share links…</div>
              ) : loadError ? (
                <p className="share-modal-error">{loadError}</p>
              ) : (
                <>
                  <LinkRow
                    label="View link"
                    linkType="view"
                    link={links?.view}
                    busy={linkBusy === 'view'}
                    onAction={(action, expiresAt) => handleLinkAction('view', action, expiresAt)}
                  />
                  <LinkRow
                    label="Edit link"
                    linkType="edit"
                    link={links?.edit}
                    busy={linkBusy === 'edit'}
                    onAction={(action, expiresAt) => handleLinkAction('edit', action, expiresAt)}
                  />
                </>
              )}
            </section>

            <section className="share-modal-section">
              <h4>Collaborators</h4>
              {!sharedProject ? (
                <div className="now-empty">Loading collaborators…</div>
              ) : (shareState.collaborators?.length ?? 0) === 0 ? (
                <div className="now-empty">No collaborators yet — share a link above to invite people.</div>
              ) : (
                <ul className="share-collaborator-list">
                  {shareState.collaborators?.map((c) => {
                    const entry = sharedProject?.collaborators?.[c.uid];
                    const isAnonymous = !!entry?.isAnonymous;
                    const busy = collabBusy === c.uid;
                    return (
                      <li key={c.uid} className="share-collaborator-row">
                        <span className="presence-avatar" aria-hidden="true">
                          {isSafePhotoURL(c.photoURL) ? (
                            <img src={c.photoURL} alt="" className="presence-avatar-img" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="presence-avatar-initials">{initialsOf(c.displayName)}</span>
                          )}
                        </span>
                        <span className="share-collaborator-name">
                          {c.displayName}
                          {isAnonymous && <span className="share-collaborator-anon">Anonymous</span>}
                        </span>
                        <select
                          value={c.role}
                          disabled={busy}
                          aria-label={`Role for ${c.displayName}`}
                          onChange={(e) => handleRoleChange(c.uid, e.target.value)}
                        >
                          <option value={SHARE_ROLES.VIEWER}>Viewer</option>
                          <option value={SHARE_ROLES.EDITOR}>Editor</option>
                        </select>
                        <button
                          type="button"
                          className="btn btn-icon"
                          disabled={busy || isAnonymous}
                          title={isAnonymous ? undefined : 'Make owner'}
                          aria-label={`Make ${c.displayName} the owner`}
                          onClick={() => handleTransfer(c.uid, c.displayName, c.photoURL)}
                        >
                          <Crown size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          disabled={busy}
                          style={{ color: 'var(--color-danger)' }}
                          aria-label={`Remove ${c.displayName}`}
                          onClick={() => handleRemove(c.uid, c.displayName)}
                        >
                          <UserMinus size={14} />
                        </button>
                      </li>
                    );
                  }) ?? []}
                </ul>
              )}
            </section>
          </>
        ) : shareState.state === 'shared-with-me' ? (
          <section className="share-modal-section">
            <p>
              This project is shared with you. Your role: <strong>{shareState.role === 'editor' ? 'Editor' : 'Viewer'}</strong>
            </p>
            <p className="share-modal-readonly-note">Only the project owner can manage sharing.</p>
          </section>
        ) : (
          // This modal is only ever opened right after sharing succeeds or on
          // an already-shared project (see App.jsx's handleShareProject) — so
          // reaching here always means the live sharedProjects subscription
          // just hasn't delivered its first snapshot yet, never a genuinely
          // unshared project. Always show the loading state instead of a
          // "not shared" message that would be actively wrong.
          <div className="now-empty">Setting up sharing…</div>
        )}
      </div>
    </div>
  );
}

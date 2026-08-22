/**
 * CommentThread — the comment composer + posted-comment list for
 * TaskDetailModal, extracted as part of the W3 restructure (see TODO.md).
 * Genuinely self-contained: comments post immediately (like Todoist)
 * rather than going through TaskDetailModal's draft/autosave lifecycle, so
 * this component never touches `initialSnapshotRef`/`isDirty`/
 * `commitChanges` — it only needs `task` from its parent, and pulls
 * everything else (user, sharedProject, addComment/deleteComment) from its
 * own hooks, the same "own its own state" convention Settings/sections/
 * already established.
 *
 * @-mention autocomplete (Collaborative Projects, Phase 3) is shared-task
 * only. Viewer-role collaborators get a read-only note instead of the
 * composer: comments are stored EMBEDDED in the task document's `comments`
 * array, not in a separate collection, so a comment write is really a write
 * to the whole task — `tasks/{taskId}`'s firestore.rules only allow
 * `parentOwner() || parentEditor()`. Widening that rule to include viewers
 * would let them edit every other field too, since rules can't cheaply
 * express "only the comments array changed" — so the UI hides the composer
 * instead of showing a write that would just fail.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '../../../hooks/useEscapeLayer';
import { createPortal } from 'react-dom';
import { Ban, FileIcon, Lock, Loader2, Paperclip, Send, X } from 'lucide-react';
import { useScheduler, MAX_COMMENTS_PER_TASK } from '../../../context/SchedulerContext';
import { useAuth } from '../../../context/AuthContext';
import { validateAttachment, formatFileSize, ATTACHMENT_ACCEPT } from '../../../services/attachmentService';
import { formatDisplayDateTime } from '../../../utils/dateUtils';
import {
  findActiveMentionSpan,
  getMentionCandidates,
  filterMentionCandidates,
  insertMention,
  parseCommentBody,
} from '../../../utils/commentMentions';
import { computeEffectiveRole, resolveOwnerProfile } from '../../../utils/sharedProjectAccess';

export default function CommentThread({ task }) {
  const { addComment, deleteComment, sharedProjects, viewersByProject } = useScheduler();
  const { user } = useAuth();

  const isSharedTask = !!task.sharedProjectId;
  const sharedProject = isSharedTask ? sharedProjects?.[task.sharedProjectId] : null;
  const myRole = isSharedTask ? computeEffectiveRole(sharedProject, user?.uid) : null;
  const isReadOnlyViewer = isSharedTask && myRole === 'viewer';
  const atCommentCap = (task.comments?.length || 0) >= MAX_COMMENTS_PER_TASK;

  const [commentText, setCommentText] = useState('');
  const [commentFile, setCommentFile] = useState(null);
  const [commentFilePreview, setCommentFilePreview] = useState(null);
  const [isPostingComment, setIsPostingComment] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [lightboxAttachment, setLightboxAttachment] = useState(null);
  const commentFileInputRef = useRef(null);
  const commentInputRef = useRef(null);

  // @-mention autocomplete state — `mentionSpan` is the in-progress "@query"
  // the caret currently sits at the end of (see commentMentions.js's
  // findActiveMentionSpan), null when the caret isn't inside one.
  const [mentionSpan, setMentionSpan] = useState(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);

  // The owner has no entry in `collaborators` (see SharedProject typedef) —
  // resolveOwnerProfile prefers the denormalized ownerDisplayName/
  // ownerPhotoURL on the project doc (durable, works while the owner's
  // offline), falling back to live presence and then a generic label for a
  // project doc that predates that field.
  const ownerProfile = sharedProject
    ? resolveOwnerProfile(sharedProject, viewersByProject?.[task.sharedProjectId], sharedProject.ownerId)
    : null;
  const mentionCandidates = sharedProject
    ? getMentionCandidates({
        ownerId: sharedProject.ownerId,
        collaborators: sharedProject.collaborators,
        currentUid: user?.uid,
        ownerDisplayName: ownerProfile?.displayName,
        ownerPhotoURL: ownerProfile?.photoURL,
      })
    : [];
  const mentionMatches = mentionSpan ? filterMentionCandidates(mentionSpan.query, mentionCandidates) : [];
  const mentionDropdownOpen = isSharedTask && !!mentionSpan && mentionMatches.length > 0;

  // Escape dismisses the mention dropdown and nothing else. This sits inside
  // TaskDetailModal, which is itself an escape layer, so it has to register as
  // a deeper one — otherwise the modal takes the keypress and the half-written
  // comment goes with it.
  useEscapeLayer(mentionDropdownOpen, () => setMentionSpan(null));

  /** Re-derive the active "@query" span from the input's current caret position. */
  function refreshMentionSpan(nextText) {
    if (!isSharedTask) return;
    const el = commentInputRef.current;
    const caret = el ? el.selectionStart : null;
    const span = caret == null ? null : findActiveMentionSpan(nextText, caret);
    setMentionSpan(span);
    setMentionHighlight(0);
  }

  function selectMention(candidate) {
    const el = commentInputRef.current;
    const caret = el ? el.selectionStart : commentText.length;
    if (!mentionSpan) return;
    const { text: nextText, caret: nextCaret } = insertMention(commentText, mentionSpan, candidate, caret);
    setCommentText(nextText);
    setMentionSpan(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  /** Returns true if it handled the key (caller should preventDefault). */
  function handleCommentInputKeyDown(e) {
    if (mentionDropdownOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionHighlight((i) => Math.min(i + 1, mentionMatches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionHighlight((i) => Math.max(i - 1, 0));
        return true;
      }
      // Escape is claimed by the escape layer below, not here — inside
      // TaskDetailModal a keydown branch never sees it (see useEscapeLayer),
      // and one press used to close the modal and lose the comment draft.
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionMatches[mentionHighlight]);
        return true;
      }
    }
    return false;
  }

  // Revoke the previous object URL whenever the pending attachment changes
  // (new file picked, removed, or comment posted) so picking several image
  // attachments in a row doesn't leak blob URLs for the lifetime of the tab.
  useEffect(() => {
    return () => {
      if (commentFilePreview) URL.revokeObjectURL(commentFilePreview);
    };
  }, [commentFilePreview]);

  function handleCommentFileSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = validateAttachment(file);
    if (error) {
      setCommentError(error);
      return;
    }
    setCommentError('');
    setCommentFile(file);
    setCommentFilePreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  }

  function handleRemoveCommentFile() {
    setCommentFile(null);
    setCommentFilePreview(null);
  }

  // Lets a screenshot on the clipboard (Ctrl+V / Cmd+V, e.g. from Win+Shift+S)
  // attach directly to the comment without saving it to disk first — same
  // validation/preview path as picking a file.
  function handleCommentPaste(e) {
    const file = Array.from(e.clipboardData?.items || [])
      .find((item) => item.kind === 'file')
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    // Attachments aren't offered on shared tasks (see the attach-button
    // removal below), but paste doesn't go through that button — guard it
    // here too so a pasted screenshot can't sneak a file in anyway.
    if (isSharedTask) {
      setCommentError('Attachments aren\'t available in shared projects yet.');
      return;
    }
    const error = validateAttachment(file);
    if (error) {
      setCommentError(error);
      return;
    }
    setCommentError('');
    setCommentFile(file);
    setCommentFilePreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  }

  async function handlePostComment() {
    if (isReadOnlyViewer) return; // Defense in depth — UI already hides the composer for viewers.
    const text = commentText.trim();
    if (!text && !commentFile) return;
    if (atCommentCap) {
      setCommentError(`This task has reached the ${MAX_COMMENTS_PER_TASK}-comment limit — delete an old comment to add a new one.`);
      return;
    }
    setIsPostingComment(true);
    setCommentError('');
    try {
      await addComment(task.id, { text, file: commentFile });
      setCommentText('');
      setMentionSpan(null);
      handleRemoveCommentFile();
    } catch (err) {
      setCommentError(err.message || 'Failed to post comment.');
    } finally {
      setIsPostingComment(false);
    }
  }

  return (
    <>
      <div className="form-row comments-section">
        <label>
          Comments{task.comments?.length ? ` (${task.comments.length}/${MAX_COMMENTS_PER_TASK})` : ''}
        </label>
        <div className="comment-list">
          {(task.comments || []).map((c) => {
            // Personal-task comments have no author fields (see
            // Comment typedef) — every comment there was posted by
            // the current user, so this falls back to `user` for
            // avatar/name exactly like it always has. A shared
            // task's comment renders ITS OWN stored author instead
            // (Phase 3) — this used to hardcode the CURRENT user for
            // every row, which was wrong as soon as anyone else
            // posted.
            const authorName = c.authorDisplayName || user?.displayName || user?.email || '?';
            const authorPhotoURL = c.authorUid ? c.authorPhotoURL : user?.photoURL;
            return (
              <div key={c.id} className="comment-row">
                {authorPhotoURL ? (
                  <img src={authorPhotoURL} alt="" referrerPolicy="no-referrer" className="account-avatar" />
                ) : (
                  <span className="account-avatar account-avatar-fallback">{authorName[0].toUpperCase()}</span>
                )}
                <div className="comment-body">
                  {isSharedTask && c.authorDisplayName && (
                    <span className="comment-author">{c.authorDisplayName}</span>
                  )}
                  {c.text && (
                    <p className="comment-text">
                      {parseCommentBody(c.text).map((seg, i) =>
                        seg.type === 'mention' ? (
                          <span key={i} className="comment-mention">
                            @{seg.displayName}
                          </span>
                        ) : (
                          <React.Fragment key={i}>{seg.value}</React.Fragment>
                        )
                      )}
                    </p>
                  )}
                  {c.attachment &&
                    (c.attachment.type.startsWith('image/') ? (
                      <button
                        type="button"
                        className="comment-attachment-thumb"
                        onClick={() => setLightboxAttachment(c.attachment)}
                      >
                        <img src={c.attachment.url} alt={c.attachment.name} />
                      </button>
                    ) : (
                      <a
                        href={c.attachment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="comment-attachment-file"
                      >
                        <FileIcon size={14} />
                        <span className="comment-attachment-file-name">{c.attachment.name}</span>
                        <span className="comment-attachment-file-size">{formatFileSize(c.attachment.size)}</span>
                      </a>
                    ))}
                  <span className="comment-meta">{formatDisplayDateTime(c.createdAt)}</span>
                </div>
                {/* Deleting a comment is also a task write (embedded array) — same
                    rules gap as posting, so hidden for read-only viewers too. */}
                {!isReadOnlyViewer && (
                  <button
                    type="button"
                    className="btn btn-icon comment-remove"
                    onClick={() => deleteComment(task.id, c.id)}
                    style={{ color: 'var(--color-danger)' }}
                    aria-label="Delete comment"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {(commentError || atCommentCap) && (
          <p className="form-warning">
            <Ban size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span>
              {commentError ||
                `Comment limit reached (${MAX_COMMENTS_PER_TASK}) — delete an old comment to add a new one.`}
            </span>
          </p>
        )}

        {commentFile && (
          <div className="comment-pending-file">
            {commentFilePreview ? (
              <img src={commentFilePreview} alt="" className="comment-pending-thumb" />
            ) : (
              <FileIcon size={14} />
            )}
            <span className="comment-pending-name">{commentFile.name}</span>
            <button type="button" onClick={handleRemoveCommentFile} aria-label="Remove attachment">
              <X size={12} />
            </button>
          </div>
        )}

        {isReadOnlyViewer ? (
          <p className="comment-viewonly-note">
            <Lock size={13} aria-hidden="true" />
            <span>Commenting needs edit access on this project — ask the owner for editor access to reply.</span>
          </p>
        ) : (
        <div className="comment-input-bar-wrapper">
          {/* Shared tasks can't attach files yet (Storage isn't provisioned —
              see attachmentService.js's checkAttachmentAllowed), so this note
              takes the attach button's place instead of stacking a second
              notice under the comment-cap warning above. Only shown once the
              cap note above isn't already covering this state's own composer. */}
          {isSharedTask && !atCommentCap && (
            <p className="comment-viewonly-note">
              <Paperclip size={13} aria-hidden="true" />
              <span>Attachments aren't available in shared projects yet — text comments work as usual.</span>
            </p>
          )}
          {mentionDropdownOpen && (
            <ul className="mention-dropdown comment-mention-dropdown" role="listbox">
              {mentionMatches.map((candidate, i) => (
                <li key={candidate.uid} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === mentionHighlight}
                    className={`mention-dropdown-option ${i === mentionHighlight ? 'highlighted' : ''}`}
                    onMouseEnter={() => setMentionHighlight(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectMention(candidate);
                    }}
                  >
                    {candidate.photoURL ? (
                      <img src={candidate.photoURL} alt="" referrerPolicy="no-referrer" className="account-avatar" />
                    ) : (
                      <span className="account-avatar account-avatar-fallback">
                        {candidate.displayName[0].toUpperCase()}
                      </span>
                    )}
                    {candidate.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="comment-input-bar">
            <input
              ref={commentInputRef}
              type="text"
              value={commentText}
              onChange={(e) => {
                setCommentText(e.target.value);
                refreshMentionSpan(e.target.value);
              }}
              onKeyDown={(e) => {
                if (handleCommentInputKeyDown(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handlePostComment();
                }
              }}
              onKeyUp={() => refreshMentionSpan(commentText)}
              onClick={() => refreshMentionSpan(commentText)}
              onBlur={() => setMentionSpan(null)}
              onPaste={handleCommentPaste}
              placeholder={atCommentCap ? 'Comment limit reached' : isSharedTask ? 'Comment (type @ to mention)' : 'Comment'}
              disabled={isPostingComment || atCommentCap}
            />
            {!isSharedTask && (
              <>
                <input
                  ref={commentFileInputRef}
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  style={{ display: 'none' }}
                  onChange={handleCommentFileSelect}
                />
                <button
                  type="button"
                  className="btn btn-icon comment-attach-btn"
                  onClick={() =>
                    user ? commentFileInputRef.current?.click() : setCommentError('Sign in to attach files to a comment.')
                  }
                  title={user ? 'Attach a file' : 'Sign in to attach files'}
                  disabled={isPostingComment || atCommentCap}
                >
                  <Paperclip size={15} />
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-icon comment-send-btn"
              onClick={handlePostComment}
              disabled={isPostingComment || atCommentCap || (!commentText.trim() && !commentFile)}
              aria-label={isPostingComment ? 'Posting comment…' : 'Post comment'}
            >
              {isPostingComment ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
        )}
      </div>

      {lightboxAttachment &&
        createPortal(
          <div className="attachment-lightbox" onClick={() => setLightboxAttachment(null)}>
            <button
              type="button"
              className="attachment-lightbox-close"
              onClick={() => setLightboxAttachment(null)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <img src={lightboxAttachment.url} alt={lightboxAttachment.name} onClick={(e) => e.stopPropagation()} />
          </div>,
          document.body
        )}
    </>
  );
}

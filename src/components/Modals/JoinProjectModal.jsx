/**
 * JoinProjectModal — what a visitor sees after clicking someone's share link
 * (Collaborative Projects, Phase 2). Driven entirely by `useJoinFlow`'s
 * status; this component makes no decisions of its own.
 *
 * It covers four kinds of moment:
 *   - working (resolving the link / writing membership) — a plain busy state,
 *     since these are usually fast enough to barely register;
 *   - a name prompt, shown ONLY to anonymous visitors with no cached name for
 *     this link (a signed-in user already has a name and is never asked);
 *   - a specific failure — expired, revoked, or invalid — because "this link
 *     expired" tells someone to go ask for a new one, whereas a generic error
 *     just reads as the app being broken;
 *   - success, which self-dismisses since the app has already navigated to
 *     the project behind it.
 *
 * Deliberately NOT dismissable while work is in flight: closing midway would
 * leave the visitor signed in anonymously with a half-finished join and no
 * link left in the URL to retry with (it's stripped immediately — see
 * useJoinFlow's header).
 */

import React, { useEffect, useState } from 'react';
import { Users, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useModalA11y } from '../../hooks/useModalA11y';
import { JOIN_STATUS } from '../../utils/joinFlow';

const BUSY_STATUSES = new Set([JOIN_STATUS.RESOLVING, JOIN_STATUS.JOINING]);

/** Failure copy, keyed by status — each says what actually happened and what to do about it. */
const FAILURE_COPY = {
  [JOIN_STATUS.LINK_EXPIRED]: {
    title: 'This link has expired',
    body: 'Ask whoever shared it with you for a new link.',
  },
  [JOIN_STATUS.LINK_DISABLED]: {
    title: 'This link has been turned off',
    body: 'The project owner revoked it. Ask them for a new link if you still need access.',
  },
  [JOIN_STATUS.INVALID_TOKEN]: {
    title: "This link doesn't work",
    body: "It may have been changed, deleted, or copied incompletely. Check you have the whole link, or ask for a new one.",
  },
  [JOIN_STATUS.ALREADY_MEMBER]: {
    title: 'You already have access',
    body: "This project is already in your list — there's nothing more to do.",
  },
};

// This component is mounted unconditionally at the App root (see its own
// doc comment) so it's ready the instant a share link resolves — but that
// means useModalA11y must NOT run until there's actually a dialog on
// screen. useModalA11y pushes onto the app-wide open-modal stack for as
// long as its owning component stays mounted, so calling it here
// unconditionally would leave a permanent phantom entry on that stack for
// every session that never carries a join token (i.e. almost all of them),
// silently breaking Escape-to-close for every other modal for the rest of
// the session. Same split as CompleteTaskConfirmModal: bail out to null
// before any hook with a stack side effect runs, and do the real work in an
// inner component that only mounts while `status` is non-IDLE.
export default function JoinProjectModal({ status, projectName, error, onSubmitName, onDismiss }) {
  if (status === JOIN_STATUS.IDLE) return null;
  return (
    <JoinProjectModalInner
      status={status}
      projectName={projectName}
      error={error}
      onSubmitName={onSubmitName}
      onDismiss={onDismiss}
    />
  );
}

function JoinProjectModalInner({ status, projectName, error, onSubmitName, onDismiss }) {
  const [name, setName] = useState('');
  const isBusy = BUSY_STATUSES.has(status);
  // Escape must not close the modal mid-join (see the header), so the a11y
  // hook only gets a real close handler when dismissing is actually safe.
  const modalRef = useModalA11y(isBusy ? () => {} : onDismiss);

  // Success needs no interaction — the app has already switched to the
  // project underneath, so lingering here would just be a wall to click past.
  useEffect(() => {
    if (status !== JOIN_STATUS.SUCCESS) return undefined;
    const timer = setTimeout(onDismiss, 1600);
    return () => clearTimeout(timer);
  }, [status, onDismiss]);

  const failure = FAILURE_COPY[status];

  return (
    <div className="modal-overlay join-modal-overlay" onClick={isBusy ? undefined : onDismiss}>
      <div
        className="modal join-modal"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-modal-title"
      >
        {isBusy && (
          <div className="join-modal-body join-modal-centered" aria-live="polite">
            <Users size={28} className="join-modal-icon" aria-hidden="true" />
            <h2 id="join-modal-title" className="join-modal-title">
              {status === JOIN_STATUS.RESOLVING ? 'Opening shared project…' : 'Joining…'}
            </h2>
            {projectName && <p className="join-modal-sub">{projectName}</p>}
          </div>
        )}

        {status === JOIN_STATUS.NEEDS_NAME && (
          <form
            className="join-modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmitName(name);
            }}
          >
            <h2 id="join-modal-title" className="join-modal-title">
              {projectName ? `Join "${projectName}"` : 'Join shared project'}
            </h2>
            <p className="join-modal-sub">
              What should collaborators call you? This is only used to label your changes in this project.
            </p>
            <label className="join-modal-label" htmlFor="join-display-name">
              Display name
            </label>
            <input
              id="join-display-name"
              autoFocus
              className="input"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex"
            />
            <div className="join-modal-actions">
              <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
                Join project
              </button>
            </div>
          </form>
        )}

        {failure && (
          <div className="join-modal-body join-modal-centered">
            <AlertCircle size={28} className="join-modal-icon join-modal-icon-error" aria-hidden="true" />
            <h2 id="join-modal-title" className="join-modal-title">
              {failure.title}
            </h2>
            <p className="join-modal-sub">{failure.body}</p>
            <div className="join-modal-actions">
              <button type="button" className="btn btn-primary" onClick={onDismiss}>
                Continue to TaskFlow
              </button>
            </div>
          </div>
        )}

        {status === JOIN_STATUS.ERROR && (
          <div className="join-modal-body join-modal-centered">
            <AlertCircle size={28} className="join-modal-icon join-modal-icon-error" aria-hidden="true" />
            <h2 id="join-modal-title" className="join-modal-title">
              Couldn't open that link
            </h2>
            <p className="join-modal-sub">{error || 'Something went wrong. Please try again.'}</p>
            <div className="join-modal-actions">
              <button type="button" className="btn btn-primary" onClick={onDismiss}>
                Continue to TaskFlow
              </button>
            </div>
          </div>
        )}

        {status === JOIN_STATUS.SUCCESS && (
          <div className="join-modal-body join-modal-centered" aria-live="polite">
            <CheckCircle2 size={28} className="join-modal-icon join-modal-icon-success" aria-hidden="true" />
            <h2 id="join-modal-title" className="join-modal-title">
              {projectName ? `Joined "${projectName}"` : 'Joined'}
            </h2>
            <p className="join-modal-sub">It's in your project list now — no need to keep the link.</p>
          </div>
        )}
      </div>
    </div>
  );
}

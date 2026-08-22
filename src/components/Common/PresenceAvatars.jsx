/**
 * PresenceAvatars — who else is looking at this shared project right now
 * (Collaborative Projects, Phase 1).
 *
 * Deliberately simple: avatars only, no live cursors or selection highlights —
 * those are explicitly out of scope for v1 (see TODO.md). Presence is derived
 * from heartbeat recency by computeActiveViewers, not from an explicit "leave"
 * event, because the web has no reliable one: a closed laptop lid or a killed
 * tab never says goodbye, so a viewer simply ages out.
 *
 * Renders nothing at all when nobody else is viewing, so a personal project or
 * a shared one you happen to have to yourself shows no chrome.
 *
 * SECURITY NOTE: `displayName`/`photoURL` are user-supplied (an anonymous
 * visitor picks their own name). `firestore.rules` length-caps both and React
 * escapes the name on render, but photoURL is only ever used as an <img src>
 * after a scheme check — a `javascript:` URL here is exactly the kind of thing
 * rules can't catch. See the Collaborator typedef in types/index.js.
 */

import React from 'react';
import { initialsOf, isSafePhotoURL } from '../../utils/avatarDisplay';

/** Beyond this, remaining viewers collapse into a "+N" chip so a busy project can't overflow the toolbar. */
const MAX_VISIBLE = 3;

export default function PresenceAvatars({ viewers }) {
  if (!viewers || viewers.length === 0) return null;

  const visible = viewers.slice(0, MAX_VISIBLE);
  const overflow = viewers.length - visible.length;
  const label =
    viewers.length === 1
      ? `${viewers[0].displayName} is viewing this project`
      : `${viewers.map((v) => v.displayName).join(', ')} are viewing this project`;

  return (
    <div className="presence-avatars" role="group" aria-label={label} title={label}>
      {visible.map((viewer) => (
        <span key={viewer.uid} className="presence-avatar" aria-hidden="true">
          {isSafePhotoURL(viewer.photoURL) ? (
            <img src={viewer.photoURL} alt="" className="presence-avatar-img" referrerPolicy="no-referrer" />
          ) : (
            <span className="presence-avatar-initials">{initialsOf(viewer.displayName)}</span>
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span className="presence-avatar presence-avatar-overflow" aria-hidden="true">
          +{overflow}
        </span>
      )}
    </div>
  );
}

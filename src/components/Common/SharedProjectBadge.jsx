/**
 * SharedProjectBadge — the one place every project-listing surface renders
 * the THREE-state sharing indicator (Collaborative Projects, Phase 2):
 * personal (no badge at all — the quiet default), "shared by me" (you own
 * it, collaborators/link exist), or "shared with me" (someone else owns it,
 * you joined via their link). See utils/sharedProjectAccess.js's
 * `getProjectShareState` for the pure decision this renders — this component
 * is intentionally dumb, just formatting whatever that function returns.
 *
 * Two variants:
 * - `compact` (default) — a small icon + short text, for dense lists (sidebar
 *   rows, ManageProjectsModal, search dropdown) where there's no room for
 *   avatars or names.
 * - `detailed` — for larger surfaces (List view's project header): adds the
 *   collaborator count/avatars for "shared by me", or the owner's name for
 *   "shared with me".
 *
 * ACCESSIBILITY: the icon alone never carries the meaning — every rendered
 * badge has a plain-English `aria-label`/visible text alternative (not just
 * an icon+color), since color/icon-only status is exactly the kind of thing
 * screen readers and colorblind users can't rely on.
 *
 * Renders `null` for `'personal'` (see getProjectShareState) — the sidebar/
 * list/etc. call sites don't need their own "personal ? null : ..." guard.
 */

import React from 'react';
import { Users, UserCircle2 } from 'lucide-react';
import { getProjectShareState } from '../../utils/sharedProjectAccess';
import { initialsOf, isSafePhotoURL } from '../../utils/avatarDisplay';

/** Beyond this, remaining collaborator avatars collapse into a "+N" chip — same threshold as PresenceAvatars. */
const MAX_VISIBLE_AVATARS = 3;

/**
 * @param {object} props
 * @param {object} props.project - The app-local Project (src/types/index.js).
 * @param {object|null|undefined} props.sharedProject - The live `sharedProjects/{id}` doc for
 *   `project.sharedProjectId` (e.g. `sharedProjects[project.sharedProjectId]` from `useScheduler()`).
 * @param {string|null|undefined} props.uid - The current user's Firebase uid (from `useAuth().user?.uid`).
 * @param {'compact'|'detailed'} [props.variant] - Defaults to 'compact'.
 * @param {string} [props.ownerDisplayName] - Only used by 'shared-with-me' in the 'detailed' variant — the
 *   owner's display name to show alongside your role. Callers that don't have it (owner uids aren't
 *   resolvable client-side beyond what the shared project doc itself carries) may omit it; the badge
 *   falls back to a generic "Shared with you" without a name.
 */
export default function SharedProjectBadge({ project, sharedProject, uid, variant = 'compact', ownerDisplayName }) {
  const result = getProjectShareState(project, sharedProject, uid);

  if (result.state === 'personal') return null;

  if (result.state === 'shared-by-me') {
    const { collaboratorCount, collaborators } = result;
    const label =
      collaboratorCount === 0
        ? 'Shared by you — no collaborators yet'
        : `Shared by you with ${collaboratorCount} collaborator${collaboratorCount === 1 ? '' : 's'}`;

    if (variant === 'compact') {
      return (
        <span className="shared-project-badge shared-project-badge-by-me" title={label}>
          <Users size={12} aria-hidden="true" />
          <span className="shared-project-badge-text">{collaboratorCount > 0 ? collaboratorCount : 'Shared'}</span>
          <span className="visually-hidden">{label}</span>
        </span>
      );
    }

    const visible = collaborators.slice(0, MAX_VISIBLE_AVATARS);
    const overflow = collaborators.length - visible.length;
    return (
      <div className="shared-project-badge shared-project-badge-by-me shared-project-badge-detailed" title={label}>
        <Users size={13} aria-hidden="true" />
        <span className="shared-project-badge-text">Shared by you</span>
        {collaborators.length > 0 && (
          <div className="presence-avatars" role="group" aria-label={label}>
            {visible.map((c) => (
              <span key={c.uid} className="presence-avatar" aria-hidden="true">
                {isSafePhotoURL(c.photoURL) ? (
                  <img src={c.photoURL} alt="" className="presence-avatar-img" referrerPolicy="no-referrer" />
                ) : (
                  <span className="presence-avatar-initials">{initialsOf(c.displayName)}</span>
                )}
              </span>
            ))}
            {overflow > 0 && (
              <span className="presence-avatar presence-avatar-overflow" aria-hidden="true">
                +{overflow}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // shared-with-me
  const { role } = result;
  const roleLabel = role === 'editor' ? 'Editor' : 'Viewer';
  const label = ownerDisplayName ? `Shared with you by ${ownerDisplayName} · ${roleLabel}` : `Shared with you · ${roleLabel}`;

  if (variant === 'compact') {
    return (
      <span className="shared-project-badge shared-project-badge-with-me" title={label}>
        <UserCircle2 size={12} aria-hidden="true" />
        <span className="visually-hidden">{label}</span>
      </span>
    );
  }

  return (
    <div className="shared-project-badge shared-project-badge-with-me shared-project-badge-detailed" title={label}>
      <UserCircle2 size={13} aria-hidden="true" />
      <span className="shared-project-badge-text">
        {ownerDisplayName ? `Shared by ${ownerDisplayName}` : 'Shared with you'} · {roleLabel}
      </span>
    </div>
  );
}

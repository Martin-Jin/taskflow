import { describe, it, expect } from 'vitest';
import {
  SHARE_ROLES,
  OWNER,
  resolveTokenRole,
  computeEffectiveRole,
  canEdit,
  canView,
  canManageSharing,
  planCollaboratorJoin,
  planOwnershipTransfer,
  isSharedProject,
  isLikelySharedProjectOwner,
  getProjectShareState,
  generateShareToken,
  resolveOwnerProfile,
  getAssignableCollaborators,
  planSelfRename,
  planGuestMigration,
  isGuestUser,
  findOwnGuestName,
} from '../../src/utils/sharedProjectAccess';

function projectWithLinks({
  viewToken = 'view-tok',
  viewEnabled = true,
  viewExpiresAt,
  editToken = 'edit-tok',
  editEnabled = true,
  editExpiresAt,
} = {}) {
  return {
    ownerId: 'owner-1',
    collaborators: {},
    links: {
      view: { token: viewToken, enabled: viewEnabled, expiresAt: viewExpiresAt ?? null },
      edit: { token: editToken, enabled: editEnabled, expiresAt: editExpiresAt ?? null },
    },
  };
}

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();
const PAST = new Date('2026-01-01T00:00:00.000Z').getTime();
const FUTURE = new Date('2027-01-01T00:00:00.000Z').getTime();

describe('resolveTokenRole', () => {
  it('resolves the view token to viewer', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, 'view-tok')).toBe(SHARE_ROLES.VIEWER);
  });

  it('resolves the edit token to editor', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, 'edit-tok')).toBe(SHARE_ROLES.EDITOR);
  });

  it('returns null for a disabled view link even with the correct token', () => {
    const project = projectWithLinks({ viewEnabled: false });
    expect(resolveTokenRole(project, 'view-tok')).toBeNull();
  });

  it('returns null for a disabled edit link even with the correct token', () => {
    const project = projectWithLinks({ editEnabled: false });
    expect(resolveTokenRole(project, 'edit-tok')).toBeNull();
  });

  it('returns null for a rotated/stale token (no longer matches the current stored token)', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, 'old-view-tok')).toBeNull();
  });

  it('returns null for a token that has never existed', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, 'totally-unknown')).toBeNull();
  });

  it('returns null for an empty string token', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, '')).toBeNull();
  });

  it('returns null for a null token', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, null)).toBeNull();
  });

  it('returns null for an undefined token', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, undefined)).toBeNull();
  });

  it('returns null for a non-string token', () => {
    const project = projectWithLinks();
    expect(resolveTokenRole(project, 12345)).toBeNull();
    expect(resolveTokenRole(project, { token: 'view-tok' })).toBeNull();
  });

  it('returns null when links is missing entirely (malformed doc)', () => {
    expect(resolveTokenRole({ ownerId: 'owner-1' }, 'view-tok')).toBeNull();
  });

  it('returns null when sharedProject itself is missing/malformed', () => {
    expect(resolveTokenRole(null, 'view-tok')).toBeNull();
    expect(resolveTokenRole(undefined, 'view-tok')).toBeNull();
    expect(resolveTokenRole('not-an-object', 'view-tok')).toBeNull();
  });

  it('does not throw when a link entry itself is malformed (missing token/enabled)', () => {
    const project = { ownerId: 'owner-1', links: { view: {}, edit: null } };
    expect(() => resolveTokenRole(project, 'view-tok')).not.toThrow();
    expect(resolveTokenRole(project, 'view-tok')).toBeNull();
  });
});

describe('computeEffectiveRole', () => {
  it('gives the owner uid the owner role regardless of collaborators/token', () => {
    const project = projectWithLinks();
    expect(computeEffectiveRole(project, 'owner-1', null)).toBe(OWNER);
  });

  it('owner precedence beats even a presented token from someone else\'s link', () => {
    const project = projectWithLinks();
    expect(computeEffectiveRole(project, 'owner-1', 'edit-tok')).toBe(OWNER);
  });

  it('returns the stored collaborator role when no token is presented', () => {
    const project = projectWithLinks();
    project.collaborators['user-a'] = { role: SHARE_ROLES.EDITOR, displayName: 'A', photoURL: null, joinedAt: 'x' };
    expect(computeEffectiveRole(project, 'user-a', null)).toBe(SHARE_ROLES.EDITOR);
  });

  it('an existing editor presenting a view-only link stays editor (no silent downgrade)', () => {
    const project = projectWithLinks();
    project.collaborators['user-a'] = { role: SHARE_ROLES.EDITOR, displayName: 'A', photoURL: null, joinedAt: 'x' };
    expect(computeEffectiveRole(project, 'user-a', 'view-tok')).toBe(SHARE_ROLES.EDITOR);
  });

  it('an existing viewer presenting an edit link is upgraded to editor', () => {
    const project = projectWithLinks();
    project.collaborators['user-a'] = { role: SHARE_ROLES.VIEWER, displayName: 'A', photoURL: null, joinedAt: 'x' };
    expect(computeEffectiveRole(project, 'user-a', 'edit-tok')).toBe(SHARE_ROLES.EDITOR);
  });

  it('a brand new uid with only a view token resolves to viewer', () => {
    const project = projectWithLinks();
    expect(computeEffectiveRole(project, 'stranger', 'view-tok')).toBe(SHARE_ROLES.VIEWER);
  });

  it('a brand new uid with a disabled token resolves to null', () => {
    const project = projectWithLinks({ viewEnabled: false });
    expect(computeEffectiveRole(project, 'stranger', 'view-tok')).toBeNull();
  });

  it('returns null when there is no collaborator entry and no valid token', () => {
    const project = projectWithLinks();
    expect(computeEffectiveRole(project, 'stranger', null)).toBeNull();
    expect(computeEffectiveRole(project, 'stranger', 'bogus')).toBeNull();
  });

  it('does not throw and returns null for a malformed/missing links object', () => {
    const project = { ownerId: 'owner-1', collaborators: {} };
    expect(() => computeEffectiveRole(project, 'stranger', 'view-tok')).not.toThrow();
    expect(computeEffectiveRole(project, 'stranger', 'view-tok')).toBeNull();
  });

  it('does not throw for a completely malformed sharedProject doc', () => {
    expect(() => computeEffectiveRole(null, 'user-a', 'tok')).not.toThrow();
    expect(computeEffectiveRole(null, 'user-a', 'tok')).toBeNull();
    expect(computeEffectiveRole({}, 'user-a', 'tok')).toBeNull();
  });

  it('ignores a garbage stored role value on a collaborator entry', () => {
    const project = projectWithLinks();
    project.collaborators['user-a'] = { role: 'superadmin', displayName: 'A', photoURL: null, joinedAt: 'x' };
    expect(computeEffectiveRole(project, 'user-a', null)).toBeNull();
  });
});

describe('canEdit / canView / canManageSharing', () => {
  it('owner can do everything', () => {
    expect(canEdit(OWNER)).toBe(true);
    expect(canView(OWNER)).toBe(true);
    expect(canManageSharing(OWNER)).toBe(true);
  });

  it('editor can edit and view but not manage sharing', () => {
    expect(canEdit(SHARE_ROLES.EDITOR)).toBe(true);
    expect(canView(SHARE_ROLES.EDITOR)).toBe(true);
    expect(canManageSharing(SHARE_ROLES.EDITOR)).toBe(false);
  });

  it('viewer can view only', () => {
    expect(canEdit(SHARE_ROLES.VIEWER)).toBe(false);
    expect(canView(SHARE_ROLES.VIEWER)).toBe(true);
    expect(canManageSharing(SHARE_ROLES.VIEWER)).toBe(false);
  });

  it('null role can do nothing', () => {
    expect(canEdit(null)).toBe(false);
    expect(canView(null)).toBe(false);
    expect(canManageSharing(null)).toBe(false);
  });
});

describe('planCollaboratorJoin', () => {
  it('allows a join with a valid view token and returns a viewer collaboratorEntry', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      displayName: 'New User',
      photoURL: null,
      presentedToken: 'view-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe(SHARE_ROLES.VIEWER);
    expect(result.collaboratorEntry).toEqual({
      role: SHARE_ROLES.VIEWER,
      displayName: 'New User',
      photoURL: null,
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('allows a join with a valid edit token and returns an editor collaboratorEntry', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      displayName: 'New User',
      presentedToken: 'edit-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe(SHARE_ROLES.EDITOR);
  });

  it('defaults displayName to "Anonymous" when none is provided', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'view-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.collaboratorEntry.displayName).toBe('Anonymous');
  });

  it('rejects when the token resolves to null (disabled link)', () => {
    const project = projectWithLinks({ viewEnabled: false });
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'view-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.role).toBeNull();
    expect(result.collaboratorEntry).toBeUndefined();
    expect(result.reason).toBeTruthy();
  });

  it('rejects when the token resolves to null (unknown/stale token)', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'garbage',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.role).toBeNull();
  });

  it('rejects when no uid is provided', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: null,
      presentedToken: 'view-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects (no-op) when the joining uid is already the owner', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'owner-1',
      presentedToken: 'view-tok',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.role).toBe(OWNER);
  });
});

describe('generateShareToken', () => {
  it('produces a string with at least 128 bits of entropy worth of length', () => {
    const token = generateShareToken();
    expect(typeof token).toBe('string');
    // Base64 encodes 6 bits/char; 128 bits needs >= ~22 chars (16 bytes -> 22 chars, no padding).
    expect(token.length).toBeGreaterThanOrEqual(20);
  });

  it('is URL-safe (no +, /, or = characters)', () => {
    const token = generateShareToken();
    expect(token).not.toMatch(/[+/=]/);
  });

  it('produces distinct tokens across many calls', () => {
    const tokens = new Set();
    for (let i = 0; i < 500; i++) {
      tokens.add(generateShareToken());
    }
    expect(tokens.size).toBe(500);
  });
});

describe('link expiry', () => {
  it('resolveTokenRole rejects an expired view link (millis expiresAt)', () => {
    const project = projectWithLinks({ viewExpiresAt: PAST });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBeNull();
  });

  it('resolveTokenRole rejects an expired edit link', () => {
    const project = projectWithLinks({ editExpiresAt: PAST });
    expect(resolveTokenRole(project, 'edit-tok', NOW)).toBeNull();
  });

  it('resolveTokenRole accepts a link with a future expiry', () => {
    const project = projectWithLinks({ viewExpiresAt: FUTURE });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('resolveTokenRole accepts a link with null expiresAt (never expires)', () => {
    const project = projectWithLinks({ viewExpiresAt: null });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('resolveTokenRole accepts a link with absent expiresAt entirely', () => {
    const project = projectWithLinks();
    delete project.links.view.expiresAt;
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('tolerates a Date instance for expiresAt', () => {
    const project = projectWithLinks({ viewExpiresAt: new Date(PAST) });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBeNull();
    const projectFuture = projectWithLinks({ viewExpiresAt: new Date(FUTURE) });
    expect(resolveTokenRole(projectFuture, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('tolerates a Firestore-Timestamp-like {seconds, nanoseconds} object', () => {
    const expiredTimestamp = { seconds: Math.floor(PAST / 1000), nanoseconds: 0 };
    const project = projectWithLinks({ viewExpiresAt: expiredTimestamp });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBeNull();

    const futureTimestamp = { seconds: Math.floor(FUTURE / 1000), nanoseconds: 0 };
    const projectFuture = projectWithLinks({ viewExpiresAt: futureTimestamp });
    expect(resolveTokenRole(projectFuture, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('tolerates a Timestamp-like object with toMillis()', () => {
    const project = projectWithLinks({ viewExpiresAt: { toMillis: () => PAST } });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBeNull();
  });

  it('tolerates a Timestamp-like object with toDate()', () => {
    const project = projectWithLinks({ viewExpiresAt: { toDate: () => new Date(PAST) } });
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBeNull();
  });

  it('does not throw on an unrecognized expiresAt shape and treats it as never-expiring', () => {
    const project = projectWithLinks({ viewExpiresAt: 'not-a-real-timestamp' });
    expect(() => resolveTokenRole(project, 'view-tok', NOW)).not.toThrow();
    expect(resolveTokenRole(project, 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('computeEffectiveRole rejects a brand-new uid via an expired token', () => {
    const project = projectWithLinks({ viewExpiresAt: PAST });
    expect(computeEffectiveRole(project, 'stranger', 'view-tok', NOW)).toBeNull();
  });

  it('an EXISTING collaborator is unaffected by their original link later expiring (expiry gates joining, not standing access)', () => {
    const project = projectWithLinks({ viewExpiresAt: PAST });
    project.collaborators['user-a'] = { role: SHARE_ROLES.VIEWER, displayName: 'A', photoURL: null, joinedAt: 'x' };
    // Presenting the now-expired token they originally joined with must not
    // evict them - their stored role still holds.
    expect(computeEffectiveRole(project, 'user-a', 'view-tok', NOW)).toBe(SHARE_ROLES.VIEWER);
    // Even with no token presented at all, standing access is untouched.
    expect(computeEffectiveRole(project, 'user-a', null, NOW)).toBe(SHARE_ROLES.VIEWER);
  });

  it('an existing collaborator can still be upgraded via a DIFFERENT, still-valid stronger link', () => {
    const project = projectWithLinks({ viewExpiresAt: PAST, editExpiresAt: FUTURE });
    project.collaborators['user-a'] = { role: SHARE_ROLES.VIEWER, displayName: 'A', photoURL: null, joinedAt: 'x' };
    expect(computeEffectiveRole(project, 'user-a', 'edit-tok', NOW)).toBe(SHARE_ROLES.EDITOR);
  });
});

describe('planCollaboratorJoin reasons', () => {
  it('reason is "invalid_token" for an unknown token', () => {
    const project = projectWithLinks();
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'garbage',
      now: '2026-06-15T12:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('invalid_token');
  });

  it('reason is "link_disabled" for a disabled-but-matching link', () => {
    const project = projectWithLinks({ viewEnabled: false });
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'view-tok',
      now: '2026-06-15T12:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('link_disabled');
  });

  it('reason is "link_expired" for an expired-but-matching link', () => {
    const project = projectWithLinks({ viewExpiresAt: new Date('2026-01-01T00:00:00.000Z') });
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'view-tok',
      now: '2026-06-15T12:00:00.000Z',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('link_expired');
  });

  it('a valid, unexpired link still succeeds (no false-positive expiry)', () => {
    const project = projectWithLinks({ viewExpiresAt: new Date('2027-01-01T00:00:00.000Z') });
    const result = planCollaboratorJoin({
      sharedProject: project,
      uid: 'new-user',
      presentedToken: 'view-tok',
      now: '2026-06-15T12:00:00.000Z',
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe(SHARE_ROLES.VIEWER);
  });
});

describe('planOwnershipTransfer', () => {
  function projectForTransfer() {
    return {
      ownerId: 'owner-1',
      collaborators: {
        'editor-a': { role: SHARE_ROLES.EDITOR, displayName: 'Editor A', photoURL: null, joinedAt: 'x' },
        'viewer-b': { role: SHARE_ROLES.VIEWER, displayName: 'Viewer B', photoURL: null, joinedAt: 'x' },
        'anon-c': { role: SHARE_ROLES.EDITOR, displayName: 'Anon C', photoURL: null, joinedAt: 'x', isAnonymous: true },
      },
    };
  }

  it('happy path: owner transfers to an existing non-anonymous collaborator', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'editor-a' });
    expect(result.allowed).toBe(true);
    expect(result.newOwnerId).toBe('editor-a');
    expect(result.collaboratorUpdates).toEqual({ 'owner-1': { role: SHARE_ROLES.EDITOR } });
  });

  // Regression: the returned plan must express the recipient's REMOVAL from
  // `collaborators`, not just the outgoing owner's demotion. An owner left
  // sitting in the map is invisible normally (computeEffectiveRole checks
  // ownerId first) but would make a later transfer away from them see a stale
  // "already a collaborator" entry and mis-authorize it.
  it('removes the new owner from collaborators and demotes the old owner to editor', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'editor-a' });
    expect(result.allowed).toBe(true);
    // New owner is no longer a collaborator — they're `ownerId` now.
    expect(result.collaborators).not.toHaveProperty('editor-a');
    // Outgoing owner is retained as an editor, not dropped entirely.
    expect(result.collaborators['owner-1'].role).toBe(SHARE_ROLES.EDITOR);
    // Everyone else is left exactly as they were.
    expect(result.collaborators['viewer-b']).toEqual(project.collaborators['viewer-b']);
    expect(result.collaborators['anon-c']).toEqual(project.collaborators['anon-c']);
  });

  it('does not mutate the input project when planning a transfer', () => {
    const project = projectForTransfer();
    planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'editor-a' });
    expect(project.ownerId).toBe('owner-1');
    expect(project.collaborators['editor-a'].role).toBe(SHARE_ROLES.EDITOR);
    expect(project.collaborators).not.toHaveProperty('owner-1');
  });

  // The post-transfer map must not leave the new owner resolving as a mere
  // collaborator, and the old owner must land on exactly `editor`.
  it('produces a post-transfer state where roles resolve correctly', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'editor-a' });
    const after = { ...project, ownerId: result.newOwnerId, collaborators: result.collaborators };
    expect(computeEffectiveRole(after, 'editor-a', undefined)).toBe(OWNER);
    expect(computeEffectiveRole(after, 'owner-1', undefined)).toBe(SHARE_ROLES.EDITOR);
    // And a second transfer back is now legitimate, since the ex-owner is a real collaborator.
    const back = planOwnershipTransfer({ sharedProject: after, actingUid: 'editor-a', recipientUid: 'owner-1' });
    expect(back.allowed).toBe(true);
  });

  it('rejects when the acting user is not the current owner', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'editor-a', recipientUid: 'viewer-b' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_owner');
  });

  it('rejects when the recipient is not an existing collaborator', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'stranger' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('recipient_not_collaborator');
  });

  it('rejects a self-transfer', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'owner-1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('self_transfer');
  });

  it('rejects transferring to an anonymous collaborator (via stored isAnonymous flag)', () => {
    const project = projectForTransfer();
    const result = planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: 'anon-c' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('recipient_anonymous');
  });

  it('rejects transferring to an anonymous collaborator (via injected predicate)', () => {
    const project = projectForTransfer();
    delete project.collaborators['editor-a'].isAnonymous;
    const result = planOwnershipTransfer({
      sharedProject: project,
      actingUid: 'owner-1',
      recipientUid: 'editor-a',
      isAnonymousUid: (uid) => uid === 'editor-a',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('recipient_anonymous');
  });

  it('rejects with missing uids', () => {
    const project = projectForTransfer();
    expect(planOwnershipTransfer({ sharedProject: project, actingUid: null, recipientUid: 'editor-a' }).allowed).toBe(false);
    expect(planOwnershipTransfer({ sharedProject: project, actingUid: 'owner-1', recipientUid: null }).allowed).toBe(false);
  });

  it('does not throw on a malformed sharedProject', () => {
    expect(() => planOwnershipTransfer({ sharedProject: null, actingUid: 'owner-1', recipientUid: 'editor-a' })).not.toThrow();
    expect(planOwnershipTransfer({ sharedProject: null, actingUid: 'owner-1', recipientUid: 'editor-a' }).allowed).toBe(false);
  });
});

describe('isSharedProject', () => {
  it('is false for a personal project with no sharedProjectId', () => {
    expect(isSharedProject({ id: 'p1', name: 'Personal' })).toBe(false);
  });

  it('is true once a project has a sharedProjectId', () => {
    expect(isSharedProject({ id: 'p1', name: 'Team', sharedProjectId: 'sp1' })).toBe(true);
  });

  it('is false for an empty-string sharedProjectId', () => {
    expect(isSharedProject({ id: 'p1', sharedProjectId: '' })).toBe(false);
  });

  it('is false for null/undefined input', () => {
    expect(isSharedProject(null)).toBe(false);
    expect(isSharedProject(undefined)).toBe(false);
  });
});

describe('isLikelySharedProjectOwner', () => {
  it('trusts the live sharedProject.ownerId when it has loaded', () => {
    expect(isLikelySharedProjectOwner({ ownerId: 'owner-1' }, { ownerId: 'owner-1' }, 'owner-1')).toBe(true);
    expect(isLikelySharedProjectOwner({ ownerId: 'owner-1' }, { ownerId: 'owner-1' }, 'someone-else')).toBe(false);
  });

  it('prefers the live value over a stale local ownerId after an ownership transfer', () => {
    // Local row still says the original owner (write-once, never updated by
    // transferSharedProjectOwnership); live doc says the new owner.
    const stalelyLocalProject = { ownerId: 'old-owner' };
    expect(isLikelySharedProjectOwner({ ownerId: 'new-owner' }, stalelyLocalProject, 'new-owner')).toBe(true);
    expect(isLikelySharedProjectOwner({ ownerId: 'new-owner' }, stalelyLocalProject, 'old-owner')).toBe(false);
  });

  it('falls back to the local ownerId when the live doc has not loaded yet', () => {
    // sharedProjects[id] is undefined right after a fresh page load, before
    // useSharedProjectSync's subscription delivers its first snapshot.
    expect(isLikelySharedProjectOwner(undefined, { ownerId: 'owner-1' }, 'owner-1')).toBe(true);
    expect(isLikelySharedProjectOwner(null, { ownerId: 'owner-1' }, 'owner-1')).toBe(true);
  });

  it('is false for a non-owner (collaborator leaving) whether or not the live doc has loaded', () => {
    // joinSharedProject never stamps ownerId onto a collaborator's local row.
    const collaboratorLocalProject = { sharedProjectId: 'sp1' };
    expect(isLikelySharedProjectOwner({ ownerId: 'owner-1' }, collaboratorLocalProject, 'collaborator-1')).toBe(false);
    expect(isLikelySharedProjectOwner(undefined, collaboratorLocalProject, 'collaborator-1')).toBe(false);
  });

  it('is false with no signed-in uid', () => {
    expect(isLikelySharedProjectOwner({ ownerId: 'owner-1' }, { ownerId: 'owner-1' }, undefined)).toBe(false);
  });
});

describe('getProjectShareState', () => {
  const project = { id: 'p1', name: 'Team', sharedProjectId: 'sp1' };

  it('is "personal" for a project with no sharedProjectId, regardless of other args', () => {
    const personalProject = { id: 'p1', name: 'Solo' };
    expect(getProjectShareState(personalProject, { ownerId: 'owner-1' }, 'owner-1')).toEqual({ state: 'personal' });
    expect(getProjectShareState(personalProject, null, null)).toEqual({ state: 'personal' });
  });

  it('is "personal" when signed out (no uid), even if the project is shared and the doc is loaded', () => {
    const sharedProject = { ownerId: 'owner-1', collaborators: {} };
    expect(getProjectShareState(project, sharedProject, null)).toEqual({ state: 'personal' });
    expect(getProjectShareState(project, sharedProject, undefined)).toEqual({ state: 'personal' });
  });

  it('is "personal" when shared but the sharedProjects doc has not loaded yet (onSnapshot pending)', () => {
    expect(getProjectShareState(project, undefined, 'owner-1')).toEqual({ state: 'personal' });
    expect(getProjectShareState(project, null, 'owner-1')).toEqual({ state: 'personal' });
  });

  it('is "personal" for a stale sharedProjectId with no matching doc (same as not-yet-loaded from the caller\'s perspective)', () => {
    expect(getProjectShareState(project, null, 'owner-1')).toEqual({ state: 'personal' });
  });

  it('is "personal" if the loaded doc is malformed (missing ownerId)', () => {
    expect(getProjectShareState(project, { collaborators: {} }, 'owner-1')).toEqual({ state: 'personal' });
  });

  it('is "shared-by-me" for the owner, with a collaborator count and list', () => {
    const sharedProject = {
      ownerId: 'owner-1',
      collaborators: {
        'user-a': { role: SHARE_ROLES.EDITOR, displayName: 'A', photoURL: 'https://x/a.png' },
        'user-b': { role: SHARE_ROLES.VIEWER, displayName: 'B', photoURL: null },
      },
    };
    const result = getProjectShareState(project, sharedProject, 'owner-1');
    expect(result.state).toBe('shared-by-me');
    expect(result.collaboratorCount).toBe(2);
    expect(result.collaborators).toEqual(
      expect.arrayContaining([
        { uid: 'user-a', displayName: 'A', photoURL: 'https://x/a.png', role: SHARE_ROLES.EDITOR },
        { uid: 'user-b', displayName: 'B', photoURL: null, role: SHARE_ROLES.VIEWER },
      ])
    );
  });

  it('is "shared-by-me" with an empty collaborator list when the owner has shared but nobody has joined yet', () => {
    const sharedProject = { ownerId: 'owner-1', collaborators: {} };
    const result = getProjectShareState(project, sharedProject, 'owner-1');
    expect(result).toEqual({ state: 'shared-by-me', collaboratorCount: 0, collaborators: [] });
  });

  it('is "shared-with-me" for a non-owner collaborator, surfacing the owner id and their own role', () => {
    const sharedProject = {
      ownerId: 'owner-1',
      collaborators: { 'user-a': { role: SHARE_ROLES.EDITOR, displayName: 'A', photoURL: null } },
    };
    expect(getProjectShareState(project, sharedProject, 'user-a')).toEqual({
      state: 'shared-with-me',
      ownerId: 'owner-1',
      role: SHARE_ROLES.EDITOR,
    });
  });

  it('"shared-with-me" defaults an anonymous collaborator with a garbage role to viewer', () => {
    const sharedProject = {
      ownerId: 'owner-1',
      collaborators: { 'anon-1': { role: 'superadmin', displayName: 'Anonymous', photoURL: null, isAnonymous: true } },
    };
    expect(getProjectShareState(project, sharedProject, 'anon-1')).toEqual({
      state: 'shared-with-me',
      ownerId: 'owner-1',
      role: SHARE_ROLES.VIEWER,
    });
  });

  it('"shared-with-me" for a uid with no collaborators entry at all (e.g. accessed via link, not yet in the map) defaults to viewer', () => {
    const sharedProject = { ownerId: 'owner-1', collaborators: {} };
    expect(getProjectShareState(project, sharedProject, 'stranger')).toEqual({
      state: 'shared-with-me',
      ownerId: 'owner-1',
      role: SHARE_ROLES.VIEWER,
    });
  });

  it('does not throw for a malformed collaborators field', () => {
    const sharedProject = { ownerId: 'owner-1', collaborators: 'not-an-object' };
    expect(() => getProjectShareState(project, sharedProject, 'owner-1')).not.toThrow();
    expect(getProjectShareState(project, sharedProject, 'owner-1')).toEqual({
      state: 'shared-by-me',
      collaboratorCount: 0,
      collaborators: [],
    });
  });
});

describe('resolveOwnerProfile', () => {
  it('prefers the denormalized ownerDisplayName/ownerPhotoURL on the project doc', () => {
    const sharedProject = { ownerId: 'owner-1', ownerDisplayName: 'Alice', ownerPhotoURL: 'https://x/alice.png' };
    expect(resolveOwnerProfile(sharedProject, [{ uid: 'owner-1', displayName: 'Stale Name', photoURL: null }], 'owner-1')).toEqual({
      displayName: 'Alice',
      photoURL: 'https://x/alice.png',
    });
  });

  it('treats a denormalized name with no photo as photoURL: null, not undefined', () => {
    const sharedProject = { ownerId: 'owner-1', ownerDisplayName: 'Alice' };
    expect(resolveOwnerProfile(sharedProject, null, 'owner-1')).toEqual({ displayName: 'Alice', photoURL: null });
  });

  it('falls back to live presence when the doc has no denormalized owner profile (pre-existing doc)', () => {
    const sharedProject = { ownerId: 'owner-1' };
    const viewers = [{ uid: 'owner-1', displayName: 'Bob', photoURL: 'https://x/bob.png' }];
    expect(resolveOwnerProfile(sharedProject, viewers, 'owner-1')).toEqual({
      displayName: 'Bob',
      photoURL: 'https://x/bob.png',
    });
  });

  it('falls back to a generic label when neither the doc nor presence has the owner', () => {
    expect(resolveOwnerProfile({ ownerId: 'owner-1' }, [], 'owner-1')).toEqual({
      displayName: 'Project owner',
      photoURL: null,
    });
    expect(resolveOwnerProfile(null, null, 'owner-1')).toEqual({ displayName: 'Project owner', photoURL: null });
  });

  it('ignores a viewer entry that is not the owner', () => {
    const viewers = [{ uid: 'someone-else', displayName: 'Not The Owner', photoURL: null }];
    expect(resolveOwnerProfile({ ownerId: 'owner-1' }, viewers, 'owner-1')).toEqual({
      displayName: 'Project owner',
      photoURL: null,
    });
  });
});

describe('getAssignableCollaborators', () => {
  it('includes the owner plus every collaborator, anonymous ones included', () => {
    const result = getAssignableCollaborators({
      ownerId: 'owner-1',
      ownerDisplayName: 'Alice',
      ownerPhotoURL: 'https://x/alice.png',
      collaborators: {
        'real-1': { role: 'editor', displayName: 'Bob', photoURL: 'https://x/bob.png' },
        'guest-1': { role: 'viewer', displayName: 'Guest 1234', photoURL: null, isAnonymous: true },
      },
    });
    expect(result).toEqual([
      { uid: 'owner-1', displayName: 'Alice', photoURL: 'https://x/alice.png' },
      { uid: 'real-1', displayName: 'Bob', photoURL: 'https://x/bob.png' },
      { uid: 'guest-1', displayName: 'Guest 1234', photoURL: null },
    ]);
  });

  it('does not exclude anonymous collaborators (deliberate divergence from getMentionCandidates)', () => {
    const result = getAssignableCollaborators({
      ownerId: 'owner-1',
      collaborators: { 'guest-1': { role: 'viewer', displayName: 'Guest', isAnonymous: true } },
    });
    expect(result.map((c) => c.uid)).toContain('guest-1');
  });

  it('does not exclude the current viewer (unlike getMentionCandidates, which has no currentUid param at all)', () => {
    const result = getAssignableCollaborators({
      ownerId: 'owner-1',
      collaborators: { 'real-1': { role: 'editor', displayName: 'Bob' } },
    });
    expect(result.map((c) => c.uid)).toEqual(['owner-1', 'real-1']);
  });

  it('falls back to generic labels/nulls when displayName/photoURL are missing', () => {
    const result = getAssignableCollaborators({
      ownerId: 'owner-1',
      collaborators: { 'real-1': { role: 'editor' } },
    });
    expect(result).toEqual([
      { uid: 'owner-1', displayName: 'Project owner', photoURL: null },
      { uid: 'real-1', displayName: 'Someone', photoURL: null },
    ]);
  });

  it('returns an empty list when there is no ownerId and no collaborators', () => {
    expect(getAssignableCollaborators({})).toEqual([]);
  });

  it('skips a malformed entry with an empty-string uid', () => {
    const result = getAssignableCollaborators({
      ownerId: 'owner-1',
      collaborators: { '': { role: 'editor', displayName: 'Nobody' } },
    });
    expect(result).toEqual([{ uid: 'owner-1', displayName: 'Project owner', photoURL: null }]);
  });
});

describe('planSelfRename', () => {
  const uid = 'user-1';

  it('returns project ids where the user is a member with a stale displayName', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { [uid]: { role: 'viewer', displayName: 'Old Name' } } },
      'proj-b': { ownerId: 'owner-y', collaborators: { [uid]: { role: 'editor', displayName: 'Old Name' } } },
    };
    expect(planSelfRename(uid, 'New Name', sharedProjects)).toEqual(['proj-a', 'proj-b']);
  });

  it('skips a project where the stored name already matches (no-op)', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { [uid]: { role: 'viewer', displayName: 'New Name' } } },
    };
    expect(planSelfRename(uid, 'New Name', sharedProjects)).toEqual([]);
  });

  it('skips a project where the user is the owner (no collaborators entry to rename)', () => {
    const sharedProjects = {
      'proj-a': { ownerId: uid, collaborators: { 'other-uid': { role: 'editor', displayName: 'Someone' } } },
    };
    expect(planSelfRename(uid, 'New Name', sharedProjects)).toEqual([]);
  });

  it('skips a project the user is not a member of at all', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { 'other-uid': { role: 'editor', displayName: 'Someone' } } },
    };
    expect(planSelfRename(uid, 'New Name', sharedProjects)).toEqual([]);
  });

  it('returns an empty array for missing/empty inputs rather than throwing', () => {
    expect(planSelfRename(null, 'New Name', {})).toEqual([]);
    expect(planSelfRename(uid, '', {})).toEqual([]);
    expect(planSelfRename(uid, 'New Name', null)).toEqual([]);
    expect(planSelfRename(uid, 'New Name', {})).toEqual([]);
  });
});

describe('planGuestMigration', () => {
  const oldUid = 'guest-1';

  it('returns one entry per project the old uid is a viewer/editor on', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { [oldUid]: { role: 'viewer', displayName: 'Ada', photoURL: 'a.png' } } },
      'proj-b': { ownerId: 'owner-y', collaborators: { [oldUid]: { role: 'editor', displayName: 'Ada' } } },
    };
    expect(planGuestMigration(oldUid, sharedProjects)).toEqual([
      { projectId: 'proj-a', role: 'viewer', displayName: 'Ada', photoURL: 'a.png' },
      { projectId: 'proj-b', role: 'editor', displayName: 'Ada', photoURL: null },
    ]);
  });

  it('skips a project the old uid is not a member of', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { 'other-uid': { role: 'editor', displayName: 'Someone' } } },
    };
    expect(planGuestMigration(oldUid, sharedProjects)).toEqual([]);
  });

  it('defensively skips a project where the old uid is the owner', () => {
    const sharedProjects = {
      'proj-a': { ownerId: oldUid, collaborators: {} },
    };
    expect(planGuestMigration(oldUid, sharedProjects)).toEqual([]);
  });

  it('falls back to "Anonymous" for a missing displayName', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { [oldUid]: { role: 'viewer' } } },
    };
    expect(planGuestMigration(oldUid, sharedProjects)).toEqual([
      { projectId: 'proj-a', role: 'viewer', displayName: 'Anonymous', photoURL: null },
    ]);
  });

  it('ignores a malformed role rather than guessing one', () => {
    const sharedProjects = {
      'proj-a': { ownerId: 'owner-x', collaborators: { [oldUid]: { role: 'admin', displayName: 'Ada' } } },
    };
    expect(planGuestMigration(oldUid, sharedProjects)).toEqual([]);
  });

  it('returns an empty array for missing/malformed inputs rather than throwing', () => {
    expect(planGuestMigration(null, {})).toEqual([]);
    expect(planGuestMigration(oldUid, null)).toEqual([]);
    expect(planGuestMigration(oldUid, {})).toEqual([]);
    expect(planGuestMigration(oldUid, 'not an object')).toEqual([]);
  });

  it('handles no shared projects at all (trivial case — nothing to migrate)', () => {
    expect(planGuestMigration(oldUid, {})).toEqual([]);
  });
});

describe('isGuestUser', () => {
  it('is true for a plain anonymous session (empty providerData)', () => {
    expect(isGuestUser({ isAnonymous: true, providerData: [] })).toBe(true);
  });

  it('is true for a guest even after a join replaces the session with a custom-token one', () => {
    // Post-join, Firebase reports isAnonymous: false for everyone (see
    // shareLinkService.js) — providerData must be what decides this, not
    // isAnonymous, which is why this case is pinned explicitly.
    expect(isGuestUser({ isAnonymous: false, providerData: [] })).toBe(true);
  });

  it('is false for a real Google-linked account, whatever isAnonymous says', () => {
    expect(isGuestUser({ isAnonymous: false, providerData: [{ providerId: 'google.com' }] })).toBe(false);
    expect(isGuestUser({ isAnonymous: true, providerData: [{ providerId: 'google.com' }] })).toBe(false);
  });

  it('is false for null/undefined (signed out)', () => {
    expect(isGuestUser(null)).toBe(false);
    expect(isGuestUser(undefined)).toBe(false);
  });

  it('treats a missing/malformed providerData as a guest rather than throwing', () => {
    expect(isGuestUser({})).toBe(true);
    expect(isGuestUser({ providerData: null })).toBe(true);
  });
});

describe('findOwnGuestName', () => {
  const uid = 'guest-1';

  it('finds the name from whichever joined project has an entry', () => {
    const sharedProjects = {
      'proj-a': { collaborators: { [uid]: { displayName: 'Guesty' } } },
    };
    expect(findOwnGuestName(uid, sharedProjects)).toBe('Guesty');
  });

  it('returns null when the uid has no entry anywhere', () => {
    const sharedProjects = { 'proj-a': { collaborators: { 'other-uid': { displayName: 'Someone' } } } };
    expect(findOwnGuestName(uid, sharedProjects)).toBeNull();
  });

  it('returns null for missing/empty inputs rather than throwing', () => {
    expect(findOwnGuestName(null, {})).toBeNull();
    expect(findOwnGuestName(uid, null)).toBeNull();
    expect(findOwnGuestName(uid, {})).toBeNull();
  });

  it('skips a blank displayName in favor of another project that has a real one', () => {
    const sharedProjects = {
      'proj-a': { collaborators: { [uid]: { displayName: '   ' } } },
      'proj-b': { collaborators: { [uid]: { displayName: 'Real Name' } } },
    };
    expect(findOwnGuestName(uid, sharedProjects)).toBe('Real Name');
  });
});

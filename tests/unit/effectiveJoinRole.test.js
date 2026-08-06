/**
 * Unit tests for effectiveJoinRole (cloudflare-worker/src/shareLinkLogic.js).
 *
 * This is the fix for a silent role-downgrade finding. The resolve endpoint
 * used to return whatever role the presented LINK granted, and the client wrote
 * it straight into `collaborators` — so an editor who re-opened an old view link
 * was demoted to viewer, and the project owner clicking their own link was
 * written into their own collaborators map. Neither the client (which cannot
 * read the project document before membership exists) nor firestore.rules
 * (which only checked the written role equals the token's role) could catch it.
 *
 * These assert the precedence rule stated in
 * src/utils/sharedProjectAccess.js's computeEffectiveRole: an existing
 * collaborator's stored role is a FLOOR, never a ceiling, and the owner is never
 * a collaborator on their own project. Kept in sync with that function by hand,
 * per shareLinkLogic.js's header contract.
 */

import { describe, expect, it } from 'vitest';
import { effectiveJoinRole } from '../../cloudflare-worker/src/shareLinkLogic.js';

const project = (overrides = {}) => ({
  ownerId: 'owner-1',
  collaborators: {},
  ...overrides,
});

describe('effectiveJoinRole', () => {
  it('gives a brand-new joiner exactly the role the link grants', () => {
    expect(effectiveJoinRole(project(), 'newcomer', 'viewer')).toEqual({ role: 'viewer', isOwner: false });
    expect(effectiveJoinRole(project(), 'newcomer', 'editor')).toEqual({ role: 'editor', isOwner: false });
  });

  it('does NOT downgrade an existing editor who presents a view link (the bug)', () => {
    const p = project({ collaborators: { bob: { role: 'editor' } } });
    expect(effectiveJoinRole(p, 'bob', 'viewer')).toEqual({ role: 'editor', isOwner: false });
  });

  it('DOES upgrade an existing viewer who presents an edit link', () => {
    const p = project({ collaborators: { bob: { role: 'viewer' } } });
    expect(effectiveJoinRole(p, 'bob', 'editor')).toEqual({ role: 'editor', isOwner: false });
  });

  it('keeps a matching role unchanged (re-clicking the same link is a no-op)', () => {
    const p = project({ collaborators: { bob: { role: 'viewer' } } });
    expect(effectiveJoinRole(p, 'bob', 'viewer')).toEqual({ role: 'viewer', isOwner: false });
  });

  it('reports the owner as owner and grants no collaborator role at all', () => {
    // The owner already has full access; writing them into `collaborators`
    // would leave ownerId and that map disagreeing about who they are.
    expect(effectiveJoinRole(project(), 'owner-1', 'editor')).toEqual({ role: null, isOwner: true });
    expect(effectiveJoinRole(project(), 'owner-1', 'viewer')).toEqual({ role: null, isOwner: true });
  });

  it('ignores a garbage/unknown stored role rather than trusting it as a floor', () => {
    const p = project({ collaborators: { bob: { role: 'admin' } } });
    expect(effectiveJoinRole(p, 'bob', 'viewer')).toEqual({ role: 'viewer', isOwner: false });
  });

  it('tolerates a missing/malformed project or collaborators map without throwing', () => {
    expect(effectiveJoinRole(null, 'bob', 'viewer')).toEqual({ role: 'viewer', isOwner: false });
    expect(effectiveJoinRole({}, 'bob', 'editor')).toEqual({ role: 'editor', isOwner: false });
    expect(effectiveJoinRole({ collaborators: null }, 'bob', 'viewer')).toEqual({ role: 'viewer', isOwner: false });
  });
});

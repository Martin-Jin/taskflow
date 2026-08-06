// Adversarial security-rules tests for the `sharedProjects` collection (see
// firestore.rules' "SHARED PROJECTS (collaboration — Phase 0)" block and
// TODO.md's "Non-negotiable security requirement"). Run via `npm run
// test:rules`, which boots the Firestore emulator first (see package.json /
// firebase.json) — these tests do NOT run as part of `npm run test:unit`.
//
// Fixtures are seeded with `withSecurityRulesDisabled` so setup itself never
// depends on the rules being tested (that would make the tests circular).
//
// IMPORTANT: per src/types/index.js's SharedProject/Collaborator typedefs and
// firestore.rules' isOwner()/isCollaborator() split, the owner is identified
// SOLELY by `ownerId` and must never appear as an entry in `collaborators`
// (role 'owner' is not a valid Collaborator.role — only 'editor'/'viewer').
// Fixtures below deliberately keep the owner out of `collaborators` so that
// membership checks are exercised as they really are in production, not
// masked by an owner-shaped collaborator entry that would make isMember()
// true via isCollaborator() even if isOwner()-based access were broken.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, query } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', '..', 'firestore.rules');

const PROJECT_ID = 'taskflow-rules-test';

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8571,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// --- Fixture ids ----------------------------------------------------------
const OWNER = 'owner-uid';
const EDITOR = 'editor-uid';
const VIEWER = 'viewer-uid';
const STRANGER = 'stranger-uid'; // signed in, but not a member of anything
const OTHER_OWNER = 'other-owner-uid'; // owns a second, unrelated project

const VIEW_TOKEN = 'view-token-with-enough-entropy-000';
const EDIT_TOKEN = 'edit-token-with-enough-entropy-000';

function collaboratorEntry(role, displayName, isAnonymous = false) {
  return { role, displayName, photoURL: null, joinedAt: 'x', isAnonymous };
}

// Owner is intentionally NOT a key here — see file-level comment above.
// NOTE: no `links` field — tokens no longer live on the project document at
// all (see firestore.rules' "WHERE TOKENS LIVE" header comment). Seed them
// separately into sharedProjects/{id}/private/links via seedLinks() below.
function baseProjectData(overrides = {}) {
  return {
    ownerId: OWNER,
    name: 'Shared Project A',
    collaborators: {
      [EDITOR]: collaboratorEntry('editor', 'Editor'),
      [VIEWER]: collaboratorEntry('viewer', 'Viewer'),
    },
    ...overrides,
  };
}

function defaultLinksData() {
  return {
    view: { token: VIEW_TOKEN, enabled: true },
    edit: { token: EDIT_TOKEN, enabled: true },
  };
}

async function seedProject(projectId, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sharedProjects', projectId), data);
  });
}

// Seeds the secret share-link tokens into the private subdocument no client
// can ever read or write (sharedProjects/{id}/private/links).
async function seedLinks(projectId, linksData) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sharedProjects', projectId, 'private', 'links'), linksData);
  });
}

async function seedTask(projectId, taskId, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sharedProjects', projectId, 'tasks', taskId), data);
  });
}

async function seedComment(projectId, taskId, commentId, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sharedProjects', projectId, 'tasks', taskId, 'comments', commentId), data);
  });
}

async function seedUserDoc(uid, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', uid), data);
  });
}

// withSecurityRulesDisabled's callback result is NOT propagated by the return
// value of withSecurityRulesDisabled itself (it's awaited and discarded) — so
// reads that need their value back must capture it into an outer variable.
async function readProjectBypassingRules(projectId) {
  let data;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'sharedProjects', projectId));
    data = snap.data();
  });
  return data;
}

// A "real" (non-anonymous) signed-in user. `joinEntryWellFormed()` reads
// `request.auth.token.firebase.sign_in_provider` to pin `isAnonymous`, so every
// authenticated context used to exercise a real account must carry an explicit
// non-'anonymous' provider claim — 'google.com' here, matching how the app's
// real Google-sign-in users actually look to rules.
function asUser(uid, claims) {
  return testEnv.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'google.com' },
    ...claims,
  }).firestore();
}

function asAnon(uid, claims) {
  return testEnv.authenticatedContext(uid, {
    ...claims,
    firebase: { sign_in_provider: 'anonymous' },
  }).firestore();
}

function unauth() {
  return testEnv.unauthenticatedContext().firestore();
}

// A JOINING context, modelled on what actually reaches the rules at join time.
//
// A join can only happen in a session created by `signInWithCustomToken` —
// that is the only way the `joinToken` claim exists at all — so the provider
// is ALWAYS 'custom' here, never 'google.com'/'anonymous'. That is precisely
// why `joinEntryWellFormed()` cannot read `sign_in_provider` to decide whether
// the joiner is anonymous (it would read 'custom' for everyone) and instead
// trusts the `wasAnonymous` claim the join endpoint mints from the visitor's
// original, pre-join token. These fixtures must keep modelling that, or they
// will silently stop testing the real shape of a join.
function asJoiner(uid, token, wasAnonymous) {
  return testEnv
    .authenticatedContext(uid, {
      firebase: { sign_in_provider: 'custom' },
      joinToken: token,
      ...(wasAnonymous !== undefined ? { wasAnonymous } : {}),
    })
    .firestore();
}

/** A real (Google-backed) account joining via a link. */
function asUserWithToken(uid, token) {
  return asJoiner(uid, token, false);
}

/** An anonymous visitor joining via a link. */
function asAnonWithToken(uid, token) {
  return asJoiner(uid, token, true);
}

describe('non-discoverability (core requirement)', () => {
  beforeEach(async () => {
    await seedProject(PROJECT_ID, baseProjectData());
  });

  it('a signed-in stranger cannot get a project they are not a member of', async () => {
    const db = asUser(STRANGER);
    await assertFails(getDoc(doc(db, 'sharedProjects', PROJECT_ID)));
  });

  it('a stranger cannot list/query the sharedProjects collection at all', async () => {
    const db = asUser(STRANGER);
    await assertFails(getDocs(collection(db, 'sharedProjects')));
  });

  it('even the legitimate owner cannot list/query the sharedProjects collection (list is never granted)', async () => {
    const db = asUser(OWNER);
    await assertFails(getDocs(collection(db, 'sharedProjects')));
    await assertFails(getDocs(query(collection(db, 'sharedProjects'))));
  });

  it('an unauthenticated user cannot read anything under sharedProjects', async () => {
    const db = unauth();
    await assertFails(getDoc(doc(db, 'sharedProjects', PROJECT_ID)));
    await assertFails(getDocs(collection(db, 'sharedProjects')));
  });

  it('a collaborator on project A cannot read project B, nor B tasks/comments', async () => {
    const PROJECT_B = 'project-b';
    await seedProject(PROJECT_B, baseProjectData({
      ownerId: OTHER_OWNER,
      collaborators: {},
    }));
    await seedTask(PROJECT_B, 'task-b1', { title: 'B task' });
    await seedComment(PROJECT_B, 'task-b1', 'comment-b1', { authorUid: OTHER_OWNER, text: 'hi' });

    // EDITOR is a member of PROJECT_ID (project A) but not project B.
    const db = asUser(EDITOR);
    await assertFails(getDoc(doc(db, 'sharedProjects', PROJECT_B)));
    await assertFails(getDoc(doc(db, 'sharedProjects', PROJECT_B, 'tasks', 'task-b1')));
    await assertFails(getDoc(doc(db, 'sharedProjects', PROJECT_B, 'tasks', 'task-b1', 'comments', 'comment-b1')));
  });

  it('a collaborator cannot read the owner personal users/{ownerUid} doc', async () => {
    await seedUserDoc(OWNER, { displayName: 'Owner personal doc' });
    const db = asUser(EDITOR);
    await assertFails(getDoc(doc(db, 'users', OWNER)));
  });
});

describe('reads/writes by role', () => {
  beforeEach(async () => {
    await seedProject(PROJECT_ID, baseProjectData());
    await seedLinks(PROJECT_ID, defaultLinksData());
  });

  it('owner can get their project', async () => {
    const db = asUser(OWNER);
    await assertSucceeds(getDoc(doc(db, 'sharedProjects', PROJECT_ID)));
  });

  // --- Regression coverage for the fixed privilege-escalation bug ---------
  // Tokens used to live in a `links` map ON the project document, which
  // every member could read via an ordinary `get` — letting a viewer read
  // the edit token in plaintext and re-join as an editor. These assert the
  // fixed design: no token is ever reachable through the project doc, and
  // the private/links doc itself is unreadable/unwritable by anyone.

  it('a viewer reading the project doc gets no token anywhere in the data (no links field at all)', async () => {
    const db = asUser(VIEWER);
    const snap = await assertSucceeds(getDoc(doc(db, 'sharedProjects', PROJECT_ID)));
    const data = snap.data();
    expect(data.links).toBeUndefined();
    expect(Object.keys(data)).not.toContain('links');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(VIEW_TOKEN);
    expect(serialized).not.toContain(EDIT_TOKEN);
  });

  it('no client can read sharedProjects/{id}/private/links: not the owner, an editor, a viewer, nor a non-member', async () => {
    const privateLinksRef = (db) => doc(db, 'sharedProjects', PROJECT_ID, 'private', 'links');
    await assertFails(getDoc(privateLinksRef(asUser(OWNER))));
    await assertFails(getDoc(privateLinksRef(asUser(EDITOR))));
    await assertFails(getDoc(privateLinksRef(asUser(VIEWER))));
    await assertFails(getDoc(privateLinksRef(asUser(STRANGER))));
  });

  it('no client can write sharedProjects/{id}/private/links either, including the owner', async () => {
    const privateLinksRef = (db) => doc(db, 'sharedProjects', PROJECT_ID, 'private', 'links');
    await assertFails(setDoc(privateLinksRef(asUser(OWNER)), defaultLinksData()));
    await assertFails(updateDoc(privateLinksRef(asUser(OWNER)), { view: { token: 'x', enabled: false } }));
  });

  it('owner can update project content', async () => {
    const db = asUser(OWNER);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: 'Renamed by owner' }));
  });

  it('owner can delete their project', async () => {
    const db = asUser(OWNER);
    await assertSucceeds(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID)));
  });

  it('editor can update project content', async () => {
    const db = asUser(EDITOR);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: 'Renamed by editor' }));
  });

  it('viewer can get but not update the project', async () => {
    const db = asUser(VIEWER);
    await assertSucceeds(getDoc(doc(db, 'sharedProjects', PROJECT_ID)));
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: 'Renamed by viewer' }));
  });

  it('viewer cannot delete the project', async () => {
    const db = asUser(VIEWER);
    await assertFails(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID)));
  });

  it('editor cannot delete the project', async () => {
    const db = asUser(EDITOR);
    await assertFails(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID)));
  });

  it('editor cannot modify collaborators', async () => {
    const db = asUser(EDITOR);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...data.collaborators,
        [STRANGER]: collaboratorEntry('editor', 'Stranger'),
      },
    }));
  });

  it('editor cannot add a links field back onto the project document', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      links: { view: { token: 'new-view-token-000000000000', enabled: true }, edit: { token: EDIT_TOKEN, enabled: true } },
    }));
  });

  it('editor cannot modify ownerId', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { ownerId: EDITOR }));
  });

  it('editor cannot write an unexpected key onto the project document', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { junk: 'x' }));
  });

  it('editor cannot write a large junk field under an unexpected key', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      bloat: 'a'.repeat(300 * 1024),
    }));
  });

  // REGRESSION: `projectFieldsAllowed`'s hasOnly describes the WHOLE document,
  // not just the changed keys, so a field missing from that list denies every
  // editor write to any project carrying it — not just writes that touch it.
  // When the denormalized owner name/photo were added, omitting them there
  // would have broken all editor renames on real projects while every existing
  // test still passed, because this file's fixture predates those fields.
  it('editor can still rename a project that carries the denormalized owner fields', async () => {
    await seedProject(PROJECT_ID, baseProjectData({
      ownerDisplayName: 'Owner Person',
      ownerPhotoURL: 'https://example.com/avatar.png',
    }));
    const db = asUser(EDITOR);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: 'Renamed by editor' }));
  });

  it('editor cannot set an over-long owner display name or photo URL', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { ownerDisplayName: 'a'.repeat(201) }));
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { ownerPhotoURL: 'a'.repeat(2001) }));
  });

  it('editor cannot set an empty or over-long name', async () => {
    const db = asUser(EDITOR);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: '' }));
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { name: 'a'.repeat(201) }));
  });

  it('owner cannot set collaborators to a string', async () => {
    const db = asUser(OWNER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), { collaborators: 'not-a-map' }));
  });

  it('owner cannot add a links field back onto the project document', async () => {
    const db = asUser(OWNER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      links: { view: { token: 'new-view-token-000000000000', enabled: true }, edit: { token: EDIT_TOKEN, enabled: true } },
    }));
  });

  describe('tasks', () => {
    beforeEach(async () => {
      await seedTask(PROJECT_ID, 'task-1', { title: 'Do the thing' });
    });

    it('viewer cannot write tasks', async () => {
      const db = asUser(VIEWER);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-2'), { title: 'New' }));
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1'), { title: 'Edited by viewer' }));
    });

    it('editor can write tasks', async () => {
      const db = asUser(EDITOR);
      await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1'), { title: 'Edited by editor' }));
    });

    it('owner can write tasks', async () => {
      const db = asUser(OWNER);
      await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1'), { title: 'Edited by owner' }));
    });

    it('viewer can read tasks', async () => {
      const db = asUser(VIEWER);
      await assertSucceeds(getDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1')));
    });
  });

  describe('comments', () => {
    beforeEach(async () => {
      await seedTask(PROJECT_ID, 'task-1', { title: 'Do the thing' });
    });

    it('a viewer can create a comment (commenting is not an edit privilege)', async () => {
      const db = asUser(VIEWER);
      await assertSucceeds(setDoc(
        doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c1'),
        { authorUid: VIEWER, text: 'hello' },
      ));
    });

    it('an editor can create a comment', async () => {
      const db = asUser(EDITOR);
      await assertSucceeds(setDoc(
        doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c2'),
        { authorUid: EDITOR, text: 'hello' },
      ));
    });

    it('nobody can create a comment with an authorUid that is not their own uid', async () => {
      const db = asUser(VIEWER);
      await assertFails(setDoc(
        doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c3'),
        { authorUid: EDITOR, text: 'impersonating' },
      ));
    });

    it('a stranger (non-member) cannot create a comment even with their own authorUid', async () => {
      const db = asUser(STRANGER);
      await assertFails(setDoc(
        doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c4'),
        { authorUid: STRANGER, text: 'intruder' },
      ));
    });

    it('a user cannot delete another user comment', async () => {
      await seedComment(PROJECT_ID, 'task-1', 'c-viewer', { authorUid: VIEWER, text: 'viewer said this' });
      const db = asUser(EDITOR);
      await assertFails(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c-viewer')));
    });

    it('a user cannot update another user comment', async () => {
      await seedComment(PROJECT_ID, 'task-1', 'c-viewer', { authorUid: VIEWER, text: 'viewer said this' });
      const db = asUser(EDITOR);
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c-viewer'), { text: 'edited by editor' }));
    });

    it('the owner can delete another user comment', async () => {
      await seedComment(PROJECT_ID, 'task-1', 'c-viewer', { authorUid: VIEWER, text: 'viewer said this' });
      const db = asUser(OWNER);
      await assertSucceeds(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c-viewer')));
    });

    it('the author can delete their own comment', async () => {
      await seedComment(PROJECT_ID, 'task-1', 'c-viewer', { authorUid: VIEWER, text: 'viewer said this' });
      const db = asUser(VIEWER);
      await assertSucceeds(deleteDoc(doc(db, 'sharedProjects', PROJECT_ID, 'tasks', 'task-1', 'comments', 'c-viewer')));
    });
  });

  describe('presence', () => {
    it('a member can write only their own presence doc', async () => {
      const db = asUser(EDITOR);
      await assertSucceeds(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', EDITOR), { lastSeenAt: 'x' }));
    });

    it('a member cannot write another uid presence doc', async () => {
      const db = asUser(EDITOR);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', VIEWER), { lastSeenAt: 'x' }));
    });

    it('a non-member cannot write a presence doc even under their own uid', async () => {
      const db = asUser(STRANGER);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', STRANGER), { lastSeenAt: 'x' }));
    });

    it('presence with just valid displayName/photoURL/lastSeenAt succeeds', async () => {
      const db = asUser(EDITOR);
      await assertSucceeds(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', EDITOR), {
        displayName: 'Editor Name',
        photoURL: 'https://example.com/p.png',
        lastSeenAt: 'x',
      }));
    });

    it('presence with an unexpected key fails', async () => {
      const db = asUser(EDITOR);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', EDITOR), {
        lastSeenAt: 'x',
        adminOverride: true,
      }));
    });

    it('presence with a displayName over 120 chars fails', async () => {
      const db = asUser(EDITOR);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', EDITOR), {
        lastSeenAt: 'x',
        displayName: 'a'.repeat(121),
      }));
    });

    it('presence with a ~200KB junk field fails', async () => {
      const db = asUser(EDITOR);
      await assertFails(setDoc(doc(db, 'sharedProjects', PROJECT_ID, 'presence', EDITOR), {
        lastSeenAt: 'x',
        photoURL: 'a'.repeat(200 * 1024),
      }));
    });
  });
});

// A collaborator (viewer or editor, anonymous or real) renaming only their
// OWN `collaborators` entry's `displayName` — see firestore.rules'
// `isRenamingSelf()`. Neither the owner branch nor the pre-existing editor
// branch admits this (see that function's comment), so this is its own rule.
describe('self-rename (collaborator changing own displayName)', () => {
  beforeEach(async () => {
    await seedProject(PROJECT_ID, baseProjectData());
  });

  it('a viewer can rename only their own displayName', async () => {
    const db = asUser(VIEWER);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'New Viewer Name',
    }));
    const data = await readProjectBypassingRules(PROJECT_ID);
    expect(data.collaborators[VIEWER].displayName).toBe('New Viewer Name');
  });

  it('an editor can rename only their own displayName', async () => {
    const db = asUser(EDITOR);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${EDITOR}.displayName`]: 'New Editor Name',
    }));
    const data = await readProjectBypassingRules(PROJECT_ID);
    expect(data.collaborators[EDITOR].displayName).toBe('New Editor Name');
  });

  it('an anonymous collaborator can rename their own displayName', async () => {
    await seedProject(PROJECT_ID, baseProjectData({
      collaborators: {
        [EDITOR]: collaboratorEntry('editor', 'Editor'),
        [VIEWER]: collaboratorEntry('viewer', 'Viewer', true),
      },
    }));
    const db = asAnon(VIEWER);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'New Anon Name',
    }));
  });

  it('a collaborator cannot rename someone else\'s entry', async () => {
    const db = asUser(VIEWER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${EDITOR}.displayName`]: 'Hijacked Name',
    }));
  });

  it('a collaborator cannot change their own role while renaming', async () => {
    const db = asUser(VIEWER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'New Name',
      [`collaborators.${VIEWER}.role`]: 'editor',
    }));
  });

  it('a collaborator cannot change their own isAnonymous flag while renaming', async () => {
    const db = asUser(VIEWER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'New Name',
      [`collaborators.${VIEWER}.isAnonymous`]: true,
    }));
  });

  // Not a case isRenamingSelf() itself needs to cover: the owner already has
  // full control over `collaborators` via `ownerFieldsUnchanged()` (any owner
  // write that keeps `collaborators` a map and doesn't touch `ownerId`/`links`
  // succeeds) — this just confirms that pre-existing owner path, unrelated to
  // the self-rename rule, tolerates a stray write under the owner's own uid
  // rather than accidentally rejecting it as malformed.
  it('the owner writing under their own uid key succeeds via the owner branch, not the self-rename one', async () => {
    const db = asUser(OWNER);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${OWNER}.displayName`]: 'Owner renamed',
    }));
  });

  it('a stranger (not a member) cannot rename anything', async () => {
    const db = asUser(STRANGER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'Hijacked Name',
    }));
  });

  it('a rename cannot smuggle in an unrelated top-level field', async () => {
    const db = asUser(VIEWER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'New Name',
      name: 'Renamed project too',
    }));
  });

  it('an empty or over-long displayName is rejected', async () => {
    const db = asUser(VIEWER);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: '',
    }));
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      [`collaborators.${VIEWER}.displayName`]: 'a'.repeat(121),
    }));
  });
});

describe('join-by-token', () => {
  beforeEach(async () => {
    await seedProject(PROJECT_ID, baseProjectData({ collaborators: {} }));
    await seedLinks(PROJECT_ID, defaultLinksData());
  });

  it('presenting the correct enabled edit token adds only yourself at role editor', async () => {
    const db = asUserWithToken(STRANGER, EDIT_TOKEN);
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('editor', 'Stranger'),
      },
    }));
    const after = await readProjectBypassingRules(PROJECT_ID);
    expect(after.collaborators[STRANGER].role).toBe('editor');
    expect(Object.keys(after.collaborators).sort()).toEqual([STRANGER]);
  });

  it('after a successful join, the project document does not contain a joinToken field', async () => {
    const db = asUserWithToken(STRANGER, EDIT_TOKEN);
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('editor', 'Stranger'),
      },
    }));
    const after = await readProjectBypassingRules(PROJECT_ID);
    expect(after.joinToken).toBeUndefined();
    expect(Object.keys(after)).not.toContain('joinToken');
  });

  it('presenting the view token yields role viewer', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('claiming editor role while presenting the view token fails', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('editor', 'Stranger'),
      },
    }));
  });

  it('a wrong/unknown token claim fails', async () => {
    const db = asUserWithToken(STRANGER, 'totally-bogus-token-00000000000000');
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('no claim at all fails', async () => {
    const db = asUser(STRANGER);
    const before = await readProjectBypassingRules(PROJECT_ID);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        ...before.collaborators,
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('a token on a disabled link fails', async () => {
    await seedLinks(PROJECT_ID, {
      view: { token: VIEW_TOKEN, enabled: false },
      edit: { token: EDIT_TOKEN, enabled: true },
    });
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('an expired link fails', async () => {
    const { Timestamp } = await import('firebase/firestore');
    const past = Timestamp.fromDate(new Date(Date.now() - 60 * 60 * 1000));
    await seedLinks(PROJECT_ID, {
      view: { token: VIEW_TOKEN, enabled: true, expiresAt: past },
      edit: { token: EDIT_TOKEN, enabled: true },
    });
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('a future expiresAt succeeds', async () => {
    const { Timestamp } = await import('firebase/firestore');
    const future = Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000));
    await seedLinks(PROJECT_ID, {
      view: { token: VIEW_TOKEN, enabled: true, expiresAt: future },
      edit: { token: EDIT_TOKEN, enabled: true },
    });
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('an absent/null expiresAt succeeds (never expires)', async () => {
    // defaultLinksData() has no expiresAt key at all.
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));

    // Also verify an explicit null expiresAt succeeds.
    await seedProject('proj-null-expiry', baseProjectData({ collaborators: {} }));
    await seedLinks('proj-null-expiry', {
      view: { token: VIEW_TOKEN, enabled: true, expiresAt: null },
      edit: { token: EDIT_TOKEN, enabled: true },
    });
    const db2 = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertSucceeds(updateDoc(doc(db2, 'sharedProjects', 'proj-null-expiry'), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
      },
    }));
  });

  it('a joiner stuffing an extra key inside their own collaborators entry fails', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: { ...collaboratorEntry('viewer', 'Stranger'), adminOverride: true },
      },
    }));
  });

  it('a joiner sending a ~300KB bloat field inside their own entry fails', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: { ...collaboratorEntry('viewer', 'Stranger'), bloat: 'a'.repeat(300 * 1024) },
      },
    }));
  });

  it('a joiner sending an over-long displayName (>120 chars) fails', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'a'.repeat(121)),
      },
    }));
  });

  it('a real (non-anonymous) joiner sending isAnonymous: false succeeds', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger', false),
      },
    }));
  });

  it('a real (non-anonymous) joiner lying with isAnonymous: true fails', async () => {
    const db = asUserWithToken(STRANGER, VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        [STRANGER]: collaboratorEntry('viewer', 'Stranger', true),
      },
    }));
  });

  it('an anonymous joiner sending isAnonymous: true succeeds', async () => {
    const db = asAnonWithToken('anon-joiner-1', VIEW_TOKEN);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        'anon-joiner-1': collaboratorEntry('viewer', 'Anon Joiner', true),
      },
    }));
  });

  // REGRESSION: this is the exact bug the `wasAnonymous` claim exists to fix.
  // A join always happens in a custom-token session, so the rules once read
  // `sign_in_provider == 'anonymous'` and got 'custom' for EVERY joiner —
  // meaning an anonymous visitor could record themselves as a real account,
  // and later be handed ownership of a project their storage-clear would
  // orphan. If someone reverts joinerIsAnonymous() to read sign_in_provider,
  // the two tests below start failing while the four above still pass.
  it('an anonymous joiner cannot pass themselves off as a real account (the sign_in_provider trap)', async () => {
    // Provider says 'custom' (as it always does at join time) but the minted
    // claim says anonymous — the entry must match the CLAIM, not the provider.
    const db = asJoiner('anon-joiner-3', VIEW_TOKEN, true);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        'anon-joiner-3': collaboratorEntry('viewer', 'Sneaky', false),
      },
    }));
  });

  it('a joiner whose token carries no wasAnonymous claim is treated as a real account', async () => {
    // An older token still in flight during a Worker deploy: the absent claim
    // must read as "not anonymous" rather than erroring the whole join.
    const db = asJoiner('legacy-joiner', VIEW_TOKEN, undefined);
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        'legacy-joiner': collaboratorEntry('viewer', 'Legacy', false),
      },
    }));
  });

  it('an anonymous joiner lying with isAnonymous: false fails', async () => {
    const db = asAnonWithToken('anon-joiner-2', VIEW_TOKEN);
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      collaborators: {
        'anon-joiner-2': collaboratorEntry('viewer', 'Anon Joiner', false),
      },
    }));
  });

  describe('a joiner cannot escalate privileges in the same write', () => {
    it('cannot add a different uid than themselves', async () => {
      const db = asUserWithToken(STRANGER, VIEW_TOKEN);
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [OTHER_OWNER]: collaboratorEntry('viewer', 'Other'),
        },
      }));
    });

    it('cannot add two uids in one join write', async () => {
      const db = asUserWithToken(STRANGER, VIEW_TOKEN);
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
          [OTHER_OWNER]: collaboratorEntry('viewer', 'Other'),
        },
      }));
    });

    it('cannot modify another existing collaborator role in the same write', async () => {
      // Reseed with EDITOR/VIEWER already present (baseProjectData's default).
      await seedProject(PROJECT_ID, baseProjectData());
      const db = asUserWithToken(STRANGER, VIEW_TOKEN);
      // VIEWER is bumped to 'editor' here — an actual escalation of an
      // EXISTING collaborator's role, piggybacked on the joiner's own write.
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [EDITOR]: collaboratorEntry('editor', 'Editor'),
          [VIEWER]: collaboratorEntry('editor', 'Viewer'), // escalated from viewer to editor!
          [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
        },
      }));
    });

    it('cannot add a links field back onto the project document in the same write', async () => {
      const db = asUserWithToken(STRANGER, VIEW_TOKEN);
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
        },
        links: {
          view: { token: 'rotated-token-000000000000000', enabled: true },
          edit: { token: EDIT_TOKEN, enabled: true },
        },
      }));
    });

    it('cannot change ownerId in the same write', async () => {
      const db = asUserWithToken(STRANGER, VIEW_TOKEN);
      await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
        ownerId: STRANGER,
        collaborators: {
          [STRANGER]: collaboratorEntry('viewer', 'Stranger'),
        },
      }));
    });

    // Regression: the vulnerability that was fixed let a viewer read the edit
    // token off the project doc and re-join presenting it to escalate to
    // editor. Now the token can only ever arrive as a claim minted server-side
    // by the join endpoint — a viewer acting alone, with no valid joinToken
    // claim (or the wrong one), cannot bump their own role no matter what
    // they write.
    it('an existing viewer cannot self-escalate to editor without a valid joinToken claim', async () => {
      await seedProject(PROJECT_ID, baseProjectData()); // EDITOR/VIEWER already members
      const dbNoClaim = asUser(VIEWER);
      await assertFails(updateDoc(doc(dbNoClaim, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [EDITOR]: collaboratorEntry('editor', 'Editor'),
          [VIEWER]: collaboratorEntry('editor', 'Viewer'), // self-escalation attempt
        },
      }));

      const dbWrongClaim = asUserWithToken(VIEWER, 'totally-bogus-token-00000000000000');
      await assertFails(updateDoc(doc(dbWrongClaim, 'sharedProjects', PROJECT_ID), {
        collaborators: {
          [EDITOR]: collaboratorEntry('editor', 'Editor'),
          [VIEWER]: collaboratorEntry('editor', 'Viewer'), // self-escalation attempt
        },
      }));
    });
  });
});

describe('ownership transfer', () => {
  beforeEach(async () => {
    await seedProject(PROJECT_ID, baseProjectData());
  });

  it('owner can transfer to an existing collaborator, staying on as editor', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    // EDITOR (already a collaborator) becomes the new owner; the outgoing
    // owner (OWNER) is retained as an editor entry per the rules' contract.
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: EDITOR,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });

  // REGRESSION: the client's transfer write originally also stamped an
  // `updatedAt`, as every other write in sharedProjectService.js does. That
  // makes a THIRD affected key, which `hasOnly(['ownerId','collaborators'])`
  // rejects — so every ownership transfer failed. Pinning it here so the
  // stamp can't be "helpfully" added back.
  it('a transfer that also stamps updatedAt fails (only ownerId + collaborators may change)', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: EDITOR,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
      updatedAt: new Date().toISOString(),
    }));
  });

  // A transfer must also re-stamp the denormalized owner name/photo, or the
  // project keeps advertising the OUTGOING owner (see resolveOwnerProfile in
  // sharedProjectAccess.js). That makes them affected keys on the transfer
  // write, so the allowlist has to admit them — this pins that, since the
  // narrower ['ownerId','collaborators'] allowlist passes every other test
  // in this describe block while silently breaking real transfers.
  it('a transfer may also re-stamp the denormalized owner name/photo', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: EDITOR,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
      ownerDisplayName: 'Editor Person',
      ownerPhotoURL: null,
    }));
  });

  it('transfer to a uid that is not already a collaborator fails', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: STRANGER, // STRANGER was never a collaborator on this project
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });

  it('a non-owner editor cannot transfer ownership', async () => {
    const db = asUser(EDITOR);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: EDITOR,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });

  it('a non-owner viewer cannot transfer ownership', async () => {
    const db = asUser(VIEWER);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: VIEWER,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });

  // The project document no longer has a `links` field at all (tokens live
  // in private/links), so "a transfer that touches links" now means "a
  // transfer that tries to add a links field" — which the transfer's own
  // affectedKeys().hasOnly(['ownerId', 'collaborators']) check forbids.
  it('a transfer that also adds a links field in the same write fails', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: EDITOR,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
      links: {
        view: { token: 'rotated-during-transfer-00000', enabled: true },
        edit: { token: EDIT_TOKEN, enabled: true },
      },
    }));
  });

  // Regression: an anonymous visitor has no durable identity, so a project
  // must never be transferrable to one — see recipientIsRealAccount().
  it('transfer to a collaborator whose entry has isAnonymous: true fails', async () => {
    const ANON_COLLAB = 'anon-collab-uid';
    await seedProject(PROJECT_ID, baseProjectData({
      collaborators: {
        ...baseProjectData().collaborators,
        [ANON_COLLAB]: collaboratorEntry('editor', 'Anon Collab', true),
      },
    }));
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertFails(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: ANON_COLLAB,
      collaborators: {
        ...data.collaborators,
        [ANON_COLLAB]: collaboratorEntry('editor', 'Anon Collab', true),
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });

  it('transfer to a normal (non-anonymous) collaborator still succeeds', async () => {
    const db = asUser(OWNER);
    const data = baseProjectData();
    await assertSucceeds(updateDoc(doc(db, 'sharedProjects', PROJECT_ID), {
      ownerId: VIEWER,
      collaborators: {
        ...data.collaborators,
        [OWNER]: collaboratorEntry('editor', 'Owner'),
      },
    }));
  });
});

describe('create', () => {
  it('cannot create a sharedProject whose ownerId is someone elses uid', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj'), {
      ownerId: OWNER,
      name: 'Sneaky',
      collaborators: {},
    }));
  });

  it('a signed-in real user can create a sharedProject they own', async () => {
    const db = asUser(STRANGER);
    await assertSucceeds(setDoc(doc(db, 'sharedProjects', 'new-proj-2'), {
      ownerId: STRANGER,
      name: 'My New Project',
      collaborators: {},
    }));
  });

  it('an anonymous user cannot create a sharedProject', async () => {
    const db = asAnon('anon-uid-1');
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj-3'), {
      ownerId: 'anon-uid-1',
      name: 'Anon attempt',
      collaborators: {},
    }));
  });

  // Regression: `links` used to be allowed (even required) on the project
  // document itself. The fix requires create to explicitly NOT have a links
  // field — a client can no longer smuggle tokens onto the document at
  // creation time either.
  it('cannot create a sharedProject with a links field on the document', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj-links'), {
      ownerId: STRANGER,
      name: 'Sneaky links',
      collaborators: {},
      links: {
        view: { token: 'some-token-000000000000000', enabled: true },
        edit: { token: 'some-token-000000000000000', enabled: true },
      },
    }));
  });

  // Regression: a creator used to be able to prefill collaborators with other
  // people's uids at creation time. A new project must start empty.
  it('cannot create a sharedProject with a prefilled collaborators map containing another uid', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj-prefilled'), {
      ownerId: STRANGER,
      name: 'Prefilled',
      collaborators: {
        [OTHER_OWNER]: collaboratorEntry('editor', 'Other'),
      },
    }));
  });

  it('cannot create a sharedProject with an empty name', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj-empty-name'), {
      ownerId: STRANGER,
      name: '',
      collaborators: {},
    }));
  });

  it('cannot create a sharedProject with an over-long (>200 char) name', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'sharedProjects', 'new-proj-long-name'), {
      ownerId: STRANGER,
      name: 'a'.repeat(201),
      collaborators: {},
    }));
  });
});

describe('anonProfiles', () => {
  it('a valid small anonProfiles doc succeeds', async () => {
    const db = asUser(STRANGER);
    await assertSucceeds(setDoc(doc(db, 'anonProfiles', STRANGER), {
      displayName: 'Stranger',
      updatedAt: 'x',
    }));
  });

  it('an anonProfiles doc with an extra key fails', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'anonProfiles', STRANGER), {
      displayName: 'Stranger',
      updatedAt: 'x',
      adminOverride: true,
    }));
  });

  it('an anonProfiles doc with a ~200KB field fails', async () => {
    const db = asUser(STRANGER);
    await assertFails(setDoc(doc(db, 'anonProfiles', STRANGER), {
      displayName: 'a'.repeat(200 * 1024),
      updatedAt: 'x',
    }));
  });
});

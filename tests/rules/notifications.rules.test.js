// Adversarial security-rules tests for the mention-notification inbox
// (firestore.rules' "MENTION NOTIFICATIONS (collaboration — Phase 4)" block).
// Run via `npm run test:rules` (boots the Firestore emulator first).
//
// This is the app's second cross-user WRITE path, so each test below pins one
// clause of the create rule; each was mutation-tested (clause loosened, the
// matching test confirmed to fail) — see the commit/PR notes.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', '..', 'firestore.rules');

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'taskflow-rules-test-notifications',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8571 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});

const OWNER = 'owner-uid';
const EDITOR = 'editor-uid'; // the commenter in most tests
const VIEWER = 'viewer-uid'; // the mentioned person in most tests
const GUEST = 'guest-uid'; // anonymous collaborator
const STRANGER = 'stranger-uid';
const OTHER_OWNER = 'other-owner-uid';

const PROJECT = 'proj-a';
const OTHER_PROJECT = 'proj-b'; // owned by OTHER_OWNER; EDITOR/VIEWER are not members
const COMMENT = 'comment_123';

function entry(role, isAnonymous = false) {
  return { role, displayName: role, photoURL: null, joinedAt: 'x', isAnonymous };
}

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sharedProjects', PROJECT), {
      ownerId: OWNER,
      name: 'A',
      collaborators: { [EDITOR]: entry('editor'), [VIEWER]: entry('viewer'), [GUEST]: entry('editor', true) },
    });
    await setDoc(doc(db, 'sharedProjects', OTHER_PROJECT), { ownerId: OTHER_OWNER, name: 'B', collaborators: {} });
  });
});

const as = (uid) => testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore();
const unauth = () => testEnv.unauthenticatedContext().firestore();

function payload(overrides = {}) {
  return {
    type: 'mention',
    senderUid: EDITOR,
    senderName: 'Editor',
    projectId: PROJECT,
    taskId: 'task-1',
    commentId: COMMENT,
    taskTitle: 'Do the thing',
    snippet: 'hey @Viewer look',
    read: false,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

const ref = (db, recipient, id = COMMENT) => doc(db, 'notifications', recipient, 'items', id);

async function seedNotification(recipient, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(ref(ctx.firestore(), recipient), { ...payload(overrides), createdAt: new Date() });
  });
}

describe('create — who may notify whom', () => {
  it('a member can notify another member', async () => {
    await assertSucceeds(setDoc(ref(as(EDITOR), VIEWER), payload()));
  });

  it('the owner can notify a collaborator, and a collaborator can notify the owner', async () => {
    await assertSucceeds(setDoc(ref(as(OWNER), VIEWER), payload({ senderUid: OWNER })));
    await assertSucceeds(setDoc(ref(as(EDITOR), OWNER), payload()));
  });

  it('a stranger (not a member) cannot notify a member', async () => {
    await assertFails(setDoc(ref(as(STRANGER), VIEWER), payload({ senderUid: STRANGER })));
  });

  it('a member cannot notify someone who is not a member of the project', async () => {
    await assertFails(setDoc(ref(as(EDITOR), STRANGER), payload()));
  });

  it('a member of a different project cannot use this project as the reference', async () => {
    // OTHER_OWNER owns project B only; pointing at project A must fail.
    await assertFails(setDoc(ref(as(OTHER_OWNER), VIEWER), payload({ senderUid: OTHER_OWNER })));
  });

  it('cannot reference a project that does not exist', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ projectId: 'nope' })));
  });

  it('an unauthenticated caller cannot create', async () => {
    await assertFails(setDoc(ref(unauth(), VIEWER), payload()));
  });

  it('cannot notify yourself', async () => {
    await assertFails(setDoc(ref(as(EDITOR), EDITOR), payload()));
  });

  it('cannot notify an anonymous guest', async () => {
    await assertFails(setDoc(ref(as(EDITOR), GUEST), payload()));
  });
});

describe('create — sender and shape', () => {
  it('senderUid must equal the caller (no impersonation)', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ senderUid: OWNER })));
  });

  it('rejects an unknown extra field', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ extra: 'x' })));
  });

  it('rejects a missing required field', async () => {
    const p = payload();
    delete p.snippet;
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), p));
  });

  it('rejects a wrong type value', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ type: 'email' })));
  });

  it('rejects an oversized snippet and an oversized title', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ snippet: 'x'.repeat(201) })));
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ taskTitle: 'x'.repeat(201) })));
  });

  it('rejects a non-string snippet', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ snippet: { a: 1 } })));
  });

  it('must be created unread', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ read: true })));
  });

  it('createdAt must be the server time, not a client-chosen date', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ createdAt: new Date('2020-01-01') })));
  });

  it('the document id must equal commentId', async () => {
    await assertFails(setDoc(ref(as(EDITOR), VIEWER, 'some-other-id'), payload()));
  });

  it('the sender cannot overwrite an existing notification', async () => {
    await seedNotification(VIEWER);
    await assertFails(setDoc(ref(as(EDITOR), VIEWER), payload({ snippet: 'changed' })));
  });
});

describe('read / update / delete — recipient only', () => {
  beforeEach(async () => {
    await seedNotification(VIEWER);
  });

  it('the recipient can get and list their own notifications', async () => {
    await assertSucceeds(getDoc(ref(as(VIEWER), VIEWER)));
    await assertSucceeds(getDocs(collection(as(VIEWER), 'notifications', VIEWER, 'items')));
  });

  it('nobody else can get or list them — not even the sender', async () => {
    await assertFails(getDoc(ref(as(EDITOR), VIEWER)));
    await assertFails(getDocs(collection(as(EDITOR), 'notifications', VIEWER, 'items')));
    await assertFails(getDoc(ref(as(STRANGER), VIEWER)));
    await assertFails(getDoc(ref(unauth(), VIEWER)));
  });

  it('the recipient can mark one read', async () => {
    await assertSucceeds(updateDoc(ref(as(VIEWER), VIEWER), { read: true }));
  });

  it('the recipient cannot change any other field', async () => {
    await assertFails(updateDoc(ref(as(VIEWER), VIEWER), { snippet: 'edited' }));
    await assertFails(updateDoc(ref(as(VIEWER), VIEWER), { read: true, senderName: 'Someone else' }));
  });

  it('read must stay a boolean', async () => {
    await assertFails(updateDoc(ref(as(VIEWER), VIEWER), { read: 'yes' }));
  });

  it('nobody else can update it, including the sender', async () => {
    await assertFails(updateDoc(ref(as(EDITOR), VIEWER), { read: true }));
    await assertFails(updateDoc(ref(as(STRANGER), VIEWER), { read: true }));
  });

  it('the recipient can delete their own; nobody else can', async () => {
    await assertFails(deleteDoc(ref(as(EDITOR), VIEWER)));
    await assertFails(deleteDoc(ref(as(STRANGER), VIEWER)));
    await assertSucceeds(deleteDoc(ref(as(VIEWER), VIEWER)));
  });

  it('a user cannot read another user\'s inbox through a subcollection list', async () => {
    await assertFails(getDocs(collection(as(STRANGER), 'notifications', VIEWER, 'items')));
  });
});

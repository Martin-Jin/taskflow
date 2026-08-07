import { describe, it, expect } from 'vitest';
import {
  isSharedSection,
  partitionSectionsBySharing,
  serializeSharedSection,
  deserializeSharedSection,
  sharedSectionFingerprint,
  planSharedSectionWrites,
  planRemoteSectionApply,
  preserveSharedSections,
} from '../../src/utils/sharedTaskSync';

const PROJECT = 'proj_1';

function sharedSection(overrides = {}) {
  return {
    id: 'sec1',
    name: 'To Do',
    projectId: PROJECT,
    order: 1,
    sharedProjectId: PROJECT,
    ...overrides,
  };
}

function personalSection(overrides = {}) {
  return { id: 'p1', name: 'Personal section', projectId: 'proj_local', order: 1, ...overrides };
}

/** The fingerprint map a caller holds after a successful sync of `sections`. */
function syncedFrom(sections) {
  return new Map(sections.map((s) => [s.id, sharedSectionFingerprint(s)]));
}

describe('classification', () => {
  it('recognises a shared section by its project pointer', () => {
    expect(isSharedSection(sharedSection())).toBe(true);
    expect(isSharedSection(personalSection())).toBe(false);
    expect(isSharedSection({ sharedProjectId: '' })).toBe(false);
    expect(isSharedSection(null)).toBe(false);
  });

  it('partitions a mixed list', () => {
    const { personalSections, sharedSections } = partitionSectionsBySharing([personalSection(), sharedSection()]);
    expect(personalSections).toHaveLength(1);
    expect(sharedSections).toHaveLength(1);
  });

  it('tolerates an empty/absent list', () => {
    expect(partitionSectionsBySharing(undefined)).toEqual({ personalSections: [], sharedSections: [] });
  });
});

describe('serialization', () => {
  it('strips the local-only project pointer — the document path already says which project it is in', () => {
    expect(serializeSharedSection(sharedSection())).not.toHaveProperty('sharedProjectId');
  });

  it('strips undefined values, which the Firestore SDK rejects outright', () => {
    const serialized = serializeSharedSection(sharedSection({ note: undefined }));
    expect(serialized).not.toHaveProperty('note');
  });

  it('round-trips back into the app-local shape, given the reader\'s own local projectId', () => {
    // `projectId` is local-only (see LOCAL_ONLY_SECTION_FIELDS) — a real
    // reader always supplies its own local Project row id explicitly rather
    // than trusting whatever the document happened to carry.
    const section = sharedSection();
    expect(deserializeSharedSection(serializeSharedSection(section), PROJECT, section.projectId)).toEqual(section);
  });

  it('strips the local-only projectId too — it is the OWNER\'s local Project row id, meaningless to any other collaborator', () => {
    expect(serializeSharedSection(sharedSection())).not.toHaveProperty('projectId');
  });

  it('fingerprints ignore key order, so a rebuilt object is not seen as an edit', () => {
    const a = { id: 's1', name: 'X', order: 2 };
    const b = { order: 2, id: 's1', name: 'X' };
    expect(sharedSectionFingerprint(a)).toBe(sharedSectionFingerprint(b));
  });

  it('fingerprints ignore the local-only pointer but catch real edits', () => {
    expect(sharedSectionFingerprint(sharedSection())).toBe(sharedSectionFingerprint({ ...sharedSection(), sharedProjectId: 'other' }));
    expect(sharedSectionFingerprint(sharedSection())).not.toBe(sharedSectionFingerprint(sharedSection({ name: 'Changed' })));
  });

  it('fingerprints ignore a differing local projectId too — the same section synced to two collaborators must not write-loop', () => {
    const a = sharedSection({ projectId: 'owner-local-project-id' });
    const b = sharedSection({ projectId: 'viewer-local-project-id' });
    expect(sharedSectionFingerprint(a)).toBe(sharedSectionFingerprint(b));
  });
});

// REGRESSION: see the identical task-side comment in sharedTaskSync.test.js.
// A Board column (Section) the owner created in a shared project never
// appeared for a viewer/editor for the same reason a task didn't: `projectId`
// is the owner's own local Project row id, synced verbatim, which only ever
// matches the OWNER's own `activeProjectId` — never a joiner's (whose local
// Project row id is `sharedProjectId`, a different value).
describe('projectId is per-reader, never trusted from the document (the "viewer never sees new sections" bug)', () => {
  it('deserializeSharedSection stamps the READER-supplied localProjectId, not the document one', () => {
    const doc = serializeSharedSection(sharedSection({ projectId: 'owner-local-project-id' }));
    const forViewer = deserializeSharedSection(doc, PROJECT, 'viewer-local-project-id');
    expect(forViewer.projectId).toBe('viewer-local-project-id');
  });

  it('planRemoteSectionApply resolves a fresh viewer session (no local sections yet) to their OWN local project id', () => {
    const remote = [serializeSharedSection(sharedSection({ id: 'owner-section', projectId: 'owner-local-project-id' }))];
    const { sections } = planRemoteSectionApply({
      localSections: [],
      remoteSections: remote,
      projectId: PROJECT,
      pending: new Map(),
      knownRemoteIds: [],
      localProjectId: 'viewer-local-project-id',
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].projectId).toBe('viewer-local-project-id');
    expect(sections[0].projectId).not.toBe('owner-local-project-id');
  });
});

describe('planSharedSectionWrites', () => {
  it('creates sections not yet known to be stored', () => {
    const plan = planSharedSectionWrites({ sections: [sharedSection()], projectId: PROJECT, syncedFingerprints: new Map() });
    expect(plan.creates.map((s) => s.id)).toEqual(['sec1']);
    expect(plan.updates).toEqual([]);
  });

  it('updates only genuinely changed sections', () => {
    const original = sharedSection();
    const synced = syncedFrom([original]);
    const edited = { ...original, name: 'Edited' };
    const plan = planSharedSectionWrites({ sections: [edited], projectId: PROJECT, syncedFingerprints: synced });
    expect(plan.updates.map((s) => s.id)).toEqual(['sec1']);
    expect(plan.creates).toEqual([]);
  });

  it('writes nothing when nothing changed — no write loop', () => {
    const section = sharedSection();
    const plan = planSharedSectionWrites({ sections: [section], projectId: PROJECT, syncedFingerprints: syncedFrom([section]) });
    expect(plan).toEqual({ creates: [], updates: [], deletes: [] });
  });

  it('ignores personal sections and other projects entirely', () => {
    const plan = planSharedSectionWrites({
      sections: [personalSection(), sharedSection({ id: 'other', sharedProjectId: 'proj_2' })],
      projectId: PROJECT,
      syncedFingerprints: new Map(),
    });
    expect(plan.creates).toEqual([]);
  });

  it('NEVER infers a delete from a section simply being absent', () => {
    // A cloud pull/restore can replace the array wholesale. Treating "gone"
    // as "delete it remotely" would destroy a collaborator's column.
    const section = sharedSection();
    const plan = planSharedSectionWrites({ sections: [], projectId: PROJECT, syncedFingerprints: syncedFrom([section]) });
    expect(plan.deletes).toEqual([]);
  });

  it('deletes only what the caller explicitly says was deleted', () => {
    const section = sharedSection();
    const plan = planSharedSectionWrites({
      sections: [],
      projectId: PROJECT,
      syncedFingerprints: syncedFrom([section]),
      deletedIds: ['sec1'],
    });
    expect(plan.deletes).toEqual(['sec1']);
  });

  it('skips a delete for something never synced — no wasted round-trip', () => {
    const plan = planSharedSectionWrites({
      sections: [],
      projectId: PROJECT,
      syncedFingerprints: new Map(),
      deletedIds: ['never-existed'],
    });
    expect(plan.deletes).toEqual([]);
  });

  it('a duplicate `order` from two concurrent creates is not treated as a conflict needing a write — LWW handles it for free', () => {
    // Two collaborators create a section "at the same time", each computing
    // `order` from a stale sections.length — both end up with the same
    // order value. This is a cosmetic tie, not a write-planning concern: both
    // are simply creates, and planSharedSectionWrites has no special casing
    // for a shared `order` value because none is needed (see
    // sharedTaskSync.js's header for the full reasoning).
    const a = sharedSection({ id: 'a', order: 3 });
    const b = sharedSection({ id: 'b', order: 3 });
    const plan = planSharedSectionWrites({ sections: [a, b], projectId: PROJECT, syncedFingerprints: new Map() });
    expect(plan.creates.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('planRemoteSectionApply — the in-flight write race guard', () => {
  it('applies a remote change when nothing is pending', () => {
    const local = sharedSection();
    const remote = [{ ...serializeSharedSection(local), name: 'Changed elsewhere' }];
    const { sections } = planRemoteSectionApply({ localSections: [local], remoteSections: remote, projectId: PROJECT, pending: new Map() });
    expect(sections[0].name).toBe('Changed elsewhere');
    expect(sections[0].sharedProjectId).toBe(PROJECT);
  });

  it('IGNORES a stale snapshot that predates our own in-flight write', () => {
    const edited = sharedSection({ name: 'My edit' });
    const pending = new Map([['sec1', sharedSectionFingerprint(edited)]]);
    const staleRemote = [{ ...serializeSharedSection(sharedSection()), name: 'Old value' }];
    const { sections, confirmedIds } = planRemoteSectionApply({
      localSections: [edited],
      remoteSections: staleRemote,
      projectId: PROJECT,
      pending,
    });
    expect(sections[0].name).toBe('My edit');
    expect(confirmedIds).toEqual([]);
  });

  it('clears the guard once the server echoes back what we wrote', () => {
    const edited = sharedSection({ name: 'My edit' });
    const pending = new Map([['sec1', sharedSectionFingerprint(edited)]]);
    const { sections, confirmedIds } = planRemoteSectionApply({
      localSections: [edited],
      remoteSections: [serializeSharedSection(edited)],
      projectId: PROJECT,
      pending,
    });
    expect(confirmedIds).toEqual(['sec1']);
    expect(sections[0].name).toBe('My edit');
  });

  it('guards per section — one in-flight edit does not block another collaborator change', () => {
    const mine = sharedSection({ id: 'mine', name: 'My edit' });
    const theirs = sharedSection({ id: 'theirs', name: 'Old' });
    const pending = new Map([['mine', sharedSectionFingerprint(mine)]]);
    const remote = [
      { ...serializeSharedSection(sharedSection({ id: 'mine' })), name: 'Stale' },
      { ...serializeSharedSection(theirs), name: 'Their new edit' },
    ];
    const { sections } = planRemoteSectionApply({ localSections: [mine, theirs], remoteSections: remote, projectId: PROJECT, pending });
    const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
    expect(byId.mine.name).toBe('My edit');
    expect(byId.theirs.name).toBe('Their new edit');
  });

  it('removes a section deleted remotely, and reports it', () => {
    const local = sharedSection();
    const { sections, removedIds } = planRemoteSectionApply({
      localSections: [local],
      remoteSections: [],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(sections).toEqual([]);
    expect(removedIds).toEqual(['sec1']);
  });

  it('keeps a locally-created section the server has not echoed yet, rather than flickering it away', () => {
    const created = sharedSection();
    const pending = new Map([['sec1', sharedSectionFingerprint(created)]]);
    const { sections, removedIds } = planRemoteSectionApply({
      localSections: [created],
      remoteSections: [],
      projectId: PROJECT,
      pending,
    });
    expect(sections.map((s) => s.id)).toEqual(['sec1']);
    expect(removedIds).toEqual([]);
  });

  it('keeps a locally-deleted section deleted while our delete is in flight', () => {
    const pending = new Map([['sec1', null]]);
    const { sections, confirmedIds } = planRemoteSectionApply({
      localSections: [],
      remoteSections: [serializeSharedSection(sharedSection())],
      projectId: PROJECT,
      pending,
    });
    expect(sections).toEqual([]);
    expect(confirmedIds).toEqual([]);
  });

  it('confirms our delete once the server no longer has it', () => {
    const pending = new Map([['sec1', null]]);
    const { confirmedIds } = planRemoteSectionApply({
      localSections: [sharedSection()],
      remoteSections: [],
      projectId: PROJECT,
      pending,
    });
    expect(confirmedIds).toEqual(['sec1']);
  });

  it('leaves personal sections and other projects untouched, preserving their order', () => {
    const personal = personalSection();
    const other = sharedSection({ id: 'o1', sharedProjectId: 'proj_2' });
    const { sections } = planRemoteSectionApply({
      localSections: [personal, sharedSection(), other],
      remoteSections: [serializeSharedSection(sharedSection())],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(sections.map((s) => s.id)).toEqual(['p1', 'sec1', 'o1']);
  });

  it('adds a section created by a collaborator', () => {
    const { sections } = planRemoteSectionApply({
      localSections: [],
      remoteSections: [serializeSharedSection(sharedSection({ id: 'new' }))],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(sections.map((s) => s.id)).toEqual(['new']);
  });

  it('REGRESSION: keeps a just-created local section with no `pending` entry yet — addSection tags sharedProjectId synchronously, but the debounced push (and thus `pending`) has not run yet, so a snapshot landing in that window must not treat "not pending, not remote, not yet known-remote" as deleted', () => {
    const justCreated = sharedSection({ id: 'brand-new' });
    const { sections, removedIds } = planRemoteSectionApply({
      localSections: [justCreated],
      remoteSections: [],
      projectId: PROJECT,
      pending: new Map(),
      knownRemoteIds: [], // never confirmed to exist server-side — exactly the ambiguous case
    });
    expect(sections.map((s) => s.id)).toEqual(['brand-new']);
    expect(removedIds).toEqual([]);
  });

  it('still removes a section genuinely deleted by a collaborator, once it was previously known to exist server-side', () => {
    const local = sharedSection({ id: 'was-here' });
    const { sections, removedIds } = planRemoteSectionApply({
      localSections: [local],
      remoteSections: [],
      projectId: PROJECT,
      pending: new Map(),
      knownRemoteIds: ['was-here'],
    });
    expect(sections).toEqual([]);
    expect(removedIds).toEqual(['was-here']);
  });

  it('without knownRemoteIds supplied at all (old callers), falls back to the pre-existing behaviour of removing an unpending local section', () => {
    const local = sharedSection({ id: 'legacy' });
    const { sections, removedIds } = planRemoteSectionApply({
      localSections: [local],
      remoteSections: [],
      projectId: PROJECT,
      pending: new Map(),
    });
    expect(sections).toEqual([]);
    expect(removedIds).toEqual(['legacy']);
  });

  it('LWW: a remote rename always wins wholesale — no field-level merge for sections', () => {
    const local = sharedSection({ name: 'Mine', order: 5 });
    const remote = { ...serializeSharedSection(sharedSection()), name: 'Theirs', order: 9 };
    const { sections } = planRemoteSectionApply({ localSections: [local], remoteSections: [remote], projectId: PROJECT, pending: new Map() });
    expect(sections[0].name).toBe('Theirs');
    expect(sections[0].order).toBe(9);
  });
});

describe('preserveSharedSections — the cloud-pull/restore landmine', () => {
  it('keeps live shared sections instead of a stale pulled/restored copy', () => {
    const incoming = [personalSection({ name: 'Old personal' }), sharedSection({ name: 'Stale pulled copy' })];
    const live = [sharedSection({ name: 'Collaborator current' })];
    const result = preserveSharedSections(incoming, live);
    expect(result.map((s) => s.name)).toEqual(['Old personal', 'Collaborator current']);
  });

  it('resurrects shared sections dropped entirely by a pull/restore that never knew about them', () => {
    const result = preserveSharedSections([personalSection()], [sharedSection()]);
    expect(result.map((s) => s.id)).toEqual(['p1', 'sec1']);
  });

  it('drops shared sections when there are none live (project left or deleted)', () => {
    expect(preserveSharedSections([personalSection(), sharedSection()], [])).toHaveLength(1);
  });
});

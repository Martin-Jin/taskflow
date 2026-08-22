/**
 * Coverage for trash/restore.
 *
 * The restore rule is the whole feature, and every interesting case is a
 * REFUSAL to re-attach: a task the user deleted since must not come back, and
 * one they've since filed somewhere else must not be yanked out of it. Both
 * would look like a successful restore in the UI while quietly overwriting
 * deliberate work, which is exactly the class of bug a functional click-through
 * can't see.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProjectTrashEntry,
  buildSectionTrashEntry,
  buildLabelTrashEntry,
  pruneTrash,
  planTrashRestore,
  describeTrashEntry,
  describeTrashExpiry,
  TRASH_RETENTION_DAYS,
  MAX_TRASH_ENTRIES,
} from '../../src/utils/trash';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ids = (prefix = 'e') => {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
};

const project = (over) => ({ id: 'p1', name: 'Work', ...over });
const section = (over) => ({ id: 's1', name: 'Planning', projectId: 'p1', ...over });
const label = (over) => ({ id: 'l1', name: 'urgent', color: '#f00', ...over });
const task = (over) => ({ id: 't1', title: 'A task', ...over });

describe('capturing a delete', () => {
  it('records a project, its sections, and each task with the section it was in', () => {
    const entry = buildProjectTrashEntry({
      project: project(),
      sections: [section(), section({ id: 's2', projectId: 'other' })],
      tasks: [
        task({ id: 't1', projectId: 'p1', sectionId: 's1', sectionName: 'Planning' }),
        task({ id: 't2', projectId: 'p1' }),
        task({ id: 't3', projectId: 'other' }),
      ],
      nowMs: NOW,
      makeId: ids(),
    });
    expect(entry.kind).toBe('project');
    expect(entry.name).toBe('Work');
    // Only this project's sections and tasks.
    expect(entry.sections.map((s) => s.id)).toEqual(['s1']);
    expect(entry.detached).toEqual([
      { taskId: 't1', sectionId: 's1', sectionName: 'Planning' },
      { taskId: 't2', sectionId: null, sectionName: null },
    ]);
  });

  it('refuses to capture a shared project, which has nothing local to rebuild from', () => {
    // Its tasks live in Firestore and are discarded outright on delete, and
    // the document itself is gone — see the module header.
    expect(buildProjectTrashEntry({ project: project({ sharedProjectId: 'sp1' }), sections: [], tasks: [], nowMs: NOW, makeId: ids() })).toBeNull();
  });

  it('records a section and the tasks that fall out of it', () => {
    const entry = buildSectionTrashEntry({
      section: section(),
      tasks: [task({ id: 't1', sectionId: 's1' }), task({ id: 't2', sectionId: 's9' })],
      nowMs: NOW,
      makeId: ids(),
    });
    expect(entry.detached).toEqual([{ taskId: 't1' }]);
  });

  it('records a tag and the tasks it was stripped from', () => {
    const entry = buildLabelTrashEntry({
      label: label(),
      tasks: [task({ id: 't1', labelIds: ['l1', 'l2'] }), task({ id: 't2', labelIds: ['l2'] }), task({ id: 't3' })],
      nowMs: NOW,
      makeId: ids(),
    });
    expect(entry.detached).toEqual([{ taskId: 't1' }]);
  });

  it('does not store copies of the tasks themselves', () => {
    // Only pointers — a stored copy would overwrite whatever the user has done
    // to the task since deleting.
    const entry = buildSectionTrashEntry({
      section: section(),
      tasks: [task({ id: 't1', sectionId: 's1', title: 'Secret title' })],
      nowMs: NOW,
      makeId: ids(),
    });
    expect(JSON.stringify(entry)).not.toContain('Secret title');
  });
});

describe('pruneTrash', () => {
  const entry = (id, ageDays) => ({ id, kind: 'label', name: id, deletedAt: NOW - ageDays * DAY });

  it('drops entries past the retention window', () => {
    const out = pruneTrash([entry('fresh', 1), entry('old', TRASH_RETENTION_DAYS + 1)], NOW);
    expect(out.map((e) => e.id)).toEqual(['fresh']);
  });

  it('keeps one right at the edge of the window', () => {
    expect(pruneTrash([entry('edge', TRASH_RETENTION_DAYS - 1)], NOW)).toHaveLength(1);
  });

  it('caps the list newest-first, so the cap keeps what is most likely still wanted', () => {
    const many = Array.from({ length: MAX_TRASH_ENTRIES + 5 }, (_, i) => entry(`e${i}`, i * 0.01));
    const out = pruneTrash(many, NOW);
    expect(out).toHaveLength(MAX_TRASH_ENTRIES);
    expect(out[0].id).toBe('e0'); // newest
    expect(out.map((e) => e.id)).not.toContain(`e${MAX_TRASH_ENTRIES + 4}`); // oldest dropped
  });

  it('discards malformed entries rather than carrying them forever', () => {
    expect(pruneTrash([null, {}, { deletedAt: 'soon' }, entry('good', 1)], NOW).map((e) => e.id)).toEqual(['good']);
  });

  it('does not mutate its input, and tolerates nothing', () => {
    const input = [entry('a', 1), entry('b', 2)];
    pruneTrash(input, NOW);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
    expect(pruneTrash(undefined, NOW)).toEqual([]);
  });
});

describe('planTrashRestore — projects', () => {
  const entry = () =>
    buildProjectTrashEntry({
      project: project(),
      sections: [section()],
      tasks: [
        task({ id: 't1', projectId: 'p1', sectionId: 's1', sectionName: 'Planning' }),
        task({ id: 't2', projectId: 'p1' }),
      ],
      nowMs: NOW,
      makeId: ids(),
    });

  /** State after the delete: project and section gone, tasks unparented. */
  const afterDelete = (over = {}) => ({
    projects: [],
    sections: [],
    labels: [],
    tasks: [task({ id: 't1' }), task({ id: 't2' })],
    ...over,
  });

  it('brings back the project, its sections, and re-files its tasks', () => {
    const plan = planTrashRestore(entry(), afterDelete());
    expect(plan.ok).toBe(true);
    expect(plan.projects.map((p) => p.id)).toEqual(['p1']);
    expect(plan.sections.map((s) => s.id)).toEqual(['s1']);
    expect(plan.taskUpdates).toEqual([
      { taskId: 't1', updates: { projectId: 'p1', sectionId: 's1', sectionName: 'Planning' } },
      { taskId: 't2', updates: { projectId: 'p1' } },
    ]);
    expect(plan.reattached).toBe(2);
    expect(plan.skipped).toBe(0);
  });

  it('skips a task the user deleted in the meantime rather than resurrecting it', () => {
    const plan = planTrashRestore(entry(), afterDelete({ tasks: [task({ id: 't2' })] }));
    expect(plan.taskUpdates.map((u) => u.taskId)).toEqual(['t2']);
    expect(plan.skipped).toBe(1);
  });

  it('skips a task the user has since filed into another project', () => {
    // THE case that matters: yanking it back would silently undo a deliberate move.
    const plan = planTrashRestore(entry(), afterDelete({ tasks: [task({ id: 't1', projectId: 'other' }), task({ id: 't2' })] }));
    expect(plan.taskUpdates.map((u) => u.taskId)).toEqual(['t2']);
    expect(plan.skipped).toBe(1);
    expect(plan.reattached).toBe(1);
  });

  it('re-parents but does not re-section a task that has since been filed elsewhere', () => {
    const plan = planTrashRestore(entry(), afterDelete({ tasks: [task({ id: 't1', sectionId: 'other' })] }));
    expect(plan.taskUpdates[0].updates).toEqual({ projectId: 'p1' });
  });

  it('does not duplicate a project or section whose id is already back', () => {
    const plan = planTrashRestore(entry(), afterDelete({ projects: [project()], sections: [section()] }));
    expect(plan.projects).toEqual([]);
    expect(plan.sections).toEqual([]);
    // The tasks still get re-attached — that's the part that was missing.
    expect(plan.reattached).toBe(2);
  });
});

describe('planTrashRestore — sections', () => {
  const entry = () =>
    buildSectionTrashEntry({ section: section(), tasks: [task({ id: 't1', sectionId: 's1' })], nowMs: NOW, makeId: ids() });

  it('brings the section back and re-files its tasks', () => {
    const plan = planTrashRestore(entry(), { projects: [project()], sections: [], labels: [], tasks: [task({ id: 't1' })] });
    expect(plan.sections.map((s) => s.id)).toEqual(['s1']);
    expect(plan.taskUpdates).toEqual([{ taskId: 't1', updates: { sectionId: 's1', sectionName: 'Planning' } }]);
  });

  it('refuses when the section’s project is gone, since it would come back unreachable', () => {
    // Every view finds a section through its project.
    const out = planTrashRestore(entry(), { projects: [], sections: [], labels: [], tasks: [task({ id: 't1' })] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/project/i);
    // And it names no raw ids at the user.
    expect(out.error).not.toContain('p1');
  });

  it('skips a task already filed into another section', () => {
    const plan = planTrashRestore(entry(), {
      projects: [project()], sections: [], labels: [], tasks: [task({ id: 't1', sectionId: 'other' })],
    });
    expect(plan.taskUpdates).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

describe('planTrashRestore — labels', () => {
  const entry = () =>
    buildLabelTrashEntry({ label: label(), tasks: [task({ id: 't1', labelIds: ['l1', 'l2'] })], nowMs: NOW, makeId: ids() });

  it('brings the tag back and re-tags its tasks, preserving their other tags', () => {
    const plan = planTrashRestore(entry(), { projects: [], sections: [], labels: [], tasks: [task({ id: 't1', labelIds: ['l2'] })] });
    expect(plan.labels.map((l) => l.id)).toEqual(['l1']);
    expect(plan.taskUpdates).toEqual([{ taskId: 't1', updates: { labelIds: ['l2', 'l1'] } }]);
  });

  it('is idempotent for a task that already carries the tag', () => {
    const plan = planTrashRestore(entry(), { projects: [], sections: [], labels: [label()], tasks: [task({ id: 't1', labelIds: ['l1'] })] });
    expect(plan.taskUpdates).toEqual([]);
    expect(plan.labels).toEqual([]);
  });

  it('handles a task with no tags at all', () => {
    const plan = planTrashRestore(entry(), { projects: [], sections: [], labels: [], tasks: [task({ id: 't1' })] });
    expect(plan.taskUpdates[0].updates.labelIds).toEqual(['l1']);
  });
});

describe('planTrashRestore — refusals', () => {
  it('refuses nothing, and an unknown kind', () => {
    expect(planTrashRestore(null, {}).ok).toBe(false);
    expect(planTrashRestore({ kind: 'spaceship' }, {}).ok).toBe(false);
  });
});

describe('display helpers', () => {
  it('says what came back with a project', () => {
    const entry = buildProjectTrashEntry({
      project: project(), sections: [section()],
      tasks: [task({ id: 't1', projectId: 'p1' }), task({ id: 't2', projectId: 'p1' })],
      nowMs: NOW, makeId: ids(),
    });
    expect(describeTrashEntry(entry)).toBe('Project · 2 tasks, 1 section');
  });

  it('distinguishes a tag that affected nothing', () => {
    const entry = buildLabelTrashEntry({ label: label(), tasks: [], nowMs: NOW, makeId: ids() });
    expect(describeTrashEntry(entry)).toBe('Tag · no tasks affected');
  });

  it('counts down to expiry in plain words', () => {
    expect(describeTrashExpiry({ deletedAt: NOW }, NOW)).toBe(`expires in ${TRASH_RETENTION_DAYS} days`);
    expect(describeTrashExpiry({ deletedAt: NOW - (TRASH_RETENTION_DAYS - 1) * DAY }, NOW)).toBe('expires tomorrow');
    expect(describeTrashExpiry({ deletedAt: NOW - TRASH_RETENTION_DAYS * DAY }, NOW)).toBe('expiring now');
  });
});

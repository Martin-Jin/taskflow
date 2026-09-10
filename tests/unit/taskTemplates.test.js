/**
 * Coverage for task templates.
 *
 * The round trip is what matters: a shape captured from real tasks and rebuilt
 * against a new anchor must come back with the same relative spacing, the same
 * parent structure, and the same dependencies — pointing at the NEW tasks, not
 * the originals. A dependency or parent id that survives as a stale reference
 * is the failure mode here, and it produces a subtly broken task tree rather
 * than an error.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTemplateFromTasks,
  planTemplateInstantiation,
  sortTemplates,
  describeTemplate,
  MAX_TEMPLATES,
  MAX_TEMPLATE_TASKS,
  MAX_TEMPLATE_NAME_LENGTH,
} from '../../src/utils/taskTemplates';

/** Deterministic id factory, so assertions can name the ids. */
function idFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

const task = (over) => ({ estimatedHours: 1, priority: 'medium', ...over });

/** A release process: kickoff (day 0) -> draft (+3) -> review (+10), review depends on draft. */
const releaseSubtree = () => [
  task({ id: 'root', title: 'Ship release', dueDate: '2026-09-01' }),
  task({ id: 'draft', title: 'Write notes', dueDate: '2026-09-04', parentId: 'root' }),
  task({ id: 'review', title: 'Review notes', dueDate: '2026-09-11', parentId: 'root', dependsOn: ['draft'] }),
];

describe('buildTemplateFromTasks', () => {
  it('stores due dates as offsets from the earliest date, not absolute dates', () => {
    const { template } = buildTemplateFromTasks({ name: 'Release', tasks: releaseSubtree() }, [], idFactory('t'));
    expect(template.tasks.map((t) => [t.title, t.dueDayOffset])).toEqual([
      ['Ship release', 0],
      ['Write notes', 3],
      ['Review notes', 10],
    ]);
    // No absolute date anywhere, or the template would only work in September.
    expect(JSON.stringify(template)).not.toContain('2026-09');
  });

  it('rewrites parent and dependency ids as template-local references', () => {
    const { template } = buildTemplateFromTasks({ name: 'Release', tasks: releaseSubtree() }, [], idFactory('t'));
    const byTitle = Object.fromEntries(template.tasks.map((t) => [t.title, t]));
    // The original real ids must not survive — they'd dangle once the source
    // tasks are deleted.
    expect(JSON.stringify(template)).not.toContain('"root"');
    expect(JSON.stringify(template)).not.toContain('"draft"');
    expect(byTitle['Write notes'].parentLocalId).toBe(byTitle['Ship release'].localId);
    expect(byTitle['Review notes'].dependsOnLocalIds).toEqual([byTitle['Write notes'].localId]);
  });

  it('drops dependencies pointing outside the captured subtree', () => {
    // They'd reference a task with nothing to do with the new instance.
    const tasks = [
      task({ id: 'root', title: 'Root', dueDate: '2026-09-01' }),
      task({ id: 'kid', title: 'Kid', parentId: 'root', dueDate: '2026-09-02', dependsOn: ['root', 'outsider'] }),
    ];
    const { template } = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'));
    const kid = template.tasks.find((t) => t.title === 'Kid');
    expect(kid.dependsOnLocalIds).toHaveLength(1);
    expect(kid.dependsOnLocalIds[0]).toBe(template.tasks.find((t) => t.title === 'Root').localId);
  });

  it('orders parents before children regardless of input order', () => {
    // Instantiation wires parents in one forward pass, so this ordering is
    // load-bearing, and the input order is whatever the caller happened to pass.
    const reversed = [...releaseSubtree()].reverse();
    const { template } = buildTemplateFromTasks({ name: 'T', tasks: reversed }, [], idFactory('t'));
    expect(template.tasks[0].title).toBe('Ship release');
    expect(template.tasks[0].parentLocalId).toBeNull();
  });

  it('keeps undated tasks undated rather than inventing an offset', () => {
    const tasks = [
      task({ id: 'root', title: 'Root', dueDate: '2026-09-01' }),
      task({ id: 'kid', title: 'Someday', parentId: 'root' }),
    ];
    const { template } = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'));
    expect(template.tasks.find((t) => t.title === 'Someday').dueDayOffset).toBeNull();
  });

  it('handles a shape with no due dates at all', () => {
    const tasks = [task({ id: 'a', title: 'A' }), task({ id: 'b', title: 'B', parentId: 'a' })];
    const { ok, template } = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'));
    expect(ok).toBe(true);
    expect(template.tasks.every((t) => t.dueDayOffset === null)).toBe(true);
  });

  it('does not capture recurrence, completion, comments or blocks', () => {
    const tasks = [
      task({
        id: 'root',
        title: 'Root',
        dueDate: '2026-09-01',
        isRecurring: true,
        recurrenceString: 'every week',
        recurrenceAnchor: '2026-09-01',
        isCompleted: true,
        completedAt: '2026-09-02T00:00:00.000Z',
        comments: [{ id: 'c1', body: 'hi' }],
        postponeCount: 4,
      }),
    ];
    const { template } = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'));
    const entry = template.tasks[0];
    for (const field of ['isRecurring', 'recurrenceString', 'recurrenceAnchor', 'isCompleted', 'completedAt', 'comments', 'postponeCount']) {
      expect(entry[field]).toBeUndefined();
    }
  });

  it('does not capture the project or section — those are chosen per instance', () => {
    const tasks = [task({ id: 'root', title: 'Root', dueDate: '2026-09-01', projectId: 'p1', sectionId: 's1' })];
    const { template } = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'));
    expect(template.tasks[0].projectId).toBeUndefined();
    expect(template.tasks[0].sectionId).toBeUndefined();
  });

  it('survives a corrupt parent cycle instead of hanging', () => {
    // Depth-walking up parentId would spin forever without its bound.
    const tasks = [
      task({ id: 'a', title: 'A', parentId: 'b' }),
      task({ id: 'b', title: 'B', parentId: 'a' }),
    ];
    expect(() => buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t'))).not.toThrow();
  });
});

describe('buildTemplateFromTasks — rejecting', () => {
  it('refuses a nameless template', () => {
    expect(buildTemplateFromTasks({ name: '  ', tasks: releaseSubtree() }).ok).toBe(false);
  });

  it('refuses an over-long name', () => {
    const out = buildTemplateFromTasks({ name: 'x'.repeat(MAX_TEMPLATE_NAME_LENGTH + 1), tasks: releaseSubtree() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(String(MAX_TEMPLATE_NAME_LENGTH)));
  });

  it('refuses an empty selection', () => {
    expect(buildTemplateFromTasks({ name: 'T', tasks: [] }).ok).toBe(false);
    expect(buildTemplateFromTasks({ name: 'T', tasks: null }).ok).toBe(false);
  });

  it('refuses a duplicate name, case-insensitively', () => {
    const existing = [{ id: 'x', name: 'Release', tasks: [] }];
    expect(buildTemplateFromTasks({ name: 'release', tasks: releaseSubtree() }, existing).ok).toBe(false);
  });

  it('refuses past the template cap, and says how to make room', () => {
    const existing = Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ id: `x${i}`, name: `T${i}`, tasks: [] }));
    const out = buildTemplateFromTasks({ name: 'One more', tasks: releaseSubtree() }, existing);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/delete one/i);
  });

  it('refuses a subtree past the per-template task cap', () => {
    const tasks = Array.from({ length: MAX_TEMPLATE_TASKS + 1 }, (_, i) => task({ id: `t${i}`, title: `T${i}` }));
    const out = buildTemplateFromTasks({ name: 'Huge', tasks });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(String(MAX_TEMPLATE_TASKS)));
  });
});

describe('planTemplateInstantiation', () => {
  const build = () => buildTemplateFromTasks({ name: 'Release', tasks: releaseSubtree() }, [], idFactory('t')).template;

  it('rebuilds the same relative spacing around a new anchor', () => {
    const plan = planTemplateInstantiation(build(), { anchorDate: '2027-01-10' }, idFactory('new'));
    expect(plan.map((t) => [t.title, t.dueDate])).toEqual([
      ['Ship release', '2027-01-10'],
      ['Write notes', '2027-01-13'],
      ['Review notes', '2027-01-20'],
    ]);
  });

  it('rebases across a month boundary', () => {
    const plan = planTemplateInstantiation(build(), { anchorDate: '2027-01-25' }, idFactory('new'));
    expect(plan.map((t) => t.dueDate)).toEqual(['2027-01-25', '2027-01-28', '2027-02-04']);
  });

  it('points parents and dependencies at the NEW tasks', () => {
    const plan = planTemplateInstantiation(build(), { anchorDate: '2027-01-10' }, idFactory('new'));
    const [root, draft, review] = plan;
    expect(draft.parentId).toBe(root.id);
    expect(review.dependsOn).toEqual([draft.id]);
    // No id from the original tasks survives anywhere.
    expect(JSON.stringify(plan)).not.toContain('"root"');
    expect(JSON.stringify(plan)).not.toContain('"draft"');
  });

  it('leaves the root parentless and returns parents before children', () => {
    const plan = planTemplateInstantiation(build(), { anchorDate: '2027-01-10' }, idFactory('new'));
    expect(plan[0].parentId).toBeUndefined();
    // Firestore's SDK throws synchronously on ANY `undefined` field value in
    // a write payload (see firestoreSync.js's stripUndefined) — a root task
    // must OMIT parentId entirely, not carry the key with an undefined
    // value, or a cloud backup silently fails the moment a template-created
    // root task reaches it. toBeUndefined() alone doesn't distinguish those
    // two cases, which is exactly how this shipped once already.
    expect('parentId' in plan[0]).toBe(false);
    const seen = new Set();
    for (const t of plan) {
      if (t.parentId) expect(seen.has(t.parentId)).toBe(true);
      seen.add(t.id);
    }
  });

  it('applies the chosen project and section to every task', () => {
    const plan = planTemplateInstantiation(
      build(),
      { anchorDate: '2027-01-10', projectId: 'p9', sectionId: 's9' },
      idFactory('new')
    );
    expect(plan.every((t) => t.projectId === 'p9' && t.sectionId === 's9')).toBe(true);
  });

  it('drops label ids whose label no longer exists', () => {
    const tasks = [task({ id: 'root', title: 'Root', dueDate: '2026-09-01', labelIds: ['keep', 'gone'] })];
    const template = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t')).template;
    const plan = planTemplateInstantiation(
      template,
      { anchorDate: '2027-01-10', validLabelIds: new Set(['keep']) },
      idFactory('new')
    );
    expect(plan[0].labelIds).toEqual(['keep']);
  });

  it('keeps undated tasks undated', () => {
    const tasks = [
      task({ id: 'root', title: 'Root', dueDate: '2026-09-01' }),
      task({ id: 'kid', title: 'Someday', parentId: 'root' }),
    ];
    const template = buildTemplateFromTasks({ name: 'T', tasks }, [], idFactory('t')).template;
    const plan = planTemplateInstantiation(template, { anchorDate: '2027-01-10' }, idFactory('new'));
    expect(plan.find((t) => t.title === 'Someday').dueDate).toBeNull();
  });

  it('creates undated tasks when no anchor date is given', () => {
    const plan = planTemplateInstantiation(build(), { anchorDate: null }, idFactory('new'));
    expect(plan.every((t) => t.dueDate === null)).toBe(true);
    // The shape still comes through — only the dates are absent.
    expect(plan[2].dependsOn).toEqual([plan[1].id]);
  });

  it('tolerates an empty or missing template', () => {
    expect(planTemplateInstantiation(null, { anchorDate: '2027-01-10' }, idFactory('new'))).toEqual([]);
    expect(planTemplateInstantiation({ tasks: [] }, { anchorDate: '2027-01-10' }, idFactory('new'))).toEqual([]);
  });
});

describe('display helpers', () => {
  it('orders alphabetically rather than by recency', () => {
    const out = sortTemplates([{ name: 'Zebra' }, { name: 'apple' }, { name: 'Mango' }]);
    expect(out.map((t) => t.name)).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('does not mutate its input, and tolerates nothing', () => {
    const input = [{ name: 'B' }, { name: 'A' }];
    sortTemplates(input);
    expect(input.map((t) => t.name)).toEqual(['B', 'A']);
    expect(sortTemplates(undefined)).toEqual([]);
  });

  it('summarises count and span, since the count alone hides the shape', () => {
    const template = buildTemplateFromTasks({ name: 'R', tasks: releaseSubtree() }, [], idFactory('t')).template;
    expect(describeTemplate(template)).toBe('3 tasks over 11 days');
  });

  it('describes a same-day checklist and an undated shape distinctly', () => {
    const sameDay = { tasks: [{ dueDayOffset: 0 }, { dueDayOffset: 0 }] };
    expect(describeTemplate(sameDay)).toBe('2 tasks, all due on the anchor date');
    expect(describeTemplate({ tasks: [{ dueDayOffset: null }] })).toBe('1 task, no due dates');
  });
});

/**
 * ============================================================================
 * TRASH — restore a deleted project, section or label
 * ============================================================================
 * Undo covers tasks and blocks only (see docs/LIMITATIONS.md), so deleting a
 * project, a board section or a tag was permanent: the one place in the app
 * where a single misclick destroyed something with no way back, which sat
 * oddly beside the care taken over backups everywhere else.
 *
 * WHY A TRASH RATHER THAN UNDO. These live in their own `useState`, not the
 * `useHistoryState` transactional stack, so either route is real work. The
 * deciding argument is that regret about a structural delete arrives *later* —
 * minutes or days, not one keystroke — and the undo stack is in-memory, so it
 * dies exactly when you'd want it. A trash entry survives a reload, and it
 * syncs, so the misclick and the recovery don't have to happen on the same
 * device.
 *
 * WHAT AN ENTRY HAS TO STORE, AND WHY IT'S NOT THE TASKS. None of these
 * deletes destroys a task — each DETACHES them:
 *   - a label is stripped from every task carrying it;
 *   - a section's tasks fall back to "No Section";
 *   - a local project's tasks are unparented into Inbox.
 * So an entry stores the deleted ROW (plus a project's own sections) and the
 * ids of the tasks that were detached — the pointers, not the payload. Storing
 * task copies would be both redundant and dangerous: restoring would overwrite
 * whatever the user has done to those tasks since.
 *
 * THE RESTORE RULE, which is the whole correctness story: re-attach a task
 * only if it STILL EXISTS and is STILL DETACHED. A task the user has since
 * deleted must not come back, and one they've since filed somewhere else must
 * not be yanked out of it. Restore is therefore best-effort by design, and
 * reports what it could and couldn't reconnect rather than pretending the
 * delete never happened.
 *
 * A SHARED PROJECT CANNOT BE RESTORED, and says so instead of half-trying.
 * Deleting one removes the Firestore document (if you own it), drops your
 * membership pointer, and discards the local task copies outright, because
 * those tasks live in Firestore rather than in this store. There is nothing
 * left locally to rebuild from, and re-creating the row would produce a
 * project pointing at a document that no longer exists.
 *
 * RETENTION: bounded two ways, per CLAUDE.md's rule that anything persisted to
 * Firestore needs a documented and *implemented* policy. Entries expire after
 * TRASH_RETENTION_DAYS and the list is capped at MAX_TRASH_ENTRIES, whichever
 * bites first. Unlike saved views or templates — things you mean to keep — a
 * trash entry is a safety net with a natural shelf life, so this one really is
 * a prune (`pruneTrash`, run on load and after every delete), not just a
 * refusal at the door.
 * ============================================================================
 */

/** How long a deleted thing stays recoverable. Matches the 30-day sweep already used for completed tasks and task tombstones (see dataRetention.js), so the app has one answer to "how long do we keep deleted things?". */
export const TRASH_RETENTION_DAYS = 30;

/** Hard cap regardless of age, so a bug or a bulk-delete spree can't grow the synced document without limit. */
export const MAX_TRASH_ENTRIES = 50;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Entry kinds. `project` carries its sections too; `sharedProject` exists only so the UI can explain why it can't be restored. */
export const TRASH_KINDS = ['project', 'section', 'label'];

/**
 * Captures a project delete. `sections` are the project's own sections (also
 * being deleted), and `tasks` is the full task list as it was BEFORE the
 * delete, read here to record which tasks are about to be detached.
 *
 * @returns {object|null} a trash entry, or null for a shared project (nothing
 *   local survives to rebuild from — see the header)
 */
export function buildProjectTrashEntry({ project, sections, tasks, nowMs, makeId }) {
  if (!project || project.sharedProjectId) return null;
  const projectSections = (sections || []).filter((s) => s.projectId === project.id);
  return {
    id: makeId(),
    kind: 'project',
    name: project.name,
    deletedAt: nowMs,
    project,
    sections: projectSections,
    // Each detached task's prior section, so restoring puts it back in the
    // right column rather than dumping the whole project into "No Section".
    detached: (tasks || [])
      .filter((t) => t.projectId === project.id)
      .map((t) => ({ taskId: t.id, sectionId: t.sectionId || null, sectionName: t.sectionName || null })),
  };
}

/** Captures a section delete. Its tasks fall back to "No Section", so only their ids are needed. */
export function buildSectionTrashEntry({ section, tasks, nowMs, makeId }) {
  if (!section) return null;
  return {
    id: makeId(),
    kind: 'section',
    name: section.name,
    deletedAt: nowMs,
    section,
    detached: (tasks || []).filter((t) => t.sectionId === section.id).map((t) => ({ taskId: t.id })),
  };
}

/** Captures a tag delete, with the tasks it was stripped from. */
export function buildLabelTrashEntry({ label, tasks, nowMs, makeId }) {
  if (!label) return null;
  return {
    id: makeId(),
    kind: 'label',
    name: label.name,
    deletedAt: nowMs,
    label,
    detached: (tasks || []).filter((t) => (t.labelIds || []).includes(label.id)).map((t) => ({ taskId: t.id })),
  };
}

/**
 * Drops expired and over-cap entries. Newest first, so the cap keeps what's
 * most likely to still be wanted.
 *
 * Pure, and run both on load and after each delete — an entry that ages out
 * while the app is closed still has to disappear, and a delete spree has to be
 * capped without waiting for the next load.
 *
 * @param {object[]} entries
 * @param {number} nowMs
 * @returns {object[]}
 */
export function pruneTrash(entries, nowMs) {
  const cutoff = nowMs - TRASH_RETENTION_DAYS * MS_PER_DAY;
  return [...(entries || [])]
    .filter((e) => e && typeof e.deletedAt === 'number' && e.deletedAt > cutoff)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, MAX_TRASH_ENTRIES);
}

/**
 * Works out exactly what restoring an entry should change, without changing
 * anything — so the caller can apply it all in one commit, and so the
 * interesting decisions (skip a task that moved, skip a row that already
 * exists again) are testable without driving the UI.
 *
 * @param {object} entry - a trash entry
 * @param {{tasks: object[], projects: object[], sections: object[], labels: object[]}} state - current state
 * @returns {{ok: false, error: string} | {ok: true, projects: object[], sections: object[], labels: object[], taskUpdates: {taskId: string, updates: object}[], reattached: number, skipped: number}}
 */
export function planTrashRestore(entry, state) {
  if (!entry) return { ok: false, error: 'Nothing to restore.' };
  const tasks = state?.tasks || [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const plan = { ok: true, projects: [], sections: [], labels: [], taskUpdates: [], reattached: 0, skipped: 0 };

  // A row whose id is already back (restored twice, or re-created by hand with
  // the same id via a backup restore) is left alone rather than duplicated.
  const exists = (list, id) => (list || []).some((x) => x.id === id);

  if (entry.kind === 'project') {
    if (!exists(state?.projects, entry.project.id)) plan.projects.push(entry.project);
    for (const section of entry.sections || []) {
      if (!exists(state?.sections, section.id)) plan.sections.push(section);
    }
    for (const d of entry.detached || []) {
      const task = taskById.get(d.taskId);
      // Still exists, and still unparented — see the header's restore rule.
      if (!task || task.projectId) {
        plan.skipped += 1;
        continue;
      }
      const updates = { projectId: entry.project.id };
      // Only re-file it into its old section if that section is coming back
      // and the task hasn't since been filed elsewhere.
      const sectionComingBack = d.sectionId && (entry.sections || []).some((s) => s.id === d.sectionId);
      if (sectionComingBack && !task.sectionId) {
        updates.sectionId = d.sectionId;
        updates.sectionName = d.sectionName;
      }
      plan.taskUpdates.push({ taskId: d.taskId, updates });
      plan.reattached += 1;
    }
    return plan;
  }

  if (entry.kind === 'section') {
    // A section whose project has since been deleted would come back
    // unreachable — every view finds it through its project.
    if (entry.section.projectId && !exists(state?.projects, entry.section.projectId)) {
      return { ok: false, error: 'Restore the project this section belonged to first — a section is only reachable through its project.' };
    }
    if (!exists(state?.sections, entry.section.id)) plan.sections.push(entry.section);
    for (const d of entry.detached || []) {
      const task = taskById.get(d.taskId);
      if (!task || task.sectionId) {
        plan.skipped += 1;
        continue;
      }
      plan.taskUpdates.push({
        taskId: d.taskId,
        updates: { sectionId: entry.section.id, sectionName: entry.section.name },
      });
      plan.reattached += 1;
    }
    return plan;
  }

  if (entry.kind === 'label') {
    if (!exists(state?.labels, entry.label.id)) plan.labels.push(entry.label);
    for (const d of entry.detached || []) {
      const task = taskById.get(d.taskId);
      if (!task) {
        plan.skipped += 1;
        continue;
      }
      // Already carries it (restored twice, or re-tagged by hand) — nothing to do.
      if ((task.labelIds || []).includes(entry.label.id)) continue;
      plan.taskUpdates.push({ taskId: d.taskId, updates: { labelIds: [...(task.labelIds || []), entry.label.id] } });
      plan.reattached += 1;
    }
    return plan;
  }

  return { ok: false, error: 'This kind of item can’t be restored.' };
}

/** What the row says: what it was, and how much comes back with it. */
export function describeTrashEntry(entry) {
  const kindLabel = { project: 'Project', section: 'Section', label: 'Tag' }[entry?.kind] || 'Item';
  const count = (entry?.detached || []).length;
  if (entry?.kind === 'project') {
    const sectionCount = (entry.sections || []).length;
    const parts = [`${count} task${count === 1 ? '' : 's'}`];
    if (sectionCount > 0) parts.push(`${sectionCount} section${sectionCount === 1 ? '' : 's'}`);
    return `${kindLabel} · ${parts.join(', ')}`;
  }
  if (count === 0) return `${kindLabel} · no tasks affected`;
  return `${kindLabel} · ${count} task${count === 1 ? '' : 's'}`;
}

/** Human-readable "how long left before this is gone for good". */
export function describeTrashExpiry(entry, nowMs) {
  const daysLeft = Math.ceil((entry.deletedAt + TRASH_RETENTION_DAYS * MS_PER_DAY - nowMs) / MS_PER_DAY);
  if (daysLeft <= 0) return 'expiring now';
  if (daysLeft === 1) return 'expires tomorrow';
  return `expires in ${daysLeft} days`;
}

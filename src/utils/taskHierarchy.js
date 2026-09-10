/**
 * ============================================================================
 * TASK HIERARCHY HELPERS
 * ============================================================================
 * Shared read-only helpers for the "container-only parent" rule (see
 * types/index.js's Task.estimatedHours/remainingHours doc comments): once a
 * task has ≥1 sub-task, its own estimatedHours/remainingHours stop being a
 * directly-editable number and become a live rollup of its children's own
 * effective hours instead — cascading naturally, since a child that itself
 * has children returns ITS rollup rather than a raw stored number.
 *
 * Deliberately a pure, on-demand derivation rather than something that
 * mutates/caches a computed value onto the stored Task object — a cached sum
 * would drift the moment a child's own hours change and nothing re-synced it
 * (see CLAUDE.md's guidance on derived vs. stored values). Callers that
 * display a task's hours (TaskListPanel, BoardView, TaskDetailModal) should
 * use these instead of reading `task.estimatedHours`/`remainingHours`
 * directly whenever the task might have children.
 *
 * NOT used by the scheduler itself: a container parent is excluded from
 * allocation entirely (see rebalanceEngine.js's `parentIds` check), so it
 * never needs a rolled-up hours figure to schedule against — only leaf
 * tasks (or subtasks-of-subtasks that are themselves leaves) ever get their
 * own calendar blocks, using their own real stored hours.
 * ============================================================================
 */

import { applyRecurringCompletion, computeRecurringDescendantState, planSeriesReanchor } from './recurrenceState';
import { resolveCurrentOccurrenceDueDate } from './recurrence';

/** Direct children of `taskId` (one level) — a child that itself has children is not expanded here. */
export function getDirectChildren(taskId, tasks) {
  return tasks.filter((t) => t.parentId === taskId);
}

/** True if `taskId` has at least one direct sub-task. */
export function hasChildTasks(taskId, tasks) {
  return tasks.some((t) => t.parentId === taskId);
}

/**
 * Recursive rollup, generic over which hours field to sum (`estimatedHours`
 * or `remainingHours`) — a leaf task (no children) just returns its own
 * stored value for that field. `visited` guards against a hand-edited/
 * corrupted backup introducing a `parentId` cycle, mirroring the same
 * defensive pattern used elsewhere for parentId walks (e.g.
 * SchedulerContext's getDescendantIds).
 */
function rollupHours(task, tasks, field, visited) {
  if (visited.has(task.id)) return task[field] || 0; // cycle guard — treat as a leaf rather than recursing forever
  const children = getDirectChildren(task.id, tasks);
  if (children.length === 0) return task[field] || 0;
  visited.add(task.id);
  return children.reduce((sum, child) => sum + rollupHours(child, tasks, field, visited), 0);
}

/** A task's effective `estimatedHours`: its own value if it's a leaf, otherwise the sum of its children's effective estimatedHours. */
export function getEffectiveEstimatedHours(task, tasks) {
  return rollupHours(task, tasks, 'estimatedHours', new Set());
}

/** A task's effective `remainingHours`: its own value if it's a leaf, otherwise the sum of its children's effective remainingHours. */
export function getEffectiveRemainingHours(task, tasks) {
  return rollupHours(task, tasks, 'remainingHours', new Set());
}

/**
 * "Time left" read/write for a single (non-container) task — shared by
 * TaskDetailModal's "Time left" field and anything else that needs to log
 * elapsed work against it (e.g. TimerContext's stop/mark-done actions). Not
 * container-aware (see getEffectiveRemainingHours for that rollup); callers
 * with a container task should use the rollup for display and never let a
 * container be logged against directly.
 *
 * A non-recurring task stores this straight on `task.remainingHours`. A
 * recurring task never stores `remainingHours` at all (rebalanceEngine.js
 * computes it fresh per-occurrence), so this instead reads/writes a
 * per-occurrence override keyed by `task.dueDate` — the occurrence's
 * ORIGINAL pattern-generated due date (see Task.remainingHoursOverride's
 * doc comment in types/index.js), same key SchedulerContext.completeTask
 * already uses for `overrides` and clears this map on completion. NOT
 * resolveCurrentOccurrenceDueDate's moved-to date — the override map is
 * always keyed by the pattern date, even for a moved occurrence.
 */
export function getEffectiveRemainingHoursForOccurrence(task) {
  if (!task.isRecurring) return Number(task.remainingHours) || 0;
  const override = task.dueDate ? task.remainingHoursOverride?.[task.dueDate] : null;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.min(Math.max(0, override), task.estimatedHours);
  }
  // No override recorded — fall back to the full estimate. Precisely
  // matching rebalanceEngine's `estimatedHours - spent` here would need this
  // occurrence's already-placed block hours, which aren't cleanly available
  // to every caller; the full estimate is correct for a not-yet-worked
  // occurrence and only under-states hours already spent today.
  return task.estimatedHours;
}

/**
 * Field patch (pass straight to updateTask) that reduces `task`'s current
 * "Time left" by `elapsedHours`, clamped to never go below 0. See
 * getEffectiveRemainingHoursForOccurrence for the read-side counterpart and
 * the recurring-override keying rule.
 */
export function computeRemainingHoursPatchAfterElapsed(task, elapsedHours) {
  const current = getEffectiveRemainingHoursForOccurrence(task);
  const clamped = Math.min(Math.max(0, current - elapsedHours), task.estimatedHours);
  if (!task.isRecurring) return { remainingHours: clamped };
  if (!task.dueDate) return null; // no due date yet — nothing to key the override by
  return { remainingHoursOverride: { ...(task.remainingHoursOverride || {}), [task.dueDate]: clamped } };
}

/**
 * How many hours `computeRemainingHoursPatchAfterElapsed(task, elapsedHours)`
 * would ACTUALLY subtract, after its own clamp to [0, estimatedHours] — which
 * can be less than `elapsedHours` itself if remaining hours was already near
 * zero. Used by markBlockDone (SchedulerContext.jsx) to record the true
 * applied amount on the block, so unmarkBlockDone's reversal adds back
 * exactly that — not the block's own `durationHours`, which could overstate
 * what was really taken off if remaining hours had less than durationHours
 * left to give in the first place.
 */
export function computeActuallyAppliedHours(task, elapsedHours) {
  const current = getEffectiveRemainingHoursForOccurrence(task);
  const clamped = Math.min(Math.max(0, current - elapsedHours), task.estimatedHours);
  return current - clamped;
}

/**
 * The reverse of computeRemainingHoursPatchAfterElapsed: a field patch that
 * ADDS `hoursToRestore` back onto `task`'s current "Time left", clamped to
 * never exceed `estimatedHours` (mirroring the forward function's own
 * never-below-0 clamp). `hoursToRestore` should be whatever
 * computeActuallyAppliedHours reported at completion time — see
 * ScheduledBlock.hoursAppliedToRemaining's own doc comment for why that's
 * stored rather than re-derived from durationHours.
 */
export function computeRemainingHoursPatchAfterRestore(task, hoursToRestore) {
  const current = getEffectiveRemainingHoursForOccurrence(task);
  const clamped = Math.min(Math.max(0, current + hoursToRestore), task.estimatedHours);
  if (!task.isRecurring) return { remainingHours: clamped };
  if (!task.dueDate) return null;
  return { remainingHoursOverride: { ...(task.remainingHoursOverride || {}), [task.dueDate]: clamped } };
}

/**
 * Plans which of `task`'s not-yet-done scheduled blocks a manual "Time
 * left" EDIT should auto-mark done (or un-mark), given the OLD and NEW
 * remaining-hours values the user just set directly. Pure/read-only —
 * returns `{ toMarkDone, toUnmark, toShrink, toReschedule }`; the caller
 * (SchedulerContext's setRemainingHoursWithBlockInference) is what actually
 * applies these via markBlockDone/unmarkBlockDone/direct block edits/a
 * scoped re-balance so the existing hoursAppliedToRemaining bookkeeping and
 * undo/commit semantics stay in one place, not duplicated here.
 *
 * FORWARD (newRemaining < oldRemaining — the user logged more work than the
 * scheduler's own block math had captured): treats the decrease as a pool of
 * "extra elapsed hours" and walks `blocks` (already assumed sorted oldest
 * first — see TaskDetailModal's taskScheduledBlocks) marking a block fully
 * done whenever the pool covers its whole durationHours, oldest first. The
 * one block where the pool runs out mid-way (covers some but not all of it)
 * is the BOUNDARY block, handled one of two ways depending on whether it's
 * already elapsed (see `today`/`nowMinutes`, the same wall-clock inputs
 * missedTasks.js's isBlockMissed uses):
 *   - NOT yet started (a future block): shrinks in place to exactly the
 *     leftover pool, keeping its own startTime — e.g. a 4:10-5:20pm block
 *     with only 0.5h of pool left over becomes 4:10-4:40pm. Reported via
 *     `toShrink`; nothing needs rescheduling since the block already sat in
 *     an open slot with no other work claiming the trimmed-off remainder.
 *   - Already started or past (`block.date < today`, or today's block whose
 *     startTime has already passed `nowMinutes`): the wall-clock time already
 *     happened, but the pool says only PART of it was real work. That part
 *     is preserved as a genuine "done" record — shrunk to the pool amount,
 *     keeping its original startTime — and the rest of the block's original
 *     duration (which the pool doesn't cover) didn't actually get done, so
 *     it's handed back via `toReschedule` as hours still owed, for the
 *     caller to re-place with a fresh scheduling pass rather than silently
 *     dropped. Reported via `toShrink` (the done remnant) + `toReschedule`
 *     (the owed hours) together, never `toMarkDone` — a done record with a
 *     trimmed duration needs its own `hoursAppliedToRemaining`, which
 *     `toMarkDone`'s blanket "whole block" handling doesn't carry.
 *
 * REVERSE (newRemaining > oldRemaining — the user is correcting an error by
 * INCREASING time left): walks already-done blocks NEWEST first (undoing
 * the most recently inferred completion first, mirroring how the forward
 * direction consumes oldest first) un-marking until the increase is
 * accounted for or there are no more done blocks to undo. Unchanged by the
 * shrink/reschedule addition above — growing time left never needs to
 * un-shrink a block or cancel a reschedule, since neither of those leaves a
 * `done` record behind for this walk to find.
 *
 * Deliberately excludes blocks the user already marked done through the
 * checkbox UI in the SAME edit — those aren't re-evaluated here, this only
 * infers NEW completions/reversals from the numeric delta.
 *
 * `today`/`nowMinutes` are optional (default to "everything is in the
 * future") purely so existing callers/tests that only care about the
 * whole-block FORWARD/REVERSE behavior don't need to pass wall-clock state
 * they have no reason to compute — every real caller (SchedulerContext) has
 * both on hand already.
 */
export function planBlockCompletionFromRemainingHoursEdit(blocks, oldRemaining, newRemaining, today = null, nowMinutes = null) {
  const delta = oldRemaining - newRemaining; // positive = user logged MORE work
  if (delta > 0) {
    let pool = delta;
    const toMarkDone = [];
    const toShrink = [];
    const toReschedule = [];
    for (const block of blocks) {
      if (block.status === 'done') continue;
      if (pool < block.durationHours) {
        // Rounded to hundredths of an hour (same precision rebalanceEngine.js
        // uses for its own unplacedHours reporting) — pool accumulates via
        // repeated float subtraction above, so an exact-looking input like
        // "0.3h left over" can otherwise arrive here as 0.30000000000000004.
        const roundedPool = Math.round(pool * 100) / 100;
        if (roundedPool > 0) {
          const hasElapsed = today != null && (block.date < today || (block.date === today && timeToMinutesLocal(block.startTime) <= (nowMinutes ?? -Infinity)));
          if (hasElapsed) {
            // The block's wall-clock time already happened, but only `pool`
            // hours of it were real work — preserve that much as a done
            // record at its original startTime, and owe the rest back to
            // the scheduler instead of silently losing it.
            toShrink.push({ id: block.id, durationHours: roundedPool, markDone: true });
            toReschedule.push(Math.round((block.durationHours - roundedPool) * 100) / 100);
          } else {
            // Still in the future — nothing has happened yet, so simply
            // trim the open slot down to what's actually still needed.
            toShrink.push({ id: block.id, durationHours: roundedPool, markDone: false });
          }
        }
        break;
      }
      pool -= block.durationHours;
      toMarkDone.push(block.id);
      if (pool <= 0) break;
    }
    return { toMarkDone, toUnmark: [], toShrink, toReschedule };
  }
  if (delta < 0) {
    let pool = -delta; // hours to "un-spend"
    const doneNewestFirst = blocks.filter((b) => b.status === 'done').slice().reverse();
    const toUnmark = [];
    for (const block of doneNewestFirst) {
      if (pool <= 0) break;
      toUnmark.push(block.id);
      pool -= block.hoursAppliedToRemaining ?? block.durationHours;
    }
    return { toMarkDone: [], toUnmark, toShrink: [], toReschedule: [] };
  }
  return { toMarkDone: [], toUnmark: [], toShrink: [], toReschedule: [] };
}

// Local, dependency-free copy of dateUtils.js's timeToMinutes — this file
// already keeps its date/hours math self-contained (see the module doc
// comment) and pulling in the full dateUtils module for one conversion
// isn't worth the coupling.
function timeToMinutesLocal(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Walk up `task.parentId` (arbitrarily deep — nesting is capped at 2 levels
 * by the UI, but this walk stays general/defensive rather than assuming
 * that) to find the nearest ancestor with its own `dueDate`. Returns null if
 * `task` has no parent, or every ancestor up the chain is also undated.
 * `visited` guards against a hand-edited/corrupted backup introducing a
 * cycle, mirroring the same defensive pattern used elsewhere for parentId
 * walks (e.g. SchedulerContext's getDescendantIds).
 *
 * Used to enforce that a sub-task's own due date can never be scheduled past
 * its parent goal's deadline — see TaskDetailModal's due-date validation and
 * WeekView/MonthView's drag-to-reschedule guard. This mirrors (but is a
 * separate copy of) allocator.js's private findAncestorDueDate, which feeds
 * the same date in as soft pacing pressure for undated sub-tasks rather than
 * a hard validation boundary — kept here instead of exported from
 * allocator.js so UI code doesn't reach into the scheduling engine's
 * internals for an unrelated purpose.
 */
export function findNearestAncestorDueDate(task, tasksById) {
  if (!task.parentId) return null;
  const visited = new Set([task.id]);
  let current = task;
  while (current.parentId) {
    const parent = tasksById.get ? tasksById.get(current.parentId) : tasksById[current.parentId];
    if (!parent || visited.has(parent.id)) return null;
    if (parent.dueDate) return parent.dueDate;
    visited.add(parent.id);
    current = parent;
  }
  return null;
}

/**
 * Is `task` "done for now"? For a plain task this is just `isCompleted`. For
 * a recurring task, `isCompleted` is deliberately never set true on a normal
 * completion (see SchedulerContext.completeTask) — instead each closed-out
 * occurrence's date is recorded into `completedDates`, so "done for now"
 * means today's date is in there. This is purely a "does today's occurrence
 * still need doing" check — it says nothing about whether the task will ever
 * be permanently done, which is why TaskDetailModal (editing the recurring
 * task itself) should keep reading `isCompleted` directly rather than this;
 * it's meant for list-style views that want to show "done for today".
 * Exception: TaskDetailModal's own completion-checkbox controls (the header
 * checkbox and the inline sub-task row checkboxes) deliberately DO use this
 * helper rather than raw `isCompleted`, so a recurring task/sub-task already
 * completed today shows checked and offers only "uncomplete" instead of
 * re-offering "complete" — everywhere else in that file (recurrence editing,
 * "apply to all sub-tasks", etc.) still reads `isCompleted` directly.
 */
export function isCompletedForCurrentOccurrence(task, todayIso) {
  if (task.isRecurring) return !!task.completedDates?.includes(todayIso);
  return !!task.isCompleted;
}

/**
 * Should `task` render as checked/struck-through in a list-style view (e.g.
 * TaskListPanel's Overdue/Today/Upcoming rows)? Not the same question as
 * isCompletedForCurrentOccurrence: that helper answers "was TODAY's date
 * recorded as done", which is only meaningful for the occurrence a recurring
 * task is CURRENTLY sitting on. Completing an occurrence advances `dueDate`
 * to the next, not-yet-completed one (see recurrenceState.js), while today's
 * date stays in the rolling `completedDates` window for days afterward — so
 * a recurring task already rolled forward into the future (shown in
 * "Upcoming") would otherwise still read as checked off of that stale
 * window, even though its actual current occurrence hasn't happened yet.
 * Gating on `dueDate <= todayIso` for a recurring task fixes that: only a
 * recurring task whose occurrence is due today (or overdue) can be "done for
 * now" in this sense. A non-recurring task has no such window to be misled
 * by, so it keeps behaving exactly as isCompletedForCurrentOccurrence alone.
 */
export function isCheckedForListDisplay(task, todayIso) {
  if (!task.isRecurring) return isCompletedForCurrentOccurrence(task, todayIso);
  return !!task.dueDate && task.dueDate <= todayIso && isCompletedForCurrentOccurrence(task, todayIso);
}

/**
 * True if `taskId` has at least one direct sub-task and every one of them is
 * "done for now" (see isCompletedForCurrentOccurrence) — the rollup that
 * drives auto-completing a parent once its whole checklist is done for the
 * current cycle (see SchedulerContext.completeTask's upward cascade). A task
 * with no children is never "all children done" (there's nothing to roll
 * up), so this is false for a leaf — callers should gate on hasChildTasks
 * first if they need to tell "no children" apart from "children, not all
 * done".
 */
export function areAllChildrenCompletedForCurrentOccurrence(taskId, tasks, todayIso) {
  const children = getDirectChildren(taskId, tasks);
  if (children.length === 0) return false;
  return children.every((child) => isCompletedForCurrentOccurrence(child, todayIso));
}

/**
 * All descendants of `taskId` (children, grandchildren, ...) as full Task
 * objects, via the `parentId` chain — used by TaskDetailModal's "Apply to
 * all sub-tasks" action, which cascades a parent's shared fields down its
 * whole subtree (not just direct children), same depth as any other
 * subtree-wide operation (see SchedulerContext's own getDescendantIds, used
 * for completeTask/deleteTask's cascades — kept as a separate copy here
 * since that one is module-private and returns ids only). `visited` guards
 * against a hand-edited/corrupted backup introducing a `parentId` cycle.
 */
export function getAllDescendants(taskId, tasks) {
  const childrenByParentId = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const siblings = childrenByParentId.get(t.parentId) || [];
    siblings.push(t);
    childrenByParentId.set(t.parentId, siblings);
  }
  const descendants = [];
  const visited = new Set([taskId]);
  const queue = [...(childrenByParentId.get(taskId) || [])];
  while (queue.length > 0) {
    const t = queue.pop();
    if (visited.has(t.id)) continue;
    visited.add(t.id);
    descendants.push(t);
    queue.push(...(childrenByParentId.get(t.id) || []));
  }
  return descendants;
}

/**
 * Sub-task nesting is capped at 2 levels (task -> sub-task -> sub-task of
 * that sub-task) — true if `task` is already a sub-task of a sub-task, i.e.
 * it cannot itself take on any children. Shared by every path that can
 * create or move a parent/child relationship (adding a new sub-task,
 * reparenting an existing task via the menu/move-to picker/drag-and-drop, or
 * smart-parse's "sub of <task>" detector) so they can't drift on the rule.
 */
export function isAtMaxSubtaskDepth(task, tasks) {
  if (!task.parentId) return false;
  const parent = tasks.find((t) => t.id === task.parentId);
  return !!(parent && parent.parentId);
}

/**
 * Every task id that is NOT a valid new parent for `taskId` — itself (can't
 * be its own parent), every one of its own descendants (would create a
 * cycle), and any task already at max sub-task depth (see
 * isAtMaxSubtaskDepth — it can't take on a child of its own). Used to filter
 * candidate lists for reparenting UI (the move-to picker, drag-and-drop
 * targets) and to validate smart-parse's "sub of <task>" match before
 * applying it, so all three paths enforce the identical rule.
 */
export function getIneligibleParentIds(taskId, tasks) {
  const ids = new Set([taskId, ...getAllDescendants(taskId, tasks).map((t) => t.id)]);
  tasks.forEach((t) => {
    if (!ids.has(t.id) && isAtMaxSubtaskDepth(t, tasks)) ids.add(t.id);
  });
  return ids;
}

/**
 * Whether this client may compact `task`'s completed-occurrence history.
 *
 * Compaction is the one non-commutative operation in the recurring-task model
 * (it removes entries and increments an archive), so it's only safe where
 * there is exactly ONE writer — see utils/recurrenceState.js's
 * planOccurrenceCompaction. A personal task satisfies that by definition: it
 * lives in this user's own store and nobody else can write it. A SHARED task
 * does not, so it's excluded here and compacted by its owner instead, which is
 * the only identity guaranteed to be singular for it.
 *
 * Deliberately a conservative test — anything not provably single-writer
 * simply doesn't compact, which costs a little storage rather than risking a
 * double-counted month in someone's stats.
 */
export function canCompact(task) {
  return !task?.sharedProjectId;
}

/**
 * Upward-completion cascade: after `taskId` (recurring or not) just closed
 * out its current occurrence within `newTasks`, walk up its `parentId` chain
 * completing any parent whose ENTIRE set of direct children is now done for
 * the current cycle too (see isCompletedForCurrentOccurrence /
 * areAllChildrenCompletedForCurrentOccurrence above) — repeating up the
 * chain, since completing a parent can in turn complete a grandparent. A
 * parent that itself has no dueDate/isRecurring info of its own just follows
 * the same recurring/non-recurring completion shape completeTask already
 * uses for a standalone task, so a container parent behaves identically
 * whether a user clicks it directly or every one of its children happens to
 * close out this way.
 *
 * When the parent being cascaded-into IS recurring, every one of ITS
 * recurring descendants (siblings of `taskId`, from the parent's point of
 * view) rolls forward together with it — same computeRecurringDescendantState
 * helper SchedulerContext.completeTask's own direct-completion path uses for
 * its descendants, reused here so a group closing out via the cascade and a
 * group closed out by completing the parent directly can't diverge on this
 * bookkeeping. This is what lets each recurring sub-task stay pinned on
 * today's occurrence (see recurrenceState.js's planSubtaskOccurrenceCompletion)
 * until the group as a whole is done — without this, siblings would keep
 * showing checked for a NOW-STALE occurrence once the parent (and thus the
 * cycle) has moved on.
 *
 * Extracted out of SchedulerContext.jsx (which pulls in Firebase/hooks and so
 * can't be imported directly by a Vitest unit test) so this cascade decision
 * stays independently testable — see tests/unit/taskHierarchy.test.js. Pure
 * and pre-commit: returns a new tasks array, doesn't call commit itself —
 * completeTask folds this into its own single commit so the whole cascade
 * (leaf + every newly-completed ancestor + every rolled-forward sibling)
 * lands as one undoable action. `visited` guards the same
 * hand-edited-backup parentId-cycle case every other parentId walk in this
 * app guards against.
 *
 * @param {import('../types').Task[]} newTasks
 * @param {string} taskId - the task that just closed out its current occurrence
 * @param {string} todayIso
 * @param {string} nowIso - ISO timestamp for completedAt/updatedAt stamps
 * @returns {import('../types').Task[]}
 */
export function applyUpwardCompletionCascade(newTasks, taskId, todayIso, nowIso) {
  let current = newTasks;
  let cursor = current.find((t) => t.id === taskId);
  const visited = new Set([taskId]);
  while (cursor?.parentId && !visited.has(cursor.parentId)) {
    visited.add(cursor.parentId);
    const parentId = cursor.parentId;
    const parent = current.find((t) => t.id === parentId);
    if (!parent) break;
    if (!areAllChildrenCompletedForCurrentOccurrence(parentId, current, todayIso)) break;
    if (isCompletedForCurrentOccurrence(parent, todayIso)) break; // already done — nothing to cascade, and avoids re-advancing a recurring parent past what it already advanced to

    if (parent.isRecurring && parent.dueDate) {
      // The parent may itself be sitting on an off-pattern override (see
      // recurrence.js's computeRecurringRescheduleUpdate/
      // resolveCurrentOccurrenceDueDate) — re-anchor onto the resolved date
      // first so "next" is computed from where its current occurrence
      // actually is, not a stale pre-move anchor. Same reasoning as
      // SchedulerContext.completeTask's own direct-completion handling.
      const originalParentDueDate = parent.dueDate;
      const resolvedParentDueDate = resolveCurrentOccurrenceDueDate(parent);
      const effectiveParent = resolvedParentDueDate && resolvedParentDueDate !== originalParentDueDate
        ? { ...parent, ...planSeriesReanchor(parent, resolvedParentDueDate) }
        : parent;
      // Same roll-forward every other recurring completion uses — see
      // utils/recurrenceState.js's applyRecurringCompletion, which records the
      // occurrence into the commutative set and re-derives dueDate from it.
      const rolled = applyRecurringCompletion(effectiveParent, effectiveParent.dueDate, todayIso, { compact: canCompact(effectiveParent) });
      // The now-closed-out occurrence's override entry (keyed by the
      // ORIGINAL pre-move date) is dead once it's rolled forward — drop it,
      // same cleanup completeTask does for the task it completes directly.
      const parentOverrides = parent.overrides && originalParentDueDate in parent.overrides
        ? Object.fromEntries(Object.entries(parent.overrides).filter(([key]) => key !== originalParentDueDate))
        : parent.overrides;
      const parentDescendantIds = new Set(getAllDescendants(parentId, current).map((t) => t.id));
      current = current.map((t) => {
        if (t.id === parentId) return { ...t, ...rolled, overrides: parentOverrides, completedAt: nowIso, updatedAt: nowIso };
        // Roll every recurring descendant forward in lockstep with the parent
        // — see this function's doc comment above. `taskId` itself is one of
        // these descendants (it's what triggered this cascade) and gets
        // rolled forward here too, exactly like completeTask's own direct
        // descendant-sync does for the task it completes directly.
        if (parentDescendantIds.has(t.id)) {
          const update = computeRecurringDescendantState(t, todayIso);
          return update ? { ...t, ...update, updatedAt: nowIso } : t;
        }
        return t;
      });
    } else {
      current = current.map((t) =>
        t.id === parentId ? { ...t, isCompleted: true, completedAt: nowIso, remainingHours: 0, updatedAt: nowIso } : t
      );
    }
    cursor = current.find((t) => t.id === parentId);
  }
  return current;
}

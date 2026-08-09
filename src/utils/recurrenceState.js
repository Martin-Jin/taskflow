/**
 * ============================================================================
 * RECURRENCE STATE — the convergent source of truth for a recurring task
 * ============================================================================
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Completing a recurring task used to be a read-modify-write on three fields
 * whose new value was a function of their OLD value:
 *
 *   dueDate           advance   — next occurrence after the current dueDate
 *   completedDates    append    — [occurrenceDate, ...existing], trimmed to 7d
 *   completionHistory increment — history[month] + 1
 *
 * That is fine for one writer. It is NOT fine for a shared project, whose
 * conflict policy is last-write-wins per task document (see
 * utils/sharedTaskSync.js). LWW is correct for "replace" fields — two people
 * retitling a task, second writer wins, nothing was lost that wasn't meant to
 * be replaced — but it silently corrupts accumulators:
 *
 *   - LOST COMPLETION. Alice completes the 08-06 occurrence and writes the
 *     whole doc. Bob, on a snapshot taken before that landed, completes 08-07
 *     and writes completedDates: ['08-07'] computed from HIS read, which never
 *     saw Alice's entry. His document write replaces hers wholesale. 08-06
 *     disappears from streaks/history and nothing errors.
 *   - DOUBLE-ADVANCE. Alice completes: dueDate 08-06 -> 08-07. Bob's client
 *     receives that snapshot and he clicks the checkbox believing he's
 *     completing the occurrence he was looking at. His client advances
 *     08-07 -> 08-08. The 08-07 occurrence is skipped without anyone doing it.
 *
 * THE FIX: A COMMUTATIVE SOURCE OF TRUTH, WITH EVERYTHING ELSE DERIVED
 * -------------------------------------------------------------------
 * Two stored fields replace the three mutable ones as the source of truth:
 *
 *   completedOccurrences  string[]      merged by UNION (set semantics)
 *   skippedThrough        string|null   merged by MAX
 *
 * Union and max are both commutative, associative and idempotent, so two
 * clients applying the same two completions in either order reach byte-
 * identical state, and applying the same completion twice changes nothing.
 * That last property is what kills double-advance — and it's a real
 * single-user bug too, not only a collaboration one: double-clicking the
 * checkbox today skips an occurrence.
 *
 * `dueDate`, `completedDates` and `completionHistory` then become PURE
 * FUNCTIONS of those two fields (see deriveRecurringFields). They are still
 * stored on the Task with exactly their existing shapes and meanings, so every
 * existing reader — the allocator, Board, WeekView, Stats, missedTasks.js,
 * taskHierarchy.js — is completely unchanged. What changed is only who writes
 * them. Because they're derived, LWW on them is harmless and self-healing: a
 * stale write is corrected by the next recompute on any client.
 *
 * WHY `skippedThrough` HAS TO EXIST
 * ---------------------------------
 * The subtlest behaviour being preserved. Today, completing a task that is 30
 * days overdue jumps to the next occurrence after TODAY — it does not build a
 * 30-day backlog (SchedulerContext.completeTask's `baseDate = dueDate < today
 * ? today : dueDate`). A naive "dueDate = first uncompleted occurrence"
 * derivation would regress that into 30 overdue items, because those 30
 * occurrences were never completed. `skippedThrough` records "occurrences up
 * to here are closed out but were NOT completed", so the backlog is skipped
 * without inflating completion counts or streaks. It merges by max(), so it
 * stays as commutative as the completion set itself.
 *
 * KEEPING completedOccurrences BOUNDED (see planOccurrenceCompaction)
 * -------------------------------------------------------------------
 * The set only grows on ACTUAL completions, never on missed ones — that's what
 * `skippedThrough` buys us, so a task ignored for six months adds one entry
 * when it's finally ticked, not 180. Even so it needs a bound, because of an
 * asymmetry between the two storage paths:
 *
 *   - A SHARED task is one Firestore document per task, so it has a whole 1MB
 *     to itself. At ~13 bytes per entry, a daily task would need centuries.
 *   - A PERSONAL task has no such headroom. services/firestoreSync.js stores
 *     ALL of a user's data — every task, block, section, event, note and
 *     setting — in the SINGLE document users/{uid}. That one 1MB budget is
 *     shared by everything, so ten daily recurring tasks over five years is
 *     ~230KB of it. Unbounded growth there is a real, if slow, problem.
 *
 * Compaction is safe here for a reason worth stating explicitly, because it's
 * the whole justification: a trim is a read-modify-write, and folding trimmed
 * dates into a monthly counter is an INCREMENT — precisely the non-commutative
 * operations this module exists to eliminate. They're safe only because
 * compaction never has more than one writer. A personal task has exactly one
 * writer by definition; a shared task has exactly one owner. One uniform rule
 * ("the authoritative writer compacts") covers both with no special-casing.
 *
 * MIXED-VERSION DEVICES
 * ---------------------
 * A device still running pre-migration code writes `dueDate` directly and
 * knows nothing about these fields. They're additive, so that old client keeps
 * working. deriveRecurringFields handles the reverse direction — see its
 * `storedDueDate` handling, which treats a stored dueDate AHEAD of the derived
 * one as evidence of an external advance and re-anchors rather than dragging
 * the task backwards.
 *
 * Every function here is pure: no Firebase, no Date.now(), no randomness. The
 * caller always passes `todayIso`. That's what makes the convergence and
 * rollforward properties directly unit-testable (tests/unit/recurrenceState.test.js).
 * ============================================================================
 */

import { addDays, addMonthsClamped, diffDays } from './dateUtils';
import { parseRecurrenceRule, resolveCurrentOccurrenceDueDate } from './recurrence';
import { generateRuleOccurrences } from './recurrenceExpansion';

/**
 * How many days past a search start we're willing to walk looking for the next
 * occurrence, derived from the rule's own cadence so an "every 999 years" rule
 * still resolves. Generous multiplier + flat margin covers weekday-specific
 * rules (whose next match can be up to a full extra week out) and month-length
 * variation, without ever being unbounded.
 */
function lookaheadDays(rule) {
  switch (rule.unit) {
    case 'day':
      return rule.count + 7;
    case 'week':
      return rule.count * 7 + 14;
    case 'month':
      return rule.count * 31 + 31;
    case 'year':
      return rule.count * 366 + 366;
    default:
      return 366;
  }
}

/** Translate this app's natural-language `{unit, count, days}` rule into the RRULE-ish shape generateRuleOccurrences takes. */
function toExpansionRule(rule) {
  switch (rule.unit) {
    case 'day':
      return { freq: 'DAILY', interval: Math.max(1, rule.count), byDay: null, count: null };
    case 'week':
      return {
        freq: 'WEEKLY',
        interval: Math.max(1, rule.count),
        byDay: rule.days && rule.days.length ? rule.days : null,
        count: null,
      };
    // `year` maps to a MONTHLY step of count*12, matching computeNextDueDate's
    // own year-as-12-months convention (see utils/recurrence.js).
    case 'month':
      return { freq: 'MONTHLY', interval: Math.max(1, rule.count), byDay: null, count: null };
    case 'year':
      return { freq: 'MONTHLY', interval: Math.max(1, rule.count * 12), byDay: null, count: null };
    default:
      return null;
  }
}

/**
 * The first occurrence of `rule` (anchored at `anchor`) that falls on or after
 * `from`, or null if none is reachable within the rule's own lookahead window.
 *
 * Leans on generateRuleOccurrences' `estimateStartIndex` jump so this stays
 * cheap even for an anchor years in the past — it does NOT walk every
 * occurrence from the anchor forward.
 *
 * @param {string} anchor - ISO date (YYYY-MM-DD), the series' first occurrence
 * @param {{unit: string, count: number, days?: number[]}} rule
 * @param {string} from - ISO date to search on/after
 * @returns {string|null}
 */
export function occurrenceOnOrAfter(anchor, rule, from) {
  if (!anchor || !rule) return null;
  const expansionRule = toExpansionRule(rule);
  if (!expansionRule) return null;
  // Occurrences never precede the anchor, so a `from` before it resolves to
  // the anchor's own first occurrence rather than searching backwards.
  const searchStart = from < anchor ? anchor : from;
  const hardStop = addDays(searchStart, lookaheadDays(rule));
  const dates = generateRuleOccurrences(anchor, expansionRule, searchStart, hardStop);
  return dates.length > 0 ? dates[0] : null;
}

/** The first occurrence strictly after `after`. Thin wrapper for readability at call sites. */
export function occurrenceAfter(anchor, rule, after) {
  return occurrenceOnOrAfter(anchor, rule, addDays(after, 1));
}

/**
 * The last occurrence on or before `on`, or null if the series starts later.
 * Used to close out an overdue backlog: completing a stale occurrence marks
 * everything through today's own occurrence as skipped, exactly matching
 * completeTask's existing `baseDate = today` rollforward.
 */
export function lastOccurrenceOnOrBefore(anchor, rule, on) {
  if (!anchor || !rule || on < anchor) return null;
  const expansionRule = toExpansionRule(rule);
  if (!expansionRule) return null;
  // Walk a bounded window ending at `on` and take the last hit. The window is
  // one full cadence wide, so it always contains at least one occurrence
  // whenever the series started before `on`.
  const windowStart = addDays(on, -lookaheadDays(rule));
  const searchStart = windowStart < anchor ? anchor : windowStart;
  const dates = generateRuleOccurrences(anchor, expansionRule, searchStart, on);
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

/** Normalize a completed-occurrence list: unique, ascending, ISO strings only. */
export function normalizeOccurrences(occurrences) {
  if (!Array.isArray(occurrences)) return [];
  const seen = new Set();
  for (const d of occurrences) {
    if (typeof d === 'string' && d.length > 0) seen.add(d);
  }
  return [...seen].sort();
}

/**
 * Merge two recurring-state values into their convergent join. This IS the
 * conflict resolution for recurring tasks, and the reason the whole model
 * exists: union is commutative/associative/idempotent, max is too, so
 * merge(a, b) === merge(b, a) and merge(a, a) === a for every input.
 *
 * Applied by the shared-project sync engine whenever a remote task document
 * arrives for a recurring task, instead of the plain last-write-wins used for
 * every other field (see hooks/useSharedProjectSync.js).
 *
 * @param {{completedOccurrences?: string[], skippedThrough?: string|null}} a
 * @param {{completedOccurrences?: string[], skippedThrough?: string|null}} b
 * @returns {{completedOccurrences: string[], skippedThrough: string|null}}
 */
export function mergeRecurringState(a, b) {
  const completedOccurrences = normalizeOccurrences([
    ...(a?.completedOccurrences || []),
    ...(b?.completedOccurrences || []),
  ]);
  const aSkipped = a?.skippedThrough || null;
  const bSkipped = b?.skippedThrough || null;
  let skippedThrough = null;
  if (aSkipped && bSkipped) skippedThrough = aSkipped >= bSkipped ? aSkipped : bSkipped;
  else skippedThrough = aSkipped || bSkipped;
  return { completedOccurrences, skippedThrough };
}

/** How many days of raw completion dates stay in the derived `completedDates` view before rolling into the monthly aggregate. Matches the pre-existing window exactly. */
const COMPLETED_DATES_WINDOW_DAYS = 7;

/**
 * Recompute the three DERIVED fields (`dueDate`, `completedDates`,
 * `completionHistory`) from the two source-of-truth fields. Pure, so two
 * clients holding the same source state always render the same task.
 *
 * `dueDate` = the first occurrence that is neither already completed nor
 * closed out by `skippedThrough`. Note this deliberately does NOT clamp to
 * today: a genuinely overdue, never-completed recurring task keeps showing its
 * stale past due date and reads as overdue, exactly as it does today. The
 * rollforward happens only when an occurrence is actually completed (see
 * planOccurrenceCompletion), which is where the current code applies it too.
 *
 * `completedDates` = completions inside the trailing 7-day window, NEWEST
 * FIRST — same shape and ordering the pre-existing field had, since
 * missedTasks.js/BoardView/TaskDetailModal/StatsDashboard all read it directly.
 *
 * `completionHistory` = `completionHistoryArchive` (a frozen baseline captured
 * at migration time, so pre-existing history is never lost) plus a monthly
 * rollup of every completion older than that window. Derived rather than
 * incremented, so it can't double-count under concurrent completion.
 *
 * @param {import('../types').Task} task
 * @param {string} todayIso - ISO date (YYYY-MM-DD); injected, never read from the clock, so this stays testable.
 * @returns {{dueDate: string|null, completedDates: string[], completionHistory: Record<string, number>}}
 */
export function deriveRecurringFields(task, todayIso) {
  const completedOccurrences = normalizeOccurrences(task?.completedOccurrences);
  const completed = new Set(completedOccurrences);
  const skippedThrough = task?.skippedThrough || null;

  // --- completedDates / completionHistory ---------------------------------
  const windowStart = addDays(todayIso, -COMPLETED_DATES_WINDOW_DAYS);
  const completedDates = [];
  const completionHistory = { ...(task?.completionHistoryArchive || {}) };
  for (const d of completedOccurrences) {
    if (d >= windowStart) {
      completedDates.push(d);
    } else {
      const monthKey = d.slice(0, 7); // "YYYY-MM"
      completionHistory[monthKey] = (completionHistory[monthKey] || 0) + 1;
    }
  }
  completedDates.reverse(); // normalizeOccurrences sorts ascending; this field is newest-first.

  // --- dueDate -------------------------------------------------------------
  const rule = task?.recurrenceRule || parseRecurrenceRule(task?.recurrenceString);
  const anchor = task?.recurrenceAnchor || null;
  if (!rule || !anchor) {
    // Not enough information to derive — leave whatever's stored untouched
    // rather than guessing. Covers a recurring task whose string didn't parse
    // and a not-yet-migrated one alike.
    return { dueDate: task?.dueDate ?? null, completedDates, completionHistory };
  }

  // Start after whatever's already closed out, then skip any occurrence
  // already recorded as completed — or dropped by a `deleted` override.
  //
  // The override check keeps this in agreement with recurrence.js's
  // expandTaskOccurrences, which the scheduler uses: without it, an occurrence
  // the expansion skips could still be handed back here as the due date, so
  // the task would show a deadline for a day it's never scheduled on. Task
  // overrides only carry `date` today (see computeRecurringRescheduleUpdate's
  // off-pattern branch), so this is currently unreachable — but the two
  // functions must not be able to disagree about what an occurrence is.
  //
  // The loop is bounded by how many occurrences can be skipped, so it always
  // terminates even against a pathological override map.
  const overrides = task?.overrides || {};
  const isResolved = (date) => completed.has(date) || overrides[date]?.deleted === true;
  let candidate = skippedThrough ? occurrenceAfter(anchor, rule, skippedThrough) : occurrenceOnOrAfter(anchor, rule, anchor);
  let guard = completed.size + Object.keys(overrides).length + 1;
  while (candidate && isResolved(candidate) && guard-- > 0) {
    candidate = occurrenceAfter(anchor, rule, candidate);
  }

  // MIXED-VERSION SAFETY: a device still on pre-migration code advances
  // `dueDate` directly without recording an occurrence. If the stored dueDate
  // is AHEAD of what we derived, that older client has legitimately moved the
  // series on, and re-deriving backwards would undo its work and resurrect an
  // occurrence the user already closed. Trust the further-ahead value.
  const storedDueDate = task?.dueDate || null;
  if (storedDueDate && candidate && storedDueDate > candidate) {
    return { dueDate: storedDueDate, completedDates, completionHistory };
  }

  return { dueDate: candidate ?? storedDueDate, completedDates, completionHistory };
}

/**
 * The source-of-truth update for completing one occurrence of a recurring
 * task — the write half of this module, returned as a plain descriptor so the
 * Firestore layer can apply it as an `arrayUnion` (see
 * services/sharedProjectService.js) and local state can apply it as a merge,
 * from one decision.
 *
 * Idempotent: completing an occurrence already in the set returns the set
 * unchanged, so a double-click (or a second collaborator clicking the same
 * checkbox) advances nothing. That's the double-advance fix.
 *
 * Rollforward: completing an occurrence that's in the PAST also closes out
 * everything through today's own occurrence via `skippedThrough`, so an
 * overdue task jumps to its next future occurrence rather than accumulating a
 * backlog — preserving completeTask's existing `baseDate = today` behaviour
 * exactly, without counting those skipped occurrences as completed.
 *
 * @param {import('../types').Task} task
 * @param {string} occurrenceDate - ISO date of the occurrence being closed out (normally the task's current dueDate)
 * @param {string} todayIso - ISO date (YYYY-MM-DD)
 * @returns {{completedOccurrences: string[], skippedThrough: string|null, addedOccurrence: string|null}}
 *   `addedOccurrence` is null when this was a no-op repeat, so callers can skip a pointless write.
 */
export function planOccurrenceCompletion(task, occurrenceDate, todayIso) {
  const existing = normalizeOccurrences(task?.completedOccurrences);
  const alreadyCompleted = existing.includes(occurrenceDate);
  const completedOccurrences = alreadyCompleted ? existing : normalizeOccurrences([...existing, occurrenceDate]);

  let skippedThrough = task?.skippedThrough || null;
  if (occurrenceDate < todayIso) {
    const rule = task?.recurrenceRule || parseRecurrenceRule(task?.recurrenceString);
    const anchor = task?.recurrenceAnchor || null;
    const closeOutThrough = rule && anchor ? lastOccurrenceOnOrBefore(anchor, rule, todayIso) : null;
    if (closeOutThrough && (!skippedThrough || closeOutThrough > skippedThrough)) {
      skippedThrough = closeOutThrough;
    }
  }

  return {
    completedOccurrences,
    skippedThrough,
    addedOccurrence: alreadyCompleted ? null : occurrenceDate,
  };
}

/**
 * The inverse of applyRecurringCompletion for ONE occurrence — un-checking a
 * recurring task (SchedulerContext.uncompleteTask). Removes the occurrence
 * from the source set and re-derives, which rolls the due date back to it
 * automatically rather than needing a separate "undo the advance" step.
 *
 * Removal is NOT commutative with union (that's what makes a remove-wins vs
 * add-wins tie unresolvable in general), so this is a deliberate local user
 * action applied as a plain write, exactly like planSeriesReanchor. In a
 * shared project the write is last-write-wins per document, same as any other
 * edit: if someone re-completes concurrently, the later write stands. That's
 * the accepted policy for intentional edits — it's only the ACCUMULATION path
 * (completion) that had to be made order-independent.
 *
 * @param {import('../types').Task} task
 * @param {string} occurrenceDate - the occurrence to reopen
 * @param {string} todayIso
 * @returns {object} fields to spread onto the task
 */
export function planOccurrenceUncompletion(task, occurrenceDate, todayIso) {
  const completedOccurrences = normalizeOccurrences(task?.completedOccurrences).filter((d) => d !== occurrenceDate);
  // A skip watermark at/after the reopened occurrence would keep the derived
  // due date parked past it, so the un-check would appear to do nothing.
  const existingSkipped = task?.skippedThrough || null;
  const skippedThrough = existingSkipped && existingSkipped < occurrenceDate ? existingSkipped : null;
  const next = { ...task, completedOccurrences, skippedThrough };
  const derived = deriveRecurringFields(next, todayIso);
  return {
    completedOccurrences,
    skippedThrough,
    // Re-derive from scratch rather than trusting the stored dueDate, which is
    // ahead of where we're rolling back to — deriveRecurringFields' "trust a
    // dueDate that's further ahead" rule would otherwise refuse to move it.
    dueDate: deriveRecurringFields({ ...next, dueDate: null }, todayIso).dueDate,
    completedDates: derived.completedDates,
    completionHistory: derived.completionHistory,
  };
}

/**
 * Re-anchor a series when the user manually moves a recurring task's due date
 * (TaskDetailModal/AddTaskModal, the AI plan assistant, a Todoist re-import).
 * This is a deliberate user action rather than a completion, so it REPLACES
 * the anchor rather than merging — and it drops completions on/after the new
 * date, matching computeRecurringRescheduleUpdate's existing rule that moving
 * the due date back onto an already-completed occurrence is the user reopening
 * it, not relabeling a done one.
 *
 * `skippedThrough` is cleared when it would otherwise sit on/after the new
 * anchor, since a stale close-out marker would immediately push the freshly
 * chosen due date forward again — the single most confusing thing this model
 * could do to someone who just picked a date.
 *
 * @param {import('../types').Task} task
 * @param {string} newDueDate - ISO date the user chose
 * @returns {{recurrenceAnchor: string, completedOccurrences: string[], skippedThrough: string|null, dueDate: string}}
 */
export function planSeriesReanchor(task, newDueDate) {
  const completedOccurrences = normalizeOccurrences(task?.completedOccurrences).filter((d) => d < newDueDate);
  const existingSkipped = task?.skippedThrough || null;
  const skippedThrough = existingSkipped && existingSkipped < newDueDate ? existingSkipped : null;
  return {
    recurrenceAnchor: newDueDate,
    completedOccurrences,
    skippedThrough,
    dueDate: newDueDate,
  };
}

/**
 * recurrence.js's computeEnforceDueDateSyncUpdates cascades an enforcing
 * ancestor's dueDate onto descendants, but it only knows how to produce a
 * plain `dueDate`/`dueDateInherited` pair — it has no access to this
 * module's re-anchoring (recurrence.js is the OLDER module and this one
 * already imports from it; the reverse import would be circular, see this
 * file's header comment). So SchedulerContext.jsx's addTask/updateTask call
 * this afterward, as the layer that can see both function's outputs: for any
 * update that lands a new `dueDate` on a task that `isRecurring`, replace the
 * raw dueDate with a full re-anchor (recurrenceAnchor/completedOccurrences/
 * skippedThrough/dueDate) via planSeriesReanchor — otherwise the next
 * completion/reschedule on that descendant re-derives dueDate from its
 * untouched old anchor and silently undoes the cascade. Mirrors the identical
 * reasoning already applied to a user's own direct due-date edit (see
 * updateTask's own planSeriesReanchor call). `dueDateInherited` is preserved
 * as-is since re-anchoring doesn't change whether this date is still "the
 * ancestor's".
 *
 * @param {import('../types').Task[]} tasks - same array computeEnforceDueDateSyncUpdates was run against
 * @param {Map<string, object>} enforceDueDateSyncUpdates - computeEnforceDueDateSyncUpdates' output
 * @returns {Map<string, object>} same map, with recurring descendants' dueDate updates re-anchored
 */
export function reanchorRecurringEnforceDueDateUpdates(tasks, enforceDueDateSyncUpdates) {
  if (enforceDueDateSyncUpdates.size === 0) return enforceDueDateSyncUpdates;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reanchored = new Map();
  for (const [taskId, update] of enforceDueDateSyncUpdates) {
    const task = byId.get(taskId);
    if (task?.isRecurring && update.dueDate) {
      const { dueDateInherited } = update;
      reanchored.set(
        taskId,
        { ...planSeriesReanchor(task, update.dueDate), ...(dueDateInherited !== undefined ? { dueDateInherited } : {}) }
      );
    } else {
      reanchored.set(taskId, update);
    }
  }
  return reanchored;
}

/**
 * How a single descendant (sub-task) should be updated when its RECURRING
 * ancestor is completed and rolls forward — the new-model replacement for
 * recurrence.js's computeRecurringDescendantUpdate, which advanced dueDate
 * and appended to completedDates directly.
 *
 * The two cases are unchanged from that function, and the reasoning behind
 * them is worth preserving verbatim:
 *
 *   - Descendant is ITSELF recurring with its own dueDate (e.g. via
 *     TaskDetailModal's "Apply to all sub-tasks", which copies isRecurring/
 *     recurrenceString/dueDate straight down): roll it forward exactly as the
 *     ancestor rolls forward, recording the occurrence against its OWN state.
 *     That mirroring exists because missedTasks.js's isBlockTaskCompleted
 *     reads a recurring task's own completedDates to decide whether ITS block
 *     shows as done — without it, a sub-task completed via its parent never
 *     appears done anywhere.
 *   - Otherwise: leave it completely alone. An undated sub-task already
 *     borrows its nearest ancestor's dueDate for scheduling urgency, and a
 *     dated-but-non-recurring sub-task's date is a plain deadline with no
 *     recurrence reason to clear it — nulling it out destroyed real user data
 *     for no benefit. isCompleted is untouched too: this path only exists to
 *     stop a recurring parent's roll-forward from stranding a sub-task in a
 *     stale completed state, which can't apply to one never completed.
 *
 * @param {import('../types').Task} descendant
 * @param {string} todayIso
 * @returns {object|null} fields to spread onto the descendant, or null for "don't touch it".
 */
export function computeRecurringDescendantState(descendant, todayIso) {
  if (!descendant?.isRecurring || !descendant.dueDate) return null;
  // The descendant may itself be sitting on an off-pattern override (see
  // recurrence.js's computeRecurringRescheduleUpdate/
  // resolveCurrentOccurrenceDueDate) — re-anchor onto the resolved date first
  // so "next" is computed from where the descendant's current occurrence
  // actually is, not a stale pre-move anchor. Same reasoning as
  // SchedulerContext.completeTask's own top-level handling of this case.
  const originalDueDate = descendant.dueDate;
  const resolvedDueDate = resolveCurrentOccurrenceDueDate(descendant);
  const effective = resolvedDueDate && resolvedDueDate !== originalDueDate
    ? { ...descendant, ...planSeriesReanchor(descendant, resolvedDueDate) }
    : descendant;
  const rolled = applyRecurringCompletion(effective, effective.dueDate, todayIso);
  // The now-closed-out occurrence's override entry (keyed by the ORIGINAL
  // pre-move date, same convention completeTask uses) is dead once it's
  // rolled forward — drop it so it doesn't linger and resurface later.
  if (descendant.overrides && originalDueDate in descendant.overrides) {
    return {
      ...rolled,
      overrides: Object.fromEntries(Object.entries(descendant.overrides).filter(([key]) => key !== originalDueDate)),
    };
  }
  return rolled;
}

/**
 * Give a recurring task the anchor this model needs, if it doesn't have one.
 * Every path that creates or newly-marks-recurring a task funnels through here
 * (SchedulerContext's addTask/updateTask, the migration, Todoist import), so
 * an un-anchored recurring task can't reach the derive path and silently fall
 * back to "leave dueDate alone forever".
 *
 * The anchor is the series' defining first occurrence, so an existing task's
 * current `dueDate` is exactly the right seed: derive then returns that same
 * date, making adoption a no-op from the user's point of view.
 *
 * @param {import('../types').Task} task
 * @returns {object} fields to spread onto the task; empty when nothing is needed.
 */
export function ensureRecurrenceAnchor(task) {
  if (!task?.isRecurring || !task.dueDate) return {};
  if (typeof task.recurrenceAnchor === 'string' && task.recurrenceAnchor.length > 0) return {};
  return {
    recurrenceAnchor: task.dueDate,
    completedOccurrences: normalizeOccurrences(task.completedOccurrences),
    skippedThrough: task.skippedThrough || null,
  };
}

/**
 * The complete field set to spread onto a recurring task when one of its
 * occurrences is completed — the source-of-truth update plus the three derived
 * fields recomputed from it, in one call.
 *
 * Shared by SchedulerContext.completeTask's own branch and its descendant
 * cascade so the two can't diverge on this bookkeeping, exactly as
 * computeCompletionHistoryUpdate was shared before it.
 *
 * @param {import('../types').Task} task
 * @param {string} occurrenceDate - the occurrence being closed out (normally the task's current dueDate)
 * @param {string} todayIso
 * @returns {{completedOccurrences: string[], skippedThrough: string|null, dueDate: string|null,
 *   completedDates: string[], completionHistory: Record<string, number>, isCompleted: boolean, remainingHours: number}}
 */
export function applyRecurringCompletion(task, occurrenceDate, todayIso, { compact = false } = {}) {
  const anchored = { ...task, ...ensureRecurrenceAnchor(task) };
  const plan = planOccurrenceCompletion(anchored, occurrenceDate, todayIso);
  let next = { ...anchored, ...plan };
  let derived = deriveRecurringFields(next, todayIso);

  // Completion is the only moment the occurrence set grows, so it's the
  // natural place to keep it bounded. Opt-in via `compact` because compaction
  // is the one non-commutative operation in this model and is only safe for
  // the single authoritative writer — see planOccurrenceCompaction. It needs
  // the freshly-derived dueDate as its bound, hence deriving either side of
  // it; the second derive is cheap and keeps the returned views provably
  // consistent with the state they're returned alongside.
  if (compact) {
    const compaction = planOccurrenceCompaction({ ...next, dueDate: derived.dueDate }, todayIso);
    if (compaction) {
      next = { ...next, ...compaction };
      derived = deriveRecurringFields(next, todayIso);
    }
  }

  return {
    recurrenceAnchor: next.recurrenceAnchor,
    completedOccurrences: next.completedOccurrences,
    skippedThrough: next.skippedThrough,
    ...(next.completionHistoryArchive ? { completionHistoryArchive: next.completionHistoryArchive } : {}),
    dueDate: derived.dueDate,
    completedDates: derived.completedDates,
    completionHistory: derived.completionHistory,
    // A recurring task never becomes "done" — it rolls forward and is
    // schedulable again for its new occurrence (see types/index.js).
    isCompleted: false,
    remainingHours: task.estimatedHours,
  };
}

/**
 * Mark today's occurrence of a recurring SUB-TASK done WITHOUT advancing its
 * own `dueDate` — the "checked for today, but stays parked on today's
 * occurrence" half of the parent/sub-task completion split (see
 * SchedulerContext.completeTask's `existing.parentId` branch and
 * applyUpwardCompletionCascade).
 *
 * A top-level recurring task rolls forward the instant it's completed
 * (applyRecurringCompletion). A recurring SUB-TASK must not: TaskListPanel
 * buckets a task into Overdue/Today/Upcoming off its own dueDate, so
 * advancing it immediately would make the sub-task vanish from "Today" the
 * moment it's checked, even though its siblings (and the parent) aren't done
 * yet for this cycle. Instead the sub-task stays visibly checked in "Today"
 * (isCheckedForListDisplay reads completedDates, which this DOES update) with
 * its dueDate pinned to the current occurrence — until the whole group closes
 * out and applyUpwardCompletionCascade's descendant-sync rolls every recurring
 * descendant, including this one, forward together (see
 * computeRecurringDescendantState).
 *
 * Reuses planOccurrenceCompletion for the source-of-truth write (so the same
 * union/rollforward-through-skippedThrough semantics apply — a sub-task
 * completed while overdue still closes its backlog out to today) and
 * deriveRecurringFields for completedDates/completionHistory, but discards
 * the derived `dueDate` in favour of the task's current one.
 *
 * @param {import('../types').Task} task
 * @param {string} occurrenceDate - the occurrence being marked done (normally the task's current dueDate)
 * @param {string} todayIso
 * @returns {{completedOccurrences: string[], skippedThrough: string|null, dueDate: string,
 *   completedDates: string[], completionHistory: Record<string, number>}}
 */
export function planSubtaskOccurrenceCompletion(task, occurrenceDate, todayIso) {
  const anchored = { ...task, ...ensureRecurrenceAnchor(task) };
  const plan = planOccurrenceCompletion(anchored, occurrenceDate, todayIso);
  const next = { ...anchored, ...plan };
  const derived = deriveRecurringFields(next, todayIso);
  return {
    recurrenceAnchor: next.recurrenceAnchor,
    completedOccurrences: next.completedOccurrences,
    skippedThrough: next.skippedThrough,
    // Pinned — see doc comment above. Deliberately NOT derived.dueDate.
    dueDate: anchored.dueDate,
    completedDates: derived.completedDates,
    completionHistory: derived.completionHistory,
  };
}

/**
 * How much raw completion history to keep before folding it into the monthly
 * archive. A year is well past anything the UI reads date-by-date (the
 * `completedDates` view is a 7-day window, and Stats reads the monthly
 * aggregate), while leaving generous room for a task completed irregularly.
 */
export const COMPACTION_WINDOW_DAYS = 365;

/**
 * Fold old raw occurrences into the monthly archive, keeping
 * `completedOccurrences` bounded. Returns null when there's nothing to do, so
 * the caller can skip a pointless write.
 *
 * MUST ONLY BE CALLED BY THE AUTHORITATIVE WRITER — the owner of a shared
 * project, or the (single) owner of a personal task. This is the one function
 * in this module that is NOT commutative: it removes entries and increments
 * counters, so two clients running it concurrently would double-count a month
 * into the archive. See the module header for why that restriction is
 * satisfiable rather than merely hoped for.
 *
 * THE CORRECTNESS CONSTRAINT: compaction must never move `dueDate`. Dropping a
 * completed occurrence requires raising `skippedThrough` past it (otherwise the
 * derivation would rediscover it as unresolved and drag the due date
 * backwards) — but raising `skippedThrough` blindly would leap over any
 * UNCOMPLETED occurrence sitting between two dropped ones, silently advancing
 * the task. So the cutoff is bounded by the current `dueDate` as well as by
 * age: only occurrences strictly BEFORE the due date are eligible, and
 * everything before the due date is by definition already resolved (it's the
 * first unresolved occurrence). Moving the watermark across purely resolved
 * ground cannot change what the derivation returns.
 *
 * @param {import('../types').Task} task
 * @param {string} todayIso - ISO date (YYYY-MM-DD)
 * @param {number} [windowDays] - override for tests
 * @returns {{completedOccurrences: string[], completionHistoryArchive: Record<string, number>, skippedThrough: string}|null}
 */
export function planOccurrenceCompaction(task, todayIso, windowDays = COMPACTION_WINDOW_DAYS) {
  const occurrences = normalizeOccurrences(task?.completedOccurrences);
  if (occurrences.length === 0) return null;

  const ageCutoff = addDays(todayIso, -windowDays);
  const dueDate = task?.dueDate || null;
  // Bounded by BOTH age and the due date — see the constraint above. Without
  // a due date we have no proof of what's resolved, so decline to compact.
  if (!dueDate) return null;
  const cutoff = ageCutoff < dueDate ? ageCutoff : dueDate;

  const dropped = occurrences.filter((d) => d < cutoff);
  if (dropped.length === 0) return null;

  const completionHistoryArchive = { ...(task?.completionHistoryArchive || {}) };
  for (const d of dropped) {
    const monthKey = d.slice(0, 7); // "YYYY-MM"
    completionHistoryArchive[monthKey] = (completionHistoryArchive[monthKey] || 0) + 1;
  }

  const highestDropped = dropped[dropped.length - 1];
  const existingSkipped = task?.skippedThrough || null;
  const skippedThrough = existingSkipped && existingSkipped > highestDropped ? existingSkipped : highestDropped;

  return {
    completedOccurrences: occurrences.filter((d) => d >= cutoff),
    completionHistoryArchive,
    skippedThrough,
  };
}

/**
 * True if `task` carries the fields this model needs. Used to tell a migrated
 * recurring task from one that still predates it, so the migration and the
 * derive path can both stay no-ops for anything they shouldn't touch.
 */
export function hasRecurrenceState(task) {
  return !!task?.isRecurring && typeof task?.recurrenceAnchor === 'string' && task.recurrenceAnchor.length > 0;
}

/**
 * Number of days between two ISO dates, exposed so callers doing their own
 * bounds checks don't reach past this module into dateUtils for it. Kept here
 * (rather than re-exported blindly) purely so this module's public surface is
 * self-describing.
 */
export function daysBetween(fromIso, toIso) {
  return diffDays(fromIso, toIso);
}

/** Re-exported for the migration, which needs month arithmetic identical to the rest of this model. */
export { addMonthsClamped };

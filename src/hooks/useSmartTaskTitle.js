/**
 * useSmartTaskTitle — shared smart-parse wiring for the Title field, used by
 * both AddTaskModal and TaskDetailModal so the two screens can't drift.
 *
 * Each SCALAR field (dueDate/recurrence/priority/dependency/project) is
 * described by the caller as { isUntouched, apply, revert } since "untouched"
 * and "revert to what" differ between Add (blank defaults) and Edit (the
 * task's original value) — see each modal's `fields` object.
 *
 * `labels` ("@tag" mentions) is handled separately, not through `fields`:
 * unlike the scalar fields, a detected tag never overwrites anything and
 * has no "original value" to revert to — Label creation itself is deferred
 * to the caller's Save handler (see SchedulerContext.getOrCreateLabelIds),
 * so there is nothing for `apply`/`revert` to do here. This hook just
 * tracks which detected tags are still visible vs. dismissed, the same
 * bookkeeping every scalar field gets, without forcing labels through a
 * contract built for single overwritable values.
 *
 * DISMISSAL: dismissing a detection reverts its field (or, for a label,
 * just hides that one chip) and blocks that exact phrase from reapplying
 * *while it's still typed*. The moment that phrase is no longer present in
 * the title (edited or deleted), the block is lifted — so retyping the
 * same trigger word later re-arms smart parse instead of staying silently
 * dismissed for the rest of the session.
 */

import { useState } from 'react';
import {
  Repeat,
  Wind,
  CalendarClock,
  CalendarCheck,
  CalendarX2,
  Flag,
  Link2,
  HelpCircle,
  Folder,
  Tag,
  Clock,
  Link as LinkIcon,
  Ban,
  CornerUpRight,
  CornerUpLeft,
  ListFilter,
} from 'lucide-react';
import { parseTaskText, stripMatchedText } from '../utils/smartParse';
import { formatDisplayDate, formatTime12h } from '../utils/dateUtils';
import { linkLabel } from '../utils/linkify';
import { PRIORITY_LABELS } from '../utils/priorityColor';
import { formatHours } from '../utils/formatHours';

const SCALAR_FIELD_TYPES = [
  'link',
  'dueDate',
  'fixedTime',
  'recurrence',
  'priority',
  'estimatedHours',
  'unattended',
  'enforceDueDate',
  'earliestDate',
  'excludeFromAutoSchedule',
  'dependency',
  'subOf',
  'unsubtask',
  'project',
  'sectionShorthand',
];

export function useSmartTaskTitle({ tasks, projects = [], sections = [], fields }) {
  const [smartDetected, setSmartDetected] = useState({});
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set());

  function handleTitleChange(value) {
    const { detected } = parseTaskText(value, { existingTasks: tasks, projects, sections });
    const nextVisible = {};
    const nextDismissed = new Set(dismissedKeys);

    SCALAR_FIELD_TYPES.forEach((type) => {
      const match = detected[type];
      const field = fields[type];
      if (!field) return;

      // Drop any dismissal for this type that doesn't match what's currently
      // typed. A dismissed key must only keep suppressing the exact phrase it
      // was dismissed for — otherwise, editing straight from one valid match
      // to a *different* valid match of the same type (e.g. "at 9pm" -> "at
      // 10pm") never passes through a "no match" state, so the old key would
      // never get cleared, and coming back to the original phrase later would
      // stay silently (and permanently) suppressed. This mirrors the `labels`
      // cleanup below, which already compares against the full current match
      // set rather than only clearing on a total absence of matches.
      const key = match ? `${type}:${match.matchedText}` : null;
      [...nextDismissed].forEach((k) => {
        if (k.startsWith(`${type}:`) && k !== key) nextDismissed.delete(k);
      });

      if (!match) {
        // If a chip was showing (i.e. this field was auto-applied from a
        // previous detection), the phrase that drove it just got edited
        // away — revert the field now, otherwise it stays "touched" forever
        // and isUntouched() below would block re-applying the same phrase
        // if the user retypes it.
        const wasVisible = smartDetected[type];
        if (wasVisible) fields[type].revert(wasVisible);
        return;
      }

      if (field.isUntouched() && !nextDismissed.has(key)) {
        // Pass the full detection set so a field's apply() can see what else
        // was just detected in this same pass (e.g. recurrence checking
        // whether a due date was also detected, without relying on a sibling
        // setState having already landed — state updates aren't visible
        // within the same synchronous pass).
        field.apply(match, detected);
        nextVisible[type] = match;
      }
    });

    const labelMatches = detected.labels || [];
    const matchedLabelKeys = new Set(labelMatches.map((m) => `labels:${m.matchedText}`));
    [...nextDismissed].forEach((key) => {
      if (key.startsWith('labels:') && !matchedLabelKeys.has(key)) nextDismissed.delete(key);
    });
    const visibleLabels = labelMatches.filter((m) => !nextDismissed.has(`labels:${m.matchedText}`));
    if (visibleLabels.length > 0) nextVisible.labels = visibleLabels;

    setDismissedKeys(nextDismissed);
    setSmartDetected(nextVisible);
  }

  /** For `labels`, `match` identifies which of the several detected tags to dismiss. */
  function dismissSmartChip(type, match) {
    if (type === 'labels') {
      if (!match) return;
      setDismissedKeys((prev) => new Set(prev).add(`labels:${match.matchedText}`));
      setSmartDetected((prev) => {
        const remaining = (prev.labels || []).filter((m) => m.matchedText !== match.matchedText);
        const next = { ...prev };
        if (remaining.length > 0) next.labels = remaining;
        else delete next.labels;
        return next;
      });
      return;
    }

    const entry = smartDetected[type];
    if (!entry) return;
    setDismissedKeys((prev) => new Set(prev).add(`${type}:${entry.matchedText}`));
    fields[type].revert(entry);
    setSmartDetected((prev) => {
      const next = { ...prev };
      delete next[type];
      return next;
    });
  }

  /**
   * Resolve an ambiguous (multi-candidate) chip by applying one specific
   * candidate the user picked from the chip's disambiguation popover (see
   * SmartChips' `expandable` chips) — generic across any field that can
   * produce a `candidates` array, not just `sectionShorthand`, so a future
   * ambiguous-match field can reuse this same path without changes here.
   *
   * `candidate` is field-specific — for `sectionShorthand` it's the
   * `{project, section}` pair the user clicked. It's forwarded into
   * `fields[type].apply` as `{ ...candidate, task: null }` so every field's
   * `apply(match)` can keep reading `match.project`/`match.section`/
   * `match.task` the same way it already does for a normal (non-ambiguous)
   * detection — `task: null` is just a filler for fields that also check a
   * `match.task` shape (none currently do for an expandable field, but this
   * keeps the match object shape consistent rather than field-dependent).
   *
   * Once applied, the ambiguous entry in `smartDetected` is replaced with a
   * resolved one carrying the same matchedText/fragment (so buildFinalTitle
   * still strips the right span of text) but the chosen project/section and
   * an empty candidates list — the same lifecycle a normal chip's
   * `apply` already produces, so the "Multiple matches" chip turns straight
   * into the resolved "Project → Section" chip rather than needing a second
   * keystroke to re-detect.
   */
  function applySmartChipCandidate(type, candidate) {
    const entry = smartDetected[type];
    if (!entry || !fields[type]) return;
    const resolvedMatch = { ...entry, ...candidate, candidates: [] };
    fields[type].apply(resolvedMatch, smartDetected);
    setSmartDetected((prev) => ({ ...prev, [type]: resolvedMatch }));
  }

  /**
   * Strip whatever smart-parse phrases are still accepted (visible) out of
   * the saved title. If that leaves nothing (e.g. the whole title was just
   * a smart-parsed link), falls back to `fallback` if the caller passed one
   * (e.g. the link's hostname) — otherwise falls back to the untouched raw
   * title so a save is never blocked, even if that means the phrase stays
   * visible in the title after all.
   */
  function buildFinalTitle(title, fallback) {
    let result = title;
    SCALAR_FIELD_TYPES.forEach((type) => {
      if (smartDetected[type]) result = stripMatchedText(result, smartDetected[type].matchedText);
    });
    (smartDetected.labels || []).forEach((match) => {
      result = stripMatchedText(result, match.matchedText);
    });
    return result.trim() || fallback || title.trim();
  }

  function resetSmartState() {
    setSmartDetected({});
    setDismissedKeys(new Set());
  }

  return { smartDetected, handleTitleChange, dismissSmartChip, applySmartChipCandidate, buildFinalTitle, resetSmartState };
}

/**
 * Turns a `smartDetected` map into the chip objects `SmartChips` renders —
 * shared by AddTaskModal and TaskDetailModal so their smart-parse chip UI
 * can't drift apart (see this file's doc comment for how detection itself
 * is centralized; this covers the display side).
 */
export function buildSmartChips(smartDetected) {
  return [
    smartDetected.link && { type: 'link', icon: LinkIcon, label: linkLabel(smartDetected.link.url) },
    smartDetected.dueDate && { type: 'dueDate', icon: CalendarClock, label: `Due ${formatDisplayDate(smartDetected.dueDate.iso)}` },
    smartDetected.fixedTime && { type: 'fixedTime', icon: Clock, label: `At ${formatTime12h(smartDetected.fixedTime.time)}` },
    smartDetected.recurrence && { type: 'recurrence', icon: Repeat, label: `Repeats ${smartDetected.recurrence.recurrenceString}` },
    smartDetected.priority && { type: 'priority', icon: Flag, label: `${PRIORITY_LABELS[smartDetected.priority.level]} priority` },
    smartDetected.estimatedHours && {
      type: 'estimatedHours',
      icon: Clock,
      label: `Est. ${formatHours(smartDetected.estimatedHours.hours)}`,
    },
    smartDetected.unattended && { type: 'unattended', icon: Wind, label: 'Can run unattended' },
    smartDetected.enforceDueDate && { type: 'enforceDueDate', icon: CalendarCheck, label: 'Enforce due date' },
    smartDetected.earliestDate && {
      type: 'earliestDate',
      icon: CalendarX2,
      label: `Not before ${formatDisplayDate(smartDetected.earliestDate.iso)}`,
    },
    smartDetected.excludeFromAutoSchedule && { type: 'excludeFromAutoSchedule', icon: Ban, label: 'Excluded from auto-schedule' },
    smartDetected.dependency &&
      (smartDetected.dependency.task
        ? { type: 'dependency', icon: Link2, label: `After: ${smartDetected.dependency.task.title}` }
        : { type: 'dependency', icon: HelpCircle, label: `No match for "${smartDetected.dependency.fragment}"` }),
    smartDetected.subOf &&
      (smartDetected.subOf.task
        ? { type: 'subOf', icon: CornerUpRight, label: `Sub-task of: ${smartDetected.subOf.task.title}` }
        : { type: 'subOf', icon: HelpCircle, label: `No match for "${smartDetected.subOf.fragment}"` }),
    smartDetected.unsubtask && { type: 'unsubtask', icon: CornerUpLeft, label: 'Remove from parent task' },
    smartDetected.project &&
      (smartDetected.project.project
        ? {
            type: 'project',
            icon: smartDetected.project.sectionFragment && !smartDetected.project.section ? HelpCircle : Folder,
            label: smartDetected.project.sectionFragment
              ? smartDetected.project.section
                ? `Project: ${smartDetected.project.project.name} → ${smartDetected.project.section.name}`
                : `${smartDetected.project.project.name}: no section match for "${smartDetected.project.sectionFragment}"`
              : `Project: ${smartDetected.project.project.name}`,
          }
        : { type: 'project', icon: HelpCircle, label: `No project match for "${smartDetected.project.fragment}"` }),
    smartDetected.sectionShorthand &&
      (smartDetected.sectionShorthand.candidates.length > 0
        ? {
            type: 'sectionShorthand',
            icon: ListFilter,
            label: `Multiple matches for "${smartDetected.sectionShorthand.fragment}"`,
            expandable: true,
            candidates: smartDetected.sectionShorthand.candidates,
          }
        : smartDetected.sectionShorthand.section
          ? {
              type: 'sectionShorthand',
              icon: Folder,
              label: `Project: ${smartDetected.sectionShorthand.project.name} → ${smartDetected.sectionShorthand.section.name}`,
            }
          : { type: 'sectionShorthand', icon: HelpCircle, label: `No section match for "${smartDetected.sectionShorthand.fragment}"` }),
    ...(smartDetected.labels || []).map((m) => ({
      type: 'labels',
      key: `labels:${m.matchedText}`,
      icon: Tag,
      label: `#${m.name}`,
      match: m,
    })),
  ].filter(Boolean);
}

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
 * just hides that one chip) and remembers the exact typed occurrence that was
 * cancelled (see utils/dismissedSpans.js) — not the phrase text. That
 * occurrence is blanked out before parsing, so a later date typed after it
 * still gets detected, and the same word typed again elsewhere is a fresh
 * detection. The cancel lifts as soon as the user edits the cancelled text.
 */

import { useRef, useState } from 'react';
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
  Sunrise,
  CornerUpRight,
  CornerUpLeft,
  ListFilter,
  UserPlus,
} from 'lucide-react';
import { parseTaskText, stripMatchedText } from '../utils/smartParse';
import { shiftSpans, maskSpans, findLiveIndex, removeRanges } from '../utils/dismissedSpans';
import { formatDisplayDate, formatTime12h } from '../utils/dateUtils';
import { linkLabel } from '../utils/linkify';
import { PRIORITY_LABELS } from '../utils/priorityColor';
import { TIME_OF_DAY_LABELS } from '../utils/timeOfDay';
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
  'preferredTimeOfDay',
  'dependency',
  'subOf',
  'unsubtask',
  'assignTo',
  'project',
  'sectionShorthand',
];

export function useSmartTaskTitle({ tasks, projects = [], sections = [], collaborators = [], fields }) {
  const [smartDetected, setSmartDetected] = useState({});
  // Cancelled occurrences, as character ranges in the current title. A ref
  // (not state) because only the next parse reads them; nothing renders from them.
  const dismissedSpansRef = useRef([]);
  const lastTitleRef = useRef('');

  /** Copy of a detection that also records where in the title it was found. */
  function withStart(match, title) {
    const start = findLiveIndex(title, match.matchedText, dismissedSpansRef.current);
    return start === -1 ? match : { ...match, start };
  }

  function handleTitleChange(value) {
    dismissedSpansRef.current = shiftSpans(dismissedSpansRef.current, lastTitleRef.current, value);
    lastTitleRef.current = value;
    const { detected } = parseTaskText(maskSpans(value, dismissedSpansRef.current), {
      existingTasks: tasks,
      projects,
      sections,
      collaborators,
    });
    const nextVisible = {};

    SCALAR_FIELD_TYPES.forEach((type) => {
      const match = detected[type];
      const field = fields[type];
      if (!field) return;

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

      if (field.isUntouched()) {
        // Pass the full detection set so a field's apply() can see what else
        // was just detected in this same pass (e.g. recurrence checking
        // whether a due date was also detected, without relying on a sibling
        // setState having already landed — state updates aren't visible
        // within the same synchronous pass).
        field.apply(match, detected);
        nextVisible[type] = withStart(match, value);
      }
    });

    const visibleLabels = (detected.labels || []).map((m) => withStart(m, value));
    if (visibleLabels.length > 0) nextVisible.labels = visibleLabels;

    setSmartDetected(nextVisible);
  }

  /** Remember the typed occurrence behind `entry` as cancelled, so it's skipped from now on. */
  function cancelOccurrence(entry) {
    const title = lastTitleRef.current;
    const start = entry.start ?? findLiveIndex(title, entry.matchedText, dismissedSpansRef.current);
    if (start < 0) return;
    const end = start + entry.matchedText.length;
    dismissedSpansRef.current = [...dismissedSpansRef.current, { start, end, text: title.slice(start, end) }];
  }

  /** For `labels`, `match` identifies which of the several detected tags to dismiss. */
  function dismissSmartChip(type, match) {
    if (type === 'labels') {
      if (!match) return;
      cancelOccurrence(match);
      setSmartDetected((prev) => {
        const remaining = (prev.labels || []).filter((m) => m.matchedText !== match.matchedText || m.start !== match.start);
        const next = { ...prev };
        if (remaining.length > 0) next.labels = remaining;
        else delete next.labels;
        return next;
      });
      return;
    }

    const entry = smartDetected[type];
    if (!entry) return;
    cancelOccurrence(entry);
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
    const entries = [...SCALAR_FIELD_TYPES.map((type) => smartDetected[type]).filter(Boolean), ...(smartDetected.labels || [])];
    // Strip each phrase from the exact spot it was detected, so a cancelled
    // twin typed earlier in the title ("friday monday" with friday cancelled)
    // isn't removed instead. Entries with no recorded spot fall back to the
    // first occurrence.
    const ranges = [];
    const unplaced = [];
    entries.forEach((e) => {
      const end = e.start + e.matchedText.length;
      if (e.start != null && title.slice(e.start, end).toLowerCase() === e.matchedText.toLowerCase()) ranges.push({ start: e.start, end });
      else unplaced.push(e);
    });
    let result = ranges.length ? removeRanges(title, ranges) : title;
    unplaced.forEach((e) => {
      result = stripMatchedText(result, e.matchedText);
    });
    return result.trim() || fallback || title.trim();
  }

  function resetSmartState() {
    setSmartDetected({});
    dismissedSpansRef.current = [];
    lastTitleRef.current = '';
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
    smartDetected.preferredTimeOfDay && {
      type: 'preferredTimeOfDay',
      icon: Sunrise,
      label: `Prefers ${TIME_OF_DAY_LABELS[smartDetected.preferredTimeOfDay.period]?.toLowerCase() || smartDetected.preferredTimeOfDay.period}`,
    },
    smartDetected.dependency &&
      (smartDetected.dependency.task
        ? { type: 'dependency', icon: Link2, label: `After: ${smartDetected.dependency.task.title}` }
        : { type: 'dependency', icon: HelpCircle, label: `No match for "${smartDetected.dependency.fragment}"` }),
    smartDetected.subOf &&
      (smartDetected.subOf.task
        ? { type: 'subOf', icon: CornerUpRight, label: `Sub-task of: ${smartDetected.subOf.task.title}` }
        : { type: 'subOf', icon: HelpCircle, label: `No match for "${smartDetected.subOf.fragment}"` }),
    smartDetected.unsubtask && { type: 'unsubtask', icon: CornerUpLeft, label: 'Remove from parent task' },
    smartDetected.assignTo &&
      (smartDetected.assignTo.collaborator
        ? { type: 'assignTo', icon: UserPlus, label: `Assign to: ${smartDetected.assignTo.collaborator.displayName}` }
        : smartDetected.assignTo.placeholderName
          ? { type: 'assignTo', icon: UserPlus, label: `Assign to: ${smartDetected.assignTo.placeholderName} (placeholder)` }
          : { type: 'assignTo', icon: HelpCircle, label: `No match for "${smartDetected.assignTo.fragment}"` }),
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

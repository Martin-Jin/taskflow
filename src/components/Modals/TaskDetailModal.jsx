/**
 * TaskDetailModal — the "task page" edit surface, laid out Todoist-style: a
 * title header, a free-text main column (description + sub-tasks), and a
 * compact metadata sidebar (Project, Date, Priority, Labels, ...). Lets the
 * user edit every tracked property of a Task plus manage its subtasks (add
 * / rename / check off / remove / open) — each sub-task is a real,
 * independently-editable item (SubtaskDetailModal), though — per the
 * Subtask typedef — it's still never split out into its own schedulable
 * Task; editing one here has no effect on the scheduling engine.
 *
 * Every field here that has a Todoist equivalent is pushed back to Todoist
 * immediately on Save (for the task itself) or immediately on each action
 * (for subtasks, which sync one at a time as you add/check/remove them) —
 * see SchedulerContext for the sync logic. Fields with no Todoist
 * equivalent (lock state, min/max chunk hours, Labels) stay app-only.
 *
 * SMART PARSE: typing "#project" or "@tag" into the title is picked up the
 * same way as the existing due-date/priority/dependency shorthands (see
 * utils/smartParse.js) — "#project" fuzzy-matches an existing Project the
 * same way "after <task>" matches a dependency; "@tag" always succeeds,
 * creating a new Label on Save if no matching one exists yet (see
 * SchedulerContext.getOrCreateLabelIds). Label resolution is deliberately
 * deferred to Save rather than happening as each keystroke is detected —
 * unlike the other fields (all local, uncommitted state), creating a Label
 * touches shared app state, and doing that on every keystroke would leave
 * stray labels behind if the user typed "@foo" and then cancelled.
 *
 * RECURRENCE: editable here as an "every N <interval>" pair (count + unit),
 * covering day/week/month/year. On Save this is written to
 * `recurrenceString` as a normalized "every N <unit>(s)" string (what
 * utils/recurrence.js's parser reads back most reliably) and, for
 * Todoist-sourced tasks with sync active, pushed to Todoist via its
 * natural-language `due_string` field so Todoist's own recurrence engine
 * picks it up too.
 *
 * LIVE UPDATES: this modal always renders from the live `task` object
 * passed down by its parent (which derives it from context on every
 * render), not a component-local snapshot frozen at open time — see the
 * parent components (TaskListPanel / BoardView) for how `editingTask` is
 * kept fresh. Local form field state (title/notes/etc. being typed) is
 * separate and only resets when the task identity changes, so in-progress
 * edits aren't clobbered by unrelated background updates (e.g. a subtask
 * toggle) while still reflecting those updates immediately elsewhere in
 * the modal (subtask checklist, subtask counts, etc.).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Repeat,
  Ban,
  Wind,
  X,
  Lock,
  Unlock,
  CalendarClock,
  CalendarCheck,
  Flag,
  Link2,
  HelpCircle,
  CalendarX2,
  Folder,
  Layers,
  Tag,
  Clock,
  Plus,
  Check,
  AlignLeft,
  MoreHorizontal,
  Trash2,
  Link as LinkIcon,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { parseDurationHours, formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { linkLabel } from '../../utils/linkify';
import { parseRecurrenceRule, RECURRENCE_UNITS, buildRecurrenceString } from '../../utils/recurrence';
import { getIneligibleDependencyIds } from '../../utils/dependencyUtils';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { formatHours } from '../../utils/formatHours';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useSmartTaskTitle } from '../../hooks/useSmartTaskTitle';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useIsMobile } from '../../hooks/useIsMobile';
import DependencyPicker from '../Common/DependencyPicker';
import LabelPicker from '../Common/LabelPicker';
import DetailField from '../Common/DetailField';
import Linkified from '../Common/Linkified';
import SmartChips from '../Common/SmartChips';
import SmartTitleInput from '../Common/SmartTitleInput';
import SubtaskDetailModal from './SubtaskDetailModal';

export default function TaskDetailModal({ task, onClose }) {
  const {
    tasks,
    updateTask,
    deleteTask,
    toggleTaskLock,
    sections,
    projects,
    labels,
    getOrCreateLabelIds,
    addSubtask,
    toggleSubtask,
    removeSubtask,
    completeTask,
  } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState(task.title);
  const [link, setLink] = useState(task.link || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [estimatedHours, setEstimatedHours] = useState(task.estimatedHours);
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || '');
  const [isRecurring, setIsRecurring] = useState(!!task.isRecurring);
  const initialRule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
  const [recurrenceCount, setRecurrenceCount] = useState(initialRule.count);
  const [recurrenceUnit, setRecurrenceUnit] = useState(initialRule.unit);
  const [projectId, setProjectId] = useState(task.projectId || '');
  const [sectionId, setSectionId] = useState(task.sectionId || '');
  // Separate from the projectId/sectionId untouched-comparisons below: a
  // "#Project/Section" smart-parse match shouldn't clobber a section the
  // user has since picked manually from the dropdown, even while the
  // project itself is still smart-parse-driven.
  const [hasEditedSection, setHasEditedSection] = useState(false);
  const [dependsOn, setDependsOn] = useState(task.dependsOn || []);
  const [isPassive, setIsPassive] = useState(!!task.isPassive);
  const [earliestDate, setEarliestDate] = useState(task.earliestDate || '');
  const [enforceDueDate, setEnforceDueDate] = useState(!!task.enforceDueDate);
  const [labelIds, setLabelIds] = useState(task.labelIds || []);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [hideCompletedSubtasks, setHideCompletedSubtasks] = useState(false);
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const notesRef = useRef(null);
  useAutosizeTextarea(notesRef, notes);

  // On mobile this menu always opens as a centered popup rather than
  // attempting to anchor to the trigger — a corner-anchored menu this wide
  // (280px, the same width as most of a phone's own viewport) rarely has
  // room to sit flush under a topbar icon without clipping. Desktop keeps
  // the anchored dropdown, still measured/portaled the same way so
  // useMenuPosition's overflow check covers it too.
  const isMobile = useIsMobile();
  const menuTriggerRef = useRef(null);
  const {
    menuRef,
    mode: menuMode,
    style: menuStyle,
  } = useMenuPosition({
    isOpen: menuOpen,
    anchorRef: menuTriggerRef,
    onClose: () => setMenuOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  // Snapshot of the task's saved values, refreshed whenever a *different*
  // task is opened (mirrors the reset-on-task.id effect below) — compared
  // against current form state to decide whether the inline Save/Cancel row
  // (rendered right under the description, Todoist-style, instead of a
  // permanent footer) should show at all.
  const initialSnapshotRef = useRef(null);
  if (!initialSnapshotRef.current) {
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: task.notes || '',
      estimatedHours: task.estimatedHours,
      priority: task.priority,
      dueDate: task.dueDate || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: initialRule.count,
      recurrenceUnit: initialRule.unit,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      isPassive: !!task.isPassive,
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      labelIds: task.labelIds || [],
    };
  }

  // Tasks that can't be picked as a dependency of this one: itself, and any
  // task that (directly or transitively) already depends on it — either
  // would create a cycle the scheduler could never resolve.
  const ineligibleDependencyIds = useMemo(() => getIneligibleDependencyIds(task.id, tasks), [task.id, tasks]);
  const dependencyOptions = tasks.filter((t) => !ineligibleDependencyIds.has(t.id) && !t.isCompleted);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const incompleteDependencies = (task.dependsOn || [])
    .map((depId) => taskById.get(depId))
    .filter((dep) => dep && !dep.isCompleted);

  // Reset local form state whenever a *different* task is opened (not on
  // every re-render, or in-progress typing would get clobbered by
  // unrelated background updates to the same task).
  useEffect(() => {
    setTitle(task.title);
    setLink(task.link || '');
    setNotes(task.notes || '');
    setEstimatedHours(task.estimatedHours);
    setPriority(task.priority);
    setDueDate(task.dueDate || '');
    setIsRecurring(!!task.isRecurring);
    const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
    setRecurrenceCount(rule.count);
    setRecurrenceUnit(rule.unit);
    setProjectId(task.projectId || '');
    setSectionId(task.sectionId || '');
    setHasEditedSection(false);
    setDependsOn(task.dependsOn || []);
    setIsPassive(!!task.isPassive);
    setEarliestDate(task.earliestDate || '');
    setEnforceDueDate(!!task.enforceDueDate);
    setLabelIds(task.labelIds || []);
    resetSmartState();
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: task.notes || '',
      estimatedHours: task.estimatedHours,
      priority: task.priority,
      dueDate: task.dueDate || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: rule.count,
      recurrenceUnit: rule.unit,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      isPassive: !!task.isPassive,
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      labelIds: task.labelIds || [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const subtasks = task.subtasks || [];
  const visibleSubtasks = hideCompletedSubtasks ? subtasks.filter((s) => !s.isCompleted) : subtasks;
  const completedSubtasks = subtasks.filter((s) => s.isCompleted).length;

  // Sections belong to a project — once a project is chosen, only show
  // that project's sections (matching Todoist's own board picker).
  const availableSections = sections.filter((s) => !projectId || s.projectId === projectId);

  function handleProjectChange(newProjectId) {
    setProjectId(newProjectId);
    // Changing project invalidates any section from the old project.
    if (sectionId && !sections.find((s) => s.id === sectionId && s.projectId === newProjectId)) {
      setSectionId('');
    }
  }

  // Smart-parse: a field only counts as "safe to auto-fill" while it still
  // matches the value the task loaded with — the moment the user directly
  // touches that field's own widget it stops being "untouched" and smart
  // parse leaves it alone (same idea as handleNotesBlur's hours check below).
  const { smartDetected, handleTitleChange: handleSmartTitleChange, dismissSmartChip, buildFinalTitle, resetSmartState } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
    fields: {
      link: {
        isUntouched: () => link === (task.link || ''),
        apply: (match) => setLink(match.url),
        revert: () => setLink(task.link || ''),
      },
      dueDate: {
        isUntouched: () => dueDate === (task.dueDate || ''),
        apply: (match) => setDueDate(match.iso),
        revert: () => setDueDate(task.dueDate || ''),
      },
      recurrence: {
        isUntouched: () => isRecurring === !!task.isRecurring,
        apply: (match, detected) => {
          setIsRecurring(true);
          setRecurrenceCount(match.rule.count);
          setRecurrenceUnit(match.rule.unit);
          if (!dueDate && !detected.dueDate) setDueDate(toISODate(new Date()));
        },
        revert: () => setIsRecurring(!!task.isRecurring),
      },
      priority: {
        isUntouched: () => priority === task.priority,
        apply: (match) => setPriority(match.level),
        revert: () => setPriority(task.priority),
      },
      estimatedHours: {
        isUntouched: () => Number(estimatedHours) === Number(task.estimatedHours),
        apply: (match) => setEstimatedHours(match.hours),
        revert: () => setEstimatedHours(task.estimatedHours),
      },
      unattended: {
        isUntouched: () => isPassive === !!task.isPassive,
        apply: () => setIsPassive(true),
        revert: () => setIsPassive(!!task.isPassive),
      },
      dependency: {
        isUntouched: () =>
          dependsOn.length === (task.dependsOn || []).length && dependsOn.every((id) => (task.dependsOn || []).includes(id)),
        apply: (match) => {
          if (match.task) setDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
        },
        revert: (entry) => {
          if (entry.task) setDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
        },
      },
      project: {
        isUntouched: () => projectId === (task.projectId || ''),
        apply: (match) => {
          if (match.project) handleProjectChange(match.project.id);
          if (match.section && !hasEditedSection) setSectionId(match.section.id);
        },
        revert: () => {
          handleProjectChange(task.projectId || '');
          if (!hasEditedSection) setSectionId(task.sectionId || '');
        },
      },
    },
  });

  function handleTitleChange(value) {
    setTitle(value);
    handleSmartTitleChange(value);
  }

  const smartChips = [
    smartDetected.link && { type: 'link', icon: LinkIcon, label: linkLabel(smartDetected.link.url) },
    smartDetected.dueDate && { type: 'dueDate', icon: CalendarClock, label: `Due ${formatDisplayDate(smartDetected.dueDate.iso)}` },
    smartDetected.recurrence && { type: 'recurrence', icon: Repeat, label: `Repeats ${smartDetected.recurrence.recurrenceString}` },
    smartDetected.priority && { type: 'priority', icon: Flag, label: `${PRIORITY_LABELS[smartDetected.priority.level]} priority` },
    smartDetected.estimatedHours && { type: 'estimatedHours', icon: Clock, label: `Est. ${formatHours(smartDetected.estimatedHours.hours)}` },
    smartDetected.unattended && { type: 'unattended', icon: Wind, label: 'Can run unattended' },
    smartDetected.dependency &&
      (smartDetected.dependency.task
        ? { type: 'dependency', icon: Link2, label: `After: ${smartDetected.dependency.task.title}` }
        : { type: 'dependency', icon: HelpCircle, label: `No match for "${smartDetected.dependency.fragment}"` }),
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
    ...(smartDetected.labels || []).map((m) => ({
      type: 'labels',
      key: `labels:${m.matchedText}`,
      icon: Tag,
      label: `#${m.name}`,
      match: m,
    })),
  ].filter(Boolean);

  // Drives the inline Save/Cancel row rendered under the description
  // (Todoist-style, replacing a permanent footer) — only worth showing once
  // something in the form actually differs from the last-saved snapshot.
  const isDirty =
    title !== initialSnapshotRef.current.title ||
    link !== initialSnapshotRef.current.link ||
    notes !== initialSnapshotRef.current.notes ||
    String(estimatedHours) !== String(initialSnapshotRef.current.estimatedHours) ||
    priority !== initialSnapshotRef.current.priority ||
    dueDate !== initialSnapshotRef.current.dueDate ||
    isRecurring !== initialSnapshotRef.current.isRecurring ||
    recurrenceCount !== initialSnapshotRef.current.recurrenceCount ||
    recurrenceUnit !== initialSnapshotRef.current.recurrenceUnit ||
    projectId !== initialSnapshotRef.current.projectId ||
    sectionId !== initialSnapshotRef.current.sectionId ||
    isPassive !== initialSnapshotRef.current.isPassive ||
    earliestDate !== initialSnapshotRef.current.earliestDate ||
    enforceDueDate !== initialSnapshotRef.current.enforceDueDate ||
    dependsOn.length !== initialSnapshotRef.current.dependsOn.length ||
    dependsOn.some((id) => !initialSnapshotRef.current.dependsOn.includes(id)) ||
    labelIds.length !== initialSnapshotRef.current.labelIds.length ||
    labelIds.some((id) => !initialSnapshotRef.current.labelIds.includes(id));
  // Note: a pending "@label" chip doesn't need its own isDirty clause —
  // detecting one requires the title to contain that "@tag" text, which the
  // `title !== ...` check above already catches (labels aren't stripped out
  // of `title` until buildFinalTitle runs at save time).

  function handleNotesBlur() {
    // Convenience: if the user typed a duration hint into the notes (e.g.
    // "30 minutes" or "1.5 hours") and hasn't touched the hours field
    // manually since opening, offer the parsed value.
    const parsed = parseDurationHours(notes);
    if (parsed && parsed !== estimatedHours && estimatedHours === task.estimatedHours) {
      setEstimatedHours(parsed);
    }
  }

  function handleAddSubtask() {
    if (!newSubtaskTitle.trim()) return;
    addSubtask(task.id, newSubtaskTitle);
    setNewSubtaskTitle('');
  }

  function handleCancelAddSubtask() {
    setNewSubtaskTitle('');
    setIsAddingSubtask(false);
  }

  function handleSave() {
    const section = sections.find((s) => s.id === sectionId);
    const nextDueDate = dueDate || null;
    const nextIsRecurring = isRecurring && !!nextDueDate;
    const nextRecurrenceString = isRecurring && nextDueDate ? buildRecurrenceString(recurrenceCount, recurrenceUnit) : null;

    // Resolve any still-pending "@tag" mentions to real Label ids now,
    // merging with whatever was already picked via the sidebar's LabelPicker.
    const pendingLabelNames = (smartDetected.labels || []).map((m) => m.name);
    const finalLabelIds = [...new Set([...labelIds, ...(pendingLabelNames.length ? getOrCreateLabelIds(pendingLabelNames) : [])])];

    const nextEstimatedHours = Number(estimatedHours) || task.estimatedHours;
    // Shift remainingHours by however much the estimate changed, rather than
    // just clamping down — otherwise raising the estimate on an
    // already-fully-scheduled task (remainingHours: 0) would never add any
    // new hours for the scheduler to place.
    const nextRemainingHours = Math.min(
      nextEstimatedHours,
      Math.max(0, task.remainingHours + (nextEstimatedHours - task.estimatedHours))
    );

    updateTask(task.id, {
      // If the title was nothing but a smart-parsed link, stripping it
      // leaves an empty string — fall back to the link's hostname rather
      // than a blank/raw-URL title.
      title: buildFinalTitle(title, link ? linkLabel(link) : task.title),
      link: link || null,
      notes,
      estimatedHours: nextEstimatedHours,
      remainingHours: nextRemainingHours,
      priority,
      dueDate: nextDueDate,
      isRecurring: nextIsRecurring,
      recurrenceString: nextRecurrenceString,
      projectId: projectId || null,
      sectionId: sectionId || null,
      sectionName: section ? section.name : null,
      dependsOn,
      isPassive,
      earliestDate: earliestDate || null,
      // Only meaningful once a due date exists — clear it rather than
      // persisting a flag that has nothing to enforce.
      enforceDueDate: enforceDueDate && !!nextDueDate,
      labelIds: finalLabelIds,
    });
    requestClose();
  }

  function handleCancel() {
    const snap = initialSnapshotRef.current;
    setTitle(snap.title);
    setLink(snap.link);
    setNotes(snap.notes);
    setEstimatedHours(snap.estimatedHours);
    setPriority(snap.priority);
    setDueDate(snap.dueDate);
    setIsRecurring(snap.isRecurring);
    setRecurrenceCount(snap.recurrenceCount);
    setRecurrenceUnit(snap.recurrenceUnit);
    setProjectId(snap.projectId);
    setSectionId(snap.sectionId);
    setHasEditedSection(false);
    setDependsOn(snap.dependsOn);
    setIsPassive(snap.isPassive);
    setEarliestDate(snap.earliestDate);
    setEnforceDueDate(snap.enforceDueDate);
    setLabelIds(snap.labelIds);
    resetSmartState();
  }

  function handleDelete() {
    deleteTask(task.id);
    requestClose();
  }

  return (
    <>
      <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
        <div
          className="modal modal-detail"
          onClick={(e) => e.stopPropagation()}
          style={{ width: 760 }}
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Task details"
          tabIndex={-1}
        >
          <div className="detail-topbar">
            <div className="detail-menu">
              <button
                type="button"
                ref={menuTriggerRef}
                className="btn btn-icon menu-trigger"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen &&
                createPortal(
                  <>
                    {menuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setMenuOpen(false)} />}
                    <ul
                      ref={menuRef}
                      className={`detail-menu-dropdown ${menuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      role="menu"
                      style={menuMode === 'anchored' ? menuStyle : undefined}
                    >
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item"
                          onClick={() => {
                            toggleTaskLock(task.id);
                            setMenuOpen(false);
                          }}
                        >
                          {task.isLocked ? <Unlock size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
                          {task.isLocked ? 'Unlock' : 'Lock'}
                        </button>
                      </li>
                      <li role="none">
                        <button type="button" role="menuitem" className="detail-menu-item detail-menu-item-danger" onClick={handleDelete}>
                          <Trash2 size={14} aria-hidden="true" />
                          Delete
                        </button>
                      </li>

                      <li role="none" className="detail-menu-divider" />

                      {dependencyOptions.length > 0 && (
                        <li role="none">
                          <DetailField icon={Link2} label="Depends on">
                            <DependencyPicker options={dependencyOptions} selectedIds={dependsOn} onChange={setDependsOn} />
                          </DetailField>
                        </li>
                      )}

                      <li role="none">
                        <DetailField icon={CalendarX2} label="Lock to a day">
                          <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={!!earliestDate}
                              onChange={(e) => setEarliestDate(e.target.checked ? toISODate(new Date()) : '')}
                            />
                            {earliestDate ? formatDisplayDate(earliestDate) : 'Not locked'}
                          </label>
                          {earliestDate && (
                            <>
                              <input
                                type="date"
                                value={earliestDate}
                                onChange={(e) => setEarliestDate(e.target.value)}
                                style={{ marginTop: 6 }}
                              />
                              <p className="form-hint">The scheduler won't place blocks before this date, overriding its usual pacing.</p>
                            </>
                          )}
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={CalendarCheck} label="Enforce due date">
                          <label className="form-checkbox-row" style={{ cursor: dueDate ? 'pointer' : 'not-allowed' }}>
                            <input
                              type="checkbox"
                              checked={enforceDueDate}
                              disabled={!dueDate}
                              onChange={(e) => setEnforceDueDate(e.target.checked)}
                            />
                            Must be done on due date
                          </label>
                          <p className="form-hint">
                            {dueDate
                              ? "Task won't be scheduled earlier — all remaining work is forced onto the due date."
                              : 'Set a due date first to enable this.'}
                          </p>
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={Wind} label="Unattended">
                          <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                            <input type="checkbox" checked={isPassive} onChange={(e) => setIsPassive(e.target.checked)} />
                            Can run unattended
                          </label>
                          <p className="form-hint">e.g. laundry — can overlap other scheduled work.</p>
                        </DetailField>
                      </li>
                    </ul>
                  </>,
                  document.body
                )}
            </div>
            <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="detail-body">
            <div className="detail-main">
              <div className="detail-editbox">
                <div className="detail-title-row">
                  <button
                    className={`task-checkbox ${task.priority} ${task.isCompleted ? 'checked' : ''}`}
                    onClick={() => {
                      if (!task.isCompleted) completeTask(task.id);
                    }}
                    disabled={task.isCompleted}
                    title={task.isCompleted ? 'Completed' : task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
                    aria-label={task.isCompleted ? `${task.title} completed` : `Mark ${task.title} complete`}
                    style={{ marginTop: 6 }}
                  >
                    {task.isCompleted && <Check size={12} aria-hidden="true" />}
                  </button>
                  <div className="detail-title-wrap">
                    <SmartTitleInput
                      value={title}
                      onChange={handleTitleChange}
                      smartDetected={smartDetected}
                      onDismiss={dismissSmartChip}
                      projects={projects}
                      sections={sections}
                      labels={labels}
                    />
                  </div>
                </div>

                <SmartChips chips={smartChips} onDismiss={dismissSmartChip} />

                {link && (
                  <div className="detail-link-badge">
                    <a href={link} target="_blank" rel="noopener noreferrer" className="detail-link-badge-open">
                      <LinkIcon size={12} aria-hidden="true" />
                      {linkLabel(link)}
                    </a>
                    <button
                      type="button"
                      className="detail-link-badge-remove"
                      onClick={() => setLink('')}
                      aria-label="Remove link"
                      title="Remove link"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                <div className="detail-notes-row">
                  <AlignLeft size={14} className="detail-notes-icon" aria-hidden="true" />
                  <div className="detail-notes-col">
                    <label htmlFor="task-detail-notes" className="sr-only">
                      Description
                    </label>
                    <textarea
                      id="task-detail-notes"
                      className="detail-notes-textarea"
                      ref={notesRef}
                      rows={1}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      onBlur={handleNotesBlur}
                      placeholder="Description"
                    />
                    <Linkified text={notes} className="notes-link-preview" />
                  </div>
                </div>
              </div>

              {isDirty && (
                <div className="detail-save-row">
                  <button type="button" className="btn" onClick={handleCancel}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleSave}>
                    Save
                  </button>
                </div>
              )}

              {incompleteDependencies.length > 0 && (
                <p className="form-warning">
                  <Ban size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                  <span>
                    Waiting on: {incompleteDependencies.map((d) => d.title).join(', ')} — won't be auto-scheduled until{' '}
                    {incompleteDependencies.length === 1 ? 'it is' : 'they are'} marked complete.
                  </span>
                </p>
              )}

              <div className="form-row">
                <div className="subtask-header">
                  <label>Sub-tasks {subtasks.length > 0 ? `(${completedSubtasks}/${subtasks.length})` : ''}</label>
                  {completedSubtasks > 0 && (
                    <button type="button" className="subtask-hide-completed" onClick={() => setHideCompletedSubtasks((v) => !v)}>
                      {hideCompletedSubtasks ? 'Show completed' : 'Hide completed'}
                    </button>
                  )}
                </div>
                <div className="subtask-list">
                  {visibleSubtasks.map((s) => (
                    <div key={s.id} className="subtask-row">
                      <input
                        type="checkbox"
                        checked={s.isCompleted}
                        onChange={() => toggleSubtask(task.id, s.id)}
                      />
                      <button
                        type="button"
                        className={`subtask-row-title ${s.isCompleted ? 'completed' : ''}`}
                        onClick={() => setEditingSubtask(s)}
                        title="Open sub-task"
                      >
                        {s.title}
                      </button>
                      <button
                        className="btn btn-icon subtask-row-remove"
                        onClick={() => removeSubtask(task.id, s.id)}
                        style={{ color: 'var(--color-danger)' }}
                        aria-label={`Delete ${s.title}`}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  {isAddingSubtask ? (
                    <div className="subtask-add-row">
                      <input
                        autoFocus
                        value={newSubtaskTitle}
                        onChange={(e) => setNewSubtaskTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddSubtask();
                          } else if (e.key === 'Escape') {
                            handleCancelAddSubtask();
                          }
                        }}
                        onBlur={() => {
                          if (!newSubtaskTitle.trim()) setIsAddingSubtask(false);
                        }}
                        placeholder="Add a sub-task…"
                        style={{ flex: 1 }}
                      />
                      <button type="button" className="btn" onClick={handleAddSubtask}>
                        <Plus size={14} />
                        Add
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="subtask-add-trigger" onClick={() => setIsAddingSubtask(true)}>
                      <Plus size={14} />
                      Add sub-task
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="detail-sidebar">
              <DetailField icon={Folder} label="Project">
                <select value={projectId} onChange={(e) => handleProjectChange(e.target.value)}>
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </DetailField>

              <DetailField icon={Layers} label="Section">
                <select
                  value={sectionId}
                  onChange={(e) => {
                    setSectionId(e.target.value);
                    setHasEditedSection(true);
                  }}
                >
                  <option value="">No section</option>
                  {availableSections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </DetailField>

              <DetailField icon={CalendarClock} label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                {!dueDate && <p className="form-hint">Won't be auto-scheduled without a due date.</p>}
              </DetailField>

              <DetailField icon={Flag} label="Priority">
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </DetailField>

              <DetailField icon={Tag} label="Labels">
                <LabelPicker
                  labels={labels}
                  selectedIds={labelIds}
                  onChange={setLabelIds}
                  onCreateLabel={(name) => getOrCreateLabelIds([name])[0]}
                />
                {(smartDetected.labels || []).length > 0 && (
                  <p className="form-hint">Pending from the title: {smartDetected.labels.map((m) => `#${m.name}`).join(', ')}</p>
                )}
              </DetailField>

              <DetailField icon={Clock} label="Estimated hours">
                <input type="number" min="0.0833" step="0.0833" value={estimatedHours} onChange={(e) => setEstimatedHours(e.target.value)} />
              </DetailField>

              <DetailField icon={Repeat} label="Repeat">
                {isRecurring ? (
                  <div className="detail-recurrence-toggle detail-recurrence-toggle-active">
                    {`Every ${recurrenceCount} ${recurrenceUnit}${recurrenceCount === 1 ? '' : 's'}`}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="detail-recurrence-toggle"
                    disabled={!dueDate}
                    onClick={() => setIsRecurring(true)}
                  >
                    Does not repeat
                  </button>
                )}
                {isRecurring && (
                  <div className="detail-field-inline" style={{ marginTop: 6 }}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={recurrenceCount}
                      onChange={(e) => setRecurrenceCount(Math.max(1, Number(e.target.value) || 1))}
                      style={{ width: 56 }}
                    />
                    <select value={recurrenceUnit} onChange={(e) => setRecurrenceUnit(e.target.value)} style={{ flex: 1 }}>
                      {RECURRENCE_UNITS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-icon detail-recurrence-clear"
                      onClick={() => setIsRecurring(false)}
                      aria-label="Turn off repeat"
                      title="Does not repeat"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {isRecurring && (
                  <p className="form-hint">Marking this complete advances the due date instead of moving it to Completed.</p>
                )}
                {!dueDate && <p className="form-hint">Needs a due date first.</p>}
              </DetailField>

            </div>
          </div>
        </div>
      </div>

      {editingSubtask && <SubtaskDetailModal taskId={task.id} subtask={editingSubtask} onClose={() => setEditingSubtask(null)} />}
    </>
  );
}

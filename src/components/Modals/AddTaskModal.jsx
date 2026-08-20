/**
 * AddTaskModal — creates a new task, laid out to match TaskDetailModal's
 * Todoist-style structure (title header, free-text main column, metadata
 * sidebar) minus the fields that only make sense once a task exists
 * (sub-tasks, lock state). Always local-only — Todoist tasks only ever
 * enter TaskFlow via the one-time import in Settings, never created here.
 *
 * A due date is OPTIONAL. Undated tasks still show up in the Tasks list
 * and Board view (matching Todoist, where an undated task is completely
 * normal) — they just have no planning window for the allocator to use,
 * so Re-balance schedule will never place them on the calendar. We surface
 * that as an inline hint rather than blocking submission.
 *
 * DEFAULT DURATION: 5 minutes (matches the same short default used for
 * Todoist-imported tasks with no duration hint — see
 * todoistService.DEFAULT_DURATION_HOURS) rather than a full hour, so an
 * un-estimated task doesn't eat an oversized, likely-wrong chunk of
 * calendar capacity. The user can lengthen it right here before saving, or
 * later from the task detail modal.
 *
 * SMART PARSE: covers a plain URL (becomes the task's `link` field), due
 * date, estimated hours, "unattended", "!noauto" (exclude from auto-
 * schedule), recurrence, dependency ("after X"), priority ("p1"-"p4"),
 * plus "#project" and "@tag".
 * Every field but priority/project/labels reads plain English — no leading
 * symbol needed. Priority stays p1-p4 only (deliberately not inferred from
 * bare words like "high"/"low" — too easy to mistake an unrelated word in
 * the title for a priority mention and silently mangle it).
 * See utils/smartParse.js for how each is detected and, for labels,
 * resolved to a real Label id only on submit.
 *
 * RECURRENCE: editable as an "every N <interval>" pair, same UI as
 * TaskDetailModal — see that component's doc comment for why a count+unit
 * pair (rather than a fixed dropdown) is needed for the recurrence engine
 * to reliably parse it back later.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  Repeat,
  Wind,
  CalendarClock,
  CalendarCheck,
  CalendarX2,
  Flag,
  Link2,
  Lock,
  Folder,
  Layers,
  Tag,
  Clock,
  MoreHorizontal,
  Ban,
  X,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import { parseDurationHours, formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { linkLabel } from '../../utils/linkify';
import { RECURRENCE_UNITS, buildRecurrenceString, WEEKDAY_LABELS, MAX_RECURRENCE_COUNT } from '../../utils/recurrence';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { computeEffectiveRole, getAssignableCollaborators, resolveOwnerProfile } from '../../utils/sharedProjectAccess';
import { NO_SCHEDULE_PROJECT_ID, NO_SCHEDULE_PROJECT_LABEL } from '../../utils/projectConstants';
import { isAtMaxSubtaskDepth } from '../../utils/taskHierarchy';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useSmartTaskTitle, buildSmartChips } from '../../hooks/useSmartTaskTitle';
import DependencyPicker from '../Common/DependencyPicker';
import HelpTooltip from '../Common/HelpTooltip';
import LabelPicker from '../Common/LabelPicker';
import DetailField from '../Common/DetailField';
import SelectMenu from '../Common/SelectMenu';
import SmartChips from '../Common/SmartChips';
import SmartTitleInput from '../Common/SmartTitleInput';
import SmartDurationInput from '../Common/SmartDurationInput';
import SmartParseGuideModal from './SmartParseGuideModal';

const DEFAULT_ESTIMATED_HOURS = 5 / 60; // 5 minutes

export default function AddTaskModal({ onClose, initialProjectId = '', initialSectionId = '' }) {
  const { addTask, tasks, sections, projects, sharedProjects, labels, getOrCreateLabelIds } = useScheduler();
  const { user } = useAuth();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState('');
  const [link, setLink] = useState('');
  const [notes, setNotes] = useState('');
  const notesRef = useRef(null);
  useAutosizeTextarea(notesRef, notes, { maxLines: 3 });
  const [estimatedHours, setEstimatedHours] = useState(DEFAULT_ESTIMATED_HOURS);
  const [hasEditedHours, setHasEditedHours] = useState(false);
  const [priority, setPriority] = useState('medium');
  const [hasEditedPriority, setHasEditedPriority] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [hasEditedDueDate, setHasEditedDueDate] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [hasEditedRecurrence, setHasEditedRecurrence] = useState(false);
  const [recurrenceCount, setRecurrenceCount] = useState(1);
  const [recurrenceUnit, setRecurrenceUnit] = useState('month');
  const [recurrenceDays, setRecurrenceDays] = useState(null);
  const [projectId, setProjectId] = useState(initialProjectId || '');
  // Pre-filled from the view the modal was opened from (e.g. a project's task
  // list, a board column) — that's a default, not a user edit, so it must not
  // block smart-parse from overriding it when the title mentions "#project".
  const [hasEditedProject, setHasEditedProject] = useState(false);
  const [sectionId, setSectionId] = useState(initialSectionId || '');
  const [hasEditedSection, setHasEditedSection] = useState(false);
  const [dependsOn, setDependsOn] = useState([]);
  const [hasEditedDependencies, setHasEditedDependencies] = useState(false);
  // Draft parent id from a smart-parsed "sub of <task>"/"subtask of <task>"
  // title mention — there's no widget to edit this directly (a brand-new
  // task has no "move to" picker of its own), so null just means "not set"
  // rather than needing a separate hasEdited flag like the fields above.
  const [parentTaskId, setParentTaskId] = useState(null);
  // Draft assignee from a smart-parsed "assign to <name>"/"for <name>" title
  // mention (see the collaborators-gated `assignTo` field below) — like
  // parentTaskId above, there's no manual widget for this in AddTaskModal, so
  // null just means "not set" rather than needing a separate hasEdited flag.
  const [assignedTo, setAssignedTo] = useState(null);
  const [isPassive, setIsPassive] = useState(false);
  const [hasEditedPassive, setHasEditedPassive] = useState(false);
  const [enforceDueDate, setEnforceDueDate] = useState(false);
  const [hasEditedEnforceDueDate, setHasEditedEnforceDueDate] = useState(false);
  const [excludeFromAutoSchedule, setExcludeFromAutoSchedule] = useState(false);
  const [hasEditedExcludeFromAutoSchedule, setHasEditedExcludeFromAutoSchedule] = useState(false);
  const [fixedTime, setFixedTime] = useState('');
  // "Fixed time" has no value to speak of while the checkbox is checked but
  // no time has been picked yet — fixedTimeEnabled tracks the checkbox
  // itself (separate from the "HH:MM" value) so that state is distinguishable
  // from "not fixed at all", and hasEditedFixedTime is a dedicated
  // manual-edit flag (unlike the other fields above, `fixedTime` alone can't
  // serve as its own "untouched" signal: a smart-parse-applied time is a
  // non-empty value too, so re-detecting a *different* time phrase later in
  // the same title would otherwise never be able to overwrite it).
  const [fixedTimeEnabled, setFixedTimeEnabled] = useState(false);
  const [hasEditedFixedTime, setHasEditedFixedTime] = useState(false);
  const [earliestDate, setEarliestDate] = useState('');
  const [hasEditedEarliestDate, setHasEditedEarliestDate] = useState(false);
  const [labelIds, setLabelIds] = useState([]);
  const [error, setError] = useState('');
  // Set the first time the user types into the title, and never cleared —
  // gates the "missing info" hint below so it doesn't show on a fresh,
  // untouched modal (only once the user has actually started filling it in,
  // even if they later clear the title back to empty).
  const [hasTypedTitle, setHasTypedTitle] = useState(false);
  const [openField, setOpenField] = useState(null); // 'date' | 'priority' | 'labels' | null
  const [moreOpen, setMoreOpen] = useState(false);
  const [showSmartParseGuide, setShowSmartParseGuide] = useState(false);

  function togglePill(field) {
    setOpenField((prev) => (prev === field ? null : field));
  }

  // A brand-new task can't be part of a dependency cycle yet, so every
  // existing incomplete task is a valid choice — completed tasks are left
  // out since "depends on an already-done task" is trivially satisfied and
  // just adds noise to the picker.
  const dependencyOptions = tasks.filter((t) => !t.isCompleted);

  const availableSections = sections.filter((s) => !projectId || s.projectId === projectId);

  // A viewer-role collaborator can look at a shared project but not create
  // tasks in it — same read-only precedent as TaskDetailModal's comment
  // composer and BoardView's section editing (both gated the same way via
  // computeEffectiveRole). Rules already refuse the write server-side; this
  // keeps the UI from offering one that would just fail.
  function isViewerOnlyProject(id) {
    const project = projects.find((p) => p.id === id);
    if (!project?.sharedProjectId) return false;
    return computeEffectiveRole(sharedProjects[project.sharedProjectId], user?.uid) === 'viewer';
  }
  const isSelectedProjectViewerOnly = !!projectId && isViewerOnlyProject(projectId);

  // Collaborators to offer for a smart-parsed "assign to"/"for" mention (see
  // the `assignTo` field below) — only meaningful once the selected project
  // actually resolves to a shared one the user can create tasks in at all
  // (a viewer can't add tasks here regardless — see isSelectedProjectViewerOnly
  // above — so there's no point detecting an assignment that could never be
  // saved). `null` for the live-presence param (unlike TaskDetailModal, this
  // modal doesn't subscribe to viewersByProject) just falls through
  // resolveOwnerProfile's own fallback chain to the project doc's denormalized
  // owner name, or a generic label — never a crash.
  const selectedProject = projects.find((p) => p.id === projectId);
  const selectedSharedProject = selectedProject?.sharedProjectId ? sharedProjects[selectedProject.sharedProjectId] : null;
  const assignableCollaborators = useMemo(() => {
    if (!selectedSharedProject || isSelectedProjectViewerOnly) return [];
    const ownerProfile = resolveOwnerProfile(selectedSharedProject, null, selectedSharedProject.ownerId);
    return getAssignableCollaborators({
      ownerId: selectedSharedProject.ownerId,
      collaborators: selectedSharedProject.collaborators,
      ownerDisplayName: ownerProfile.displayName,
      ownerPhotoURL: ownerProfile.photoURL,
    });
  }, [selectedSharedProject, isSelectedProjectViewerOnly]);

  function handleProjectChange(newProjectId) {
    setProjectId(newProjectId);
    if (sectionId && !sections.find((s) => s.id === sectionId && s.projectId === newProjectId)) {
      setSectionId('');
    }
    // A previously smart-parse-detected assignment only makes sense for the
    // project it was detected against (a different/personal project's
    // collaborator list has no relation to this uid) — drop it here rather
    // than risk carrying a stale uid over to an unrelated project. There's no
    // manual "Assign to" widget in this modal to re-set it from, unlike
    // TaskDetailModal, so this is the only place it needs clearing.
    if (assignedTo) setAssignedTo(null);
  }

  const {
    smartDetected,
    handleTitleChange: handleSmartTitleChange,
    dismissSmartChip,
    applySmartChipCandidate,
    buildFinalTitle,
  } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
    collaborators: assignableCollaborators,
    fields: {
      link: {
        isUntouched: () => true,
        apply: (match) => setLink(match.url),
        revert: () => setLink(''),
      },
      dueDate: {
        isUntouched: () => !hasEditedDueDate,
        apply: (match) => setDueDate(match.iso),
        revert: () => setDueDate(''),
      },
      fixedTime: {
        isUntouched: () => !hasEditedFixedTime,
        apply: (match) => {
          setFixedTime(match.time);
          setFixedTimeEnabled(true);
        },
        revert: () => {
          setFixedTime('');
          setFixedTimeEnabled(false);
        },
      },
      recurrence: {
        isUntouched: () => !hasEditedRecurrence,
        apply: (match, detected) => {
          setIsRecurring(true);
          setRecurrenceCount(match.rule.count);
          setRecurrenceUnit(match.rule.unit);
          setRecurrenceDays(match.rule.days || null);
          // A recurring task needs a starting due date — default to today if
          // the user hasn't set (or typed) one, matching Todoist's own behavior.
          if (!dueDate && !detected.dueDate) setDueDate(toISODate(new Date()));
        },
        revert: () => {
          setIsRecurring(false);
          setRecurrenceDays(null);
        },
      },
      priority: {
        isUntouched: () => !hasEditedPriority,
        apply: (match) => setPriority(match.level),
        revert: () => setPriority('medium'),
      },
      estimatedHours: {
        isUntouched: () => !hasEditedHours,
        apply: (match) => setEstimatedHours(match.hours),
        revert: () => setEstimatedHours(DEFAULT_ESTIMATED_HOURS),
      },
      unattended: {
        isUntouched: () => !hasEditedPassive,
        apply: () => setIsPassive(true),
        revert: () => setIsPassive(false),
      },
      enforceDueDate: {
        isUntouched: () => !hasEditedEnforceDueDate,
        apply: (match, detected) => {
          setEnforceDueDate(true);
          // Same reasoning as recurrence above — "enforce due date" is inert
          // without a due date (see the `enforceDueDate: enforceDueDate &&
          // !!dueDate` guard at save time below), so a bare "on the day"
          // mention needs one too, or the flag would silently no-op on save.
          if (!dueDate && !detected.dueDate) setDueDate(toISODate(new Date()));
        },
        revert: () => setEnforceDueDate(false),
      },
      earliestDate: {
        isUntouched: () => !hasEditedEarliestDate,
        apply: (match) => setEarliestDate(match.iso),
        revert: () => setEarliestDate(''),
      },
      excludeFromAutoSchedule: {
        isUntouched: () => !hasEditedExcludeFromAutoSchedule,
        apply: () => setExcludeFromAutoSchedule(true),
        revert: () => setExcludeFromAutoSchedule(false),
      },
      dependency: {
        isUntouched: () => !hasEditedDependencies,
        apply: (match) => {
          if (match.task) setDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
        },
        revert: (entry) => {
          if (entry.task) setDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
        },
      },
      subOf: {
        isUntouched: () => parentTaskId === null,
        apply: (match) => {
          if (!match.task) return;
          // A brand-new task has no id/descendants of its own yet, so the
          // only real check needed is the matched task's own depth — it
          // can't already be a cycle, and can't already be a descendant of
          // itself (see taskHierarchy.js's getIneligibleParentIds, which a
          // pre-existing task would need instead).
          if (isAtMaxSubtaskDepth(match.task, tasks)) return;
          setParentTaskId(match.task.id);
        },
        revert: () => setParentTaskId(null),
      },
      assignTo: {
        isUntouched: () => assignedTo === null,
        apply: (match) => {
          if (match.collaborator) setAssignedTo(match.collaborator.uid);
        },
        revert: () => setAssignedTo(null),
      },
      project: {
        isUntouched: () => !hasEditedProject,
        apply: (match) => {
          if (match.project) handleProjectChange(match.project.id);
          // Guarded separately from the project's own touch-flag: a user
          // could leave the project itself smart-parse-driven while still
          // manually overriding just the section from the dropdown, and a
          // later keystroke re-running this same detection shouldn't clobber
          // that manual section choice.
          if (match.section && !hasEditedSection) setSectionId(match.section.id);
        },
        revert: () => {
          handleProjectChange('');
          if (!hasEditedSection) setSectionId('');
        },
      },
      // Standalone "%section" shorthand — same untouched guard as `project`
      // above (both write to the same projectId/sectionId state, so a
      // manual project/section choice must block either trigger equally).
      // An ambiguous match (match.candidates non-empty) is left alone here:
      // it has no single project/section to apply yet, and is instead
      // resolved later via applySmartChipCandidate once the user picks one
      // from the chip's disambiguation popover.
      sectionShorthand: {
        isUntouched: () => !hasEditedProject,
        apply: (match) => {
          if (match.section) {
            handleProjectChange(match.project.id);
            setSectionId(match.section.id);
          }
        },
        revert: () => {
          handleProjectChange('');
          if (!hasEditedSection) setSectionId('');
        },
      },
    },
  });

  function handleTitleChange(value) {
    setTitle(value);
    handleSmartTitleChange(value);
    if (!hasTypedTitle) setHasTypedTitle(true);
  }

  const smartChips = buildSmartChips(smartDetected);

  const missingFields = [];
  if (!projectId) missingFields.push('a project');
  if (!dueDate) missingFields.push('a due date');
  // hasEditedHours alone means "the user manually touched this field" (it's
  // what gates smart-parse from overwriting a deliberate edit — see
  // estimatedHours.isUntouched above) — it stays false when smart-parse
  // itself set the duration via a detected chip, which used to make this
  // hint claim "no duration" even with an "Est. Nh" chip visibly applied.
  // A duration counts as specified either way.
  if (!hasEditedHours && !smartDetected.estimatedHours) missingFields.push('a duration');

  function handleNotesBlur() {
    const parsed = parseDurationHours(notes);
    // Only auto-fill if the user hasn't manually touched the hours field —
    // otherwise a deliberate edit could get silently overwritten by a
    // duration mention picked up from the notes on blur.
    if (parsed && !hasEditedHours) {
      setEstimatedHours(parsed);
    }
  }

  function handleSubmit() {
    if (isSelectedProjectViewerOnly) return; // UI already hides/disables this path — defense in depth.
    if (!title.trim()) {
      setError('Give the task a title.');
      return;
    }
    if (isRecurring && !dueDate) {
      setError('A recurring task needs a starting due date.');
      return;
    }
    if (fixedTimeEnabled && !fixedTime) {
      setError('Pick a time, or turn off "Fixed time".');
      return;
    }

    const section = sections.find((s) => s.id === sectionId);
    const pendingLabelNames = (smartDetected.labels || []).map((m) => m.name);
    const finalLabelIds = [...new Set([...labelIds, ...(pendingLabelNames.length ? getOrCreateLabelIds(pendingLabelNames) : [])])];

    addTask({
      // If the title was nothing but a smart-parsed link, stripping it
      // leaves an empty string — fall back to the link's hostname (already
      // used for its chip label) rather than saving a blank/raw-URL title.
      title: buildFinalTitle(title, link ? linkLabel(link) : undefined),
      link: link || null,
      notes,
      estimatedHours: Number(estimatedHours) || DEFAULT_ESTIMATED_HOURS,
      priority,
      dueDate: dueDate || null,
      isRecurring: isRecurring && !!dueDate,
      recurrenceString: isRecurring && dueDate ? buildRecurrenceString(recurrenceCount, recurrenceUnit, recurrenceDays) : null,
      projectId: projectId || null,
      sectionId: sectionId || null,
      sectionName: section ? section.name : null,
      dependsOn,
      parentId: parentTaskId || null,
      isPassive,
      enforceDueDate: enforceDueDate && !!dueDate,
      excludeFromAutoSchedule,
      fixedTime: fixedTimeEnabled && fixedTime ? fixedTime : null,
      earliestDate: earliestDate || null,
      labelIds: finalLabelIds,
      // Omitted entirely (rather than set to null) unless smart-parse actually
      // detected one against THIS project's own collaborators — see
      // types/index.js's Task.assignedTo doc comment on why it stays absent
      // on a personal (non-shared) task.
      ...(assignedTo ? { assignedTo } : {}),
    });
    requestClose();
  }

  return (
    <>
      <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-detail"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560 }}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add task"
        tabIndex={-1}
      >
        <div className="detail-header">
          <div className="detail-title-wrap">
            <SmartTitleInput
              autoFocus
              value={title}
              onChange={handleTitleChange}
              smartDetected={smartDetected}
              onDismiss={dismissSmartChip}
              placeholder="Task name"
              projects={projects}
              sections={sections}
              labels={labels}
              onEnter={handleSubmit}
            />
          </div>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {error && <p className="form-error">{error}</p>}

        {hasTypedTitle && missingFields.length > 0 && (
          <p className="form-hint-warning" style={{ marginTop: -6, paddingLeft: 7 }}>
            Note: you haven't specified {missingFields.join(', ')}.
          </p>
        )}

        <button
          type="button"
          className="form-hint"
          onClick={() => setShowSmartParseGuide(true)}
          style={{
            marginTop: -6,
            marginBottom: 10,
            paddingLeft: 7,
            background: 'none',
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
          }}
        >
          Smart parse: links, due dates, "not before Friday", "at 5pm", p1–p4, duration, "unattended", "on the day", "!noauto",
          #project, @tag, "every month"
        </button>

        <SmartChips chips={smartChips} onDismiss={dismissSmartChip} onSelectCandidate={applySmartChipCandidate} />

        <div className="form-row form-row-compact-notes">
          <textarea
            ref={notesRef}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Description (optional)"
            maxLength={10000}
          />
        </div>

        <div className="addtask-pill-row">
          <button type="button" className={`addtask-pill ${dueDate ? 'is-set' : ''}`} onClick={() => togglePill('date')}>
            <CalendarClock size={13} /> {dueDate ? formatDisplayDate(dueDate) : 'Date'}
          </button>
          <button type="button" className={`addtask-pill ${priority !== 'medium' ? 'is-set' : ''}`} onClick={() => togglePill('priority')}>
            <Flag size={13} /> {PRIORITY_LABELS[priority]}
          </button>
          <button type="button" className={`addtask-pill ${labelIds.length > 0 ? 'is-set' : ''}`} onClick={() => togglePill('labels')}>
            <Tag size={13} /> {labelIds.length > 0 ? `${labelIds.length} label${labelIds.length === 1 ? '' : 's'}` : 'Labels'}
          </button>
          <button
            type="button"
            className={`addtask-pill ${
              isRecurring || isPassive || enforceDueDate || excludeFromAutoSchedule || !!earliestDate || dependsOn.length > 0
                ? 'is-set'
                : ''
            }`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-label="More options"
            title="More options"
          >
            <MoreHorizontal size={13} />
          </button>
        </div>

        {openField === 'date' && (
          <div className="addtask-pill-panel">
            <input
              type="date"
              autoFocus
              value={dueDate}
              onChange={(e) => {
                setHasEditedDueDate(true);
                setDueDate(e.target.value);
              }}
            />
            {!dueDate && <p className="form-hint">Won't be auto-scheduled without a due date.</p>}
          </div>
        )}

        {openField === 'priority' && (
          <div className="addtask-pill-panel">
            <select
              autoFocus
              value={priority}
              onChange={(e) => {
                setHasEditedPriority(true);
                setPriority(e.target.value);
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        )}

        {openField === 'labels' && (
          <div className="addtask-pill-panel">
            <LabelPicker
              labels={labels}
              selectedIds={labelIds}
              onChange={setLabelIds}
              onCreateLabel={(name) => getOrCreateLabelIds([name])[0]}
            />
            {(smartDetected.labels || []).length > 0 && (
              <p className="form-hint">Pending from the title: {smartDetected.labels.map((m) => `#${m.name}`).join(', ')}</p>
            )}
          </div>
        )}

        {moreOpen && (
          <div className="addtask-pill-panel addtask-more-panel">
            <DetailField icon={Layers} label="Section">
              <select
                value={sectionId}
                onChange={(e) => {
                  setSectionId(e.target.value);
                  setHasEditedSection(true);
                }}
                disabled={!projectId}
              >
                <option value="">No section</option>
                {availableSections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </DetailField>

            <DetailField icon={Clock} label="Estimated time">
              <SmartDurationInput
                hours={Number(estimatedHours) || 0}
                onChange={(h) => {
                  setHasEditedHours(true);
                  setEstimatedHours(h);
                }}
              />
            </DetailField>

            <DetailField icon={Repeat} label="Repeat">
              <label className="form-checkbox-row" style={{ cursor: dueDate ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={isRecurring}
                  disabled={!dueDate}
                  onChange={(e) => {
                    setHasEditedRecurrence(true);
                    setIsRecurring(e.target.checked);
                  }}
                />
                {isRecurring
                  ? recurrenceDays && recurrenceDays.length > 0
                    ? `Every ${recurrenceCount === 1 ? '' : `${recurrenceCount} `}week${recurrenceCount === 1 ? '' : 's'} on ${recurrenceDays
                        .map((d) => WEEKDAY_LABELS[d])
                        .join(', ')}`
                    : `Every ${recurrenceCount} ${recurrenceUnit}${recurrenceCount === 1 ? '' : 's'}`
                  : 'Does not repeat'}
              </label>
              {isRecurring && !(recurrenceDays && recurrenceDays.length > 0) && (
                <div className="detail-field-inline" style={{ marginTop: 6 }}>
                  <input
                    type="number"
                    min="1"
                    max={MAX_RECURRENCE_COUNT}
                    step="1"
                    value={recurrenceCount}
                    onChange={(e) => {
                      setHasEditedRecurrence(true);
                      setRecurrenceCount(Math.min(MAX_RECURRENCE_COUNT, Math.max(1, Number(e.target.value) || 1)));
                      setRecurrenceDays(null);
                    }}
                    style={{ width: 56 }}
                  />
                  <select
                    value={recurrenceUnit}
                    onChange={(e) => {
                      setHasEditedRecurrence(true);
                      setRecurrenceUnit(e.target.value);
                      setRecurrenceDays(null);
                    }}
                    style={{ flex: 1 }}
                  >
                    {RECURRENCE_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!dueDate && <p className="form-hint">Needs a due date first.</p>}
            </DetailField>

            <DetailField icon={CalendarCheck} label="Enforce due date">
              <label className="form-checkbox-row" style={{ cursor: dueDate ? 'pointer' : 'not-allowed' }}>
                <input
                  type="checkbox"
                  checked={enforceDueDate}
                  disabled={!dueDate}
                  onChange={(e) => {
                    setHasEditedEnforceDueDate(true);
                    setEnforceDueDate(e.target.checked);
                  }}
                />
                Must be done on due date
              </label>
              <p className="form-hint">
                {dueDate
                  ? "Task won't be scheduled earlier — all remaining work is forced onto the due date."
                  : 'Set a due date first to enable this.'}
              </p>
            </DetailField>

            <DetailField icon={Clock} label="Fixed time">
              <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={fixedTimeEnabled}
                  onChange={(e) => {
                    setHasEditedFixedTime(true);
                    setFixedTimeEnabled(e.target.checked);
                    if (!e.target.checked) setFixedTime('');
                  }}
                />
                {fixedTimeEnabled ? (fixedTime ? `At ${fixedTime}` : 'Pick a time') : 'Not fixed'}
              </label>
              {fixedTimeEnabled && (
                <>
                  <input
                    type="time"
                    value={fixedTime}
                    onChange={(e) => {
                      setHasEditedFixedTime(true);
                      setFixedTime(e.target.value);
                    }}
                    style={{ marginTop: 6 }}
                  />
                  <p className="form-hint">Scheduled blocks for this task will always start at this time.</p>
                </>
              )}
            </DetailField>

            {dependencyOptions.length > 0 && (
              <DetailField
                icon={Link2}
                label="Depends on"
                labelExtra={
                  <HelpTooltip label="What does this do?">
                    A blocked task can't be marked complete or auto-scheduled until every task it depends on is done
                    first.
                  </HelpTooltip>
                }
              >
                <DependencyPicker
                  options={dependencyOptions}
                  selectedIds={dependsOn}
                  onChange={(next) => {
                    setHasEditedDependencies(true);
                    setDependsOn(next);
                  }}
                />
              </DetailField>
            )}

            <DetailField icon={CalendarX2} label="Lock to a day">
              <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!earliestDate}
                  onChange={(e) => {
                    setHasEditedEarliestDate(true);
                    setEarliestDate(e.target.checked ? toISODate(new Date()) : '');
                  }}
                />
                {earliestDate ? formatDisplayDate(earliestDate) : 'Not locked'}
              </label>
              {earliestDate && (
                <>
                  <input
                    type="date"
                    value={earliestDate}
                    onChange={(e) => {
                      setHasEditedEarliestDate(true);
                      setEarliestDate(e.target.value);
                    }}
                    style={{ marginTop: 6 }}
                  />
                  <p className="form-hint">The scheduler won't place blocks before this date, overriding its usual pacing.</p>
                </>
              )}
            </DetailField>

            <DetailField icon={Wind} label="Unattended">
              <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isPassive}
                  onChange={(e) => {
                    setHasEditedPassive(true);
                    setIsPassive(e.target.checked);
                  }}
                />
                Can run unattended
              </label>
              <p className="form-hint">e.g. laundry — can overlap other scheduled work.</p>
            </DetailField>

            <DetailField icon={Ban} label="Auto-schedule">
              <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={excludeFromAutoSchedule}
                  onChange={(e) => {
                    setHasEditedExcludeFromAutoSchedule(true);
                    setExcludeFromAutoSchedule(e.target.checked);
                  }}
                />
                {excludeFromAutoSchedule ? 'Excluded from auto-schedule' : 'Included in auto-schedule'}
              </label>
              <p className="form-hint">
                {excludeFromAutoSchedule
                  ? "Re-balance schedule will skip this task — you can still drag it onto the calendar manually."
                  : 'Re-balance schedule can place and move this task like any other.'}
              </p>
            </DetailField>
          </div>
        )}

        {isSelectedProjectViewerOnly && (
          <p className="comment-viewonly-note" style={{ margin: '0 20px' }}>
            <Lock size={13} aria-hidden="true" />
            <span>Adding tasks needs edit access on this project — ask the owner for editor access.</span>
          </p>
        )}

        <div className="addtask-footer">
          <SelectMenu
            icon={Folder}
            ariaLabel="Project"
            value={projectId}
            onChange={(next) => {
              setHasEditedProject(true);
              handleProjectChange(next);
            }}
            options={[
              { value: '', label: 'Inbox' },
              ...projects
                // A viewer-role shared project is excluded here too — not just
                // disabled on submit — so it's never even offered as a place
                // to (attempt to) add a task. The current selection is left in
                // even if it's viewer-only (e.g. opened from a Board column on
                // such a project) so the dropdown doesn't silently change out
                // from under the user; the note+disabled button above/below
                // cover that case instead.
                .filter((p) => p.name.trim().toLowerCase() !== 'inbox' && (p.id === projectId || !isViewerOnlyProject(p.id)))
                .map((p) => ({ value: p.id, label: p.name })),
              // A synthetic, always-available destination (never a real Project
              // record — see projectConstants.js) — visually set apart from the
              // real project list above since it isn't one.
              { value: NO_SCHEDULE_PROJECT_ID, label: NO_SCHEDULE_PROJECT_LABEL, separatorBefore: true },
            ]}
          />

          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSelectedProjectViewerOnly}>
              Add task
            </button>
          </div>
        </div>
      </div>
    </div>
    {showSmartParseGuide && <SmartParseGuideModal onClose={() => setShowSmartParseGuide(false)} />}
    </>
  );
}

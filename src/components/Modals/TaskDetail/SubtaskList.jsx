/**
 * SubtaskList — the "Sub-tasks" section of TaskDetailModal: the list of
 * direct children with inline complete/delete/select, and the "Add
 * sub-task" inline draft form (its own smart-parse instance, blank-start
 * fields mirroring AddTaskModal's rather than TaskDetailModal's own
 * edit-mode fields). Extracted as part of the W3 restructure — see
 * TODO.md's Phase C entry.
 *
 * Self-contained the same way CommentThread is: only needs `task` (plus
 * `setActiveTaskId`, since clicking a child task swaps the PARENT modal
 * instance over to showing that child in place — genuinely parent-owned
 * state, not something this component could derive on its own) and pulls
 * everything else from its own hooks. `sharedProject`/`ownerProfile`/
 * `assignableCollaborators` are intentionally recomputed here independently
 * of the parent's own copies (used there for the unrelated "Assign to"
 * three-dot menu) — the same deliberate small duplication CommentThread
 * uses, trading a cheap recomputation for full decoupling.
 *
 * Deliberately NOT touched by this extraction: `handleApplyToAllSubtasks`/
 * `hasEditedSharedFieldsRef`/`justAppliedToAll` and the "Apply to all
 * sub-tasks" button stay in TaskDetailModal — that button lives in the
 * inline Save/Cancel row (driven by the PARENT task's own sidebar draft
 * fields), not in this section, even though it's semantically about
 * sub-tasks.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useEscapeLayer } from '../../../hooks/useEscapeLayer';
import { ExternalLink, Lock, Plus, X } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useAuth } from '../../../context/AuthContext';
import { useCompleteTask } from '../../../context/CompleteTaskContext';
import { useSound } from '../../../context/SoundContext';
import { useSmartTaskTitle, buildSmartChips } from '../../../hooks/useSmartTaskTitle';
import { useMultiSelect } from '../../../hooks/useMultiSelect';
import { useTaskBulkEditActions } from '../../../hooks/useTaskBulkEditActions';
import { toISODate } from '../../../utils/dateUtils';
import { buildRecurrenceString } from '../../../utils/recurrence';
import { isCompletedForCurrentOccurrence, isAtMaxSubtaskDepth } from '../../../utils/taskHierarchy';
import { computeEffectiveRole, resolveOwnerProfile, getAssignableCollaborators } from '../../../utils/sharedProjectAccess';
import HelpTooltip from '../../Common/HelpTooltip';
import SmartTitleInput from '../../Common/SmartTitleInput';
import SmartChips from '../../Common/SmartChips';
import BulkActionBar from '../../Common/BulkActionBar';

// Default estimated hours for a quick-added sub-task — matches
// AddTaskModal's DEFAULT_ESTIMATED_HOURS for a brand-new top-level task, so
// an un-estimated sub-task doesn't eat an oversized chunk of capacity either
// (it's schedulable immediately, due date or not — see allocator.js's
// prioritizeTasks — but keeps the two "new task" entry points consistent).
const DEFAULT_SUBTASK_ESTIMATED_HOURS = 5 / 60;

export default function SubtaskList({ task, setActiveTaskId }) {
  const { tasks, projects, sections, labels, addTask, deleteTask, uncompleteTask, getOrCreateLabelIds, sharedProjects, viewersByProject } =
    useScheduler();
  const { user } = useAuth();
  const { requestComplete } = useCompleteTask();
  const { playUncomplete } = useSound();

  const isSharedTask = !!task.sharedProjectId;
  const sharedProject = isSharedTask ? sharedProjects?.[task.sharedProjectId] : null;
  const myRole = isSharedTask ? computeEffectiveRole(sharedProject, user?.uid) : null;
  const isReadOnlyViewer = isSharedTask && myRole === 'viewer';
  const ownerProfile = sharedProject
    ? resolveOwnerProfile(sharedProject, viewersByProject?.[task.sharedProjectId], sharedProject.ownerId)
    : null;
  const assignableCollaborators = useMemo(() => {
    if (!sharedProject) return [];
    return getAssignableCollaborators({
      ownerId: sharedProject.ownerId,
      collaborators: sharedProject.collaborators,
      ownerDisplayName: ownerProfile?.displayName,
      ownerPhotoURL: ownerProfile?.photoURL,
    });
  }, [sharedProject, ownerProfile]);

  const todayIso = useMemo(() => toISODate(new Date()), []);
  const atMaxSubtaskDepth = useMemo(() => isAtMaxSubtaskDepth(task, tasks), [task, tasks]);

  // Direct children only (one level) — a grandchild is reached by opening
  // its own parent's nested TaskDetailModal in turn, not shown flattened here.
  const childTasks = useMemo(() => tasks.filter((t) => t.parentId === task.id), [tasks, task.id]);
  const [hideCompletedSubtasks, setHideCompletedSubtasks] = useState(false);
  const visibleChildTasks = hideCompletedSubtasks ? childTasks.filter((c) => !c.isCompleted) : childTasks;
  const completedChildTasks = childTasks.filter((c) => c.isCompleted).length;

  // Bulk multi-select scoped to JUST this modal's own sub-task list (see
  // hooks/useMultiSelect.js's module doc) — fully independent of List/
  // Board/Calendar's own selections, and never shared even if this modal is
  // opened from one of those pages. Sub-tasks are plain Tasks, so this
  // reuses the same Task-only action set List/Board's own bulk-edit uses.
  const subtaskSelect = useMultiSelect();
  const selectedSubtasks = useMemo(
    () => [...subtaskSelect.selectedKeys].map((id) => childTasks.find((c) => c.id === id)).filter(Boolean),
    [subtaskSelect.selectedKeys, childTasks]
  );
  const subtaskBulkActions = useTaskBulkEditActions(selectedSubtasks, subtaskSelect.exitSelectionMode);

  // Bulk-select is scoped to whichever task's sub-task list is currently
  // shown — switching to a different task (parent, or a child navigated
  // into) must not carry over a selection made against the PREVIOUS task's
  // children. This component instance stays mounted across a task switch
  // (TaskDetailModal just re-renders it with a new `task` prop, via
  // `activeTaskId`), so this reset has to be explicit rather than relying
  // on a fresh mount.
  useEffect(() => {
    subtaskSelect.setSelectionMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  // Smart-parse draft state for the "Add sub-task" row — mirrors
  // AddTaskModal's blank-start fields (not TaskDetailModal's own edit-mode
  // fields, which compare against task.* originals) since a new sub-task
  // starts blank the same way a brand-new top-level task does. Every field
  // the main Title field smart-parses is wired here too, even though this
  // compact row has no picker widget for recurrence/dependency/unattended/
  // enforceDueDate/link/fixedTime — those simply have no way to become
  // "touched" (no hasEdited flag) since there's nothing to edit them with
  // other than smart-parse itself, so isUntouched() for them is just `true`.
  const [subtaskProjectId, setSubtaskProjectId] = useState(task.projectId ?? '');
  const [subtaskHasEditedProject, setSubtaskHasEditedProject] = useState(false);
  const [subtaskSectionId, setSubtaskSectionId] = useState(task.sectionId ?? '');
  const [subtaskHasEditedSection, setSubtaskHasEditedSection] = useState(false);
  const [subtaskPriority, setSubtaskPriority] = useState('medium');
  const [subtaskHasEditedPriority, setSubtaskHasEditedPriority] = useState(false);
  const [subtaskDueDate, setSubtaskDueDate] = useState('');
  const [subtaskHasEditedDueDate, setSubtaskHasEditedDueDate] = useState(false);
  const [subtaskEstimatedHours, setSubtaskEstimatedHours] = useState(DEFAULT_SUBTASK_ESTIMATED_HOURS);
  const [subtaskHasEditedHours, setSubtaskHasEditedHours] = useState(false);
  const [subtaskLabelIds, setSubtaskLabelIds] = useState([]);
  const [subtaskLink, setSubtaskLink] = useState('');
  const [subtaskFixedTime, setSubtaskFixedTime] = useState('');
  const [subtaskFixedTimeEnabled, setSubtaskFixedTimeEnabled] = useState(false);
  const [subtaskIsRecurring, setSubtaskIsRecurring] = useState(false);
  const [subtaskRecurrenceCount, setSubtaskRecurrenceCount] = useState(1);
  const [subtaskRecurrenceUnit, setSubtaskRecurrenceUnit] = useState('week');
  const [subtaskRecurrenceDays, setSubtaskRecurrenceDays] = useState(null);
  const [subtaskIsPassive, setSubtaskIsPassive] = useState(false);
  const [subtaskEnforceDueDate, setSubtaskEnforceDueDate] = useState(false);
  const [subtaskDependsOn, setSubtaskDependsOn] = useState([]);
  const [subtaskAssignedTo, setSubtaskAssignedTo] = useState(null);

  function handleSubtaskProjectChange(newProjectId) {
    setSubtaskProjectId(newProjectId);
    if (subtaskSectionId && !sections.find((s) => s.id === subtaskSectionId && s.projectId === newProjectId)) {
      setSubtaskSectionId('');
    }
  }

  const {
    smartDetected: subtaskSmartDetected,
    handleTitleChange: handleSubtaskSmartTitleChange,
    dismissSmartChip: dismissSubtaskSmartChip,
    buildFinalTitle: buildSubtaskFinalTitle,
    resetSmartState: resetSubtaskSmartState,
  } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
    // Only offered while the draft still inherits its parent's (shared)
    // project by default — see the assignedTo-omission comment in
    // handleAddSubtask below for why a detection stops being meaningful once
    // the draft's own project field is touched.
    collaborators: isSharedTask && !subtaskHasEditedProject ? assignableCollaborators : [],
    fields: {
      link: {
        isUntouched: () => true,
        apply: (match) => setSubtaskLink(match.url),
        revert: () => setSubtaskLink(''),
      },
      dueDate: {
        isUntouched: () => !subtaskHasEditedDueDate,
        apply: (match) => setSubtaskDueDate(match.iso),
        revert: () => setSubtaskDueDate(''),
      },
      fixedTime: {
        isUntouched: () => true,
        apply: (match) => {
          setSubtaskFixedTime(match.time);
          setSubtaskFixedTimeEnabled(true);
        },
        revert: () => {
          setSubtaskFixedTime('');
          setSubtaskFixedTimeEnabled(false);
        },
      },
      recurrence: {
        isUntouched: () => true,
        apply: (match, detected) => {
          setSubtaskIsRecurring(true);
          setSubtaskRecurrenceCount(match.rule.count);
          setSubtaskRecurrenceUnit(match.rule.unit);
          setSubtaskRecurrenceDays(match.rule.days || null);
          if (!subtaskDueDate && !detected.dueDate) setSubtaskDueDate(toISODate(new Date()));
        },
        revert: () => {
          setSubtaskIsRecurring(false);
          setSubtaskRecurrenceDays(null);
        },
      },
      priority: {
        isUntouched: () => !subtaskHasEditedPriority,
        apply: (match) => setSubtaskPriority(match.level),
        revert: () => setSubtaskPriority('medium'),
      },
      estimatedHours: {
        isUntouched: () => !subtaskHasEditedHours,
        apply: (match) => setSubtaskEstimatedHours(match.hours),
        revert: () => setSubtaskEstimatedHours(DEFAULT_SUBTASK_ESTIMATED_HOURS),
      },
      unattended: {
        isUntouched: () => true,
        apply: () => setSubtaskIsPassive(true),
        revert: () => setSubtaskIsPassive(false),
      },
      enforceDueDate: {
        isUntouched: () => true,
        apply: (match, detected) => {
          setSubtaskEnforceDueDate(true);
          if (!subtaskDueDate && !detected.dueDate) setSubtaskDueDate(toISODate(new Date()));
        },
        revert: () => setSubtaskEnforceDueDate(false),
      },
      assignTo: {
        isUntouched: () => true,
        apply: (match) => {
          if (match.collaborator) setSubtaskAssignedTo(match.collaborator.uid);
        },
        revert: () => setSubtaskAssignedTo(null),
      },
      dependency: {
        isUntouched: () => true,
        apply: (match) => {
          if (match.task) setSubtaskDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
        },
        revert: (entry) => {
          if (entry.task) setSubtaskDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
        },
      },
      project: {
        isUntouched: () => !subtaskHasEditedProject,
        apply: (match) => {
          if (match.project) handleSubtaskProjectChange(match.project.id);
          if (match.section && !subtaskHasEditedSection) setSubtaskSectionId(match.section.id);
        },
        revert: () => {
          handleSubtaskProjectChange('');
          if (!subtaskHasEditedSection) setSubtaskSectionId('');
        },
      },
    },
  });

  function handleSubtaskTitleChange(value) {
    setNewSubtaskTitle(value);
    handleSubtaskSmartTitleChange(value);
  }

  const subtaskSmartChips = useMemo(() => buildSmartChips(subtaskSmartDetected), [subtaskSmartDetected]);

  function resetSubtaskDraft() {
    setNewSubtaskTitle('');
    setSubtaskProjectId(task.projectId ?? '');
    setSubtaskHasEditedProject(false);
    setSubtaskSectionId(task.sectionId ?? '');
    setSubtaskHasEditedSection(false);
    setSubtaskPriority('medium');
    setSubtaskHasEditedPriority(false);
    setSubtaskDueDate('');
    setSubtaskHasEditedDueDate(false);
    setSubtaskEstimatedHours(DEFAULT_SUBTASK_ESTIMATED_HOURS);
    setSubtaskHasEditedHours(false);
    setSubtaskLabelIds([]);
    setSubtaskLink('');
    setSubtaskFixedTime('');
    setSubtaskFixedTimeEnabled(false);
    setSubtaskIsRecurring(false);
    setSubtaskRecurrenceCount(1);
    setSubtaskRecurrenceUnit('week');
    setSubtaskRecurrenceDays(null);
    setSubtaskIsPassive(false);
    setSubtaskEnforceDueDate(false);
    setSubtaskDependsOn([]);
    setSubtaskAssignedTo(null);
    resetSubtaskSmartState();
  }

  function handleAddSubtask() {
    if (isReadOnlyViewer) return; // Defense in depth — UI already hides the composer for viewers.
    const trimmed = newSubtaskTitle.trim();
    if (!trimmed || atMaxSubtaskDepth) return;
    // A sub-task is just a top-level task with `parentId` set — created via
    // the same addTask every other task uses. `dueDate` defaults to unset —
    // an undated sub-task is still immediately schedulable (see
    // allocator.js's prioritizeTasks), it just competes for capacity at
    // baseline urgency (or its nearest ancestor's due date, if any) instead
    // of a deadline of its own — unless smart-parse (or a manual pick) set
    // one. Project/section inherit the parent task's by default, same as
    // before, unless the draft's own project field was touched.
    const section = sections.find((s) => s.id === subtaskSectionId);
    const pendingLabelNames = (subtaskSmartDetected.labels || []).map((m) => m.name);
    const finalLabelIds = [
      ...new Set([...subtaskLabelIds, ...(pendingLabelNames.length ? getOrCreateLabelIds(pendingLabelNames) : [])]),
    ];
    addTask({
      title: buildSubtaskFinalTitle(newSubtaskTitle),
      parentId: task.id,
      estimatedHours: Number(subtaskEstimatedHours) || DEFAULT_SUBTASK_ESTIMATED_HOURS,
      priority: subtaskPriority,
      dueDate: subtaskDueDate || null,
      projectId: subtaskHasEditedProject ? subtaskProjectId || null : task.projectId ?? null,
      sectionId: subtaskHasEditedProject ? subtaskSectionId || null : task.sectionId ?? null,
      sectionName: subtaskHasEditedProject ? section?.name ?? null : task.sectionName ?? null,
      labelIds: finalLabelIds,
      link: subtaskLink || null,
      isRecurring: subtaskIsRecurring && !!subtaskDueDate,
      recurrenceString:
        subtaskIsRecurring && subtaskDueDate
          ? buildRecurrenceString(subtaskRecurrenceCount, subtaskRecurrenceUnit, subtaskRecurrenceDays)
          : null,
      dependsOn: subtaskDependsOn,
      isPassive: subtaskIsPassive,
      enforceDueDate: subtaskEnforceDueDate && !!subtaskDueDate,
      fixedTime: subtaskFixedTimeEnabled && subtaskFixedTime ? subtaskFixedTime : null,
      // Only meaningful while the sub-task still inherits its parent's
      // (shared) project by default — the `collaborators` list passed to
      // useSmartTaskTitle above is scoped to that same shared project, so a
      // detected assignment here would be meaningless once the draft's own
      // project field has been changed away from that default. Omitted
      // entirely rather than set to null on a personal task (see
      // types/index.js's Task.assignedTo doc comment).
      ...(isSharedTask && !subtaskHasEditedProject && subtaskAssignedTo ? { assignedTo: subtaskAssignedTo } : {}),
    });
    resetSubtaskDraft();
  }

  function handleCancelAddSubtask() {
    resetSubtaskDraft();
    setIsAddingSubtask(false);
  }

  // Escape collapses the add row back to its trigger rather than closing the
  // whole task modal. The title field's own mention/keyword autocompletes
  // register deeper layers while they're open, so Escape unwinds in the order
  // you'd expect: suggestion list, then this row, then the modal.
  useEscapeLayer(isAddingSubtask, handleCancelAddSubtask);

  return (
    <div className="form-row">
      <div className="subtask-header">
        <span className="subtask-header-label">
          <label>Sub-tasks {childTasks.length > 0 ? `(${completedChildTasks}/${childTasks.length})` : ''}</label>
          <HelpTooltip label="How do sub-tasks work?">
            A sub-task is a normal task in every way — priority, dependencies, search — except it's shown nested
            under its parent here. It needs its own due date (or one borrowed from its nearest dated ancestor) to
            be auto-scheduled, exactly like a top-level task needs one. A sub-task's own due date can never be
            later than that ancestor's — the ancestor's due date is the deadline for finishing every step toward
            it. Once a task has its own sub-task, it becomes a goal/container: it's never scheduled itself, and
            its hours become a live total of its sub-tasks' hours. Nesting is capped at 2 levels (a sub-task of a
            sub-task can't have its own sub-tasks).
          </HelpTooltip>
        </span>
        {!isReadOnlyViewer && childTasks.length > 0 && (
          <button
            type="button"
            className={`subtask-hide-completed ${subtaskSelect.selectionMode ? 'is-active' : ''}`}
            onClick={() => subtaskSelect.setSelectionMode(!subtaskSelect.selectionMode)}
            aria-pressed={subtaskSelect.selectionMode}
          >
            {subtaskSelect.selectionMode ? 'Cancel select' : 'Select'}
          </button>
        )}
        {completedChildTasks > 0 && (
          <button type="button" className="subtask-hide-completed" onClick={() => setHideCompletedSubtasks((v) => !v)}>
            {hideCompletedSubtasks ? 'Show completed' : 'Hide completed'}
          </button>
        )}
      </div>
      <div className="subtask-list">
        {visibleChildTasks.map((child) => {
          const childDoneForToday = isCompletedForCurrentOccurrence(child, todayIso);
          const childSelected = subtaskSelect.isSelected(child.id);
          return (
          <div key={child.id} className={`subtask-row ${childSelected ? 'is-selected' : ''}`}>
            {subtaskSelect.selectionMode ? (
              <input
                type="checkbox"
                className="bulk-select-checkbox"
                checked={childSelected}
                onChange={() => subtaskSelect.toggle(child.id)}
                aria-label={`Select ${child.title}`}
              />
            ) : (
              <input
                type="checkbox"
                checked={childDoneForToday}
                disabled={isReadOnlyViewer}
                // Mirrors the header checkbox above: a recurring
                // child completed for today shows checked and can
                // only be un-completed, rather than re-offering
                // "complete" (child.isCompleted stays false for
                // recurring tasks — see isCompletedForCurrentOccurrence).
                onChange={() => {
                  if (isReadOnlyViewer) return; // Defense in depth — checkbox is already disabled for viewers.
                  if (!childDoneForToday) {
                    requestComplete(child.id);
                  } else {
                    uncompleteTask(child.id);
                    playUncomplete();
                  }
                }}
              />
            )}
            <div
              role="button"
              tabIndex={0}
              className={`subtask-row-title-wrap ${childDoneForToday ? 'completed' : ''}`}
              onClick={() => (subtaskSelect.selectionMode ? subtaskSelect.toggle(child.id) : setActiveTaskId(child.id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (subtaskSelect.selectionMode) subtaskSelect.toggle(child.id);
                  else setActiveTaskId(child.id);
                }
              }}
              title={subtaskSelect.selectionMode ? undefined : 'Open sub-task'}
            >
              <span className="subtask-row-title">
                {child.link ? (
                  <a
                    href={child.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="task-title-link"
                    onClick={(e) => e.stopPropagation()}
                    title={`Open link: ${child.link}`}
                  >
                    {child.title}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : (
                  child.title
                )}
              </span>
              {child.notes && <span className="subtask-row-notes">{child.notes}</span>}
            </div>
            <button
              className="btn btn-icon subtask-row-remove"
              onClick={() => {
                if (isReadOnlyViewer) return; // Defense in depth — button is already disabled for viewers.
                deleteTask(child.id);
              }}
              disabled={isReadOnlyViewer}
              style={{ color: 'var(--color-danger)' }}
              aria-label={`Delete ${child.title}`}
            >
              <X size={13} />
            </button>
          </div>
          );
        })}
        {isReadOnlyViewer ? (
          <p className="comment-viewonly-note">
            <Lock size={13} aria-hidden="true" />
            <span>Adding sub-tasks needs edit access on this project — ask the owner for editor access.</span>
          </p>
        ) : atMaxSubtaskDepth ? (
          <p className="form-hint">
            Sub-tasks are capped at 2 levels deep — this task is already a sub-task of a sub-task, so it can't have its own.
          </p>
        ) : isAddingSubtask ? (
          <div
            className="subtask-add-wrap"
            onBlur={(e) => {
              // Collapse the row back to the "Add sub-task" trigger
              // once focus leaves it entirely with nothing typed —
              // matches the plain-textarea row's old onBlur, but
              // gated on relatedTarget since this now wraps
              // SmartTitleInput's own popups (mention/keyword-
              // suggest) and the Add button, which shouldn't count
              // as "focus left" while still inside this row.
              if (!newSubtaskTitle.trim() && !e.currentTarget.contains(e.relatedTarget)) {
                setIsAddingSubtask(false);
              }
            }}
          >
            <div className="subtask-add-row">
              <SmartTitleInput
                autoFocus
                value={newSubtaskTitle}
                onChange={handleSubtaskTitleChange}
                smartDetected={subtaskSmartDetected}
                onDismiss={dismissSubtaskSmartChip}
                placeholder="Add a sub-task…"
                projects={projects}
                sections={sections}
                labels={labels}
                onEnter={handleAddSubtask}
              />
              <button type="button" className="btn" onClick={handleAddSubtask}>
                Add
                <Plus size={14} />
              </button>
            </div>
            <SmartChips chips={subtaskSmartChips} onDismiss={dismissSubtaskSmartChip} />
          </div>
        ) : (
          <button type="button" className="subtask-add-trigger" onClick={() => setIsAddingSubtask(true)}>
            <Plus size={14} />
            Add sub-task
          </button>
        )}
      </div>
      {subtaskSelect.selectionMode && (
        <BulkActionBar
          count={subtaskSelect.count}
          editableFields={subtaskBulkActions.editableFields}
          projects={projects}
          labels={labels}
          onApplyField={subtaskBulkActions.applyField}
          onMarkComplete={subtaskBulkActions.markComplete}
          onMarkIncomplete={subtaskBulkActions.markIncomplete}
          onDelete={subtaskBulkActions.handleDelete}
          onCancel={subtaskSelect.exitSelectionMode}
          onSelectAll={() => subtaskSelect.selectAll(visibleChildTasks.map((c) => c.id))}
        />
      )}
    </div>
  );
}

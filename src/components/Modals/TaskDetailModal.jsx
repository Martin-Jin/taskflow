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
import {
  RefreshCw,
  Pause,
  Repeat,
  Ban,
  Wind,
  X,
  Lock,
  Unlock,
  CalendarClock,
  Flag,
  Link2,
  HelpCircle,
  CalendarX2,
  Folder,
  Layers,
  Tag,
  Clock,
  Plus,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { parseDurationHours, formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { parseRecurrenceRule, RECURRENCE_UNITS, buildRecurrenceString } from '../../utils/recurrence';
import { getIneligibleDependencyIds } from '../../utils/dependencyUtils';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { formatHours } from '../../utils/formatHours';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useSmartTaskTitle } from '../../hooks/useSmartTaskTitle';
import DependencyPicker from '../Common/DependencyPicker';
import LabelPicker from '../Common/LabelPicker';
import DetailField from '../Common/DetailField';
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
    todoistEnabled,
    syncActive,
  } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState(task.title);
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
  const [dependsOn, setDependsOn] = useState(task.dependsOn || []);
  const [isPassive, setIsPassive] = useState(!!task.isPassive);
  const [earliestDate, setEarliestDate] = useState(task.earliestDate || '');
  const [labelIds, setLabelIds] = useState(task.labelIds || []);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [hideCompletedSubtasks, setHideCompletedSubtasks] = useState(false);
  const [editingSubtask, setEditingSubtask] = useState(null);

  const notesRef = useRef(null);
  useAutosizeTextarea(notesRef, notes);

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
    setDependsOn(task.dependsOn || []);
    setIsPassive(!!task.isPassive);
    setEarliestDate(task.earliestDate || '');
    setLabelIds(task.labelIds || []);
    resetSmartState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const subtasks = task.subtasks || [];
  const visibleSubtasks = hideCompletedSubtasks ? subtasks.filter((s) => !s.isCompleted) : subtasks;
  const completedSubtasks = subtasks.filter((s) => s.isCompleted).length;
  const recurrenceIsEditable = task.source !== 'todoist';

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
    fields: {
      dueDate: {
        isUntouched: () => dueDate === (task.dueDate || ''),
        apply: (match) => setDueDate(match.iso),
        revert: () => setDueDate(task.dueDate || ''),
      },
      recurrence: {
        isUntouched: () => recurrenceIsEditable && isRecurring === !!task.isRecurring,
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
        },
        revert: () => handleProjectChange(task.projectId || ''),
      },
    },
  });

  function handleTitleChange(value) {
    setTitle(value);
    handleSmartTitleChange(value);
  }

  const smartChips = [
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
        ? { type: 'project', icon: Folder, label: `Project: ${smartDetected.project.project.name}` }
        : { type: 'project', icon: HelpCircle, label: `No project match for "${smartDetected.project.fragment}"` }),
    ...(smartDetected.labels || []).map((m) => ({
      type: 'labels',
      key: `labels:${m.matchedText}`,
      icon: Tag,
      label: `#${m.name}`,
      match: m,
    })),
  ].filter(Boolean);

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

  function handleSave() {
    const section = sections.find((s) => s.id === sectionId);
    const nextDueDate = dueDate || null;
    const nextIsRecurring = recurrenceIsEditable ? isRecurring && !!nextDueDate : task.isRecurring;
    const nextRecurrenceString = recurrenceIsEditable
      ? isRecurring && nextDueDate
        ? buildRecurrenceString(recurrenceCount, recurrenceUnit)
        : null
      : task.recurrenceString;

    // Resolve any still-pending "@tag" mentions to real Label ids now,
    // merging with whatever was already picked via the sidebar's LabelPicker.
    const pendingLabelNames = (smartDetected.labels || []).map((m) => m.name);
    const finalLabelIds = [...new Set([...labelIds, ...(pendingLabelNames.length ? getOrCreateLabelIds(pendingLabelNames) : [])])];

    updateTask(task.id, {
      title: buildFinalTitle(title) || task.title,
      notes,
      estimatedHours: Number(estimatedHours) || task.estimatedHours,
      remainingHours: Math.min(task.remainingHours, Number(estimatedHours) || task.estimatedHours),
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
      labelIds: finalLabelIds,
    });
    requestClose();
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
          style={{ width: 680 }}
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Task details"
          tabIndex={-1}
        >
          <div className="detail-header">
            <div className="detail-title-wrap">
              <SmartTitleInput value={title} onChange={handleTitleChange} smartDetected={smartDetected} onDismiss={dismissSmartChip} />
            </div>
            <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          {task.source === 'todoist' && (
            <p className="detail-sync-note">
              {syncActive ? (
                <>
                  <RefreshCw size={12} aria-hidden="true" /> Synced with Todoist — changes here update Todoist too.
                </>
              ) : todoistEnabled ? (
                <>
                  <Pause size={12} aria-hidden="true" /> Imported from Todoist — task sync is paused in Settings, so changes here stay local.
                </>
              ) : (
                'Imported from Todoist previously — no API token configured now, so changes here stay local.'
              )}
            </p>
          )}

          <SmartChips chips={smartChips} onDismiss={dismissSmartChip} />

          <div className="detail-body">
            <div className="detail-main">
              <div className="form-row">
                <label htmlFor="task-detail-notes" className="sr-only">
                  Description
                </label>
                <textarea
                  id="task-detail-notes"
                  className="detail-notes-textarea"
                  ref={notesRef}
                  rows={8}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={handleNotesBlur}
                  placeholder="Description"
                />
              </div>

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
                        style={{ color: 'var(--danger)' }}
                        aria-label={`Delete ${s.title}`}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="subtask-add-row">
                    <input
                      value={newSubtaskTitle}
                      onChange={(e) => setNewSubtaskTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddSubtask();
                        }
                      }}
                      placeholder="Add a sub-task…"
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="btn" onClick={handleAddSubtask}>
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
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
                <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
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
                <label className="form-checkbox-row" style={{ cursor: dueDate && recurrenceIsEditable ? 'pointer' : 'default' }}>
                  <input
                    type="checkbox"
                    checked={isRecurring}
                    disabled={!dueDate || !recurrenceIsEditable}
                    onChange={(e) => setIsRecurring(e.target.checked)}
                  />
                  {isRecurring ? `Every ${recurrenceCount} ${recurrenceUnit}${recurrenceCount === 1 ? '' : 's'}` : 'Does not repeat'}
                </label>
                {isRecurring && recurrenceIsEditable && (
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
                  </div>
                )}
                {isRecurring && !recurrenceIsEditable && (
                  <p className="form-hint">
                    Imported from Todoist ({task.recurrenceString || 'custom'}) — edit it there, it'll sync back on the next fetch.
                  </p>
                )}
                {isRecurring && (
                  <p className="form-hint">Marking this complete advances the due date instead of moving it to Completed.</p>
                )}
                {!dueDate && <p className="form-hint">Needs a due date first.</p>}
              </DetailField>

              {dependencyOptions.length > 0 && (
                <DetailField icon={Link2} label="Depends on">
                  <DependencyPicker options={dependencyOptions} selectedIds={dependsOn} onChange={setDependsOn} />
                </DetailField>
              )}

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
                    <input type="date" value={earliestDate} onChange={(e) => setEarliestDate(e.target.value)} style={{ marginTop: 6 }} />
                    <p className="form-hint">The scheduler won't place blocks before this date, overriding its usual pacing.</p>
                  </>
                )}
              </DetailField>

              <DetailField icon={Wind} label="Unattended">
                <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={isPassive} onChange={(e) => setIsPassive(e.target.checked)} />
                  Can run unattended
                </label>
                <p className="form-hint">e.g. laundry — can overlap other scheduled work.</p>
              </DetailField>
            </div>
          </div>

          <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'space-between' }}>
            <button
              className="btn detail-lock-btn"
              onClick={() => toggleTaskLock(task.id)}
              title={task.isLocked ? 'Unlock — allow the scheduler to rebalance this task' : 'Lock — protect this task from rebalance'}
            >
              {task.isLocked ? (
                <>
                  <Lock size={14} aria-hidden="true" /> Unlock
                </>
              ) : (
                <>
                  <Unlock size={14} aria-hidden="true" /> Lock
                </>
              )}
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={handleDelete} style={{ color: 'var(--danger)' }}>
                Delete
              </button>
              <button className="btn" onClick={requestClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSave}>
                Save
              </button>
            </div>
          </div>
        </div>
      </div>

      {editingSubtask && <SubtaskDetailModal taskId={task.id} subtask={editingSubtask} onClose={() => setEditingSubtask(null)} />}
    </>
  );
}

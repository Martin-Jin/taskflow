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
 * date, estimated hours, "unattended", recurrence, dependency ("after X"),
 * priority ("p1"-"p4"), plus "#project" and "@tag".
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

import React, { useRef, useState } from 'react';
import {
  Repeat,
  Wind,
  CalendarClock,
  CalendarCheck,
  CalendarX2,
  Flag,
  Link2,
  Folder,
  Layers,
  Tag,
  Clock,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { parseDurationHours, formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { linkLabel } from '../../utils/linkify';
import { RECURRENCE_UNITS, buildRecurrenceString, WEEKDAY_LABELS, MAX_RECURRENCE_COUNT } from '../../utils/recurrence';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
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
  const { addTask, tasks, sections, projects, labels, getOrCreateLabelIds } = useScheduler();
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
  const [isPassive, setIsPassive] = useState(false);
  const [hasEditedPassive, setHasEditedPassive] = useState(false);
  const [enforceDueDate, setEnforceDueDate] = useState(false);
  const [hasEditedEnforceDueDate, setHasEditedEnforceDueDate] = useState(false);
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
  const [labelIds, setLabelIds] = useState([]);
  const [error, setError] = useState('');
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

  function handleProjectChange(newProjectId) {
    setProjectId(newProjectId);
    if (sectionId && !sections.find((s) => s.id === sectionId && s.projectId === newProjectId)) {
      setSectionId('');
    }
  }

  const { smartDetected, handleTitleChange: handleSmartTitleChange, dismissSmartChip, buildFinalTitle } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
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
      dependency: {
        isUntouched: () => !hasEditedDependencies,
        apply: (match) => {
          if (match.task) setDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
        },
        revert: (entry) => {
          if (entry.task) setDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
        },
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
    },
  });

  function handleTitleChange(value) {
    setTitle(value);
    handleSmartTitleChange(value);
  }

  const smartChips = buildSmartChips(smartDetected);

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
      isPassive,
      enforceDueDate: enforceDueDate && !!dueDate,
      fixedTime: fixedTimeEnabled && fixedTime ? fixedTime : null,
      earliestDate: earliestDate || null,
      labelIds: finalLabelIds,
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
          Smart parse: links, due dates, "at 5pm", p1–p4, duration, "unattended", "on the day", #project, @tag, "every month"
        </button>

        <SmartChips chips={smartChips} onDismiss={dismissSmartChip} />

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
              isRecurring || isPassive || enforceDueDate || !!earliestDate || dependsOn.length > 0 ? 'is-set' : ''
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
          </div>
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
                .filter((p) => p.name.trim().toLowerCase() !== 'inbox')
                .map((p) => ({ value: p.id, label: p.name })),
            ]}
          />

          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSubmit}>
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

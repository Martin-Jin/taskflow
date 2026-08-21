/**
 * DetailSidebar — the metadata column of TaskDetailModal (Project, Section,
 * Due date, Scheduled, Priority, Labels, Estimated time, Time left, Repeat).
 * Extracted as part of the W3 restructure — see TODO.md's Phase D entry
 * for why this one is DELIBERATELY a plain presentational component
 * (every value + setter passed in as a prop) rather than owning its own
 * state the way CommentThread/SubtaskList do.
 *
 * Unlike comments/sub-tasks, these fields have no save logic of their own —
 * persistence happens entirely in the PARENT's `commitChanges`/debounced
 * autosave effect, which reads every one of these fields by name to compute
 * `sidebarDirty`/`isDirty`/`appliableSharedDirty` and reconciles external
 * changes back into them. That logic has to keep living in
 * TaskDetailModal.jsx; trying to make this component "own" the state (the
 * CommentThread/SubtaskList pattern) would mean either duplicating that
 * dirty-tracking/reconciliation machinery here too (fragile, exactly the
 * kind of thing this restructure's own guard says not to touch) or
 * threading it back out via callbacks — more indirection for no real gain.
 * A big prop list is the honest tradeoff for keeping that logic in one
 * place, unchanged.
 *
 * Dependencies/Lock/Enforce due date/Unattended are NOT here — despite
 * living right next to these fields conceptually, they render in the "..."
 * three-dot menu (a separate portal-positioned dropdown), not this static
 * sidebar column, and stay in TaskDetailModal.jsx untouched by this phase.
 */

import React from 'react';
import { X } from 'lucide-react';
import { CalendarClock, CalendarRange, Clock, Flag, Folder, Hourglass, Layers, Repeat, Tag } from 'lucide-react';
import { PRIORITY_LABELS } from '../../../utils/priorityColor';
import { formatDisplayDate, formatTime12h } from '../../../utils/dateUtils';
import { formatHours } from '../../../utils/formatHours';
import { WEEKDAY_LABELS, MAX_RECURRENCE_COUNT, RECURRENCE_UNITS } from '../../../utils/recurrence';
import { isSharedProject } from '../../../utils/sharedProjectAccess';
import { NO_SCHEDULE_PROJECT_ID, NO_SCHEDULE_PROJECT_LABEL } from '../../../utils/projectConstants';
import DetailField from '../../Common/DetailField';
import SelectMenu from '../../Common/SelectMenu';
import LabelPicker from '../../Common/LabelPicker';
import SmartDurationInput from '../../Common/SmartDurationInput';
import SmartRecurrenceInput from '../../Common/SmartRecurrenceInput';
import HelpTooltip from '../../Common/HelpTooltip';
import NumberField from '../../Common/NumberField';

export default function DetailSidebar({
  task,
  isReadOnlyViewer,
  isContainer,
  projects,
  projectId,
  onProjectChange,
  availableSections,
  sectionId,
  onSectionChange,
  dueDate,
  onDueDateChange,
  dueDateError,
  dueDateRequiredError,
  taskScheduledBlocks,
  priority,
  onPriorityChange,
  labels,
  labelIds,
  onLabelIdsChange,
  onCreateLabel,
  pendingSmartLabels,
  estimatedHours,
  onEstimatedHoursChange,
  effectiveEstimatedHours,
  childTasksCount,
  effectiveRemainingHours,
  onRemainingHoursChange,
  isRecurring,
  onIsRecurringChange,
  recurrenceCount,
  onRecurrenceCountChange,
  recurrenceUnit,
  onRecurrenceUnitChange,
  recurrenceDays,
  onRecurrenceDaysChange,
  repeatEditText,
  onRepeatEditTextChange,
  onCommitRepeatEditText,
  recentCompletionCount,
}) {
  return (
    <div className="detail-sidebar">
      <DetailField icon={Folder} label="Project">
        <SelectMenu
          ariaLabel="Project"
          value={projectId}
          onChange={onProjectChange}
          options={[
            { value: '', label: 'No project' },
            ...projects
              .filter((p) => !isSharedProject(p) || p.id === task.projectId)
              .map((p) => ({ value: p.id, label: p.name })),
            // A synthetic destination, not a real Project record (see
            // projectConstants.js) — set apart with a separator since
            // it isn't part of the real project list above it.
            { value: NO_SCHEDULE_PROJECT_ID, label: NO_SCHEDULE_PROJECT_LABEL, separatorBefore: true },
          ]}
          disabled={isReadOnlyViewer}
        />
      </DetailField>

      <DetailField icon={Layers} label="Section">
        <SelectMenu
          ariaLabel="Section"
          value={sectionId}
          onChange={onSectionChange}
          options={[
            { value: '', label: 'No section' },
            ...availableSections.map((s) => ({ value: s.id, label: s.name })),
          ]}
          disabled={isReadOnlyViewer}
        />
      </DetailField>

      <DetailField icon={CalendarClock} label="Due date">
        <input type="date" value={dueDate} onChange={(e) => onDueDateChange(e.target.value)} disabled={isReadOnlyViewer} />
        {dueDateRequiredError ? (
          <p className="form-error">{dueDateRequiredError}</p>
        ) : dueDateError ? (
          <p className="form-error">{dueDateError}</p>
        ) : isContainer ? (
          <p className="form-hint">
            A container's own due date isn't scheduled directly — it feeds urgency for sub-tasks that don't have their own.
          </p>
        ) : !dueDate && task.parentId ? (
          <p className="form-hint">
            Still schedulable without one — it'll use its parent's due date (if any) or default priority/urgency.
          </p>
        ) : (
          !dueDate && <p className="form-hint">Won't be auto-scheduled without a due date.</p>
        )}
      </DetailField>

      {!isContainer && taskScheduledBlocks.length > 0 && (
        <DetailField icon={CalendarRange} label="Scheduled">
          <div className="scheduled-blocks-list">
            {taskScheduledBlocks.map((b) => (
              <p key={b.id} className="form-hint scheduled-block-row">
                {formatDisplayDate(b.date)}, {formatTime12h(b.startTime)}–{formatTime12h(b.endTime)}
              </p>
            ))}
          </div>
        </DetailField>
      )}

      <DetailField icon={Flag} label="Priority">
        <SelectMenu
          ariaLabel="Priority"
          value={priority}
          onChange={onPriorityChange}
          options={['low', 'medium', 'high', 'urgent'].map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
          disabled={isReadOnlyViewer}
        />
      </DetailField>

      <DetailField icon={Tag} label="Labels">
        <LabelPicker
          labels={labels}
          selectedIds={labelIds}
          onChange={onLabelIdsChange}
          onCreateLabel={onCreateLabel}
          disabled={isReadOnlyViewer}
        />
        {pendingSmartLabels.length > 0 && (
          <p className="form-hint">Pending from the title: {pendingSmartLabels.map((m) => `#${m.name}`).join(', ')}</p>
        )}
      </DetailField>

      <DetailField icon={Clock} label="Estimated time">
        {isContainer ? (
          <>
            <p style={{ margin: 0, fontWeight: 600 }}>{formatHours(effectiveEstimatedHours)}</p>
            <p className="form-hint">
              Computed from {childTasksCount} sub-task{childTasksCount === 1 ? '' : 's'} — not directly editable.
            </p>
          </>
        ) : (
          <SmartDurationInput hours={Number(estimatedHours) || 0} onChange={onEstimatedHoursChange} disabled={isReadOnlyViewer} />
        )}
        {typeof task.actualHours === 'number' && (
          <p className="form-hint">Actually spent: {formatHours(task.actualHours)} (tracked via timer)</p>
        )}
      </DetailField>

      {!isContainer && (
      <DetailField icon={Hourglass} label="Time left">
        <SmartDurationInput
          hours={effectiveRemainingHours}
          onChange={onRemainingHoursChange}
          disabled={isReadOnlyViewer}
        />
      </DetailField>
      )}

      <DetailField
        icon={Repeat}
        label="Repeat"
        labelExtra={
          <HelpTooltip label="Recurrence syntax help">
            The text field accepts free-text recurrence phrases like "every 2 weeks", "every mon and wed", or
            "every other friday".
          </HelpTooltip>
        }
      >
        {isRecurring && recurrenceDays && recurrenceDays.length > 0 ? (
          repeatEditText !== null ? (
            <SmartRecurrenceInput
              value={repeatEditText}
              autoFocus
              onChange={(e) => onRepeatEditTextChange(e.target.value)}
              onBlur={onCommitRepeatEditText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') onRepeatEditTextChange(null);
              }}
              disabled={isReadOnlyViewer}
            />
          ) : (
            <div className="detail-field-inline">
              <button
                type="button"
                className="detail-recurrence-toggle"
                style={{ flex: 1 }}
                disabled={isReadOnlyViewer}
                onClick={() =>
                  onRepeatEditTextChange(
                    `every ${recurrenceCount === 1 ? '' : `${recurrenceCount} `}week${recurrenceCount === 1 ? '' : 's'} on ${recurrenceDays
                      .map((d) => WEEKDAY_LABELS[d])
                      .join(', ')}`
                  )
                }
              >
                {`Every ${recurrenceCount === 1 ? '' : `${recurrenceCount} `}week${recurrenceCount === 1 ? '' : 's'} on ${recurrenceDays
                  .map((d) => WEEKDAY_LABELS[d])
                  .join(', ')}`}
              </button>
              <button
                type="button"
                className="btn btn-icon detail-recurrence-clear"
                onClick={() => onIsRecurringChange(false)}
                disabled={isReadOnlyViewer}
                aria-label="Turn off repeat"
                title="Does not repeat"
              >
                <X size={14} />
              </button>
            </div>
          )
        ) : isRecurring ? (
          <div className="detail-recurrence-toggle detail-recurrence-toggle-active">
            {`Every ${recurrenceCount} ${recurrenceUnit}${recurrenceCount === 1 ? '' : 's'}`}
          </div>
        ) : (
          <button
            type="button"
            className="detail-recurrence-toggle"
            disabled={!dueDate || isReadOnlyViewer}
            onClick={() => onIsRecurringChange(true)}
          >
            Does not repeat
          </button>
        )}
        {isRecurring && !(recurrenceDays && recurrenceDays.length > 0) && (
          <div className="detail-field-inline" style={{ marginTop: 6 }}>
            <NumberField
              min={1}
              max={MAX_RECURRENCE_COUNT}
              step="1"
              value={recurrenceCount}
              onCommit={(v) => {
                onRecurrenceCountChange(v);
                onRecurrenceDaysChange(null);
              }}
              style={{ width: 56 }}
              disabled={isReadOnlyViewer}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <SelectMenu
                ariaLabel="Repeat unit"
                value={recurrenceUnit}
                onChange={(value) => {
                  onRecurrenceUnitChange(value);
                  onRecurrenceDaysChange(null);
                }}
                options={RECURRENCE_UNITS}
                disabled={isReadOnlyViewer}
              />
            </div>
            <button
              type="button"
              className="btn btn-icon detail-recurrence-clear"
              onClick={() => onIsRecurringChange(false)}
              disabled={isReadOnlyViewer}
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
        {task.isRecurring && (
          <p className="form-hint">
            Completed {recentCompletionCount} of the last 7 days
          </p>
        )}
        {!dueDate && <p className="form-hint">Needs a due date first.</p>}
      </DetailField>
    </div>
  );
}

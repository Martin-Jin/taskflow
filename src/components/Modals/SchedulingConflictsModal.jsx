/**
 * SchedulingConflictsModal — "View details" destination for the rebalance
 * toast (see SchedulerContext's runRebalance), listing every task that
 * couldn't be scheduled along with WHY: a fixed-time clash with a specific
 * event/routine/other task's block, a fixed time that falls outside working
 * hours entirely, a dependency that itself couldn't be scheduled this round
 * (leaving nothing to order the dependent's blocks after), simply no free
 * capacity left in its window, or (distinct from all of those — the task's
 * hours WERE fully placed) a fixed-time task that got shifted to a different
 * time-of-day the same day via allocator.js's same-day fallback. Reuses
 * StatListModal (the same scrollable list-modal shell as the Dashboard's
 * "Missed"/"Overdue" tiles) rather than a bespoke layout.
 */

import React from 'react';
import { AlertTriangle, Ban, Clock3 } from 'lucide-react';
import { addDays, formatDisplayDate, formatTime12h, toISODate } from '../../utils/dateUtils';
import StatListModal from '../Dashboard/StatListModal';

const REASON_ICON = {
  fixed_time_conflict: Clock3,
  fixed_time_outside_hours: Clock3,
  fixed_time_shifted: Clock3,
  dependency_blocked: Ban,
  no_capacity: AlertTriangle,
};

/** Plain-English explanation for one overflow/timeShifted entry's `reason`. */
function describeReason(reason, task) {
  if (!reason) return "Couldn't fit in the available capacity.";
  switch (reason.type) {
    case 'fixed_time_conflict': {
      const item = reason.conflictingItem;
      const timeLabel = task?.fixedTime ? ` at ${formatTime12h(task.fixedTime)}` : '';
      if (!item) return `Couldn't schedule${timeLabel} — that time isn't available.`;
      return `Couldn't schedule${timeLabel} — conflicts with "${item.label}" (${formatTime12h(item.start)}–${formatTime12h(item.end)}).`;
    }
    case 'fixed_time_outside_hours': {
      // A fixed time outside working hours is now scheduled there quite
      // happily (see allocator's placeFixedTimeInDay), so this reason no
      // longer means "outside your hours" — the only way it still fires is a
      // pinned time that has already gone by today, where nothing occupies
      // the slot and the day's usable range starts after it.
      const timeLabel = task?.fixedTime ? ` (${formatTime12h(task.fixedTime)})` : '';
      return `This time${timeLabel} has already passed today.`;
    }
    case 'fixed_time_shifted': {
      const item = reason.conflictingItem;
      const timeLabel = task?.fixedTime ? ` at ${formatTime12h(task.fixedTime)}` : '';
      const conflictNote = item ? ` (conflicts with "${item.label}", ${formatTime12h(item.start)}–${formatTime12h(item.end)})` : '';
      return `Could not be scheduled${timeLabel}${conflictNote} — placed elsewhere on the same day instead.`;
    }
    case 'dependency_blocked': {
      const deps = reason.blockingDependencies || [];
      if (deps.length === 0) return "Couldn't be scheduled — a task it depends on couldn't be scheduled either.";
      const names = deps.map((d) => `"${d.title}"`).join(', ');
      return deps.length === 1
        ? `Couldn't be scheduled — depends on ${names}, which itself couldn't be fit in.`
        : `Couldn't be scheduled — depends on ${deps.length} tasks that couldn't be fit in: ${names}.`;
    }
    case 'no_capacity':
    default:
      return "No free time left in this task's window — consider extending its due date or freeing up capacity.";
  }
}

/** "Today" / "Tomorrow" / a full display date for a conflict's grouping day. */
function describeDay(dateIso) {
  if (!dateIso) return 'No due date';
  const today = toISODate(new Date());
  if (dateIso === today) return 'Today';
  if (dateIso === addDays(today, 1)) return 'Tomorrow';
  return formatDisplayDate(dateIso);
}

/**
 * The day a conflict entry "occurred" on: the conflict's own `dueDate` (set
 * by allocator.js's overflow-push — see its own comment) if present,
 * otherwise falling back to the task's `dueDate` for older overflow entries
 * that predate that field. Exported so its grouping/sort behavior — in
 * particular, that entries sharing a task but carrying DIFFERENT `dueDate`s
 * (e.g. a recurring task with multiple missed occurrences) key and sort by
 * their own conflict date, not the task's, which is what previously caused
 * same-day conflicts across different tasks/occurrences to collapse into
 * one incorrectly-grouped "day" — is covered by a standalone unit test
 * rather than only by rendering this modal.
 */
export function conflictDayKey(conflictItem) {
  return conflictItem.dueDate || conflictItem.task?.dueDate || null;
}

/**
 * Attaches each conflict's resolved task and sorts by conflictDayKey, undated
 * entries trailing last — the shape StatListModal's `items` prop expects.
 * Pure and exported so the grouping/sort behavior is unit-testable without
 * rendering the modal.
 */
export function buildConflictItems(conflicts, tasks) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return conflicts
    .map((c) => ({ ...c, task: taskById.get(c.taskId) }))
    .filter((c) => c.task)
    .sort((a, b) => {
      const da = conflictDayKey(a) || '9999-99-99';
      const db = conflictDayKey(b) || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : 0;
    });
}

export default function SchedulingConflictsModal({ conflicts, tasks, onOpenDay, onClose }) {
  const items = buildConflictItems(conflicts, tasks);

  // Jumping to a day switches tabs away from wherever this modal is open, so
  // (unlike the old "open the task's edit modal on top" behavior) it also
  // closes this modal — otherwise it'd be left floating over the Calendar
  // tab it just navigated to.
  function openDayAndClose(dateIso) {
    onOpenDay(dateIso);
    onClose();
  }

  return (
    <StatListModal
      title="Scheduling conflicts"
      items={items}
      emptyMessage="No scheduling conflicts."
      onClose={onClose}
      renderItem={(item, index) => {
        const Icon = REASON_ICON[item.reason?.type] || AlertTriangle;
        const dayKey = conflictDayKey(item);
        const isNewDay = index === 0 || dayKey !== conflictDayKey(items[index - 1]);
        const dayLabel = describeDay(dayKey);
        // Keyed by index rather than bare taskId: a task can legitimately
        // appear twice in `items` now (e.g. an `overflow` entry AND a
        // `fixed_time_shifted` `timeShifted` entry for the same fixedTime
        // task/occurrence on the same run — see allocateTasks' doc comment).
        return (
          <React.Fragment key={`${item.taskId}_${dayKey || 'undated'}_${item.reason?.type || 'none'}_${index}`}>
            {isNewDay && <li className="stat-list-section-header">{dayLabel}</li>}
            <li
              className="missed-tasks-item is-openable"
              role="button"
              tabIndex={0}
              onClick={() => openDayAndClose(dayKey || toISODate(new Date()))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openDayAndClose(dayKey || toISODate(new Date()));
                }
              }}
            >
              <Icon size={13} className="missed-tasks-icon" aria-hidden="true" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span className="missed-tasks-title">{item.task.title}</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                  {describeReason(item.reason, item.task)}
                </span>
              </div>
            </li>
          </React.Fragment>
        );
      }}
    />
  );
}

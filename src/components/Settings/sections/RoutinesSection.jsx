/**
 * Settings → Fixed routines — the drag-to-edit 24h timeline (RoutineTimeline)
 * for sleep/meals/commute blocks subtracted from every day's capacity before
 * tasks are scheduled.
 *
 * THE DAY PICKER beside the timeline is what makes per-day routines editable.
 * A routine has always carried `daysOfWeek`, but the only way to reach it was
 * to create a routine and accept all seven days — so "gym on Tuesdays" wasn't
 * expressible. Picking a day filters the timeline to what applies then, and
 * anything drawn while a day is selected applies to that day only.
 *
 * "All days" is the default and is not merely a filter: it's the mode in which
 * a new routine gets all seven days, which is what most routines want. The
 * two modes are deliberately the same timeline rather than a separate editor —
 * the drag gestures, protected-routine rules and rename behaviour are all
 * identical, and only the day scope differs.
 */

import React, { useMemo, useState } from 'react';
import { useScheduler } from '../../../context/SchedulerContext';
import RoutineTimeline from '../RoutineTimeline';
import { WEEKDAY_ORDER, WEEKDAY_NAMES } from '../../../utils/workHours';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export default function RoutinesSection({ sectionRef }) {
  const { routines, setRoutines, setNotification } = useScheduler();
  // null = "All days". A number 0-6 scopes the timeline to that weekday.
  const [selectedDay, setSelectedDay] = useState(null);

  const visibleRoutines = useMemo(
    () => (selectedDay === null ? routines : routines.filter((r) => (r.daysOfWeek || ALL_DAYS).includes(selectedDay))),
    [routines, selectedDay]
  );

  function updateRoutine(id, updates) {
    setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }

  function addRoutine(startTime, endTime) {
    const id = `rt_${Date.now()}`;
    setRoutines((prev) => [
      ...prev,
      {
        id,
        label: 'New routine',
        startTime,
        endTime,
        // Scoped to whatever the picker is showing, which is the whole point:
        // drawing on "Tuesday" should not silently block out every day.
        daysOfWeek: selectedDay === null ? ALL_DAYS : [selectedDay],
        isActive: true,
      },
    ]);
    return id;
  }

  function removeRoutine(id) {
    const routine = routines.find((r) => r.id === id);
    if (routine?.isProtected) {
      setNotification({ type: 'error', message: `"${routine.label}" is a protected routine and can't be deleted.` });
      return;
    }
    setRoutines((prev) => prev.filter((r) => r.id !== id));
  }

  /** Adds or removes one day from a routine's scope, refusing to leave it with none. */
  function toggleRoutineDay(id, day) {
    setRoutines((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const days = r.daysOfWeek || ALL_DAYS;
        const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
        // A routine applying to no days is invisible everywhere and impossible
        // to get back to — refuse rather than creating an orphan.
        if (next.length === 0) return r;
        return { ...r, daysOfWeek: next };
      })
    );
  }

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Fixed routines</h3>
      <p className="settings-hint">These are subtracted from a day's capacity before tasks are scheduled.</p>
      <p className="form-hint" style={{ marginBottom: 8 }}>
        Drag on empty space to block out a new routine, drag a block to move it, drag its top/bottom edge to
        resize — click its label to rename, and use the pause/delete buttons on a block to switch it off or remove it.
      </p>

      <div className="routines-layout">
        <RoutineTimeline
          routines={visibleRoutines}
          onAdd={addRoutine}
          onUpdate={updateRoutine}
          onRemove={removeRoutine}
          selectedDay={selectedDay}
          onToggleRoutineDay={toggleRoutineDay}
        />

        <div className="routine-day-picker" role="group" aria-label="Which day to edit">
          <button
            type="button"
            className={`routine-day-option ${selectedDay === null ? 'is-selected' : ''}`}
            aria-pressed={selectedDay === null}
            onClick={() => setSelectedDay(null)}
          >
            All days
          </button>
          {WEEKDAY_ORDER.map((day) => {
            const count = routines.filter((r) => (r.daysOfWeek || ALL_DAYS).includes(day)).length;
            return (
              <button
                key={day}
                type="button"
                className={`routine-day-option ${selectedDay === day ? 'is-selected' : ''}`}
                aria-pressed={selectedDay === day}
                onClick={() => setSelectedDay(day)}
              >
                <span>{WEEKDAY_NAMES[day]}</span>
                {/* The count is the useful bit: it shows at a glance which days
                    have extra routines without selecting each one. */}
                <span className="routine-day-count">{count}</span>
              </button>
            );
          })}
          <p className="form-hint routine-day-note">
            {selectedDay === null
              ? 'Showing every routine. A new one drawn here applies to all seven days.'
              : `Showing ${WEEKDAY_NAMES[selectedDay]} only. A new one drawn here applies to ${WEEKDAY_NAMES[selectedDay]} alone.`}
          </p>
        </div>
      </div>
    </div>
  );
}

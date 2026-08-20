/**
 * Settings → Fixed routines — the drag-to-edit 24h timeline (RoutineTimeline)
 * for sleep/meals/commute blocks subtracted from every day's capacity before
 * tasks are scheduled.
 */

import React from 'react';
import { useScheduler } from '../../../context/SchedulerContext';
import RoutineTimeline from '../RoutineTimeline';

export default function RoutinesSection({ sectionRef }) {
  const { routines, setRoutines, setNotification } = useScheduler();

  function updateRoutine(id, updates) {
    setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }

  function addRoutine(startTime, endTime) {
    const id = `rt_${Date.now()}`;
    setRoutines((prev) => [
      ...prev,
      { id, label: 'New routine', startTime, endTime, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
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

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Fixed routines</h3>
      <p className="settings-hint">These are subtracted from every day's capacity before tasks are scheduled.</p>
      <p className="form-hint" style={{ marginBottom: 8 }}>
        Drag on empty space to block out a new routine, drag a block to move it, drag its top/bottom edge to
        resize — click its dot to pause/resume, click its label to rename.
      </p>
      <RoutineTimeline routines={routines} onAdd={addRoutine} onUpdate={updateRoutine} onRemove={removeRoutine} />
    </div>
  );
}

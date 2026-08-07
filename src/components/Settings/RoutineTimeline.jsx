/**
 * RoutineTimeline — a single 24-hour "day" column for editing Fixed
 * routines by drag rather than by typing start/end times:
 *   - Drag on empty space -> creates a new routine spanning the drag.
 *   - Drag a block's body -> moves it (start/end shift together).
 *   - Drag a block's top/bottom edge -> resizes that end only.
 *   - Click the trash icon -> removes the routine (hidden for a protected
 *     routine, e.g. Sleep — it can still be dragged/resized/paused, just
 *     not deleted, see FixedRoutine.isProtected).
 *   - Click the label -> rename inline; click the dot -> toggle active.
 * Mirrors the interaction model of Calendar/WeekView (mousedown+drag to
 * block out time, edge-drag to resize) so the gesture feels familiar.
 */
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { timeToMinutes, minutesToTime } from '../../utils/dateUtils';

const GRID_END_MIN = 24 * 60;
const SNAP_MIN = 5;
const HOUR_HEIGHT = 36;
const PX_PER_MIN = HOUR_HEIGHT / 60;
const MIN_DURATION_MIN = SNAP_MIN;

function clampMinutes(mins) {
  return Math.max(0, Math.min(GRID_END_MIN, mins));
}

export default function RoutineTimeline({ routines, onAdd, onUpdate, onRemove }) {
  const columnRef = useRef(null);
  const [createDrag, setCreateDrag] = useState(null); // { startMin, currentMin }
  const [editingId, setEditingId] = useState(null);

  // Holds the remove-listener teardown for whichever drag is currently in
  // progress, so it can be run on unmount too — without this, dragging then
  // switching settings tabs mid-drag leaves stale window listeners racing
  // against the unmounted component's closures.
  const activeDragCleanupRef = useRef(null);
  useEffect(() => () => activeDragCleanupRef.current?.(), []);

  const hourMarks = [];
  for (let m = 0; m <= GRID_END_MIN; m += 60) hourMarks.push(m);

  function minuteFromEvent(evt, rect) {
    const relY = evt.clientY - rect.top;
    return Math.round(clampMinutes(relY / PX_PER_MIN) / SNAP_MIN) * SNAP_MIN;
  }

  function handleColumnMouseDown(e) {
    if (e.target !== e.currentTarget || e.button !== 0) return;
    // Captured once at drag-start and reused for the whole gesture — the
    // settings panel isn't expected to scroll/resize mid-drag, so we accept
    // not re-measuring on every move.
    const rect = e.currentTarget.getBoundingClientRect();
    const startMin = minuteFromEvent(e, rect);
    let currentMin = startMin + SNAP_MIN;
    setCreateDrag({ startMin, currentMin });

    function onMove(moveEvent) {
      currentMin = minuteFromEvent(moveEvent, rect);
      setCreateDrag({ startMin, currentMin });
    }

    function onUp() {
      cleanup();
      setCreateDrag(null);
      const from = Math.min(startMin, currentMin);
      const to = Math.max(startMin, currentMin, startMin + MIN_DURATION_MIN);
      const id = onAdd(minutesToTime(from), minutesToTime(to));
      if (id) setEditingId(id);
    }

    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      activeDragCleanupRef.current = null;
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    activeDragCleanupRef.current = cleanup;
  }

  function handleMoveStart(e, routine) {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const origStart = timeToMinutes(routine.startTime);
    const origEnd = timeToMinutes(routine.endTime);
    const duration = origEnd - origStart;

    function apply(moveEvent) {
      const deltaMin = Math.round((moveEvent.clientY - startY) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
      let newStart = origStart + deltaMin;
      newStart = Math.max(0, Math.min(GRID_END_MIN - duration, newStart));
      return { startTime: minutesToTime(newStart), endTime: minutesToTime(newStart + duration) };
    }

    function onMove(moveEvent) {
      onUpdate(routine.id, apply(moveEvent));
    }
    function onUp(upEvent) {
      onUpdate(routine.id, apply(upEvent));
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      activeDragCleanupRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    activeDragCleanupRef.current = cleanup;
  }

  function handleResizeStart(e, routine, edge) {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const origStart = timeToMinutes(routine.startTime);
    const origEnd = timeToMinutes(routine.endTime);

    function apply(moveEvent) {
      const deltaMin = Math.round((moveEvent.clientY - startY) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
      if (edge === 'top') {
        const newStart = Math.max(0, Math.min(origEnd - MIN_DURATION_MIN, origStart + deltaMin));
        return { startTime: minutesToTime(newStart) };
      }
      const newEnd = Math.min(GRID_END_MIN, Math.max(origStart + MIN_DURATION_MIN, origEnd + deltaMin));
      return { endTime: minutesToTime(newEnd) };
    }

    function onMove(moveEvent) {
      onUpdate(routine.id, apply(moveEvent));
    }
    function onUp(upEvent) {
      onUpdate(routine.id, apply(upEvent));
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      activeDragCleanupRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    activeDragCleanupRef.current = cleanup;
  }

  const gridHeight = GRID_END_MIN * PX_PER_MIN;

  return (
    <div className="routine-timeline">
      <div className="routine-timeline-gutter" style={{ height: gridHeight }}>
        {hourMarks.map((m) => (
          <div key={m} className="routine-timeline-hour" style={{ top: m * PX_PER_MIN - 6 }}>
            {minutesToTime(m)}
          </div>
        ))}
      </div>
      <div
        className="routine-timeline-column"
        ref={columnRef}
        style={{ height: gridHeight }}
        onMouseDown={handleColumnMouseDown}
      >
        {hourMarks.map((m) => (
          <div key={m} className="routine-timeline-gridline" style={{ top: m * PX_PER_MIN }} />
        ))}

        {createDrag && (
          <div
            className="routine-timeline-ghost"
            style={{
              top: Math.min(createDrag.startMin, createDrag.currentMin) * PX_PER_MIN,
              height: Math.max(SNAP_MIN, Math.abs(createDrag.currentMin - createDrag.startMin)) * PX_PER_MIN,
            }}
          >
            New routine
          </div>
        )}

        {routines.map((r) => {
          const top = timeToMinutes(r.startTime) * PX_PER_MIN;
          const height = Math.max(20, (timeToMinutes(r.endTime) - timeToMinutes(r.startTime)) * PX_PER_MIN);
          const showTime = height >= 30;
          return (
            <div
              key={r.id}
              className={`routine-block ${r.isActive ? '' : 'inactive'}`}
              style={{ top, height }}
              onMouseDown={(e) => handleMoveStart(e, r)}
            >
              <div className="routine-block-edge routine-block-edge-top" onMouseDown={(e) => handleResizeStart(e, r, 'top')} />
              <div className="routine-block-row">
                <button
                  type="button"
                  className="routine-block-dot"
                  title={r.isActive ? 'Active — click to pause' : 'Paused — click to activate'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onUpdate(r.id, { isActive: !r.isActive })}
                />
                {editingId === r.id ? (
                  <input
                    className="routine-block-label-input"
                    autoFocus
                    defaultValue={r.label}
                    onMouseDown={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => {
                      onUpdate(r.id, { label: e.target.value.trim() || r.label });
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="routine-block-label"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setEditingId(r.id)}
                  >
                    {r.label}
                  </button>
                )}
                {!showTime && (
                  <span className="routine-block-time routine-block-time-inline">
                    {r.startTime}–{r.endTime}
                  </span>
                )}
                {!r.isProtected && (
                  <button
                    type="button"
                    className="routine-block-remove"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onRemove(r.id)}
                    aria-label={`Delete ${r.label}`}
                    title="Delete routine"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              {showTime && (
                <div className="routine-block-time">
                  {r.startTime}–{r.endTime}
                </div>
              )}
              <div className="routine-block-edge routine-block-edge-bottom" onMouseDown={(e) => handleResizeStart(e, r, 'bottom')} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * EventDetailModal — edits a single CalendarEvent (a slice of "busy" time on
 * the calendar, distinct from a task's ScheduledBlock). Two modes:
 *
 *   - MANUAL event (source: 'manual', or `event === null` for creation): the
 *     user owns this outright, so title/date/start/end are all editable and
 *     it can be deleted. This is the "block out time" feature — plans
 *     changed, block off 3 hours, and the next Re-balance schedules around
 *     it like any other busy time.
 *
 *   - GOOGLE event (source: 'google'): title/time came from Google Calendar
 *     and aren't editable here (edit them in Google Calendar itself, it'll
 *     sync back on the next fetch). The only control is "Ignore this event"
 *     (isFreeTime) — TaskFlow's own override that lets the scheduler place
 *     work over an event without touching it in Google Calendar. If the
 *     event is part of a recurring series (`seriesId`), a scope picker
 *     mirrors Google Calendar's own "This event / This and following /
 *     All events" prompt so the override can apply to the whole series at
 *     once instead of one instance at a time.
 *
 * Uses the same header + icon-labeled field-row language as
 * BlockDetailModal/TaskDetailModal for visual consistency, full-width (no
 * two-column split) since there's no free-text "main" content beyond the
 * title itself.
 */

import React, { useState } from 'react';
import { X, CalendarClock, Clock, Type as TitleIcon, ListTree, Ban } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import DetailField from '../Common/DetailField';

const SCOPE_OPTIONS = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following events' },
  { value: 'all', label: 'All events in the series' },
];

export default function EventDetailModal({ event, initial, onClose }) {
  const { addManualEvent, updateEvent, deleteEvent, setEventIgnored } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const isCreate = !event;
  const isManual = isCreate || event.source === 'manual';

  const [title, setTitle] = useState(event?.title || 'Blocked time');
  const [date, setDate] = useState(event?.date || initial?.date || '');
  const [startTime, setStartTime] = useState(event?.startTime || initial?.startTime || '');
  const [endTime, setEndTime] = useState(event?.endTime || initial?.endTime || '');
  const [ignored, setIgnored] = useState(!!event?.isFreeTime);
  const [scope, setScope] = useState('this');

  function handleSave() {
    if (isCreate) {
      addManualEvent({ title, date, startTime, endTime });
    } else if (isManual) {
      updateEvent(event.id, { title: title.trim() || 'Blocked time', date, startTime, endTime });
    } else {
      setEventIgnored(event, ignored, scope);
    }
    requestClose();
  }

  function handleDelete() {
    deleteEvent(event.id);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-detail"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420 }}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-detail-title"
        tabIndex={-1}
      >
        <div className="detail-header">
          <h3 id="event-detail-title" style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', flex: 1 }}>
            {isCreate ? 'Block out time' : isManual ? 'Edit blocked time' : event.title}
          </h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {isManual ? (
          <>
            <div className="detail-sidebar detail-sidebar--full">
              <DetailField icon={TitleIcon} label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Doing something else" />
              </DetailField>
              <DetailField icon={CalendarClock} label="Date">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </DetailField>
              <DetailField icon={Clock} label="Start time">
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </DetailField>
              <DetailField icon={Clock} label="End time">
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </DetailField>
            </div>
            <p className="form-hint">
              Blocked time counts as busy, same as a Google Calendar event — Re-balance schedule will plan tasks
              around it.
            </p>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              {event.date} · {event.startTime}–{event.endTime}
              {event.calendarName && event.calendarName !== 'primary' ? ` · ${event.calendarName}` : ''}
            </p>
            <div className="detail-sidebar detail-sidebar--full">
              <DetailField icon={Ban} label="Ignore">
                <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={ignored} onChange={(e) => setIgnored(e.target.checked)} />
                  Ignore this event (let the scheduler use this time)
                </label>
                <p className="form-hint">
                  Equivalent to this time not being blocked out at all — TaskFlow will schedule tasks right over it.
                  This doesn't change anything in Google Calendar itself.
                </p>
              </DetailField>
              {event.seriesId && (
                <DetailField icon={ListTree} label="Apply to">
                  <select value={scope} onChange={(e) => setScope(e.target.value)}>
                    {SCOPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <p className="form-hint">This is a recurring event — choose how far the change should apply.</p>
                </DetailField>
              )}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          {isManual && !isCreate && (
            <button className="btn" onClick={handleDelete} style={{ color: 'var(--danger)', marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {isCreate ? 'Block time' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

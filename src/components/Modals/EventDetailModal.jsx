/**
 * EventDetailModal — edits a single CalendarEvent (a slice of "busy" time on
 * the calendar, distinct from a task's ScheduledBlock).
 *
 * Every event is fully editable here regardless of `source` — this mirrors
 * real Google Calendar's own edit popup, where editing an event's
 * title/description/location/time from anywhere pushes back to the
 * calendar. A manual event just stays local; a Google-sourced event's edits
 * are pushed on the next sync (wired up in a later milestone — for now
 * edits here are local-only, same as any manual event).
 *
 * If the event is part of a recurring series (`seriesId`), a scope picker
 * mirrors Google Calendar's own "This event / This and following / All
 * events" prompt, gating both Save (for edited fields) and the "Ignore this
 * event" override — TaskFlow's own way of letting the scheduler place work
 * over an event without touching it in Google Calendar.
 *
 * Uses the same header + icon-labeled field-row language as
 * TaskDetailModal for visual consistency, full-width (no two-column split)
 * since there's no free-text "main" content beyond the title itself.
 */

import React, { useRef, useState } from 'react';
import { X, CalendarClock, Clock, Type as TitleIcon, ListTree, Ban, AlignLeft, MapPin } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
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

  const [title, setTitle] = useState(event?.title || '');
  const [description, setDescription] = useState(event?.description || '');
  const [location, setLocation] = useState(event?.location || '');
  const [date, setDate] = useState(event?.date || initial?.date || '');
  const [startTime, setStartTime] = useState(event?.startTime || initial?.startTime || '');
  const [endTime, setEndTime] = useState(event?.endTime || initial?.endTime || '');
  const [ignored, setIgnored] = useState(!!event?.isFreeTime);
  const [scope, setScope] = useState('this');

  const descriptionRef = useRef(null);
  useAutosizeTextarea(descriptionRef, description);

  function handleSave() {
    if (isCreate) {
      addManualEvent({ title, description, location, date, startTime, endTime });
    } else {
      updateEvent(
        event.id,
        { title: title.trim() || 'Untitled event', description, location, date, startTime, endTime },
        scope
      );
      if (ignored !== !!event.isFreeTime) {
        setEventIgnored(event, ignored, scope);
      }
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
            {isCreate ? 'New event' : event.title || 'Untitled event'}
          </h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!isCreate && event.calendarName && event.calendarName !== 'primary' && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Synced from {event.calendarName}</p>
        )}

        <div className="detail-sidebar detail-sidebar--full">
          <DetailField icon={TitleIcon} label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Team standup" />
          </DetailField>
          <DetailField icon={AlignLeft} label="Description">
            <textarea
              ref={descriptionRef}
              className="detail-notes-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
            />
          </DetailField>
          <DetailField icon={MapPin} label="Location">
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Conference room" />
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
          {!isCreate && (
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
          )}
          {!isCreate && event.seriesId && (
            <DetailField icon={ListTree} label="Apply to">
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                {SCOPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="form-hint">This is a recurring event — choose how far Save and Ignore should apply.</p>
            </DetailField>
          )}
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          {!isCreate && (
            <button className="btn" onClick={handleDelete} style={{ color: 'var(--color-danger)', marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {isCreate ? 'Add event' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * EventDetailModal — edits a single CalendarEvent (a slice of "busy" time on
 * the calendar, distinct from a task's ScheduledBlock).
 *
 * A manual event (created in TaskFlow) or a Google-sourced event from a
 * calendar the user owns/can write to (`canEdit !== false`) is fully
 * editable here, mirroring real Google Calendar's own edit popup — editing
 * title/description/location/time pushes back to the calendar via
 * SchedulerContext.updateEvent, including a 'this'-scope edit on a single
 * occurrence of a recurring series (pushed via Google's deterministic
 * per-instance id — see googleCalendarService.pushEventInstanceUpdate).
 *
 * A Google-sourced event from a calendar the user only has read access to
 * (e.g. a subscribed lecture timetable shared as viewer-only) is rendered
 * read-only (`event.canEdit === false`): fields are disabled and Delete is
 * hidden, since Google would reject a write against a calendar we don't own.
 * The "Ignore this event" toggle is the one exception — it's local-only
 * (SchedulerContext.setEventIgnored never pushes to Google) so it stays
 * available even on a read-only event, still via the same Save action.
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
import { timeToMinutes } from '../../utils/dateUtils';
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
  // Only an explicit `canEdit === false` counts as read-only — a manual event
  // (no `canEdit` field at all) or mock data must still be treated as fully
  // editable, so this deliberately checks `=== false` rather than `!canEdit`.
  const isReadOnly = !isCreate && event.canEdit === false;

  const [title, setTitle] = useState(event?.title || '');
  const [description, setDescription] = useState(event?.description || '');
  const [location, setLocation] = useState(event?.location || '');
  const [date, setDate] = useState(event?.date || initial?.date || '');
  const [startTime, setStartTime] = useState(event?.startTime || initial?.startTime || '');
  const [endTime, setEndTime] = useState(event?.endTime || initial?.endTime || '');
  const [ignored, setIgnored] = useState(!!event?.isFreeTime);
  const [scope, setScope] = useState('this');
  const [error, setError] = useState('');

  const descriptionRef = useRef(null);
  useAutosizeTextarea(descriptionRef, description, { maxLines: 4.5 });

  function handleSave() {
    if (!isReadOnly) {
      if (!date || !startTime || !endTime) {
        setError('Date, start time, and end time are all required.');
        return;
      }
      if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        setError('End time must be after start time.');
        return;
      }
    }
    setError('');
    if (isCreate) {
      addManualEvent({ title, description, location, date, startTime, endTime });
    } else {
      // Read-only events (subscribed/shared calendars without write access)
      // skip updateEvent entirely — its fields are disabled below so they
      // can't have changed anyway, but more importantly updateEvent also
      // pushes to Google (see SchedulerContext.updateEvent), which would
      // fail against a calendar we don't own. The "Ignore" toggle below is
      // local-only (setEventIgnored never pushes) so it stays available
      // through this same Save action regardless of read-only status.
      if (!isReadOnly) {
        const fieldUpdates = { title: title.trim() || 'Untitled event', description, location, startTime, endTime };
        // "Date" only ever means "move just THIS occurrence to a different
        // day" — for 'following'/'all' scope on a recurring event, the date
        // field is left out of the pushed updates entirely rather than
        // overwriting the master's own DTSTART with whatever occurrence
        // happened to be open (the input is disabled for that scope below,
        // for the same reason).
        if (!event.seriesId || scope === 'this') fieldUpdates.date = date;
        updateEvent(event.id, fieldUpdates, scope);
      }
      if (ignored !== !!event.isFreeTime) {
        setEventIgnored(event, ignored, scope);
      }
    }
    requestClose();
  }

  function handleDelete() {
    // scope is only meaningful for a recurring event (see the scope picker
    // below) — deleteEvent defaults to 'all' for anything else, so passing
    // it through unconditionally is safe for non-recurring events too.
    deleteEvent(event.id, scope);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-detail"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560 }}
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

        {error && <p className="form-error">{error}</p>}

        {!isCreate && event.calendarName && event.calendarName !== 'primary' && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Synced from {event.calendarName}</p>
        )}
        {isReadOnly && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
            View only — you don't have edit access to this calendar on Google Calendar.
          </p>
        )}

        <div className="detail-sidebar detail-sidebar--full">
          <DetailField icon={TitleIcon} label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Team standup" disabled={isReadOnly} />
          </DetailField>
          <DetailField icon={AlignLeft} label="Description">
            <textarea
              ref={descriptionRef}
              className="detail-notes-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
              disabled={isReadOnly}
            />
          </DetailField>
          <DetailField icon={MapPin} label="Location">
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Conference room"
              disabled={isReadOnly}
            />
          </DetailField>
          <DetailField icon={CalendarClock} label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={isReadOnly || (!isCreate && !!event.seriesId && scope !== 'this')}
            />
            {!isCreate && event.seriesId && scope !== 'this' && (
              <p className="form-hint">Moving the date only applies to a single occurrence — set "Apply to" to "This event" first.</p>
            )}
          </DetailField>
          <DetailField icon={Clock} label="Start time">
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={isReadOnly} />
          </DetailField>
          <DetailField icon={Clock} label="End time">
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={isReadOnly} />
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
          {!isCreate && !isReadOnly && (
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

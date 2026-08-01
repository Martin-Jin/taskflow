/**
 * EventDetailModal — edits a single CalendarEvent (a slice of "busy" time on
 * the calendar, distinct from a task's ScheduledBlock).
 *
 * A manual event (created in TaskFlow) or a Google-sourced event from a
 * calendar the user owns/can write to (`canEdit !== false`) is fully
 * editable here, mirroring real Google Calendar's own edit popup — editing
 * title/description/location/time pushes back to the calendar via
 * SchedulerContext.updateEvent, including a 'this'-scope edit on a single
 * occurrence of a recurring series (pushed via Google's real per-occurrence
 * instance id, resolved through `events.instances()` — see
 * googleCalendarService.pushEventInstanceUpdate).
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
import { X, CalendarClock, Clock, Type as TitleIcon, ListTree, Ban, AlignLeft, MapPin, Repeat } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { timeToMinutes } from '../../utils/dateUtils';
import { buildRRuleString, parseRRule } from '../../utils/recurrenceExpansion';
import { findRecurrencePhrase, WEEKDAY_LABELS } from '../../utils/recurrence';
import { stripMatchedText } from '../../utils/smartParse';
import DetailField from '../Common/DetailField';
import SmartRecurrenceInput from '../Common/SmartRecurrenceInput';

const SCOPE_OPTIONS = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following events' },
  { value: 'all', label: 'All events in the series' },
];

// A detected "every year" phrase (from either the Title field or the Repeat
// box itself) is deliberately never applied — recurrenceExpansion.parseRRule
// (the module that actually walks occurrences for display) only understands
// DAILY/WEEKLY/MONTHLY, so silently mapping YEARLY to one of those would
// create an event that repeats on the wrong cadence. See handleTitleChange
// and commitRepeatText below, which both guard on `match.rule.unit !== 'year'`.

/**
 * Canonical human phrase for a given interval/freq/byDay, used to (re)seed
 * SmartRecurrenceInput's text box — both as its initial value (create mode
 * default, or parsed off an existing event's recurrenceRule in edit mode)
 * and to "clean up" the box after a successful parse (e.g. "Every  2  weeks"
 * typed in becomes "every 2 weeks"). Mirrors the phrasing
 * TaskDetailModal.commitRepeatEditText's toggle button already uses for its
 * day-specific case.
 */
function formatRepeatText(interval, freq, byDay) {
  if (freq === 'WEEKLY' && byDay && byDay.length) {
    return `every ${interval === 1 ? '' : `${interval} `}week${interval === 1 ? '' : 's'} on ${byDay
      .map((d) => WEEKDAY_LABELS[d])
      .join(', ')}`;
  }
  const unit = freq === 'DAILY' ? 'day' : freq === 'MONTHLY' ? 'month' : 'week';
  return `every ${interval === 1 ? '' : `${interval} `}${unit}${interval === 1 ? '' : 's'}`;
}

export default function EventDetailModal({ event, initial, onClose, onDeleted }) {
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

  // A "true-RRULE" series (one master row carrying `recurrenceRule`, whose
  // occurrences are only ever virtual — see recurrenceExpansion.js) is the
  // only series shape this modal's Repeat editor can meaningfully touch. A
  // "synthetic" series (seriesId set, but no recurrenceRule — Google returned
  // one real row per occurrence instead of a single RRULE) has no single
  // cadence to edit: applyEventScopeUpdate's 'all' scope for that shape fans
  // a field update across EVERY row in the series rather than one master, so
  // stamping a `recurrenceRule` there would give every one of those rows its
  // own (wrong) recurring series on next expand. Repeat editing is hidden
  // entirely for that shape rather than risking that.
  const isSeriesEvent = !isCreate && !!event.seriesId;
  const isTrueRruleSeries = isSeriesEvent && !!event.recurrenceRule;
  // Whether the Repeat DetailField renders at all.
  const repeatFieldVisible = isCreate || !isSeriesEvent || isTrueRruleSeries;
  // Whether its controls are interactive and will actually be saved —
  // changing a whole series' cadence only makes sense at 'all' scope (a
  // 'this'/'following' edit only ever touches one occurrence's overrides or
  // a date-based split, neither of which has a natural cadence to change).
  const repeatControlsApply = isCreate || !isSeriesEvent || (isTrueRruleSeries && scope === 'all');

  // "Repeat" — for a plain event this turns it into a recurring one for the
  // first time (see handleSave); for an existing true-RRULE series (at 'all'
  // scope only — see repeatControlsApply above) it edits the master's own
  // cadence. Seeded from the event's existing recurrenceRule when there is
  // one, so opening an already-recurring event shows its real pattern.
  const initialRule = isTrueRruleSeries ? parseRRule(event.recurrenceRule) : null;
  const [repeats, setRepeats] = useState(!!initialRule);
  const [repeatInterval, setRepeatInterval] = useState(initialRule?.interval || 1);
  const [repeatFreq, setRepeatFreq] = useState(initialRule?.freq || 'WEEKLY');
  const [repeatByDay, setRepeatByDay] = useState(initialRule?.byDay || null); // set only via smart-parse (e.g. "every mon, wed") — no manual picker for it
  const [repeatEndType, setRepeatEndType] = useState(initialRule?.count ? 'count' : initialRule?.until ? 'until' : 'never'); // 'never' | 'count' | 'until'
  const [repeatCount, setRepeatCount] = useState(initialRule?.count || 10);
  const [repeatUntil, setRepeatUntil] = useState(initialRule?.until || '');
  // The SmartRecurrenceInput's live text (e.g. "every 2 weeks") — kept in
  // sync with repeatInterval/repeatFreq/repeatByDay via formatRepeatText
  // whenever those change from a source OTHER than this box itself (title
  // smart-parse, initial load); the box's own edits go the other way,
  // parsing text back into those fields on blur/Enter (see commitRepeatText).
  const [repeatText, setRepeatText] = useState(
    formatRepeatText(initialRule?.interval || 1, initialRule?.freq || 'WEEKLY', initialRule?.byDay || null)
  );

  // Smart-parse detection state — mirrors AddTaskModal/TaskDetailModal's own
  // "typed 'every 2 weeks' inline in the title" behavior (see
  // useSmartTaskTitle.js) so events get the same UX, reusing the exact same
  // recurrence-phrase detector rather than a second copy of the parsing
  // logic. `hasEditedRepeat` mirrors those modals' `hasEditedRecurrence`:
  // once the user manually touches any repeat control, typed-phrase
  // detection stops overwriting their choice.
  const [hasEditedRepeat, setHasEditedRepeat] = useState(false);
  const [detectedRecurrenceMatch, setDetectedRecurrenceMatch] = useState(null);

  function handleTitleChange(value) {
    setTitle(value);
    if (!isCreate || hasEditedRepeat) return;
    const match = findRecurrencePhrase(value);
    // YEARLY has no UI/RRULE support here (see REPEAT_FREQ_OPTIONS's own
    // comment) — a detected "every year" phrase is left in the title
    // untouched rather than silently applied as some other cadence.
    if (match && match.rule.unit !== 'year') {
      const freq = match.rule.unit === 'day' ? 'DAILY' : match.rule.unit === 'week' ? 'WEEKLY' : 'MONTHLY';
      setRepeats(true);
      setRepeatFreq(freq);
      setRepeatInterval(match.rule.count);
      setRepeatByDay(match.rule.days || null);
      setRepeatText(formatRepeatText(match.rule.count, freq, match.rule.days || null));
      setDetectedRecurrenceMatch(match);
    } else if (detectedRecurrenceMatch) {
      // The phrase that drove the last auto-detection got edited away.
      setRepeats(false);
      setRepeatByDay(null);
      setDetectedRecurrenceMatch(null);
    }
  }

  function markRepeatEdited() {
    setHasEditedRepeat(true);
    setDetectedRecurrenceMatch(null);
  }

  // Commits the free-text Repeat box (see the Repeat DetailField below) by
  // running it through the same phrase parser the Title field's smart-parse
  // uses — same defensive behavior as TaskDetailModal.commitRepeatEditText:
  // an unparseable (or unsupported "every year") phrase leaves the
  // last-known-good interval/freq/byDay untouched, and the box is reformatted
  // back to match rather than left showing raw text that no longer reflects
  // state.
  function commitRepeatText() {
    const match = findRecurrencePhrase(repeatText || '');
    if (match && match.rule.unit !== 'year') {
      const freq = match.rule.unit === 'day' ? 'DAILY' : match.rule.unit === 'week' ? 'WEEKLY' : 'MONTHLY';
      setRepeatFreq(freq);
      setRepeatInterval(match.rule.count);
      setRepeatByDay(match.rule.days || null);
      setRepeatText(formatRepeatText(match.rule.count, freq, match.rule.days || null));
    } else {
      setRepeatText(formatRepeatText(repeatInterval, repeatFreq, repeatByDay));
    }
  }

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
      if (repeatControlsApply && repeats && repeatEndType === 'until' && !repeatUntil) {
        setError('Pick an end date, or change "Ends" to "Never" or "After".');
        return;
      }
    }
    setError('');
    if (isCreate) {
      const recurrenceRule = repeats
        ? buildRRuleString({
            freq: repeatFreq,
            interval: repeatInterval,
            byDay: repeatByDay,
            count: repeatEndType === 'count' ? repeatCount : null,
            until: repeatEndType === 'until' ? repeatUntil : null,
          })
        : null;
      const finalTitle = detectedRecurrenceMatch ? stripMatchedText(title, detectedRecurrenceMatch.matchedText) : title;
      addManualEvent({ title: finalTitle, description, location, date, startTime, endTime, recurrenceRule });
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
        // Repeat: only touched when the editor was actually interactive for
        // this event/scope (see repeatControlsApply) — a 'this'/'following'
        // edit on an existing series never carries a cadence change.
        if (repeatControlsApply) {
          if (repeats) {
            fieldUpdates.recurrenceRule = buildRRuleString({
              freq: repeatFreq,
              interval: repeatInterval,
              byDay: repeatByDay,
              count: repeatEndType === 'count' ? repeatCount : null,
              until: repeatEndType === 'until' ? repeatUntil : null,
            });
            fieldUpdates.isRecurring = true;
            // A plain event has no seriesId yet — giving it its own id as
            // seriesId is the same "own id doubles as seriesId when
            // recurring" convention addManualEvent uses, so the "Apply to"
            // scope picker and future edits treat it as a real series.
            if (!isSeriesEvent) fieldUpdates.seriesId = event.id;
          } else if (isTrueRruleSeries) {
            // Repeats was unchecked on an existing series — stop recurring
            // entirely rather than leaving a stale recurrenceRule/seriesId
            // behind (both were only ever meaningful together here).
            fieldUpdates.recurrenceRule = null;
            fieldUpdates.isRecurring = false;
            fieldUpdates.seriesId = null;
          }
        }
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
    // Defense in depth: the optimistic local delete above changes `events`,
    // which can make the caller's own "which event is selected" derivation
    // go null in this same render pass and force this modal to unmount
    // outright — which races out requestClose's animated onClose below (its
    // pending timeout gets cancelled by useAnimatedUnmount's own unmount
    // cleanup before it ever fires). Left alone, that means the "selected
    // event id" the caller is tracking never actually gets cleared, so if a
    // later Google Calendar re-sync merges this event back in (e.g. a poll
    // racing ahead of the delete's propagation on Google's side — see
    // SchedulerContext.deleteEvent), the caller would recompute a match
    // against that stale id and silently reopen this same modal. Callers
    // that track a selected-event id should pass onDeleted to clear it here,
    // synchronously, regardless of which unmount path ends up winning.
    onDeleted?.();
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
            <input
              value={title}
              onChange={(e) => (isCreate ? handleTitleChange(e.target.value) : setTitle(e.target.value))}
              placeholder={isCreate ? 'e.g. Team standup every Monday' : 'e.g. Team standup'}
              disabled={isReadOnly}
            />
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
          {repeatFieldVisible && (
            <DetailField icon={Repeat} label="Repeat">
              <label className="form-checkbox-row" style={{ cursor: repeatControlsApply ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={repeats}
                  disabled={isReadOnly || !repeatControlsApply}
                  onChange={(e) => {
                    markRepeatEdited();
                    setRepeats(e.target.checked);
                  }}
                />
                Repeats
              </label>
              {repeats && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  <SmartRecurrenceInput
                    value={repeatText}
                    disabled={isReadOnly || !repeatControlsApply}
                    onChange={(e) => {
                      markRepeatEdited();
                      setRepeatText(e.target.value);
                    }}
                    onBlur={commitRepeatText}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRepeatText(formatRepeatText(repeatInterval, repeatFreq, repeatByDay));
                    }}
                  />
                  <div className="detail-field-inline">
                    Ends
                    <select
                      value={repeatEndType}
                      disabled={isReadOnly || !repeatControlsApply}
                      onChange={(e) => {
                        markRepeatEdited();
                        setRepeatEndType(e.target.value);
                      }}
                      style={{ flex: 1 }}
                    >
                      <option value="never">Never</option>
                      <option value="count">After</option>
                      <option value="until">On date</option>
                    </select>
                    {repeatEndType === 'count' && (
                      <input
                        type="number"
                        min="1"
                        max="730"
                        step="1"
                        value={repeatCount}
                        disabled={isReadOnly || !repeatControlsApply}
                        onChange={(e) => {
                          markRepeatEdited();
                          setRepeatCount(Math.max(1, Number(e.target.value) || 1));
                        }}
                        style={{ width: 56 }}
                      />
                    )}
                    {repeatEndType === 'until' && (
                      <input
                        type="date"
                        value={repeatUntil}
                        min={date}
                        disabled={isReadOnly || !repeatControlsApply}
                        onChange={(e) => {
                          markRepeatEdited();
                          setRepeatUntil(e.target.value);
                        }}
                      />
                    )}
                    {repeatEndType === 'count' && 'occurrences'}
                  </div>
                </div>
              )}
              {!repeatControlsApply && (
                <p className="form-hint">
                  Editing the repeat pattern only applies when the scope below is set to "All events in the series".
                </p>
              )}
            </DetailField>
          )}
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

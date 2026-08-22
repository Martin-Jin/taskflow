/**
 * Settings → Scheduling rules — buffer days, work-day window, daily hour cap,
 * planning horizon, and the two scheduler behavior toggles. See SchedulerContext's
 * SchedulingRules typedef for what each field actually drives in rebalanceEngine.js.
 */

import React from 'react';
import { useScheduler } from '../../../context/SchedulerContext';
import SelectMenu from '../../Common/SelectMenu';
import NumberField from '../../Common/NumberField';
import { WEEKDAY_ORDER, WEEKDAY_NAMES, hasPerDayWorkHours, seedPerDayWorkHours } from '../../../utils/workHours';

export default function SchedulingSection({ sectionRef }) {
  const { rules, setRules } = useScheduler();
  const perDay = hasPerDayWorkHours(rules);

  /* Switching on seeds all seven days from the single pair the user already
     set, so they edit real values rather than empty inputs. Switching off
     drops the map entirely rather than leaving a stale one behind — its mere
     presence is what puts resolveWorkWindow into per-day mode, so a leftover
     map would keep overriding invisibly. The baseline workDayStart/workDayEnd
     are never touched either way: notify-worker still reads them. */
  function setPerDay(enabled) {
    if (enabled) {
      setRules({ ...rules, workHoursByDay: seedPerDayWorkHours(rules) });
      return;
    }
    const { workHoursByDay, ...withoutMap } = rules;
    setRules(withoutMap);
  }

  function updateDay(day, patch) {
    const existing = rules.workHoursByDay?.[day] || {};
    setRules({
      ...rules,
      workHoursByDay: {
        ...rules.workHoursByDay,
        // Times are written explicitly rather than left to inherit, so
        // un-ticking and re-ticking a day doesn't silently snap it back to the
        // baseline hours the user had already changed away from.
        [day]: { start: existing.start || rules.workDayStart, end: existing.end || rules.workDayEnd, ...existing, ...patch },
      },
    });
  }

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Scheduling rules</h3>
      <div className="form-row">
        <label>Buffer days (finish this many days before due date)</label>
        <NumberField min={0} value={rules.bufferDays} onCommit={(v) => setRules({ ...rules, bufferDays: v })} />
      </div>
      <div className="form-row">
        <label htmlFor="weekStartsOn">First day of the week</label>
        {/* Lives in `rules` rather than a new setting of its own: it's already
            synced and backed up, and every reader gets it from the same place
            as the work-hours rules it sits beside. Defaults to Sunday, which
            is what every week-based view did before this was configurable. */}
        <SelectMenu
          ariaLabel="First day of the week"
          value={String(rules.weekStartsOn ?? 0)}
          onChange={(next) => setRules({ ...rules, weekStartsOn: Number(next) })}
          options={[
            { value: '0', label: 'Sunday' },
            { value: '1', label: 'Monday' },
          ]}
        />
        <p className="form-hint">
          Used by the Calendar's week view, the weekly review, and every "this week" figure on the Dashboard and Stats.
        </p>
      </div>
      {perDay ? (
        /* Per-day mode. One row per weekday rather than seven pairs of
           labelled inputs: at 390px a "start"/"end" pair with its own labels
           repeated seven times is unreadable, whereas a day name plus a
           checkbox plus two times reads as a table and wraps cleanly. */
        <div className="workhours-grid">
          {/* The seven rows replace the labelled "Work day start"/"end" pair,
              so they need a heading of their own — otherwise this reads as a
              grid of times with nothing saying what they are. */}
          <label className="workhours-heading">Work hours</label>
          {WEEKDAY_ORDER.map((day) => {
            const entry = rules.workHoursByDay?.[day] || {};
            const isWorking = entry.enabled !== false;
            return (
              <div key={day} className={`workhours-row ${isWorking ? '' : 'is-off'}`}>
                <label className="workhours-day">
                  <input
                    type="checkbox"
                    checked={isWorking}
                    onChange={(e) => updateDay(day, { enabled: e.target.checked })}
                    aria-label={`Work on ${WEEKDAY_NAMES[day]}`}
                  />
                  <span>{WEEKDAY_NAMES[day].slice(0, 3)}</span>
                </label>
                {isWorking ? (
                  <div className="workhours-times">
                    <input
                      type="time"
                      value={entry.start || rules.workDayStart}
                      onChange={(e) => updateDay(day, { start: e.target.value })}
                      aria-label={`${WEEKDAY_NAMES[day]} start time`}
                    />
                    <span className="workhours-dash">–</span>
                    <input
                      type="time"
                      value={entry.end || rules.workDayEnd}
                      onChange={(e) => updateDay(day, { end: e.target.value })}
                      aria-label={`${WEEKDAY_NAMES[day]} end time`}
                    />
                  </div>
                ) : (
                  <span className="workhours-off-label">Not working</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="form-row-split">
          <div className="form-row" style={{ flex: 1 }}>
            <label>Work day start</label>
            <input type="time" value={rules.workDayStart} onChange={(e) => setRules({ ...rules, workDayStart: e.target.value })} />
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label>Work day end</label>
            <input type="time" value={rules.workDayEnd} onChange={(e) => setRules({ ...rules, workDayEnd: e.target.value })} />
          </div>
        </div>
      )}
      <div className="form-row settings-toggle-row">
        <input type="checkbox" id="perDayWorkHours" checked={perDay} onChange={(e) => setPerDay(e.target.checked)} />
        <label htmlFor="perDayWorkHours">Different hours on different days</label>
      </div>
      <p className="settings-hint">
        {perDay
          ? 'The scheduler only plans work inside these hours, so a day marked "not working" gets left alone entirely.'
          : 'The same hours are used every day, including weekends. Turn this on to give each day its own hours, or take a day off.'}
      </p>
      <div className="form-row">
        <label>Max deep-work hours per day</label>
        <NumberField
          min={1}
          max={16}
          unitLabel="hours"
          value={rules.maxDailyDeepWorkHours}
          onCommit={(v) => setRules({ ...rules, maxDailyDeepWorkHours: v })}
        />
      </div>
      <div className="form-row">
        <label>Planning horizon (weeks)</label>
        <NumberField min={1} max={12} unitLabel="weeks" value={rules.horizonWeeks} onCommit={(v) => setRules({ ...rules, horizonWeeks: v })} />
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="frontload"
          checked={rules.frontLoadUrgent}
          onChange={(e) => setRules({ ...rules, frontLoadUrgent: e.target.checked })}
        />
        <label htmlFor="frontload">Front-load urgent/high-priority tasks near their deadline</label>
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="autoRescheduleEnabled"
          checked={rules.autoRescheduleEnabled !== false}
          onChange={(e) => setRules({ ...rules, autoRescheduleEnabled: e.target.checked })}
        />
        <label htmlFor="autoRescheduleEnabled">
          Automatically reschedule when adding a task with a due date, or when Google Calendar events change
        </label>
      </div>
    </div>
  );
}

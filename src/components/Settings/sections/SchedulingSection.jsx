/**
 * Settings → Scheduling rules — buffer days, work-day window, daily hour cap,
 * planning horizon, and the two scheduler behavior toggles. See SchedulerContext's
 * SchedulingRules typedef for what each field actually drives in rebalanceEngine.js.
 */

import React from 'react';
import { useScheduler } from '../../../context/SchedulerContext';

export default function SchedulingSection({ sectionRef }) {
  const { rules, setRules } = useScheduler();

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Scheduling rules</h3>
      <div className="form-row">
        <label>Buffer days (finish this many days before due date)</label>
        <input
          type="number"
          min="0"
          value={rules.bufferDays}
          onChange={(e) => setRules({ ...rules, bufferDays: Number(e.target.value) })}
        />
      </div>
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
      <div className="form-row">
        <label>Max deep-work hours per day</label>
        <input
          type="number"
          min="1"
          max="16"
          value={rules.maxDailyDeepWorkHours}
          onChange={(e) => setRules({ ...rules, maxDailyDeepWorkHours: Number(e.target.value) })}
        />
      </div>
      <div className="form-row">
        <label>Planning horizon (weeks)</label>
        <input
          type="number"
          min="1"
          max="12"
          value={rules.horizonWeeks}
          onChange={(e) => setRules({ ...rules, horizonWeeks: Number(e.target.value) })}
        />
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

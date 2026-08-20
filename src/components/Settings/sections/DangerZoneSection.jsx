/**
 * Settings → Danger zone — clear all tasks/boards (app-level data, via
 * SchedulerContext.clearAllData) vs. a full local reset (every persisted
 * key, via persistence.js's clearAllPersisted) — two different blast radii,
 * kept as two distinct buttons rather than one so a user reaching for "just
 * clear my tasks" can't accidentally nuke routines/rules/connections too.
 */

import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { clearAllPersisted } from '../../../utils/persistence';

export default function DangerZoneSection({ sectionRef }) {
  const { clearAllData } = useScheduler();
  const confirm = useConfirm();

  return (
    <div className="card settings-card" data-tour="danger-zone-card" ref={sectionRef}>
      <h3>Danger zone</h3>
      <p className="settings-hint">
        Clears every task and board (including the sample "Work / Writing / Personal" data new accounts start
        with) so you can start from a blank slate. Routines, scheduling rules, and your Todoist/Google Calendar
        connections are left untouched.
      </p>
      <button
        className="btn settings-inline settings-danger"
        onClick={async () => {
          if (await confirm('Clear all tasks and boards? This cannot be undone.', { confirmLabel: 'Clear all data' })) {
            clearAllData();
          }
        }}
      >
        <Trash2 size={14} />
        Clear all data (tasks &amp; boards)
      </button>

      <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 16, marginBottom: -6 }}>
        Wipes every locally-saved TaskFlow setting (tasks, blocks, routines, rules, events) from this browser and
        reloads. Todoist/Google Calendar accounts themselves are untouched — this only clears what's cached here.
      </p>
      <button
        className="btn"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)', marginTop: 10 }}
        onClick={async () => {
          if (await confirm('Reset all local TaskFlow data? This cannot be undone.', { confirmLabel: 'Reset' })) {
            clearAllPersisted();
            window.location.reload();
          }
        }}
      >
        <AlertTriangle size={14} />
        Reset local data
      </button>
    </div>
  );
}

/**
 * SmartChips — the small dismissible preview row shown under the Title
 * field in AddTaskModal/TaskDetailModal, one chip per entity smartParse.js
 * detected (due date, recurrence, priority, dependency, project, and one
 * per detected "@label"). Purely presentational — the parent modal owns
 * applying/reverting the actual field state and just passes in what to
 * render plus an onDismiss callback.
 *
 * Each chip needs a `key` unique across the whole row (not just `chip.type`)
 * since a title can carry several `labels`-type chips at once — the caller
 * supplies it, along with an optional `match` payload passed straight
 * through to onDismiss so a MULTI field (see useSmartTaskTitle) knows which
 * of its several detections to revert.
 */

import React from 'react';
import { X } from 'lucide-react';

export default function SmartChips({ chips, onDismiss }) {
  if (!chips || chips.length === 0) return null;

  return (
    <div className="smart-chip-row">
      {chips.map((chip) => (
        <span key={chip.key || chip.type} className="chip smart-chip" title={chip.title}>
          <chip.icon size={11} />
          {chip.label}
          <button
            type="button"
            className="chip-dependency-remove"
            onClick={() => onDismiss(chip.type, chip.match)}
            title={`Not this — remove ${chip.label} suggestion`}
            aria-label={`Dismiss ${chip.label} suggestion`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

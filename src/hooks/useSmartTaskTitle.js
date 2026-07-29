/**
 * useSmartTaskTitle — shared smart-parse wiring for the Title field, used by
 * both AddTaskModal and TaskDetailModal so the two screens can't drift.
 *
 * Each SCALAR field (dueDate/recurrence/priority/dependency/project) is
 * described by the caller as { isUntouched, apply, revert } since "untouched"
 * and "revert to what" differ between Add (blank defaults) and Edit (the
 * task's original value) — see each modal's `fields` object.
 *
 * `labels` ("@tag" mentions) is handled separately, not through `fields`:
 * unlike the scalar fields, a detected tag never overwrites anything and
 * has no "original value" to revert to — Label creation itself is deferred
 * to the caller's Save handler (see SchedulerContext.getOrCreateLabelIds),
 * so there is nothing for `apply`/`revert` to do here. This hook just
 * tracks which detected tags are still visible vs. dismissed, the same
 * bookkeeping every scalar field gets, without forcing labels through a
 * contract built for single overwritable values.
 *
 * DISMISSAL: dismissing a detection reverts its field (or, for a label,
 * just hides that one chip) and blocks that exact phrase from reapplying
 * *while it's still typed*. The moment that phrase is no longer present in
 * the title (edited or deleted), the block is lifted — so retyping the
 * same trigger word later re-arms smart parse instead of staying silently
 * dismissed for the rest of the session.
 */

import { useState } from 'react';
import { parseTaskText, stripMatchedText } from '../utils/smartParse';

const SCALAR_FIELD_TYPES = [
  'link',
  'dueDate',
  'recurrence',
  'priority',
  'estimatedHours',
  'unattended',
  'enforceDueDate',
  'dependency',
  'project',
];

export function useSmartTaskTitle({ tasks, projects = [], sections = [], fields }) {
  const [smartDetected, setSmartDetected] = useState({});
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set());

  function handleTitleChange(value) {
    const { detected } = parseTaskText(value, { existingTasks: tasks, projects, sections });
    const nextVisible = {};
    const nextDismissed = new Set(dismissedKeys);

    SCALAR_FIELD_TYPES.forEach((type) => {
      const match = detected[type];
      const field = fields[type];
      if (!field) return;

      if (!match) {
        // No detection of this type left in the text — clear any stale
        // dismissal so the same trigger word re-arms if typed again later.
        [...nextDismissed].forEach((key) => {
          if (key.startsWith(`${type}:`)) nextDismissed.delete(key);
        });
        // If a chip was showing (i.e. this field was auto-applied from a
        // previous detection), the phrase that drove it just got edited
        // away — revert the field now, otherwise it stays "touched" forever
        // and isUntouched() below would block re-applying the same phrase
        // if the user retypes it.
        const wasVisible = smartDetected[type];
        if (wasVisible) fields[type].revert(wasVisible);
        return;
      }

      const key = `${type}:${match.matchedText}`;
      if (field.isUntouched() && !nextDismissed.has(key)) {
        // Pass the full detection set so a field's apply() can see what else
        // was just detected in this same pass (e.g. recurrence checking
        // whether a due date was also detected, without relying on a sibling
        // setState having already landed — state updates aren't visible
        // within the same synchronous pass).
        field.apply(match, detected);
        nextVisible[type] = match;
      }
    });

    const labelMatches = detected.labels || [];
    const matchedLabelKeys = new Set(labelMatches.map((m) => `labels:${m.matchedText}`));
    [...nextDismissed].forEach((key) => {
      if (key.startsWith('labels:') && !matchedLabelKeys.has(key)) nextDismissed.delete(key);
    });
    const visibleLabels = labelMatches.filter((m) => !nextDismissed.has(`labels:${m.matchedText}`));
    if (visibleLabels.length > 0) nextVisible.labels = visibleLabels;

    setDismissedKeys(nextDismissed);
    setSmartDetected(nextVisible);
  }

  /** For `labels`, `match` identifies which of the several detected tags to dismiss. */
  function dismissSmartChip(type, match) {
    if (type === 'labels') {
      if (!match) return;
      setDismissedKeys((prev) => new Set(prev).add(`labels:${match.matchedText}`));
      setSmartDetected((prev) => {
        const remaining = (prev.labels || []).filter((m) => m.matchedText !== match.matchedText);
        const next = { ...prev };
        if (remaining.length > 0) next.labels = remaining;
        else delete next.labels;
        return next;
      });
      return;
    }

    const entry = smartDetected[type];
    if (!entry) return;
    setDismissedKeys((prev) => new Set(prev).add(`${type}:${entry.matchedText}`));
    fields[type].revert(entry);
    setSmartDetected((prev) => {
      const next = { ...prev };
      delete next[type];
      return next;
    });
  }

  /**
   * Strip whatever smart-parse phrases are still accepted (visible) out of
   * the saved title. If that leaves nothing (e.g. the whole title was just
   * a smart-parsed link), falls back to `fallback` if the caller passed one
   * (e.g. the link's hostname) — otherwise falls back to the untouched raw
   * title so a save is never blocked, even if that means the phrase stays
   * visible in the title after all.
   */
  function buildFinalTitle(title, fallback) {
    let result = title;
    SCALAR_FIELD_TYPES.forEach((type) => {
      if (smartDetected[type]) result = stripMatchedText(result, smartDetected[type].matchedText);
    });
    (smartDetected.labels || []).forEach((match) => {
      result = stripMatchedText(result, match.matchedText);
    });
    return result.trim() || fallback || title.trim();
  }

  function resetSmartState() {
    setSmartDetected({});
    setDismissedKeys(new Set());
  }

  return { smartDetected, handleTitleChange, dismissSmartChip, buildFinalTitle, resetSmartState };
}

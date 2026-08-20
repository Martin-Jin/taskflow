/**
 * AIPlanConfirmModal — Stage D of the AI Assistant upgrade (see TODO.md).
 * Renders a resolvePlan() result (see services/aiPlanService.js) as a
 * per-operation accept/reject checklist: every proposed change starts
 * checked (unless it failed validation, in which case it's shown with its
 * error and can't be checked at all), destructive operations are called out
 * visually, and Apply only executes the checked+valid subset via
 * applyPlan() against the real SchedulerContext mutators. Nothing is
 * written to the workspace before Apply is clicked.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Sparkles, X, AlertTriangle, Loader2, CheckSquare, Square } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import Modal from '../Common/Modal';
import { applyPlan } from '../../services/aiPlanService';

const GROUPS = [
  { key: 'create', label: 'Create', match: (op) => op.startsWith('create_') },
  { key: 'update', label: 'Update / Move', match: (op) => op.startsWith('update_') || op.startsWith('rename_') },
  { key: 'delete', label: 'Delete', match: (op) => op.startsWith('delete_') },
];

export default function AIPlanConfirmModal({ plan, onClose, onApplied, onProjectCreated }) {
  const scheduler = useScheduler();
  // handleApply is defined above the JSX return, so it captures requestClose
  // via this ref (set during render, from Modal's render-prop) instead of
  // destructuring it directly — ref mutation during render is safe, unlike
  // setState in render.
  const requestCloseRef = useRef(() => {});

  const [checkedIndices, setCheckedIndices] = useState(
    () => new Set(plan.entries.filter((e) => e.valid).map((e) => e.index))
  );
  const [isApplying, setIsApplying] = useState(false);
  const [applyErrors, setApplyErrors] = useState(null);

  const grouped = useMemo(() => {
    return GROUPS.map((group) => ({
      ...group,
      entries: plan.entries.filter((e) => group.match(e.operation.op)),
    })).filter((g) => g.entries.length > 0);
  }, [plan.entries]);

  const validCount = useMemo(() => plan.entries.filter((e) => e.valid).length, [plan.entries]);
  const checkedValidCount = useMemo(
    () => plan.entries.filter((e) => e.valid && checkedIndices.has(e.index)).length,
    [plan.entries, checkedIndices]
  );

  function toggle(index) {
    setCheckedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function setAllValid(checked) {
    setCheckedIndices(checked ? new Set(plan.entries.filter((e) => e.valid).map((e) => e.index)) : new Set());
  }

  async function handleApply() {
    if (isApplying || checkedValidCount === 0) return;
    setIsApplying(true);
    setApplyErrors(null);
    try {
      const results = applyPlan(plan, checkedIndices, scheduler);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setApplyErrors(
          failed.map((f) => `${plan.entries[f.index].humanDescription}: ${f.error}`)
        );
      } else {
        // Navigate to the first project the plan actually created, so a new
        // project doesn't silently exist with no visible confirmation (see
        // this change's PR description) — only the first if several were
        // created, not a multi-project switcher.
        const firstCreatedProject = results.find(
          (r) => r.ok && r.createdId && plan.entries[r.index].operation.op === 'create_project'
        );
        if (firstCreatedProject) onProjectCreated?.(firstCreatedProject.createdId);
        onApplied?.(results);
        requestCloseRef.current();
      }
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Review AI Assistant changes"
      variantClassName="modal-ai-plan-confirm"
      header={({ requestClose }) => (
        <div className="stat-list-modal-header">
          <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={16} aria-hidden="true" /> Review changes
          </h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      )}
    >
      {({ requestClose }) => {
        requestCloseRef.current = requestClose;
        return (
          <>
        <p className="form-hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Nothing has been applied yet — review each change below, uncheck anything you don't want, then Apply.
        </p>

        {validCount > 0 && (
          <div className="ai-plan-select-row">
            <button type="button" className="btn-link" onClick={() => setAllValid(true)}>
              <CheckSquare size={13} /> Select all
            </button>
            <button type="button" className="btn-link" onClick={() => setAllValid(false)}>
              <Square size={13} /> Select none
            </button>
          </div>
        )}

        <div className="ai-plan-list">
          {grouped.map((group) => (
            <div key={group.key} className="ai-plan-group">
              <p className="ai-plan-group-heading">
                {group.label} ({group.entries.length})
              </p>
              {group.entries.map((entry) => (
                <label
                  key={entry.index}
                  className={`ai-plan-item ${group.key === 'delete' ? 'is-destructive' : ''} ${!entry.valid ? 'is-invalid' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={entry.valid && checkedIndices.has(entry.index)}
                    disabled={!entry.valid}
                    onChange={() => toggle(entry.index)}
                  />
                  <span className="ai-plan-item-body">
                    <span className="ai-plan-item-desc">{entry.humanDescription}</span>
                    {!entry.valid && (
                      <span className="ai-plan-item-error">
                        <AlertTriangle size={12} aria-hidden="true" /> {entry.errors.join(' ')}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>

        {plan.entries.length === 0 && <p className="form-hint">The AI proposed no changes.</p>}

        {applyErrors && (
          <p className="form-error">
            Some changes could not be applied: {applyErrors.join(' | ')}
          </p>
        )}

        <div className="addtask-footer">
          <span className="form-hint" style={{ marginRight: 'auto' }}>
            {checkedValidCount} of {plan.entries.length} change{plan.entries.length === 1 ? '' : 's'} selected
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={requestClose} disabled={isApplying}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleApply} disabled={isApplying || checkedValidCount === 0}>
              {isApplying ? (
                <>
                  <Loader2 size={14} className="spin" /> Applying…
                </>
              ) : (
                `Apply ${checkedValidCount || ''}`
              )}
            </button>
          </div>
        </div>
          </>
        );
      }}
    </Modal>
  );
}

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
 *
 * EXPANDABLE CHIPS: a chip can also carry `expandable: true` plus a
 * `candidates` array (see useSmartTaskTitle's `sectionShorthand` chip, the
 * first field to need this) when smartParse.js found more than one
 * qualifying match and can't pick one on its own. Clicking such a chip
 * (anywhere except its dismiss button) opens a small popover listing every
 * candidate; picking one calls `onSelectCandidate(chip.type, candidate)`,
 * generically — this component has no notion of what a "candidate" means
 * for any particular field type, it just renders whatever `candidate.label`
 * the caller computed for each row. Kept deliberately simple (a plain
 * absolutely-positioned list, closes on an outside click) since candidate
 * counts are expected to stay small.
 */

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export default function SmartChips({ chips, onDismiss, onSelectCandidate }) {
  const [openChipKey, setOpenChipKey] = useState(null);
  const rowRef = useRef(null);

  useEffect(() => {
    if (!openChipKey) return undefined;
    function handlePointerDown(e) {
      if (rowRef.current?.contains(e.target)) return;
      setOpenChipKey(null);
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpenChipKey(null);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openChipKey]);

  if (!chips || chips.length === 0) return null;

  return (
    <div className="smart-chip-row" ref={rowRef}>
      {chips.map((chip) => {
        const key = chip.key || chip.type;
        const isOpen = chip.expandable && openChipKey === key;
        return (
          <span key={key} className="smart-chip-wrap">
            <span
              className={`chip smart-chip ${chip.expandable ? 'smart-chip-expandable' : ''}`}
              title={chip.title}
              onClick={chip.expandable ? () => setOpenChipKey(isOpen ? null : key) : undefined}
              role={chip.expandable ? 'button' : undefined}
              tabIndex={chip.expandable ? 0 : undefined}
            >
              <chip.icon size={11} />
              {chip.label}
              <button
                type="button"
                className="chip-dependency-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss(chip.type, chip.match);
                }}
                title={`Not this — remove ${chip.label} suggestion`}
                aria-label={`Dismiss ${chip.label} suggestion`}
              >
                <X size={11} />
              </button>
            </span>
            {isOpen && (
              <div className="smart-chip-popover">
                {chip.candidates.map((candidate, i) => (
                  <button
                    type="button"
                    key={candidate.key || i}
                    className="smart-chip-popover-item"
                    onClick={() => {
                      onSelectCandidate(chip.type, candidate);
                      setOpenChipKey(null);
                    }}
                  >
                    {candidate.project?.name ? `${candidate.project.name} › ${candidate.section.name}` : candidate.section.name}
                  </button>
                ))}
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}

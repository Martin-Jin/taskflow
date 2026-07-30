/**
 * AddTaskFabGroup — the "Add task" + "AI Quick Add" button pair shown at the
 * top of the Tasks list and Board views (TaskListPanel.jsx, BoardView.jsx).
 *
 * Desktop: both render inline, side by side, right where they've always been.
 *
 * Mobile: "Add task" alone becomes a floating FAB (see .add-task-btn's mobile
 * rule in tasklist.css). With AI Quick Add also configured, tapping that FAB
 * no longer opens "Add task" directly — it expands into two stacked mini-FABs
 * (AI Quick Add above, Add task below) so both entry points stay reachable
 * without a second permanent floating button crowding the corner. Tapping a
 * mini-FAB, the main FAB again, or anywhere outside collapses it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { isAIQuickAddConfigured } from '../../services/aiQuickAddService';
import { useIsMobile } from '../../hooks/useIsMobile';

export default function AddTaskFabGroup({ onAddTask, onAIQuickAdd }) {
  const isMobile = useIsMobile();
  const aiConfigured = isAIQuickAddConfigured();
  const speedDial = isMobile && aiConfigured;
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!expanded) return undefined;
    function handlePointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setExpanded(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [expanded]);

  function handleMainClick() {
    if (speedDial) {
      setExpanded((prev) => !prev);
    } else {
      onAddTask();
    }
  }

  function handleAdd() {
    setExpanded(false);
    onAddTask();
  }

  function handleAIQuickAdd() {
    setExpanded(false);
    onAIQuickAdd();
  }

  return (
    <div className="add-task-fab-group" ref={rootRef}>
      {aiConfigured && !speedDial && (
        <button className="btn btn-icon" data-tour="ai-quick-add" onClick={handleAIQuickAdd} aria-label="AI Quick Add" title="AI Quick Add">
          <Sparkles size={14} />
        </button>
      )}
      {speedDial && expanded && (
        <>
          <button className="btn btn-icon fab-mini" data-tour="ai-quick-add" onClick={handleAIQuickAdd} aria-label="AI Quick Add" title="AI Quick Add">
            <Sparkles size={16} />
          </button>
          <button className="btn btn-primary fab-mini" onClick={handleAdd} aria-label="Add task" title="Add task">
            <Plus size={16} />
          </button>
        </>
      )}
      <button
        className="btn btn-primary add-task-btn"
        data-tour="add-task"
        onClick={handleMainClick}
        aria-label={speedDial && expanded ? 'Close' : 'Add task'}
        aria-expanded={speedDial ? expanded : undefined}
      >
        {speedDial && expanded ? <X size={14} /> : <Plus size={14} />}
        <span className="add-task-btn-label">Add task</span>
      </button>
    </div>
  );
}

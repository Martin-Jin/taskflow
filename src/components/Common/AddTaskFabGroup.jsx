/**
 * AddTaskFabGroup — the "Add task" + "AI Quick Add" button pair shown at the
 * top of the Tasks list and Board views (TaskListPanel.jsx, BoardView.jsx),
 * and (as "Add project") on the Projects page (ProjectsPage.jsx, wired from
 * App.jsx).
 *
 * Renders as a floating FAB fixed to the bottom-right corner on every
 * breakpoint (see .add-task-btn in tasklist.css). With AI Quick Add also
 * configured, tapping it doesn't open the main action directly — it expands
 * into two stacked mini-FABs (AI Quick Add above, the main action below) so
 * both entry points stay reachable without a second permanent floating
 * button crowding the corner. Tapping a mini-FAB, the main FAB again, or
 * anywhere outside collapses it.
 *
 * The AI Quick Add mini-FAB is shown whenever the feature is configured
 * (`isAIQuickAddConfigured`), regardless of whether the user has actually
 * saved a provider API key yet. If no key is saved, tapping it shows a toast
 * pointing at Settings instead of opening the modal (see handleAIQuickAdd).
 *
 * On mobile, an optional `onOpenSearch` renders the global search/command-
 * palette button (see App.jsx's mobile-search-fab) as the top-most member of
 * this same flex column instead of App.jsx placing a second, separately
 * fixed-position button in the same corner — that way it naturally stacks
 * above (and shifts with) the AI Quick Add / main-action mini-FABs whenever
 * this group expands or collapses, with no manual offset math needed.
 *
 * `mainLabel`/`mainIcon` (optional, default "Add task"/Plus): the main
 * action's label and icon, so the same speed-dial shell can read "Add
 * project" on the Projects page without a near-duplicate component. AI Quick
 * Add's own label/icon never change — it's the same feature everywhere.
 *
 * `addTaskDisabled` (optional): hides the main action entirely — used by
 * BoardView when the current project is one this user only has viewer
 * access to (a shared project's viewer collaborator). AI Quick Add stays
 * available even then, since it isn't scoped to one project the way Board's
 * FAB is; addTask itself still refuses per-task if a plan tries to write
 * into a viewer-only project (see SchedulerContext's addTask). Named for its
 * original (Tasks-page) use — ProjectsPage has no equivalent viewer-only
 * gate, so it never passes this prop.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Search, Sparkles, X } from 'lucide-react';
import { useAIQuickAddGate } from '../../hooks/useAIQuickAddGate';

export default function AddTaskFabGroup({
  onAddTask,
  onAIQuickAdd,
  onOpenSearch,
  addTaskDisabled = false,
  mainLabel = 'Add task',
  mainIcon: MainIcon = Plus,
}) {
  const { aiConfigured, requestOpen } = useAIQuickAddGate();
  // With "Add task" hidden (viewer-only project), only keep the speed-dial
  // shape if AI Quick Add is both configured AND still has something to show
  // — otherwise the single remaining action should just be the main FAB
  // itself, same as when AI Quick Add isn't configured at all.
  const speedDial = aiConfigured && !addTaskDisabled;
  const [expanded, setExpanded] = useState(false);
  const [aiShake, setAiShake] = useState(false);
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
    } else if (addTaskDisabled) {
      // "Add task" is off (viewer-only project) and there's no speed-dial to
      // expand into (AI Quick Add isn't configured) — nothing this FAB can
      // do; see the render below, which hides it entirely in that case.
      return;
    } else {
      onAddTask();
    }
  }

  function handleAdd() {
    setExpanded(false);
    onAddTask();
  }

  function handleAIQuickAdd() {
    // The button itself stays visible either way (see file header) — it's
    // the modal that's gated, with a toast pointing at where to fix it,
    // rather than the entry point silently disappearing. Checked before
    // collapsing the mobile speed-dial (not after) so the mini-FAB is still
    // on screen to actually shake — collapsing first would unmount it.
    const opened = requestOpen(() => {
      setExpanded(false);
      onAIQuickAdd();
    });
    if (!opened) setAiShake(true);
  }

  return (
    <div className="add-task-fab-group" ref={rootRef}>
      {onOpenSearch && (
        <button
          className="btn btn-primary fab-round mobile-search-fab"
          onClick={onOpenSearch}
          aria-label="Open command palette"
          title="Search / commands"
        >
          <Search size={22} />
        </button>
      )}
      {speedDial && expanded && (
        <>
          <button
            className={`btn btn-icon fab-mini ${aiShake ? 'shake-error' : ''}`}
            data-tour="ai-quick-add"
            onClick={handleAIQuickAdd}
            onAnimationEnd={() => setAiShake(false)}
            aria-label="AI Quick Add"
            title="AI Quick Add"
          >
            <Sparkles size={16} />
          </button>
          <button className="btn btn-primary fab-mini" onClick={handleAdd} aria-label={mainLabel} title={mainLabel}>
            <MainIcon size={16} />
          </button>
        </>
      )}
      {/* addTaskDisabled + no AI Quick Add configured leaves nothing this FAB
          can do — hidden entirely rather than shown as a dead button. */}
      {(!addTaskDisabled || aiConfigured) && (
        <button
          className="btn btn-primary add-task-btn"
          data-tour="add-task"
          onClick={addTaskDisabled ? handleAIQuickAdd : handleMainClick}
          aria-label={speedDial && expanded ? 'Close' : addTaskDisabled ? 'AI Quick Add' : mainLabel}
          aria-expanded={speedDial ? expanded : undefined}
        >
          {speedDial && expanded ? <X size={14} /> : addTaskDisabled ? <Sparkles size={14} /> : <MainIcon size={14} />}
          <span className="add-task-btn-label">{addTaskDisabled ? 'AI Quick Add' : mainLabel}</span>
        </button>
      )}
    </div>
  );
}

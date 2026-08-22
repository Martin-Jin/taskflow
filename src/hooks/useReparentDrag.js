/**
 * ============================================================================
 * useReparentDrag
 * ============================================================================
 * Drag-and-drop reparenting: drop task card/row A onto task card/row B and A
 * becomes a sub-task of B (`parentId`). Shared by BoardView's kanban cards and
 * TaskListPanel's list rows so the two can't drift on the rules — which task
 * is a legal new parent (utils/taskHierarchy.js's getIneligibleParentIds: not
 * itself, not one of its own descendants, not something already at the 2-level
 * nesting cap), how close to a target's edge still counts as "clearly on it",
 * and the long-press touch gesture that stands in for HTML5 DnD on mobile.
 *
 * What a view wires up per card/row:
 *  - `handlers.dragStart(e, taskId)` on the draggable element (desktop), and
 *    `handlers.touchStart(e, taskId)` for mobile's long-press equivalent.
 *  - `handlers.dragOver`/`dragLeave`/`drop` (desktop) plus a
 *    `data-task-id={task.id}` attribute, which is how the touch path resolves
 *    which card/row is under the finger (`elementFromPoint(...).closest(...)`,
 *    the same technique WeekView's trackTouchDragToColumn uses for columns).
 *  - `handlers.consumeClick()` first in the element's own onClick, so the
 *    synthetic click that follows a long-press drag doesn't also open the task.
 *
 * The dragover/drop handlers call `stopPropagation()` once armed, so a drop
 * landing on a card can't ALSO be handled by a drop target the card sits
 * inside (BoardView's column-move drop, which stays on the column body — see
 * BoardView's own DRAG SEMANTICS note; handleColumnReorderOver already uses
 * the same trick for its own nested-target case).
 *
 * `handlers` is one stable (useCallback/useMemo) object and every handler
 * takes a task id rather than closing over one, so a memoized row component
 * (TaskListPanel's TaskRow) can take it as a prop without its React.memo
 * bailing out on every unrelated re-render.
 *
 * Both input paths funnel into the same isValidTarget/commit pair, so
 * validation only exists once regardless of device — an ineligible target
 * never arms (`targetId` stays null, so no highlight renders, no drop
 * applies, and the drop falls through to whatever is underneath).
 *
 * UNPARENT (the inverse gesture): dropping a sub-task's row onto empty list
 * background (not onto another row) clears its `parentId` instead of setting
 * one. This reuses the exact same drag state/machinery — `targetId` can hold
 * either a real task id (reparent onto that task) or the sentinel
 * `UNPARENT_TARGET_ID` (clear the parent), and `commit` branches on which.
 * `handlers.dragOverRoot`/`dropRoot` are the container-level counterpart of
 * `dragOver`/`drop` — wired onto a view's own background element (e.g.
 * TaskListPanel's `.tasklist-rows`) rather than a row, so there's no per-row
 * edge-dead-zone check to make (the whole background counts, not just a
 * clear "inside" hit) and no `dragLeaveRoot` (see dragOverRoot's own comment
 * for why). Only List view has anywhere to use this: Board never renders a
 * sub-task as its own card in the first place (rolled into the parent's
 * progress badge instead — see BoardView's SUB-TASKS note), so there's
 * nothing there to drag back out.
 * ============================================================================
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { getIneligibleParentIds } from '../utils/taskHierarchy';

/** Sentinel `targetId` meaning "drop here to clear parentId" (see UNPARENT above). */
export const UNPARENT_TARGET_ID = '__unparent__';

// Same long-press gesture WeekView's touch drag uses (see its
// trackTouchDragToColumn) — a short press distinguishes "drag this task onto
// another" from "scroll the list"; moving further than the threshold before
// the timer fires aborts the drag entirely and leaves the scroll alone.
const LONG_PRESS_MS = 250;
const DRAG_START_THRESHOLD_PX = 8;

// A drop only counts once the pointer is clearly INSIDE the target's box, not
// grazing its top/bottom edge. On the Board that keeps "drag this card past
// another one on the way to a column" from being read as a reparent (the
// column's own drop target handles those); in the list it keeps a drag that's
// merely passing over a row from arming it.
const EDGE_DEAD_ZONE_PX = 6;

// How long after a touch drag ends a click still counts as that drag's
// synthetic tail (see touchDragEndedAtRef) — browsers fire it immediately, so
// this only has to cover one frame's worth of slack.
const TOUCH_DRAG_CLICK_WINDOW_MS = 350;

function isClearlyInside(rect, clientY) {
  const inset = Math.min(EDGE_DEAD_ZONE_PX, rect.height / 4);
  return clientY >= rect.top + inset && clientY <= rect.bottom - inset;
}

/**
 * @param {object} params
 * @param {import('../types').Task[]} params.tasks
 * @param {(taskId: string, updates: object) => void} params.updateTask
 * @param {boolean} [params.disabled] - e.g. a viewer on a shared project (Board
 *   shows one project at a time, so the whole gesture can be switched off)
 * @param {(task: import('../types').Task) => boolean} [params.isTaskLocked] -
 *   per-task veto, for a view that mixes projects (List's "All Tasks" can show
 *   rows from a viewer-only shared project alongside editable ones). A locked
 *   task can be neither dragged nor dropped onto.
 * @returns {{ draggedId: string|null, targetId: string|null (a task id, or
 *   UNPARENT_TARGET_ID — see that export), endDrag: () => void, handlers: object }}
 */
export function useReparentDrag({ tasks, updateTask, disabled = false, isTaskLocked }) {
  const [draggedId, setDraggedId] = useState(null);
  const [targetId, setTargetId] = useState(null);
  // Both ids are also mirrored into refs: the touch path's window listeners and
  // the drop handler need them synchronously, before the matching state update
  // has committed.
  const draggedIdRef = useRef(null);
  const targetIdRef = useRef(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // A touch drag ends in a `touchend` on the card/row that started it, which
  // the browser follows with a synthetic click — without this, every long-press
  // drag would also open the dragged task's detail modal. Stored as the drag's
  // end timestamp rather than a plain boolean so it self-expires: a browser
  // that produces no synthetic click at all (or one cancelled by touchend's
  // preventDefault) can't leave the flag armed to swallow a later real tap.
  const touchDragEndedAtRef = useRef(0);
  const isTaskLockedRef = useRef(isTaskLocked);
  isTaskLockedRef.current = isTaskLocked;

  /** Neither draggable nor droppable-onto (see the isTaskLocked param). */
  const isLocked = useCallback((taskId) => {
    const fn = isTaskLockedRef.current;
    if (!fn) return false;
    const task = tasksRef.current.find((t) => t.id === taskId);
    return !!task && fn(task);
  }, []);

  const setTarget = useCallback((id) => {
    targetIdRef.current = id;
    setTargetId(id);
  }, []);

  const beginDrag = useCallback((taskId) => {
    draggedIdRef.current = taskId;
    setDraggedId(taskId);
  }, []);

  const endDrag = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    setTarget(null);
  }, [setTarget]);

  /** Can `candidateId` legally become the parent of the task being dragged? */
  const isValidTarget = useCallback((candidateId) => {
    const sourceId = draggedIdRef.current;
    if (disabled || !sourceId || !candidateId || sourceId === candidateId) return false;
    if (!tasksRef.current.some((t) => t.id === candidateId)) return false;
    if (isLocked(candidateId)) return false;
    return !getIneligibleParentIds(sourceId, tasksRef.current).has(candidateId);
  }, [disabled, isLocked]);

  /** Is the task currently being dragged eligible to be unparented (see UNPARENT above)? */
  const isValidUnparentTarget = useCallback(() => {
    const sourceId = draggedIdRef.current;
    if (disabled || !sourceId || isLocked(sourceId)) return false;
    const source = tasksRef.current.find((t) => t.id === sourceId);
    return !!source?.parentId;
  }, [disabled, isLocked]);

  /** Apply the reparent (or unparent) — the single write every input path ends at. */
  const commit = useCallback((candidateId) => {
    const sourceId = draggedIdRef.current;
    if (candidateId === UNPARENT_TARGET_ID) {
      if (!isValidUnparentTarget()) return;
      updateTask(sourceId, { parentId: null });
      return;
    }
    if (!isValidTarget(candidateId)) return;
    updateTask(sourceId, { parentId: candidateId });
  }, [isValidTarget, isValidUnparentTarget, updateTask]);

  const dragStart = useCallback((e, taskId) => {
    if (disabled || isLocked(taskId)) return;
    // `text/plain` matches BoardView's existing card drag, whose column-drop
    // handler reads the task id back out of it.
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
    beginDrag(taskId);
  }, [disabled, isLocked, beginDrag]);

  const dragOver = useCallback((e, taskId) => {
    if (disabled || !draggedIdRef.current) return; // not our gesture (e.g. a column reorder passing through)
    if (!isClearlyInside(e.currentTarget.getBoundingClientRect(), e.clientY) || !isValidTarget(taskId)) {
      // Not a clear hit, or not a legal parent — un-arm and let the event keep
      // bubbling so an enclosing drop target (Board's column) still works.
      if (targetIdRef.current === taskId) setTarget(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // the column body underneath must not also light up as a section drop
    if (targetIdRef.current !== taskId) setTarget(taskId);
  }, [disabled, isValidTarget, setTarget]);

  const dragLeave = useCallback((taskId) => {
    if (targetIdRef.current === taskId) setTarget(null);
  }, [setTarget]);

  const drop = useCallback((e, taskId) => {
    if (!draggedIdRef.current || targetIdRef.current !== taskId) return; // only a card/row we actually armed takes the drop
    e.preventDefault();
    e.stopPropagation(); // ...so this doesn't ALSO register as a column/section move
    commit(taskId);
    endDrag();
  }, [commit, endDrag]);

  // --- Container-level "drop on empty background to unparent" (see UNPARENT
  // above) — the counterpart of dragOver/drop above, wired onto a view's own
  // background element instead of a row. No edge-dead-zone check here (unlike
  // isClearlyInside for a row/card): the whole background counts as "on it",
  // there's no adjacent drop target underneath to disambiguate from within a
  // plain empty area. There's deliberately no dragLeaveRoot: unlike a single
  // row (a small, non-nested target), the container has child elements
  // (rows, section headers) inside it, and the browser fires dragleave on a
  // parent the instant the pointer crosses onto ANY child — a classic HTML5
  // DnD quirk that would otherwise disarm this on nearly every move tick.
  // dragOverRoot already re-evaluates and disarms on its own each time it
  // fires (including via bubbling from a child that doesn't stopPropagation),
  // so a separate leave handler isn't needed.
  const dragOverRoot = useCallback((e) => {
    // A dragOver on/near an ineligible row bubbles up here too (that row's own
    // handler only stopPropagation()s once it actually arms) — don't treat
    // hovering over a row, valid target or not, as "empty background".
    const overRow = e.target.closest?.('[data-task-id]');
    if (disabled || !draggedIdRef.current || overRow || !isValidUnparentTarget()) {
      if (targetIdRef.current === UNPARENT_TARGET_ID) setTarget(null);
      return;
    }
    e.preventDefault();
    if (targetIdRef.current !== UNPARENT_TARGET_ID) setTarget(UNPARENT_TARGET_ID);
  }, [disabled, isValidUnparentTarget, setTarget]);

  const dropRoot = useCallback((e) => {
    if (!draggedIdRef.current || targetIdRef.current !== UNPARENT_TARGET_ID) return;
    e.preventDefault();
    commit(UNPARENT_TARGET_ID);
    endDrag();
  }, [commit, endDrag]);

  /**
   * Mobile path: long-press a card/row, then track the finger across the other
   * cards/rows via elementFromPoint (there's no touch drag-and-drop API) until
   * release. Faithful to WeekView's trackTouchDragToColumn — see the header.
   */
  const touchStart = useCallback((e, taskId) => {
    if (disabled || isLocked(taskId)) return;
    const touch = e.touches?.[0];
    if (!touch) return;
    touchDragEndedAtRef.current = 0;
    const startX = touch.clientX;
    const startY = touch.clientY;
    let dragging = false;
    let lastTargetId = null;

    const longPressTimer = setTimeout(() => {
      dragging = true;
      beginDrag(taskId);
    }, LONG_PRESS_MS);

    function cleanup() {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      endDrag();
    }

    function onMove(moveEvent) {
      const t = moveEvent.touches?.[0];
      if (!t) return;
      if (!dragging) {
        // Moved before the long press landed — the user is scrolling, so bail
        // out entirely rather than starting a drag under their finger.
        if (Math.hypot(t.clientX - startX, t.clientY - startY) > DRAG_START_THRESHOLD_PX) {
          clearTimeout(longPressTimer);
          cleanup();
        }
        return;
      }
      // Safe to suppress scrolling now that the scroll-vs-drag ambiguity has
      // been resolved in favour of drag (same reasoning as WeekView's).
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const under = document.elementFromPoint(t.clientX, t.clientY);
      const el = under?.closest('[data-task-id]');
      const candidateId = el?.dataset.taskId ?? null;
      let armed =
        candidateId && isClearlyInside(el.getBoundingClientRect(), t.clientY) && isValidTarget(candidateId)
          ? candidateId
          : null;
      // No row under the finger — check for a view's unparent-drop background
      // (see UNPARENT above; e.g. TaskListPanel's `.tasklist-section`) so the
      // long-press touch path can drop-to-unparent too, not just desktop DnD.
      if (!armed && under?.closest('[data-unparent-drop]') && isValidUnparentTarget()) armed = UNPARENT_TARGET_ID;
      lastTargetId = armed;
      setTarget(armed);
    }

    function onEnd(endEvent) {
      clearTimeout(longPressTimer);
      if (dragging) {
        touchDragEndedAtRef.current = Date.now();
        if (lastTargetId) {
          if (endEvent.cancelable) endEvent.preventDefault();
          commit(lastTargetId);
        }
      }
      cleanup();
    }

    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }, [disabled, isLocked, beginDrag, endDrag, isValidTarget, isValidUnparentTarget, commit, setTarget]);

  /**
   * True once (then self-clearing) when the click being handled is really the
   * synthetic tail of a long-press drag rather than a tap — call it first in a
   * card/row's own onClick. See touchDragEndedAtRef for why this is time-boxed.
   */
  const consumeClick = useCallback(() => {
    if (Date.now() - touchDragEndedAtRef.current > TOUCH_DRAG_CLICK_WINDOW_MS) return false;
    touchDragEndedAtRef.current = 0;
    return true;
  }, []);

  const handlers = useMemo(
    () => ({ dragStart, dragOver, dragLeave, drop, dragOverRoot, dropRoot, touchStart, consumeClick }),
    [dragStart, dragOver, dragLeave, drop, dragOverRoot, dropRoot, touchStart, consumeClick]
  );

  return { draggedId, targetId, endDrag, handlers };
}

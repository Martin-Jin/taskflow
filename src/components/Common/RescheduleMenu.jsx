/**
 * RescheduleMenu — a small popover offering quick "push this task's due
 * date" presets (Tomorrow / In 3 days / Next week), plus a "Pick a date..."
 * option that reveals a native date input inline for anything else. Shared
 * between TaskListPanel's desktop hover-reveal button and its mobile
 * swipe-left gesture, so both surfaces stay visually and behaviorally
 * identical rather than each hand-rolling their own popover. On mobile the
 * swipe itself is the trigger — there's no button to anchor to (the row
 * auto-snaps back closed the instant the menu opens), so that call site
 * passes `forceCentered` instead of an `anchorRef`.
 *
 * Setting a date here goes through the exact same `onReschedule` (a plain
 * `updateTask(taskId, { dueDate })` at the call site) every other due-date
 * edit in the app already uses — this menu is only a faster way to reach
 * that same edit, not a separate code path. That's deliberate: it means the
 * app's existing "pushed N× " postpone-tracking (see rescheduleHistory.js)
 * applies automatically and correctly to a quick-reschedule the same way it
 * would to editing the date in the task's own detail view — a date pushed
 * later from this menu genuinely is a postponement by the app's own
 * definition, and nothing here needs to duplicate that logic.
 *
 * Portaled to document.body via useMenuPosition (same as ProjectActionsMenu)
 * so it isn't clipped by TaskListPanel's own scroll container, and closes on
 * Escape/outside-click/scroll for free through that same hook.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, CalendarDays, CalendarPlus, CalendarRange } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { toISODate, addDays } from '../../utils/dateUtils';

/** The three quick presets, computed fresh each render from "now" — never memoized/frozen, so a menu opened yesterday and still open past midnight (unlikely, but cheap to get right) always offers today-relative dates. */
function buildPresets() {
  const today = toISODate(new Date());
  return [
    { key: 'tomorrow', label: 'Tomorrow', icon: CalendarClock, date: addDays(today, 1) },
    { key: 'in3days', label: 'In 3 days', icon: CalendarDays, date: addDays(today, 3) },
    { key: 'nextweek', label: 'Next week', icon: CalendarRange, date: addDays(today, 7) },
  ];
}

export default function RescheduleMenu({ isOpen, onClose, anchorRef, onReschedule, forceCentered = false }) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const dateInputRef = useRef(null);

  function closeMenu() {
    setShowDatePicker(false);
    onClose();
  }

  const { menuRef, mode, style } = useMenuPosition({
    isOpen,
    anchorRef,
    onClose: closeMenu,
    forceCentered,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  if (!isOpen) return null;

  function applyDate(date) {
    onReschedule(date);
    closeMenu();
  }

  const presets = buildPresets();

  return createPortal(
    <>
      {mode === 'centered' && <div className="menu-popover-backdrop" onClick={closeMenu} />}
      <div
        ref={menuRef}
        className={`reschedule-menu ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
        role="menu"
        aria-label="Reschedule due date"
        style={mode === 'anchored' ? style : undefined}
      >
        {presets.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.key}
              type="button"
              role="menuitem"
              className="reschedule-menu-item"
              onClick={() => applyDate(preset.date)}
            >
              <Icon size={14} className="reschedule-menu-item-icon" aria-hidden="true" />
              {preset.label}
            </button>
          );
        })}
        {showDatePicker ? (
          <label className="reschedule-menu-datepicker">
            <CalendarPlus size={14} className="reschedule-menu-item-icon" aria-hidden="true" />
            <input
              ref={dateInputRef}
              type="date"
              autoFocus
              onChange={(e) => {
                if (e.target.value) applyDate(e.target.value);
              }}
              aria-label="Pick a due date"
            />
          </label>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="reschedule-menu-item"
            onClick={() => {
              setShowDatePicker(true);
              // Native date inputs need a direct user gesture to open their
              // picker via showPicker() — chained off the same click that
              // reveals the input, one tick later once it's actually mounted.
              requestAnimationFrame(() => dateInputRef.current?.showPicker?.());
            }}
          >
            <CalendarPlus size={14} className="reschedule-menu-item-icon" aria-hidden="true" />
            Pick a date…
          </button>
        )}
      </div>
    </>,
    document.body
  );
}

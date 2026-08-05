/**
 * CalendarFilterMenu — compact filter popover for the calendar toolbar.
 * Same anchored-popover pattern as ViewFilterMenu/DashboardCustomizeMenu
 * (portaled + useMenuPosition, reusing .project-actions-dropdown's popover
 * shell) but kept as its own component rather than folded into
 * ViewFilterMenu — the calendar's filter groups (show-mode, project, tag)
 * are unrelated to the Tasks page's view/status filter that component owns.
 *
 * Filter state (`filter`/`onChange`) lives in CalendarPage — this component
 * is just the picker. Projects/Tags render as collapsible sub-sections (see
 * `FilterGroup` below) rather than always-expanded checkbox lists, so the
 * menu stays compact even with many projects/labels.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter, ChevronDown, Check } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useScheduler } from '../../context/SchedulerContext';
import { UNASSIGNED_PROJECT_ID, isCalendarFilterActive } from '../../utils/calendarFilter';

const SHOW_MODE_OPTIONS = [
  { key: 'both', label: 'Tasks & events' },
  { key: 'tasks', label: 'Tasks only' },
  { key: 'events', label: 'Events only' },
];

/** Toggles `id` in/out of a null|string[] selection, materializing `null` (all `allIds`) into an explicit list on first deselect. */
function toggleSelection(current, id, allIds) {
  const base = current ?? allIds;
  const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
  // Selecting everything back is equivalent to "all" — collapse back to null
  // so a project/label added later is included by default again.
  return next.length === allIds.length ? null : next;
}

/**
 * One collapsible checkbox group (Projects or Tags) — collapsed by default,
 * showing a one-line summary ("All" or "N selected") with a chevron, so
 * several groups can coexist without the menu growing tall by default.
 */
function FilterGroup({ heading, items, selectedIds, onToggle, onReset, resetLabel }) {
  const [expanded, setExpanded] = useState(false);
  const summary = selectedIds === null ? 'All' : `${selectedIds.length} selected`;
  return (
    <div className="calendar-filter-group">
      <button
        type="button"
        className="calendar-filter-group-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="dashboard-customize-heading calendar-filter-group-heading">{heading}</span>
        <span className="calendar-filter-group-summary">
          {summary}
          <ChevronDown size={13} className={`calendar-filter-chevron ${expanded ? 'is-open' : ''}`} />
        </span>
      </button>
      {expanded && (
        <div className="calendar-filter-group-body">
          {/* Unchecking "All" (rather than a no-op) explicitly clears the
              selection to empty — otherwise, with a single item in the list,
              unchecking would immediately collapse back to "all" (see
              toggleSelection's own all-selected-collapses-to-null rule) and
              the checkbox would appear stuck checked. */}
          <label className="dashboard-customize-item calendar-filter-reset-item">
            <input type="checkbox" checked={selectedIds === null} onChange={() => onReset(selectedIds === null)} />
            {resetLabel}
          </label>
          {items.map(({ id, label, color }) => (
            <label key={id} className="dashboard-customize-item">
              <input
                type="checkbox"
                checked={selectedIds === null || selectedIds.includes(id)}
                onChange={() => onToggle(id)}
              />
              {color && <span className="calendar-filter-swatch" style={{ background: color }} />}
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CalendarFilterMenu({ filter, onChange }) {
  const { projects, labels } = useScheduler();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);

  function closeMenu() {
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  const { menuRef, mode, style } = useMenuPosition({
    isOpen,
    anchorRef: buttonRef,
    onClose: closeMenu,
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

  // Projects/Tags can't apply when only events are showing, and an empty
  // list (no projects/labels created yet) has nothing to filter by either.
  const showProjectGroup = filter.showMode !== 'events' && projects.length > 0;
  const showLabelGroup = filter.showMode !== 'events' && labels.length > 0;

  // "Unassigned" (no project) is always offered alongside real projects —
  // see calendarFilter.js's UNASSIGNED_PROJECT_ID.
  const projectItems = [...projects.map((p) => ({ id: p.id, label: p.name, color: p.color })), { id: UNASSIGNED_PROJECT_ID, label: 'Unassigned' }];
  const allProjectIds = projectItems.map((p) => p.id);
  const allLabelIds = labels.map((l) => l.id);

  const active = isCalendarFilterActive(filter);

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={`btn btn-icon calendar-filter-trigger ${active ? 'is-active' : ''}`}
        data-testid="calendar-filter-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Filter calendar"
        title="Filter calendar"
        onClick={() => setIsOpen((v) => !v)}
      >
        <Filter size={15} />
        {active && <span className="calendar-filter-active-dot" />}
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={closeMenu} />}
            <div
              ref={menuRef}
              className={`project-actions-dropdown calendar-filter-dropdown ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              role="menu"
              style={mode === 'anchored' ? style : undefined}
            >
              <p className="dashboard-customize-heading">Show</p>
              {SHOW_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter.showMode === opt.key}
                  className="project-actions-item view-filter-item"
                  onClick={() => onChange({ ...filter, showMode: opt.key })}
                >
                  {opt.label}
                  {filter.showMode === opt.key && <Check size={13} />}
                </button>
              ))}

              {showProjectGroup && (
                <FilterGroup
                  heading="Projects"
                  items={projectItems}
                  selectedIds={filter.projectIds}
                  resetLabel="All projects"
                  onReset={(wasAll) => onChange({ ...filter, projectIds: wasAll ? [] : null })}
                  onToggle={(id) => onChange({ ...filter, projectIds: toggleSelection(filter.projectIds, id, allProjectIds) })}
                />
              )}

              {showLabelGroup && (
                <FilterGroup
                  heading="Tags"
                  items={labels.map((l) => ({ id: l.id, label: l.name, color: l.color }))}
                  selectedIds={filter.labelIds}
                  resetLabel="All tags"
                  onReset={(wasAll) => onChange({ ...filter, labelIds: wasAll ? [] : null })}
                  onToggle={(id) => onChange({ ...filter, labelIds: toggleSelection(filter.labelIds, id, allLabelIds) })}
                />
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

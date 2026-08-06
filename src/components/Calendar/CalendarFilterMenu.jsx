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

import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter, ChevronDown, Check, Search } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useScheduler } from '../../context/SchedulerContext';
import { useComboboxMultiSelect } from '../../hooks/useComboboxMultiSelect';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { UNASSIGNED_PROJECT_ID, isCalendarFilterActive } from '../../utils/calendarFilter';
import { rankByNameSearch } from '../../utils/nameSearch';

// Below this many items a search box above the list is just noise (a search
// input over 2-3 checkboxes doesn't save any scrolling/scanning) — only the
// Projects group tends to grow past this in practice, since a user's project
// list is usually longer-lived than their tag list.
const SEARCH_THRESHOLD = 5;

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
 *
 * `searchable` (currently only opted into by the Projects group — see
 * SEARCH_THRESHOLD) adds a type-to-filter box above the "All ___" reset item:
 * typing narrows/reorders `items` via nameSearch.js's rankByNameSearch
 * (prefix > substring > fuzzy). Reuses useComboboxMultiSelect's query state
 * (the same state DependencyPicker/LabelPicker use for their own filtered
 * dropdowns) for the query itself, and the shared useListKeyboardNav hook
 * (also used by CommandPalette/Sidebar/ManageProjectsModal) for Up/Down/Enter
 * — with `wrap: false` (clamp at the ends rather than wrap around) since
 * this list sits inside an already-scrollable popover, and Enter *toggles*
 * the highlighted row rather than closing the menu (this group stays open
 * across several picks, like the plain checkbox rows below it).
 *
 * `showSwatch` renders a color-dot per item — opted into by Tags (Label.color
 * is always set) but not Projects (projects have no color concept).
 */
function FilterGroup({ heading, items, selectedIds, onToggle, onReset, resetLabel, searchable, showSwatch }) {
  const [expanded, setExpanded] = useState(false);
  const { query, setQuery } = useComboboxMultiSelect();
  const summary = selectedIds === null ? 'All' : `${selectedIds.length} selected`;

  const showSearch = searchable && items.length > SEARCH_THRESHOLD;
  const visibleItems = useMemo(
    () => (showSearch ? rankByNameSearch(query, items) : items),
    [showSearch, query, items]
  );

  const { activeIndex: highlightedIndex, setActiveIndex: setHighlightedIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: visibleItems.length,
    onSelect: (index) => {
      const target = visibleItems[index];
      if (target) onToggle(target.id);
    },
    wrap: false,
    resetKey: query,
  });

  function handleSearchKeyDown(e) {
    if (e.key === 'Escape' && query) {
      // First Escape just clears the query; a second (now a no-op query
      // clear) falls through to the menu's own close-on-Escape handling.
      e.stopPropagation();
      setQuery('');
      return;
    }
    handleKeyDown(e);
  }

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
          {showSearch && (
            <div className="calendar-filter-search">
              <Search size={13} className="calendar-filter-search-icon" />
              <input
                type="text"
                className="calendar-filter-search-input"
                role="combobox"
                aria-expanded={!!query.trim()}
                aria-controls={`calendar-filter-listbox-${heading}`}
                aria-activedescendant={
                  query.trim() && visibleItems[highlightedIndex] ? `calendar-filter-option-${heading}-${visibleItems[highlightedIndex].id}` : undefined
                }
                placeholder={`Search ${heading.toLowerCase()}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
          )}
          {/* Unchecking "All" (rather than a no-op) explicitly clears the
              selection to empty — otherwise, with a single item in the list,
              unchecking would immediately collapse back to "all" (see
              toggleSelection's own all-selected-collapses-to-null rule) and
              the checkbox would appear stuck checked. */}
          {!(showSearch && query.trim()) && (
            <label className="dashboard-customize-item calendar-filter-reset-item">
              <input type="checkbox" checked={selectedIds === null} onChange={() => onReset(selectedIds === null)} />
              {resetLabel}
            </label>
          )}
          {showSearch && query.trim() && visibleItems.length === 0 && (
            <p className="calendar-filter-no-match">No {heading.toLowerCase()} match "{query.trim()}".</p>
          )}
          <div id={`calendar-filter-listbox-${heading}`} role={showSearch && query.trim() ? 'listbox' : undefined} ref={listRef}>
            {visibleItems.map(({ id, label, color }, i) => {
              const isHighlighted = showSearch && query.trim() && i === highlightedIndex;
              return (
                <label
                  key={id}
                  id={showSearch && query.trim() ? `calendar-filter-option-${heading}-${id}` : undefined}
                  role={showSearch && query.trim() ? 'option' : undefined}
                  aria-selected={showSearch && query.trim() ? isHighlighted : undefined}
                  data-active={isHighlighted}
                  className={`dashboard-customize-item ${isHighlighted ? 'is-highlighted' : ''}`}
                  onMouseEnter={() => showSearch && query.trim() && setHighlightedIndex(i)}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds === null || selectedIds.includes(id)}
                    onChange={() => onToggle(id)}
                  />
                  {showSwatch && <span className="calendar-filter-swatch" style={{ background: color }} />}
                  {label}
                </label>
              );
            })}
          </div>
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
  const projectItems = [...projects.map((p) => ({ id: p.id, label: p.name })), { id: UNASSIGNED_PROJECT_ID, label: 'Unassigned' }];
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
                  searchable
                  showSwatch={false}
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
                  showSwatch
                />
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

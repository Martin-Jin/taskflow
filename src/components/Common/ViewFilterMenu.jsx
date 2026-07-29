/**
 * ViewFilterMenu — the Tasks page's single top-right dropdown for switching
 * List/Board/Gantt and picking the status filter (All/Scheduled/No due
 * date/Completed), replacing what used to be two separate rows (an
 * underlined List/Board/Gantt tab bar, and a pill-style filter tab row under
 * the project name). Same anchored-popover pattern as ProjectActionsMenu/
 * DashboardCustomizeMenu (portaled + useMenuPosition), reusing
 * .project-actions-dropdown's popover shell for the two headed groups.
 *
 * The filter is per-view (see TaskListPanel's `filterByView` state) — this
 * component is just the picker, not the source of truth for which filter
 * belongs to which view.
 *
 * `projectActions` (optional — { isPinned, onRename, onTogglePin, onDelete })
 * folds ProjectActionsMenu's Rename/Pin/Delete items into this same popover
 * as a third headed group, and swaps the trigger for a "⋯"-style icon
 * button. TaskListPanel only passes this on mobile (see useIsMobile), where
 * there isn't room for a title plus two separate menu triggers — desktop
 * keeps rendering ViewFilterMenu and ProjectActionsMenu as two triggers.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, MoreHorizontal } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { TASK_STATUS_FILTERS } from '../../utils/projectConstants';
import { ProjectActionsItems } from './ProjectActionsMenu';

export default function ViewFilterMenu({ view, onChangeView, viewOptions, filter, onChangeFilter, projectActions }) {
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

  const currentViewLabel = viewOptions.find((v) => v.key === view)?.label || view;

  function runAndClose(fn) {
    fn();
    closeMenu();
  }

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={projectActions ? 'btn btn-icon menu-trigger project-actions-trigger' : 'btn menu-trigger view-filter-trigger'}
        data-tour="tasks-view-switch"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={projectActions ? 'View, filter, and project actions' : 'Change view or filter'}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((v) => !v);
        }}
      >
        {projectActions ? (
          <MoreHorizontal size={14} />
        ) : (
          <>
            {currentViewLabel}
            <ChevronDown size={14} />
          </>
        )}
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={closeMenu} />}
            <div
              ref={menuRef}
              className={`project-actions-dropdown view-filter-dropdown ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              role="menu"
              style={mode === 'anchored' ? style : undefined}
            >
              <p className="dashboard-customize-heading">View</p>
              {viewOptions.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === v.key}
                  className="project-actions-item view-filter-item"
                  onClick={() => {
                    onChangeView(v.key);
                    closeMenu();
                  }}
                >
                  {v.label}
                  {view === v.key && <Check size={13} />}
                </button>
              ))}

              <p className="dashboard-customize-heading">Filter</p>
              {TASK_STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === f.key}
                  className="project-actions-item view-filter-item"
                  onClick={() => {
                    onChangeFilter(f.key);
                    closeMenu();
                  }}
                >
                  {f.label}
                  {filter === f.key && <Check size={13} />}
                </button>
              ))}

              {projectActions && (
                <>
                  <p className="dashboard-customize-heading">Project</p>
                  <ProjectActionsItems
                    isPinned={projectActions.isPinned}
                    onRename={projectActions.onRename}
                    onTogglePin={projectActions.onTogglePin}
                    onDelete={projectActions.onDelete}
                    runAndClose={runAndClose}
                  />
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

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
 *
 * The "Views" group lists saved searches (see utils/savedViews.js) — picking
 * one just writes its query into the search box, since a saved view IS a named
 * query. Saving is offered only while a query is active, because there is
 * nothing to name otherwise.
 *
 * `onOpenManageProjects` (optional) adds a "See / manage all projects" item
 * to that same Project group — mobile-only (desktop instead gets the same
 * item folded into ProjectActionsMenu's own dropdown, see TaskListPanel).
 * Unlike `projectActions`, it isn't gated on there being an active project
 * (it renders even on "All Tasks"), since managing the project list isn't
 * specific to any one project — so it can appear alongside or without a
 * `projectActions` group.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, MoreHorizontal, FolderKanban, Bookmark, BookmarkPlus, X } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { TASK_STATUS_FILTERS } from '../../utils/projectConstants';
import { sortSavedViews } from '../../utils/savedViews';
import { ProjectActionsItems } from './ProjectActionsMenu';

export default function ViewFilterMenu({
  view,
  onChangeView,
  viewOptions,
  filter,
  onChangeFilter,
  projectActions,
  onOpenManageProjects,
  savedViews = [],
  activeQuery = '',
  onApplySavedView,
  onSaveCurrentView,
  onDeleteSavedView,
}) {
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

  const sortedSavedViews = sortSavedViews(savedViews);
  /* Offered only when there's a query to name, and only when it isn't already
     saved — "Save current search" on a search that's already a view is a
     duplicate waiting to be rejected. */
  const trimmedQuery = activeQuery.trim();
  const canSaveCurrent = !!trimmedQuery && !!onSaveCurrentView && !savedViews.some((v) => v.query === trimmedQuery);

  const currentViewLabel = viewOptions.find((v) => v.key === view)?.label || view;
  // Either kind of "Project" group item switches the trigger to the compact
  // "⋯" icon style — `onOpenManageProjects` alone (e.g. mobile + "All Tasks",
  // which has no rename/pin/delete to offer) still needs it, not just
  // `projectActions`.
  const hasProjectGroup = !!(projectActions || onOpenManageProjects);

  function runAndClose(fn) {
    fn();
    closeMenu();
  }

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={hasProjectGroup ? 'btn btn-icon menu-trigger project-actions-trigger' : 'btn menu-trigger view-filter-trigger'}
        data-tour="tasks-view-switch"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={hasProjectGroup ? 'View, filter, and project actions' : 'Change view or filter'}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((v) => !v);
        }}
      >
        {hasProjectGroup ? (
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

              {(sortedSavedViews.length > 0 || canSaveCurrent) && (
                <>
                  <p className="dashboard-customize-heading">Views</p>
                  {sortedSavedViews.map((v) => (
                    <div key={v.id} className="saved-view-row">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-actions-item view-filter-item saved-view-apply"
                        onClick={() => {
                          onApplySavedView?.(v);
                          closeMenu();
                        }}
                        title={v.query}
                      >
                        <Bookmark size={13} />
                        <span className="saved-view-name">{v.name}</span>
                        {v.query === activeQuery.trim() && <Check size={13} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon saved-view-delete"
                        aria-label={`Delete view ${v.name}`}
                        onClick={(e) => {
                          // Kept out of the apply button so a mis-aimed click
                          // runs the view rather than deleting it.
                          e.stopPropagation();
                          onDeleteSavedView?.(v.id);
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {canSaveCurrent && (
                    <button
                      type="button"
                      role="menuitem"
                      className="project-actions-item view-filter-item"
                      onClick={() => {
                        onSaveCurrentView?.();
                        closeMenu();
                      }}
                    >
                      <BookmarkPlus size={13} />
                      Save current search as a view
                    </button>
                  )}
                </>
              )}

              {hasProjectGroup && (
                <>
                  <p className="dashboard-customize-heading">Project</p>
                  {projectActions && (
                    <ProjectActionsItems
                      isPinned={projectActions.isPinned}
                      isShared={projectActions.isShared}
                      onRename={projectActions.onRename}
                      onTogglePin={projectActions.onTogglePin}
                      onDelete={projectActions.onDelete}
                      onShare={projectActions.onShare}
                      runAndClose={runAndClose}
                    />
                  )}
                  {onOpenManageProjects && (
                    <button
                      type="button"
                      role="menuitem"
                      className="project-actions-item"
                      onClick={() => runAndClose(onOpenManageProjects)}
                    >
                      <FolderKanban size={13} />
                      See / manage all projects
                    </button>
                  )}
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

/**
 * ManageProjectsModal — mobile-friendly "see all projects" popup, since
 * mobile has no Sidebar (see Sidebar.jsx's own doc comment) to browse/manage
 * projects from. Mirrors Sidebar's search + list + Rename/Pin/Delete
 * (ProjectActionsMenu), just inside a modal shell instead of a persistent
 * rail. Its own "Add project" button opens the shared dedicated
 * AddProjectModal (see App.jsx) rather than an inline form, so there's one
 * "add project" UI across the app instead of two. Reachable two ways: the
 * mobile topbar's "⋯" menu and the Tasks page's project SelectMenu footer
 * ("See / manage all projects").
 */

import React, { useRef, useState } from 'react';
import { Plus, Search, Pin, Inbox as InboxIcon } from 'lucide-react';
import Modal from '../Common/Modal';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import ProjectActionsMenu from '../Common/ProjectActionsMenu';
import SharedProjectBadge from '../Common/SharedProjectBadge';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import {
  ALL_TASKS_PROJECT_ID,
  ALL_TASKS_PROJECT_LABEL,
  INBOX_PROJECT_ID,
  INBOX_PROJECT_LABEL,
  sortProjectsForSidebar,
} from '../../utils/projectConstants';
import { rankByNameSearch } from '../../utils/nameSearch';

export default function ManageProjectsModal({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onTogglePinProject,
  onShareProject,
  onDeleteProject,
  onClose,
}) {
  // Read from context rather than adding props: `projects` is passed in (this
  // modal is also driven with a filtered list), but the shared-project docs
  // and current uid are the same for every caller, so threading them through
  // would be noise — same approach as Sidebar's own badge wiring.
  const { sharedProjects } = useScheduler();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // pickProject is called from useListKeyboardNav's onSelect, a hook wired up
  // before Modal's render-prop (the only place requestClose is exposed) runs
  // — so requestClose is captured into this ref during render instead (ref
  // mutation during render is safe, unlike setState in render).
  const requestCloseRef = useRef(() => {});

  const sortedProjects = sortProjectsForSidebar(projects);
  // Same relevance-ranked-with-pinned/recency-tiebreak search as Sidebar.jsx
  // — see its comment for why sortedProjects (not raw `projects`) is passed in.
  const visibleProjects = query.trim()
    ? rankByNameSearch(query, sortedProjects.map((p) => ({ ...p, label: p.name })))
    : sortedProjects;
  // Same as Sidebar.jsx: keyboard nav only kicks in once a query has
  // actually narrowed the list down to ranked results.
  const isSearching = query.trim().length > 0;

  function pickProject(projectId) {
    onSelectProject(projectId);
    requestCloseRef.current();
  }

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: isSearching ? visibleProjects.length : 0,
    onSelect: (index) => {
      const project = visibleProjects[index];
      if (project) pickProject(project.id);
    },
    resetKey: query,
  });

  // Unlike CalendarFilterMenu/Sidebar (a portal popover and a persistent nav
  // rail, neither of which is a modal), Escape here can't be intercepted to
  // "just clear the query" first — useModalA11y's Escape handler listens on
  // `document` in the CAPTURE phase, so it always closes the modal before a
  // React onKeyDown (bubble phase, and scoped to this input besides) even
  // runs; stopPropagation() on the synthetic event can't reach back to stop
  // it. That already matches this file's existing rename-input Escape
  // (below), which likewise closes the modal rather than only cancelling the
  // rename — so Escape-closes-the-modal is this file's established
  // behavior, not a regression introduced here.
  const handleSearchKeyDown = handleKeyDown;

  function startRename(project) {
    setRenamingId(project.id);
    setRenameValue(project.name);
  }

  function commitRename() {
    if (renamingId && renameValue.trim()) onRenameProject(renamingId, renameValue);
    setRenamingId(null);
    setRenameValue('');
  }

  async function handleDelete(project) {
    if (await confirm(`Delete "${project.name}"? Its tasks will move to Inbox.`, { confirmLabel: 'Delete' })) {
      onDeleteProject(project.id);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Manage projects" variantClassName="modal-manage-projects" title="Projects">
      {({ requestClose }) => {
        requestCloseRef.current = requestClose;
        return (
          <>
            <div className="sidebar-project-search">
              <Search size={13} className="sidebar-project-search-icon" />
              <input
                autoFocus
                type="text"
                role="combobox"
                aria-expanded={isSearching}
                aria-controls="manage-projects-listbox"
                aria-activedescendant={
                  isSearching && visibleProjects[activeIndex] ? `manage-projects-option-${visibleProjects[activeIndex].id}` : undefined
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search projects…"
                aria-label="Search projects"
              />
            </div>

            <div
              className="sidebar-project-list manage-projects-list"
              id="manage-projects-listbox"
              role={isSearching ? 'listbox' : undefined}
              ref={listRef}
            >
              <button
                className={`nav-item sidebar-project-row ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'active' : ''}`}
                onClick={() => pickProject(ALL_TASKS_PROJECT_ID)}
              >
                <span className="sidebar-project-name">{ALL_TASKS_PROJECT_LABEL}</span>
              </button>

              <button
                className={`nav-item sidebar-project-row ${activeProjectId === INBOX_PROJECT_ID ? 'active' : ''}`}
                onClick={() => pickProject(INBOX_PROJECT_ID)}
              >
                <InboxIcon size={14} aria-hidden="true" />
                <span className="sidebar-project-name">{INBOX_PROJECT_LABEL}</span>
              </button>

              {visibleProjects.map((p, index) => (
                <div
                  key={p.id}
                  id={isSearching ? `manage-projects-option-${p.id}` : undefined}
                  role={isSearching ? 'option' : undefined}
                  aria-selected={isSearching ? index === activeIndex : undefined}
                  data-active={isSearching && index === activeIndex}
                  className={`sidebar-project-row-wrap ${activeProjectId === p.id ? 'active' : ''} ${
                    isSearching && index === activeIndex ? 'is-kbd-active' : ''
                  }`}
                  onMouseEnter={() => isSearching && setActiveIndex(index)}
                >
                  {renamingId === p.id ? (
                    <input
                      autoFocus
                      className="sidebar-project-rename-input"
                      aria-label={`Rename project "${p.name}"`}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        }
                        if (e.key === 'Escape') {
                          setRenamingId(null);
                          setRenameValue('');
                        }
                      }}
                    />
                  ) : (
                    <button className="nav-item sidebar-project-row" onClick={() => pickProject(p.id)}>
                      {p.isPinned && <Pin size={12} className="sidebar-project-pin-icon" aria-hidden="true" />}
                      <span className="sidebar-project-name">{p.name}</span>
                      <SharedProjectBadge project={p} sharedProject={sharedProjects[p.sharedProjectId]} uid={user?.uid} />
                    </button>
                  )}
                  {renamingId !== p.id && (
                    <ProjectActionsMenu
                      isPinned={!!p.isPinned}
                      isShared={!!p.sharedProjectId}
                      ariaLabel={`Actions for ${p.name}`}
                      onRename={() => startRename(p)}
                      onTogglePin={() => onTogglePinProject(p.id)}
                      onDelete={() => handleDelete(p)}
                      onShare={onShareProject ? () => onShareProject(p.id) : undefined}
                    />
                  )}
                </div>
              ))}
              {visibleProjects.length === 0 && <div className="sidebar-project-empty">No projects match.</div>}
            </div>

            <button className="nav-item sidebar-add-project-btn" onClick={onAddProject}>
              <Plus size={14} />
              Add project
            </button>
          </>
        );
      }}
    </Modal>
  );
}

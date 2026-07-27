/**
 * ManageProjectsModal — mobile-friendly "see all projects" popup, since
 * mobile has no Sidebar (see Sidebar.jsx's own doc comment) to browse/manage
 * projects from. Mirrors Sidebar's search + list + Rename/Pin/Delete
 * (ProjectActionsMenu) + "Add project" form, just inside a modal shell
 * instead of a persistent rail. Reachable two ways: the mobile topbar's
 * "⋯" menu ("Add project", opens straight into the add form via
 * `autoShowAdd`) and the Tasks page's project SelectMenu footer ("See /
 * manage all projects", opens onto the plain list+search).
 */

import React, { useState } from 'react';
import { X, Plus, Search, Pin } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import ProjectActionsMenu from '../Common/ProjectActionsMenu';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, sortProjectsForSidebar } from '../../utils/projectConstants';

export default function ManageProjectsModal({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onTogglePinProject,
  onDeleteProject,
  autoShowAdd = false,
  onClose,
}) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');
  const [isAdding, setIsAdding] = useState(autoShowAdd);
  const [newProjectName, setNewProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const sortedProjects = sortProjectsForSidebar(projects);
  const q = query.trim().toLowerCase();
  const visibleProjects = q ? sortedProjects.filter((p) => p.name.toLowerCase().includes(q)) : sortedProjects;

  function startRename(project) {
    setRenamingId(project.id);
    setRenameValue(project.name);
  }

  function commitRename() {
    if (renamingId && renameValue.trim()) onRenameProject(renamingId, renameValue);
    setRenamingId(null);
    setRenameValue('');
  }

  function handleDelete(project) {
    if (window.confirm(`Delete "${project.name}"? Its tasks will move to All Tasks.`)) {
      onDeleteProject(project.id);
    }
  }

  async function handleAddProject() {
    const trimmed = newProjectName.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    try {
      const result = await onAddProject(trimmed);
      if (result?.ok) {
        setNewProjectName('');
        setIsAdding(false);
      }
    } finally {
      setIsCreating(false);
    }
  }

  function pickProject(projectId) {
    onSelectProject(projectId);
    requestClose();
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-manage-projects"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage projects"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Projects</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="sidebar-project-search">
          <Search size={13} className="sidebar-project-search-icon" />
          <input
            autoFocus={!autoShowAdd}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
        </div>

        <div className="sidebar-project-list manage-projects-list">
          <button
            className={`nav-item sidebar-project-row ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'active' : ''}`}
            onClick={() => pickProject(ALL_TASKS_PROJECT_ID)}
          >
            <span className="sidebar-project-name">{ALL_TASKS_PROJECT_LABEL}</span>
          </button>

          {visibleProjects.map((p) => (
            <div key={p.id} className={`sidebar-project-row-wrap ${activeProjectId === p.id ? 'active' : ''}`}>
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
                </button>
              )}
              {renamingId !== p.id && (
                <ProjectActionsMenu
                  isPinned={!!p.isPinned}
                  ariaLabel={`Actions for ${p.name}`}
                  onRename={() => startRename(p)}
                  onTogglePin={() => onTogglePinProject(p.id)}
                  onDelete={() => handleDelete(p)}
                />
              )}
            </div>
          ))}
          {visibleProjects.length === 0 && <div className="sidebar-project-empty">No projects match.</div>}
        </div>

        {isAdding ? (
          <div className="sidebar-add-project-form">
            <input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Project name…"
              disabled={isCreating}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddProject();
                }
                if (e.key === 'Escape') {
                  setIsAdding(false);
                  setNewProjectName('');
                }
              }}
            />
            <div className="sidebar-add-project-actions">
              <button className="btn btn-primary" onClick={handleAddProject} disabled={isCreating || !newProjectName.trim()}>
                {isCreating ? '…' : 'Add'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setIsAdding(false);
                  setNewProjectName('');
                }}
                disabled={isCreating}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="nav-item sidebar-add-project-btn" onClick={() => setIsAdding(true)}>
            <Plus size={14} />
            Add project
          </button>
        )}
      </div>
    </div>
  );
}

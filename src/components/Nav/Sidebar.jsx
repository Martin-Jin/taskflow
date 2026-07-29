/**
 * ============================================================================
 * Sidebar
 * ============================================================================
 * Desktop-only nav rail: the Workspace tab switch (Dashboard/Calendar/Tasks/
 * Stats/Settings) plus a Todoist-style "Projects" group underneath — a
 * search box, the "All Tasks" pseudo-project pinned at the top, then real
 * projects sorted pinned-first/most-recently-visited (sortProjectsForSidebar),
 * each with a "⋯" menu (Rename/Pin/Delete via ProjectActionsMenu), and a
 * "Manage projects" button at the bottom that opens ManageProjectsModal
 * (which also has its own "Add project" form).
 *
 * Extracted out of App.jsx once the Projects group made the inline JSX too
 * large to keep readable there. Only rendered on desktop — mobile has no
 * sidebar, so project switching happens via the in-page selector added to
 * TaskListPanel/BoardView instead.
 * ============================================================================
 */

import React, { useState } from 'react';
import { FolderKanban, Search, Pin } from 'lucide-react';
import ProjectActionsMenu from '../Common/ProjectActionsMenu';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, sortProjectsForSidebar } from '../../utils/projectConstants';

export default function Sidebar({
  tabs,
  activeTab,
  onSelectTab,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenManageProjects,
  onRenameProject,
  onTogglePinProject,
  onDeleteProject,
  footer,
}) {
  const [projectQuery, setProjectQuery] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const sortedProjects = sortProjectsForSidebar(projects);
  const q = projectQuery.trim().toLowerCase();
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

  return (
    <aside className="sidebar">
      <div className="brand" data-tour="brand">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="brand-mark" />
        TaskFlow
      </div>

      <div className="nav-group">
        <div className="nav-group-label">Workspace</div>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => onSelectTab(t.id)}
            data-tour={`nav-${t.id}`}
            aria-current={activeTab === t.id ? 'page' : undefined}
          >
            <t.icon size={16} strokeWidth={2} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="nav-group sidebar-projects-group">
        <div className="nav-group-label">Projects</div>

        <div className="sidebar-project-search">
          <Search size={13} className="sidebar-project-search-icon" />
          <input
            type="text"
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
        </div>

        <button
          className={`nav-item sidebar-project-row ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'active' : ''}`}
          onClick={() => onSelectProject(ALL_TASKS_PROJECT_ID)}
          aria-current={activeProjectId === ALL_TASKS_PROJECT_ID ? 'page' : undefined}
        >
          <span className="sidebar-project-name">{ALL_TASKS_PROJECT_LABEL}</span>
        </button>

        <div className="sidebar-project-list">
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
                <button
                  className="nav-item sidebar-project-row"
                  onClick={() => onSelectProject(p.id)}
                  aria-current={activeProjectId === p.id ? 'page' : undefined}
                >
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

        <button
          className="nav-item sidebar-add-project-btn"
          data-tour="add-project"
          onClick={() => onOpenManageProjects()}
        >
          <FolderKanban size={14} />
          Manage projects
        </button>
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>{footer}</div>
    </aside>
  );
}

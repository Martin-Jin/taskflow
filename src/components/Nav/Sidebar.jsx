/**
 * ============================================================================
 * Sidebar
 * ============================================================================
 * Desktop-only nav rail: the Workspace tab switch (Dashboard/Calendar/Tasks/
 * Projects/Stats/Settings) plus a "Pinned projects" group underneath — the
 * "All Tasks" and "Inbox" pseudo-projects, then whichever real projects the
 * user has explicitly pinned, each with a "⋯" menu (Rename/Unpin/Delete via
 * ProjectActionsMenu).
 *
 * PINNED, not recent — a deliberate split of responsibilities with the
 * Projects page rather than an incidental cap. Both surfaces used to answer
 * "find and switch project", which meant neither owned it: the sidebar showed
 * the 5 most-recently-visited, so it churned under you and you could never
 * count on a given project being there. It's now a shortcut strip the user
 * curates, and BROWSING belongs entirely to the Projects page (search, Recent/
 * Shared/My Projects columns) — one click away via the Workspace group above,
 * so no second link out from here.
 *
 * The cost of the split is that pinning becomes the way to get a project into
 * the rail, which nobody discovers by accident — hence the empty state below
 * says so explicitly instead of rendering a blank group. No count cap: pinning
 * is explicit and self-limiting, so a cap would silently hide a project the
 * user deliberately put there. .sidebar-project-list already scrolls within
 * the rail (flex + overflow-y), so a long pin list costs nothing.
 *
 * "Manage projects" (ManageProjectsModal, which also has its own "Add project"
 * button opening AddProjectModal) lives on the Projects page itself and — for
 * the Tasks page specifically — TaskProjectRail, rather than duplicated here.
 *
 * Extracted out of App.jsx once the Projects group made the inline JSX too
 * large to keep readable there. Only rendered on desktop — mobile has no
 * sidebar, so project switching happens via the in-page selector added to
 * TaskListPanel/BoardView instead.
 * ============================================================================
 */

import React, { useState } from 'react';
import { Inbox, Layers } from 'lucide-react';
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
} from '../../utils/projectConstants';


export default function Sidebar({
  tabs,
  activeTab,
  onSelectTab,
  projects,
  activeProjectId,
  onSelectProject,
  onRenameProject,
  onTogglePinProject,
  onShareProject,
  onDeleteProject,
  footer,
}) {
  const { sharedProjects } = useScheduler();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  /* Pinned only, sorted by name. Name order rather than pin-recency or
     last-visited on purpose: the whole point of a curated strip is that a
     project stays where the user last saw it, and a list that rearranges
     itself is one you have to re-read every time. */
  const pinnedProjects = [...projects]
    .filter((p) => p.isPinned)
    .sort((a, b) => a.name.localeCompare(b.name));

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
        <div className="nav-group-label">Pinned projects</div>

        <button
          className={`nav-item sidebar-project-row ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'active' : ''}`}
          onClick={() => onSelectProject(ALL_TASKS_PROJECT_ID)}
          aria-current={activeProjectId === ALL_TASKS_PROJECT_ID ? 'page' : undefined}
        >
          <Layers size={14} aria-hidden="true" />
          <span className="sidebar-project-name">{ALL_TASKS_PROJECT_LABEL}</span>
        </button>

        <button
          className={`nav-item sidebar-project-row ${activeProjectId === INBOX_PROJECT_ID ? 'active' : ''}`}
          onClick={() => onSelectProject(INBOX_PROJECT_ID)}
          aria-current={activeProjectId === INBOX_PROJECT_ID ? 'page' : undefined}
        >
          <Inbox size={14} aria-hidden="true" />
          <span className="sidebar-project-name">{INBOX_PROJECT_LABEL}</span>
        </button>

        <div className="sidebar-project-list">
          {pinnedProjects.map((p) => (
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
          {pinnedProjects.length === 0 && (
            /* Says how to fill it, not just that it's empty: pinning is the
               only route into this rail now, and it isn't discoverable on its
               own. */
            <div className="sidebar-project-empty">
              Pin a project from its <span aria-hidden="true">⋯</span> menu to keep it here.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>{footer}</div>
    </aside>
  );
}

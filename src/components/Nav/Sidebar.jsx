/**
 * ============================================================================
 * Sidebar
 * ============================================================================
 * Desktop-only nav rail: the Workspace tab switch (Dashboard/Calendar/Tasks/
 * Projects/Stats/Settings) plus a lean "Projects" group underneath — the
 * "All Tasks" pseudo-project pinned at the top, then a capped list of the
 * most recently visited real projects (RECENT_PROJECT_LIMIT, by
 * `lastVisitedAt`), each with a "⋯" menu (Rename/Pin/Delete via
 * ProjectActionsMenu), and a "See all projects" link to the dedicated
 * Projects tab. Full project search/browsing, and the "Manage projects"
 * entry point (ManageProjectsModal, which also has its own "Add project"
 * form), now live on the Projects page itself rather than duplicated here.
 *
 * Extracted out of App.jsx once the Projects group made the inline JSX too
 * large to keep readable there. Only rendered on desktop — mobile has no
 * sidebar, so project switching happens via the in-page selector added to
 * TaskListPanel/BoardView instead.
 * ============================================================================
 */

import React, { useState } from 'react';
import { ArrowRight, Inbox, Pin } from 'lucide-react';
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

const RECENT_PROJECT_LIMIT = 5;

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

  // Purely recency-based (not pinned-first like the old full list) — this is
  // now a "what was I just working on" strip, not a directory to browse, so
  // pinning as a concept belongs to the full Projects page/ManageProjectsModal
  // instead. Projects never visited yet (no lastVisitedAt) are excluded rather
  // than padding out the list.
  const recentProjects = [...projects]
    .filter((p) => p.lastVisitedAt)
    .sort((a, b) => new Date(b.lastVisitedAt).getTime() - new Date(a.lastVisitedAt).getTime())
    .slice(0, RECENT_PROJECT_LIMIT);

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
        <div className="nav-group-label">Projects</div>

        <button
          className={`nav-item sidebar-project-row ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'active' : ''}`}
          onClick={() => onSelectProject(ALL_TASKS_PROJECT_ID)}
          aria-current={activeProjectId === ALL_TASKS_PROJECT_ID ? 'page' : undefined}
        >
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
          {recentProjects.map((p) => (
            <div key={p.id} className={`sidebar-project-row-wrap ${activeProjectId === p.id ? 'active' : ''}`}>
              {renamingId === p.id ? (
                <input
                  autoFocus
                  className="sidebar-project-rename-input"
                  aria-label={`Rename project "${p.name}"`}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onFocus={(e) => e.target.select()}
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
          {recentProjects.length === 0 && <div className="sidebar-project-empty">No recently visited projects yet.</div>}
        </div>

        <button
          className="nav-item sidebar-see-all-projects-btn"
          onClick={() => onSelectTab('projects')}
        >
          See all projects
          <ArrowRight size={13} />
        </button>
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>{footer}</div>
    </aside>
  );
}

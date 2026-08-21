/**
 * TaskProjectRail — "jump to any project" panel for the Tasks page (List/
 * Board/Gantt all share it, since switching projects is the same action
 * regardless of which view is active), styled after SettingsPanel's own
 * desktop rail: a persistent list of link-style buttons down the left edge
 * rather than a dropdown you have to open first. Replaces the old project
 * SelectMenu dropdown in the page header — that dropdown's trigger button is
 * now what opens/closes this rail (see TaskListPanel's taskpage-project-header).
 *
 * Open/closed state is owned by TaskListPanel (the header trigger button
 * needs to read/flip it too), not this component — see its `isOpen`/
 * `onRequestClose` props. Desktop and mobile render genuinely differently
 * from the same state:
 *   - Desktop: an inline column next to the task list, persistent across
 *     project switches (device-local, usePersistedState-backed in the
 *     parent) — picking a project does NOT close it, same as SettingsPanel's
 *     rail staying put after a click.
 *   - Mobile: there's no room for a permanent column, so it's an overlay
 *     drawer instead (built on the shared Modal — free focus trap/Escape/
 *     backdrop-click-to-close), and picking a project DOES close it, since
 *     the whole point on a small screen is to get out of the way and show
 *     the project you just picked.
 *
 * Search reuses useProjectSearch (fuzzy — prefix/substring/subsequence/typo
 * tolerant, see rankByNameSearch) — the same matcher Sidebar/ManageProjectsModal
 * search projects with, not a separate one-off implementation.
 */

import React from 'react';
import { Search, Pin, Inbox as InboxIcon, X } from 'lucide-react';
import Modal from './Common/Modal';
import { useProjectSearch } from '../hooks/useProjectSearch';
import SharedProjectBadge from './Common/SharedProjectBadge';
import { useScheduler } from '../context/SchedulerContext';
import { useAuth } from '../context/AuthContext';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, INBOX_PROJECT_ID, INBOX_PROJECT_LABEL } from '../utils/projectConstants';

function RailBody({ visibleProjects, isSearching, activeIndex, setActiveIndex, activeProjectId, sharedProjects, user, onPick }) {
  return (
    <>
      <button
        type="button"
        className={`task-project-rail-link ${activeProjectId === ALL_TASKS_PROJECT_ID ? 'is-current' : ''}`}
        aria-current={activeProjectId === ALL_TASKS_PROJECT_ID ? 'true' : undefined}
        onClick={() => onPick(ALL_TASKS_PROJECT_ID)}
      >
        {ALL_TASKS_PROJECT_LABEL}
      </button>
      <button
        type="button"
        className={`task-project-rail-link ${activeProjectId === INBOX_PROJECT_ID ? 'is-current' : ''}`}
        aria-current={activeProjectId === INBOX_PROJECT_ID ? 'true' : undefined}
        onClick={() => onPick(INBOX_PROJECT_ID)}
      >
        <InboxIcon size={13} aria-hidden="true" />
        {INBOX_PROJECT_LABEL}
      </button>

      {visibleProjects.map((p, index) => (
        <button
          key={p.id}
          type="button"
          id={isSearching ? `task-project-rail-option-${p.id}` : undefined}
          role={isSearching ? 'option' : undefined}
          aria-selected={isSearching ? index === activeIndex : undefined}
          data-active={isSearching && index === activeIndex}
          className={`task-project-rail-link ${activeProjectId === p.id ? 'is-current' : ''} ${
            isSearching && index === activeIndex ? 'is-kbd-active' : ''
          }`}
          aria-current={activeProjectId === p.id ? 'true' : undefined}
          onMouseEnter={() => isSearching && setActiveIndex(index)}
          onClick={() => onPick(p.id)}
        >
          {p.isPinned && <Pin size={11} className="task-project-rail-pin-icon" aria-hidden="true" />}
          <span className="task-project-rail-link-name">{p.name}</span>
          <SharedProjectBadge project={p} sharedProject={sharedProjects[p.sharedProjectId]} uid={user?.uid} />
        </button>
      ))}
      {visibleProjects.length === 0 && <div className="task-project-rail-empty">No projects match.</div>}
    </>
  );
}

export default function TaskProjectRail({ projects, activeProjectId, onSelectProject, isMobile, isOpen, onRequestClose }) {
  const { sharedProjects } = useScheduler();
  const { user } = useAuth();

  // Mobile auto-closes the drawer on pick (see this file's own doc comment);
  // desktop stays put, matching SettingsPanel's rail.
  function pickProject(projectId) {
    onSelectProject(projectId);
    if (isMobile) onRequestClose();
  }

  const { query, setQuery, visibleProjects, isSearching, activeIndex, setActiveIndex, listRef, handleKeyDown } =
    useProjectSearch(projects, pickProject);

  if (!isOpen) return null;

  const searchBox = (
    <div className="sidebar-project-search task-project-rail-search">
      <Search size={13} className="sidebar-project-search-icon" />
      <input
        autoFocus={isMobile}
        type="text"
        role="combobox"
        aria-expanded={isSearching}
        aria-controls="task-project-rail-listbox"
        aria-activedescendant={
          isSearching && visibleProjects[activeIndex] ? `task-project-rail-option-${visibleProjects[activeIndex].id}` : undefined
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search projects…"
        aria-label="Search projects"
      />
    </div>
  );

  const railBody = (
    <RailBody
      visibleProjects={visibleProjects}
      isSearching={isSearching}
      activeIndex={activeIndex}
      setActiveIndex={setActiveIndex}
      activeProjectId={activeProjectId}
      sharedProjects={sharedProjects}
      user={user}
      onPick={pickProject}
    />
  );

  if (isMobile) {
    return (
      <Modal
        onClose={onRequestClose}
        ariaLabel="All projects"
        overlayClassName="task-project-drawer-overlay"
        variantClassName="task-project-drawer"
      >
        <div className="task-project-rail-header">
          <span className="task-project-rail-title">All projects</span>
          <button type="button" className="btn btn-icon" onClick={onRequestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {searchBox}
        <nav
          className="task-project-rail-list"
          id="task-project-rail-listbox"
          role={isSearching ? 'listbox' : undefined}
          aria-label="All projects"
          ref={listRef}
        >
          {railBody}
        </nav>
      </Modal>
    );
  }

  return (
    <div className="task-project-rail">
      <div className="task-project-rail-header">
        <span className="task-project-rail-title">All projects</span>
      </div>
      {searchBox}
      <nav
        className="task-project-rail-list"
        id="task-project-rail-listbox"
        role={isSearching ? 'listbox' : undefined}
        aria-label="All projects"
        ref={listRef}
      >
        {railBody}
      </nav>
    </div>
  );
}

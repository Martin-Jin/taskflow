/**
 * ProjectsPage — the "Projects" directory/launcher (distinct from the
 * per-project Board/List task views): a centered greeting, a projects-only
 * fuzzy search bar styled like the Ctrl+K command palette, and three columns
 * of project rows (Recent / Shared / My projects). Read-only navigation —
 * rename/pin/delete/share stay in ManageProjectsModal/ProjectActionsMenu,
 * this page only calls `onSelectProject`. The Inbox pseudo-project (tasks
 * with no real project assigned) is pinned above "My projects" via
 * InboxRow/leadingRow rather than mixed into Recent/Shared, since those
 * columns are driven by real project metadata (lastVisitedAt, share state)
 * that Inbox doesn't have.
 *
 * Not yet wired into App.jsx's tab switch — see TODO.md's "Projects tab —
 * dedicated projects page & sidebar refactor" for the integration pass.
 */

import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Folder, FolderPlus, Inbox, SlidersHorizontal, Check, ChevronDown, FolderKanban } from 'lucide-react';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { rankByNameSearch } from '../../utils/nameSearch';
import { getProjectShareState } from '../../utils/sharedProjectAccess';
import { getProjectTaskCount, getProjectTotalHours, sortProjectsBy, PROJECT_SORT_KEYS } from '../../utils/projectStats';
import { INBOX_PROJECT_ID, INBOX_PROJECT_LABEL } from '../../utils/projectConstants';
import SharedProjectBadge from '../Common/SharedProjectBadge';
import AddTaskFabGroup from '../Common/AddTaskFabGroup';
import AIQuickAddModal from '../Modals/AIQuickAddModal';

/** Tasteful, non-gimmicky rotating subtitles, split by time of day (same three-way split as DashboardPage's greetingForHour). One is picked once per mount below — never re-randomized on re-render. */
const GREETINGS_BY_PERIOD = {
  morning: [
    'A fresh start for whatever matters today.',
    "What's worth picking up first?",
    'A clear morning is a good place to begin.',
  ],
  afternoon: [
    'Halfway through the day — what still needs attention?',
    'A good moment to check in on your projects.',
    "What's next on the list?",
  ],
  evening: [
    'Wrapping up, or planning tomorrow?',
    'A quiet moment to see where things stand.',
    'What deserves a last look before the day ends?',
  ],
};

function periodForHour(hour) {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

const SORT_LABELS = { size: 'Size', duration: 'Duration', created: 'Creation date' };

function ProjectRow({ project, tasks, sharedProjects, uid, onSelectProject }) {
  const taskCount = getProjectTaskCount(project.id, tasks);
  const hours = Math.round(getProjectTotalHours(project.id, tasks));
  return (
    <button type="button" className="projects-page-row" onClick={() => onSelectProject(project.id)}>
      <Folder size={14} className="projects-page-row-icon" aria-hidden="true" />
      <span className="projects-page-row-name">{project.name}</span>
      <span className="projects-page-row-stats">
        {taskCount} task{taskCount === 1 ? '' : 's'} · {hours}h
      </span>
      <SharedProjectBadge project={project} sharedProject={sharedProjects[project.sharedProjectId]} uid={uid} variant="detailed" />
    </button>
  );
}

/**
 * Inbox pseudo-project's row — same visual treatment as ProjectRow, but reads
 * its task count/hours off `!task.projectId` (via projectConstants'
 * INBOX_PROJECT_ID handling in getProjectTaskCount/getProjectTotalHours)
 * rather than a real project record, and never shows a SharedProjectBadge
 * since Inbox can't be shared.
 */
function InboxRow({ tasks, onSelectProject }) {
  const taskCount = getProjectTaskCount(INBOX_PROJECT_ID, tasks);
  const hours = Math.round(getProjectTotalHours(INBOX_PROJECT_ID, tasks));
  return (
    <button type="button" className="projects-page-row" onClick={() => onSelectProject(INBOX_PROJECT_ID)}>
      <Inbox size={14} className="projects-page-row-icon" aria-hidden="true" />
      <span className="projects-page-row-name">{INBOX_PROJECT_LABEL}</span>
      <span className="projects-page-row-stats">
        {taskCount} task{taskCount === 1 ? '' : 's'} · {hours}h
      </span>
    </button>
  );
}

function ProjectColumn({ title, projects, tasks, sharedProjects, uid, onSelectProject, emptyLabel, headerExtra, leadingRow }) {
  return (
    <div className="projects-page-column">
      <div className="projects-page-column-header">
        <h2>{title}</h2>
        {headerExtra}
      </div>
      {!leadingRow && projects.length === 0 ? (
        <p className="projects-page-column-empty">{emptyLabel}</p>
      ) : (
        <div className="projects-page-column-list">
          {leadingRow}
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} tasks={tasks} sharedProjects={sharedProjects} uid={uid} onSelectProject={onSelectProject} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Anchored sort/filter popover — a smaller sibling of ViewFilterMenu.jsx built for this page's Size/Duration/Creation-date + ascending/descending choice, since ViewFilterMenu itself is Tasks-page-specific (view switch + status filter). */
function ProjectSortMenu({ sortKey, ascending, onChange }) {
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

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-icon menu-trigger projects-page-sort-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Sort my projects"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((v) => !v);
        }}
      >
        <SlidersHorizontal size={13} />
        {SORT_LABELS[sortKey]}
        <ChevronDown size={13} />
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
              <p className="dashboard-customize-heading">Sort by</p>
              {PROJECT_SORT_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sortKey === key}
                  className="project-actions-item view-filter-item"
                  onClick={() => {
                    onChange(key, ascending);
                    closeMenu();
                  }}
                >
                  {SORT_LABELS[key]}
                  {sortKey === key && <Check size={13} />}
                </button>
              ))}

              <p className="dashboard-customize-heading">Order</p>
              {[
                { key: false, label: 'Descending' },
                { key: true, label: 'Ascending' },
              ].map((o) => (
                <button
                  key={String(o.key)}
                  type="button"
                  role="menuitemradio"
                  aria-checked={ascending === o.key}
                  className="project-actions-item view-filter-item"
                  onClick={() => {
                    onChange(sortKey, o.key);
                    closeMenu();
                  }}
                >
                  {o.label}
                  {ascending === o.key && <Check size={13} />}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

export default function ProjectsPage({ projects, tasks, sharedProjects, uid, onSelectProject, onOpenManageProjects, onAddProject }) {
  // Picked once per mount, not re-randomized on re-render/re-typing.
  const [greeting] = useState(() => {
    const pool = GREETINGS_BY_PERIOD[periodForHour(new Date().getHours())];
    return pool[Math.floor(Math.random() * pool.length)];
  });

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('size');
  const [ascending, setAscending] = useState(false);
  // Self-contained AI Quick Add modal, same pattern as TaskListPanel/BoardView
  // — this page owns the FAB group AND the modal it opens, rather than App.jsx
  // rendering a shared standalone AI-only FAB the way it still does for
  // Dashboard/Stats/Settings (which have no "add X" concept of their own).
  const [showAIQuickAdd, setShowAIQuickAdd] = useState(false);

  // Drives the floating quick-jump dropdown (ranked across all projects,
  // independent of which column a match happens to live in).
  const searchResults = useMemo(
    () => rankByNameSearch(query, projects.map((p) => ({ ...p, label: p.name }))),
    [query, projects]
  );
  const isSearching = query.trim().length > 0;

  // Filters a column's project list down to search matches (ranked by the
  // same fuzzy matcher used elsewhere in the app), leaving the list untouched
  // when there's no active query. Coexists with the dropdown above — the
  // dropdown is a fast keyboard-driven jump-to-project, this narrows the
  // columns themselves so browsing while searching also works.
  function filterBySearch(list) {
    if (!isSearching) return list;
    return rankByNameSearch(query, list.map((p) => ({ ...p, label: p.name })));
  }

  function selectAndClear(projectId) {
    onSelectProject(projectId);
    setQuery('');
  }

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: isSearching ? searchResults.length : 0,
    onSelect: (index) => {
      const project = searchResults[index];
      if (project) selectAndClear(project.id);
    },
    resetKey: query,
  });

  function handleSearchKeyDown(e) {
    if (e.key === 'Escape' && query) {
      e.stopPropagation();
      setQuery('');
      return;
    }
    handleKeyDown(e);
  }

  const recentProjects = useMemo(
    () =>
      [...projects]
        .filter((p) => p.lastVisitedAt)
        .sort((a, b) => new Date(b.lastVisitedAt).getTime() - new Date(a.lastVisitedAt).getTime())
        .slice(0, 8),
    [projects]
  );

  const sharedProjectsList = useMemo(
    () => projects.filter((p) => getProjectShareState(p, sharedProjects[p.sharedProjectId], uid).state !== 'personal'),
    [projects, sharedProjects, uid]
  );

  // "My projects" is deliberately the full unfiltered directory (mine +
  // shared), not just projects with no share state — Shared already carves
  // its own view out above, so this column's job is "browse everything,"
  // which is also why it's the one column the sort menu applies to.
  const myProjects = useMemo(() => sortProjectsBy(projects, tasks, sortKey, { ascending }), [projects, tasks, sortKey, ascending]);

  const visibleRecentProjects = useMemo(() => filterBySearch(recentProjects), [recentProjects, query, isSearching]);
  const visibleSharedProjects = useMemo(() => filterBySearch(sharedProjectsList), [sharedProjectsList, query, isSearching]);
  const visibleMyProjects = useMemo(() => filterBySearch(myProjects), [myProjects, query, isSearching]);

  return (
    <div className="projects-page">
      {/* Sits above the centered hero rather than inside it, so it can align
          to the far right regardless of the hero's own centered text. This is
          now the app's one entry point to ManageProjectsModal (the sidebar's
          old "Manage projects" button was removed as a redundant duplicate) —
          a plain text+icon button, not a "⋯" menu, since it's the only
          project-less action this page offers. */}
      {onOpenManageProjects && (
        <div className="projects-page-toolbar">
          <button
            type="button"
            className="nav-item projects-page-manage-btn"
            data-tour="manage-projects"
            onClick={() => onOpenManageProjects()}
          >
            <FolderKanban size={14} />
            Manage projects
          </button>
        </div>
      )}
      <div className="projects-page-hero">
        <h1>Projects</h1>
        <p>{greeting}</p>

        <div className="projects-page-search">
          <Search size={14} className="projects-page-search-icon" aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-expanded={isSearching}
            aria-controls="projects-page-search-listbox"
            aria-activedescendant={
              isSearching && searchResults[activeIndex] ? `projects-page-search-option-${searchResults[activeIndex].id}` : undefined
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search projects…"
            aria-label="Search projects"
          />

          {isSearching && (
            <div className="search-bar-dropdown" id="projects-page-search-listbox" role="listbox" ref={listRef}>
              {searchResults.length === 0 ? (
                <div className="now-empty">Nothing matches "{query}".</div>
              ) : (
                searchResults.map((p, index) => (
                  <button
                    key={p.id}
                    id={`projects-page-search-option-${p.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={`search-bar-dropdown-item ${index === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectAndClear(p.id)}
                  >
                    <Folder size={14} />
                    <span className="search-bar-dropdown-item-label">{p.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="projects-page-columns">
        <ProjectColumn
          title="Recent"
          projects={visibleRecentProjects}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel={isSearching ? 'No matches.' : 'No recently visited projects yet.'}
        />
        <ProjectColumn
          title="Shared"
          projects={visibleSharedProjects}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel={isSearching ? 'No matches.' : 'No shared projects yet.'}
        />
        <ProjectColumn
          title="My projects"
          projects={visibleMyProjects}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel={isSearching ? 'No matches.' : 'No projects yet.'}
          leadingRow={isSearching ? null : <InboxRow tasks={tasks} onSelectProject={onSelectProject} />}
          headerExtra={<ProjectSortMenu sortKey={sortKey} ascending={ascending} onChange={(k, a) => { setSortKey(k); setAscending(a); }} />}
        />
      </div>

      {onAddProject && (
        <AddTaskFabGroup
          onAddTask={onAddProject}
          onAIQuickAdd={() => setShowAIQuickAdd(true)}
          mainLabel="Add project"
          mainIcon={FolderPlus}
        />
      )}
      {showAIQuickAdd && <AIQuickAddModal onClose={() => setShowAIQuickAdd(false)} onProjectCreated={onSelectProject} />}
    </div>
  );
}

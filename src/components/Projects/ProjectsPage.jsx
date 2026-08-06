/**
 * ProjectsPage — the "Projects" directory/launcher (distinct from the
 * per-project Board/List task views): a centered greeting, a projects-only
 * fuzzy search bar styled like the Ctrl+K command palette, and three columns
 * of project rows (Recent / Shared / My projects). Read-only navigation —
 * rename/pin/delete/share stay in ManageProjectsModal/ProjectActionsMenu,
 * this page only calls `onSelectProject`.
 *
 * Not yet wired into App.jsx's tab switch — see TODO.md's "Projects tab —
 * dedicated projects page & sidebar refactor" for the integration pass.
 */

import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Folder, SlidersHorizontal, Check, ChevronDown } from 'lucide-react';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { rankByNameSearch } from '../../utils/nameSearch';
import { getProjectShareState } from '../../utils/sharedProjectAccess';
import { getProjectTaskCount, getProjectTotalHours, sortProjectsBy, PROJECT_SORT_KEYS } from '../../utils/projectStats';
import SharedProjectBadge from '../Common/SharedProjectBadge';

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
  const hours = getProjectTotalHours(project.id, tasks);
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

function ProjectColumn({ title, projects, tasks, sharedProjects, uid, onSelectProject, emptyLabel, headerExtra }) {
  return (
    <div className="projects-page-column">
      <div className="projects-page-column-header">
        <h2>{title}</h2>
        {headerExtra}
      </div>
      {projects.length === 0 ? (
        <p className="projects-page-column-empty">{emptyLabel}</p>
      ) : (
        <div className="projects-page-column-list">
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

export default function ProjectsPage({ projects, tasks, sharedProjects, uid, onSelectProject }) {
  // Picked once per mount, not re-randomized on re-render/re-typing.
  const [greeting] = useState(() => {
    const pool = GREETINGS_BY_PERIOD[periodForHour(new Date().getHours())];
    return pool[Math.floor(Math.random() * pool.length)];
  });

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('size');
  const [ascending, setAscending] = useState(false);

  const searchResults = useMemo(
    () => rankByNameSearch(query, projects.map((p) => ({ ...p, label: p.name }))),
    [query, projects]
  );
  const isSearching = query.trim().length > 0;

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

  return (
    <div className="projects-page">
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
          projects={recentProjects}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel="No recently visited projects yet."
        />
        <ProjectColumn
          title="Shared"
          projects={sharedProjectsList}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel="No shared projects yet."
        />
        <ProjectColumn
          title="My projects"
          projects={myProjects}
          tasks={tasks}
          sharedProjects={sharedProjects}
          uid={uid}
          onSelectProject={onSelectProject}
          emptyLabel="No projects yet."
          headerExtra={<ProjectSortMenu sortKey={sortKey} ascending={ascending} onChange={(k, a) => { setSortKey(k); setAscending(a); }} />}
        />
      </div>
    </div>
  );
}

/**
 * CommandPalette — global "jump to anything" (Ctrl+K / Cmd+K, see
 * useKeyboardShortcuts' `commandPalette` entry), Linear/Todoist-style.
 * Fuzzy-searches across five groups — Views (the top-level tabs), Projects,
 * Tasks, Calendar Events, and quick Actions (assembled by App.jsx from
 * functions it already has, e.g. runRebalance/toggleTheme) — and lets arrow
 * keys + Enter drive the flattened result list without leaving the keyboard.
 *
 * Views/Projects/Actions all rank via nameSearch.js's shared rankByNameSearch
 * (the same typo-tolerant matcher used everywhere else names are searched).
 * Tasks keeps its own local `fuzzyScore`/`fuzzyFilterTasks` below — task
 * titles are long free text, not short names, and that scorer's streak-
 * weighted subsequence ranking suits them better than the shared matcher
 * would (see `fuzzyScore`'s doc comment for why).
 *
 * Tasks and Events only search once a query is typed (an unfiltered dump of
 * every task/event isn't a useful "recent/quick" list the way
 * Views/Projects/Actions are), each capped at 8 results so a large
 * task/event list doesn't turn this into a second full browser. Events uses
 * SearchBar's shared `eventMatchesQuery` predicate (master events only,
 * never per-occurrence instances — see that function's doc comment) rather
 * than the Tasks group's fuzzy scorer, matching how the Tasks-page search
 * bar already searches events.
 */

import React, { useMemo, useState } from 'react';
import { X, Search, Folder, CheckSquare2, Zap, Calendar } from 'lucide-react';
import { useAnimatedUnmount } from '../hooks/useAnimatedUnmount';
import { useModalA11y } from '../hooks/useModalA11y';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL, INBOX_PROJECT_ID, INBOX_PROJECT_LABEL } from '../utils/projectConstants';
import { rankByNameSearch } from '../utils/nameSearch';
import { eventMatchesQuery } from './Common/SearchBar';
import EmptyState from './Common/EmptyState';

/**
 * Small local fuzzy-match scorer, kept only for the Tasks group — task
 * titles are long, multi-word free text, and this scorer's streak-weighted
 * subsequence scoring (a tighter/denser subsequence match ranks above a
 * scattered one) is tuned for that; nameSearch.js's rankByNameSearch is
 * tuned instead for short names (projects/views/actions) with per-word
 * typo-tolerant fuzzy matching, which doesn't rank long titles as well and
 * would degrade Tasks results. Views/Projects/Actions all use the shared
 * matcher below instead, so this is intentionally the one place two
 * matchers coexist — see this file's `groups` for how each group picks.
 * An exact substring match always outranks a scattered one, and among
 * substring matches, an earlier/tighter one wins. Non-matching subsequences
 * return -Infinity so callers can filter them out.
 */
function fuzzyScore(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -Infinity;
    streak = found === ti ? streak + 1 : 0;
    score += streak * 2 - (found - ti);
    ti = found + 1;
  }
  return score;
}

function fuzzyFilterTasks(items, query, toText) {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(toText(item), query) }))
    .filter((r) => r.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

/**
 * @param {{
 *   tabs: Array<{id: string, label: string, icon: any}>,
 *   activeTab: string,
 *   onSelectTab: (id: string) => void,
 *   projects: Array<{id: string, name: string}>,
 *   onSelectProject: (id: string) => void,
 *   tasks: Array<{id: string, title: string}>,
 *   onOpenTask: (id: string) => void,
 *   events: Array<{id: string, title: string, date: string}>,
 *   onOpenEvent: (event: object) => void,
 *   actions: Array<{id: string, label: string, icon?: any, run: () => void}>,
 *   onClose: () => void,
 * }} props
 */
export default function CommandPalette({
  tabs,
  activeTab,
  onSelectTab,
  projects,
  onSelectProject,
  tasks,
  onOpenTask,
  events,
  onOpenEvent,
  actions,
  onClose,
}) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim();

    const viewItems = rankByNameSearch(
      q,
      tabs.filter((t) => t.id !== activeTab).map((t) => ({ ...t, label: t.label }))
    ).map((t) => ({ key: `view-${t.id}`, label: t.label, icon: t.icon, run: () => onSelectTab(t.id) }));

    const projectItems = rankByNameSearch(
      q,
      [
        { id: ALL_TASKS_PROJECT_ID, name: ALL_TASKS_PROJECT_LABEL },
        { id: INBOX_PROJECT_ID, name: INBOX_PROJECT_LABEL },
        ...projects,
      ].map((p) => ({ ...p, label: p.name }))
    ).map((p) => ({ key: `project-${p.id}`, label: p.name, icon: Folder, run: () => onSelectProject(p.id) }));

    const taskItems = q
      ? fuzzyFilterTasks(
          tasks.filter((t) => !t.isCompleted),
          q,
          (t) => t.title
        )
          .slice(0, 8)
          .map((t) => ({ key: `task-${t.id}`, label: t.title, icon: CheckSquare2, run: () => onOpenTask(t.id) }))
      : [];

    const eventItems = q
      ? events
          .filter((e) => eventMatchesQuery(e, q))
          .slice(0, 8)
          .map((e) => ({ key: `event-${e.id}`, label: e.title, hint: e.date, icon: Calendar, run: () => onOpenEvent(e) }))
      : [];

    const actionItems = rankByNameSearch(q, actions.map((a) => ({ ...a, label: a.label }))).map((a) => ({
      key: `action-${a.id}`,
      label: a.label,
      icon: a.icon || Zap,
      run: a.run,
    }));

    return [
      { label: 'Actions', items: actionItems },
      { label: 'Views', items: viewItems },
      { label: 'Projects', items: projectItems },
      { label: 'Tasks', items: taskItems },
      { label: 'Events', items: eventItems },
    ].filter((g) => g.items.length > 0);
  }, [query, tabs, activeTab, projects, tasks, events, actions, onSelectTab, onSelectProject, onOpenTask, onOpenEvent]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  function runItem(item) {
    if (!item) return;
    item.run();
    requestClose();
  }

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: flatItems.length,
    onSelect: (index) => runItem(flatItems[index]),
    resetKey: query,
  });
  // Escape isn't handled here — useModalA11y's capture-phase listener
  // already closes the topmost modal, same as every other modal.

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list modal-command-palette"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
      >
        <div className="command-palette-search-row">
          <Search size={14} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={flatItems[activeIndex] ? `command-palette-item-${activeIndex}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a view, project, task, or action…"
            aria-label="Command palette search"
          />
          {/* Not a tab stop: Escape already closes the palette (see
              useModalA11y above), so leaving this in the Tab sequence would
              put it between the search input and the first result — this
              way Tab from the input lands straight on the first result. */}
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close" tabIndex={-1}>
            <X size={16} />
          </button>
        </div>

        {flatItems.length === 0 ? (
          <EmptyState>Nothing matches "{query}".</EmptyState>
        ) : (
          <div className="command-palette-list" ref={listRef} id="command-palette-listbox" role="listbox">
            {groups.map((group) => (
              <div key={group.label} className="search-bar-dropdown-group">
                <div className="search-bar-dropdown-label">{group.label}</div>
                {group.items.map((item) => {
                  const index = flatItems.indexOf(item);
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      id={`command-palette-item-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      data-active={index === activeIndex}
                      className={`search-bar-dropdown-item command-palette-item ${index === activeIndex ? 'active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onFocus={() => setActiveIndex(index)}
                      onClick={() => runItem(item)}
                    >
                      <Icon size={14} />
                      <span className="search-bar-dropdown-item-label">
                        {item.label}
                        {item.hint && <span className="search-bar-dropdown-item-hint"> · {item.hint}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

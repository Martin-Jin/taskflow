/**
 * CommandPalette — global "jump to anything" (Ctrl+K / Cmd+K, see
 * useKeyboardShortcuts' `commandPalette` entry), Linear/Todoist-style.
 * Fuzzy-searches across four groups — Views (the top-level tabs), Projects,
 * Tasks, and quick Actions (assembled by App.jsx from functions it already
 * has, e.g. runRebalance/toggleTheme) — and lets arrow keys + Enter drive
 * the flattened result list without leaving the keyboard.
 *
 * Tasks only search once a query is typed (an unfiltered dump of every task
 * isn't a useful "recent/quick" list the way Views/Projects/Actions are),
 * capped at 8 results so a large task list doesn't turn this into a second
 * full task browser.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Folder, CheckSquare2, Zap } from 'lucide-react';
import { useAnimatedUnmount } from '../hooks/useAnimatedUnmount';
import { useModalA11y } from '../hooks/useModalA11y';
import { ALL_TASKS_PROJECT_ID, ALL_TASKS_PROJECT_LABEL } from '../utils/projectConstants';

/**
 * Small local fuzzy-match scorer (no new dependency for a "jump to
 * anything" list this size) — an exact substring match always outranks a
 * scattered one, and among substring matches, an earlier/tighter one wins.
 * Non-matching subsequences return -Infinity so callers can filter them out.
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

function fuzzyFilter(items, query, toText) {
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
  actions,
  onClose,
}) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef(null);

  const groups = useMemo(() => {
    const q = query.trim();

    const viewItems = fuzzyFilter(
      tabs.filter((t) => t.id !== activeTab),
      q,
      (t) => t.label
    ).map((t) => ({ key: `view-${t.id}`, label: t.label, icon: t.icon, run: () => onSelectTab(t.id) }));

    const projectItems = fuzzyFilter(
      [{ id: ALL_TASKS_PROJECT_ID, name: ALL_TASKS_PROJECT_LABEL }, ...projects],
      q,
      (p) => p.name
    ).map((p) => ({ key: `project-${p.id}`, label: p.name, icon: Folder, run: () => onSelectProject(p.id) }));

    const taskItems = q
      ? fuzzyFilter(
          tasks.filter((t) => !t.isCompleted),
          q,
          (t) => t.title
        )
          .slice(0, 8)
          .map((t) => ({ key: `task-${t.id}`, label: t.title, icon: CheckSquare2, run: () => onOpenTask(t.id) }))
      : [];

    const actionItems = fuzzyFilter(actions, q, (a) => a.label).map((a) => ({
      key: `action-${a.id}`,
      label: a.label,
      icon: a.icon || Zap,
      run: a.run,
    }));

    return [
      { label: 'Views', items: viewItems },
      { label: 'Projects', items: projectItems },
      { label: 'Tasks', items: taskItems },
      { label: 'Actions', items: actionItems },
    ].filter((g) => g.items.length > 0);
  }, [query, tabs, activeTab, projects, tasks, actions, onSelectTab, onSelectProject, onOpenTask]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= flatItems.length) setActiveIndex(0);
  }, [flatItems.length, activeIndex]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function runItem(item) {
    if (!item) return;
    item.run();
    requestClose();
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (flatItems.length ? (i + 1) % flatItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (flatItems.length ? (i - 1 + flatItems.length) % flatItems.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(flatItems[activeIndex]);
    }
    // Escape isn't handled here — useModalA11y's capture-phase listener
    // already closes the topmost modal, same as every other modal.
  }

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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a view, project, task, or action…"
            aria-label="Command palette search"
          />
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {flatItems.length === 0 ? (
          <div className="now-empty">Nothing matches "{query}".</div>
        ) : (
          <div className="command-palette-list" ref={listRef}>
            {groups.map((group) => (
              <div key={group.label} className="search-bar-dropdown-group">
                <div className="search-bar-dropdown-label">{group.label}</div>
                {group.items.map((item) => {
                  const index = flatItems.indexOf(item);
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-active={index === activeIndex}
                      className={`search-bar-dropdown-item command-palette-item ${index === activeIndex ? 'active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runItem(item)}
                    >
                      <Icon size={14} />
                      <span className="search-bar-dropdown-item-label">{item.label}</span>
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

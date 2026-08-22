/**
 * SearchBar — a small controlled search input used on both the Tasks list
 * and the Board view to filter tasks by title, notes, subtask text, or —
 * via a leading "@" token, e.g. "@errand" — by Label/tag name. Reads/writes
 * the shared `searchQuery` on SchedulerContext so the two views stay in
 * sync if the user switches tabs mid-search.
 *
 * The input itself stays bound directly to the raw `searchQuery` string,
 * exactly as before — typing/backspace/cursor behavior is unchanged. On top
 * of that, a dropdown lists live suggestions as the user types:
 *  - By default (plain text, not inside a "#"/"@" token) it suggests
 *    matching Tasks, via `taskMatchesQuery` (below) run against the whole
 *    query — clicking one opens that task directly (via `onSelectTask`)
 *    rather than filling the search box, since the intent is to jump to it.
 *  - The same default mode also lists matching Calendar Events, via
 *    `eventMatchesQuery` (below) against the whole query. Only MASTER events
 *    are matched/listed (never per-occurrence virtual instances — see
 *    recurrenceExpansion.js) so a recurring series surfaces as one result,
 *    not one per occurrence; clicking one calls `onSelectEvent` with the
 *    event object itself (not just its id), since the caller needs its
 *    `date` to know which day to jump to.
 *  - While the last word being typed is non-empty, it also lists matching
 *    Projects (ranked/typo-tolerant via nameSearch.js's rankByNameSearch,
 *    the same matcher used everywhere else project names are searched) and
 *    Labels/tags (this part predates and is independent of the Tasks
 *    suggestions above). Clicking a project navigates to it (via
 *    `onSelectProject`) and clears the query. Clicking a tag commits the
 *    word being typed into an "@tag" token instead of navigating.
 *  - A leading "#" (bare, or with text after it — e.g. "#pro") narrows the
 *    dropdown to Projects only, same as smart-parse's own "#project"
 *    shorthand; typing a space afterwards ends that token and reverts to
 *    the default Task suggestions.
 *  - Every already-applied "@tag" token in the query renders as a removable
 *    pill chip next to the input (styled like the app's other tag pills),
 *    so an applied filter reads as a distinct chip rather than being buried
 *    in free text; removing one strips just that token from the query.
 *
 * Sized via the `.search-bar` CSS classes (global.css) rather than inline
 * styles so the mobile media query can drop the desktop max-width — an
 * inline `maxWidth` can't be overridden by a stylesheet without
 * `!important`, which was clipping this to 320px even inside a full-width
 * mobile toolbar row.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Folder, Tag, CheckSquare, Calendar } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { rankByNameSearch } from '../../utils/nameSearch';
import { parseSearchQuery, taskMatchesParsedQuery, SEARCH_OPERATOR_HINTS } from '../../utils/searchQuery';
import Badge from './Badge';

export default function SearchBar({ placeholder = 'Search tasks, or filter with due:, p1, @tag…', onSelectProject, onSelectTask, onSelectEvent }) {
  const { searchQuery, setSearchQuery, projects, labels, tasks, events } = useScheduler();
  const [isFocused, setIsFocused] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function handlePointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setIsFocused(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  // Reset the completed-tasks toggle whenever the query changes, so opting
  // in for one search doesn't silently carry over and surface completed
  // tasks in an unrelated later search.
  useEffect(() => {
    setShowCompleted(false);
  }, [searchQuery]);

  const trimmedQuery = searchQuery.trim();
  const allTokens = trimmedQuery.length ? trimmedQuery.split(/\s+/) : [];
  const appliedTagTokens = allTokens.filter((t) => t.length > 1 && t.startsWith('@'));
  // The word currently being typed — the last token — drives Project/Label
  // dropdown matching, so results update as the user types rather than only
  // once a full "@tag"/"#project" token is already committed. Trailing
  // whitespace on the raw (untrimmed) query means the caret is past the end
  // of that last token, on a fresh empty word — checked separately from the
  // trim()'d token split above, since trimming alone can't tell "#" (still
  // being typed) apart from "# " (already finished, caret after the space).
  const ownsCaretPastTrailingSpace = /\s$/.test(searchQuery);
  const activeWord = ownsCaretPastTrailingSpace ? '' : allTokens[allTokens.length - 1] || '';
  const activeWordIsTag = activeWord.startsWith('@');
  // "#project" mirrors smart-parse's own project shorthand (see
  // utils/smartParse.js) — recognized here the same way "@tag" is, so a
  // leading "#" (even bare, with nothing typed after it yet) narrows the
  // dropdown to Projects only instead of being matched as a literal "#"
  // character (which never matches anything) or falling through to the
  // default Task suggestions.
  const activeWordIsProject = activeWord.startsWith('#');
  const activeWordText = (activeWordIsTag || activeWordIsProject ? activeWord.slice(1) : activeWord).toLowerCase();

  const matchingProjects =
    activeWordIsProject || (activeWordText && !activeWordIsTag)
      ? rankByNameSearch(activeWordText, projects.map((p) => ({ ...p, label: p.name }))).slice(0, 5)
      : [];
  const matchingLabels =
    activeWordText && !activeWordIsProject
      ? labels
          .filter((l) => l.name.toLowerCase().includes(activeWordText) && !appliedTagTokens.includes(`@${l.name.toLowerCase()}`))
          .slice(0, 5)
      : [];
  // Default suggestion mode: plain text, not currently inside a "#"/"@"
  // token. Matches against the whole query (not just the active word) via
  // the same predicate the List/Board views use for in-place filtering.
  // Completed tasks are excluded by default — jumping to a finished task
  // from search isn't usually the intent — but the "Show completed" toggle
  // below lets the user opt back in for the rare case they're hunting for
  // one.
  const inTaskSuggestionMode = !activeWordIsProject && !activeWordIsTag && trimmedQuery.length > 0;
  const matchingTasks = inTaskSuggestionMode
    ? tasks.filter((t) => (showCompleted || !t.isCompleted) && taskMatchesQuery(t, trimmedQuery, labels, projects)).slice(0, 5)
    : [];
  const hasHiddenCompletedMatches =
    !showCompleted &&
    inTaskSuggestionMode &&
    tasks.some((t) => t.isCompleted && taskMatchesQuery(t, trimmedQuery, labels, projects));
  // Master events only — matched the same way Tasks are (whole trimmed query,
  // same default-suggestion gating), never expanded into per-occurrence
  // results (see recurrenceExpansion.js's doc comment on expandRecurringEvent)
  // so a recurring series surfaces as a single result rather than flooding
  // the dropdown with individual occurrences.
  const matchingEvents = inTaskSuggestionMode
    ? events.filter((e) => eventMatchesQuery(e, trimmedQuery)).slice(0, 5)
    : [];
  /* An empty focused input shows nothing but the operator hint (see the
     dropdown below). Deliberately only when EMPTY: an operator language nobody
     knows about is barely worth having, but a panel that reappears on every
     keystroke that happens to match nothing would be noise. */
  const showOperatorHint = isFocused && !searchQuery.trim();

  const showDropdown =
    isFocused &&
    (showOperatorHint ||
      matchingProjects.length > 0 ||
      matchingLabels.length > 0 ||
      matchingTasks.length > 0 ||
      matchingEvents.length > 0 ||
      hasHiddenCompletedMatches);

  function removeTagToken(token) {
    setSearchQuery(allTokens.filter((t) => t !== token).join(' '));
  }

  function applyTag(labelName) {
    const withoutActiveWord = allTokens.slice(0, -1);
    setSearchQuery([...withoutActiveWord, `@${labelName}`, ''].join(' '));
  }

  function goToProject(project) {
    setSearchQuery('');
    setIsFocused(false);
    onSelectProject?.(project.id);
  }

  function selectTask(task) {
    setSearchQuery('');
    setIsFocused(false);
    onSelectTask?.(task.id);
  }

  function selectEvent(event) {
    setSearchQuery('');
    setIsFocused(false);
    onSelectEvent?.(event);
  }

  // Flattened, in-display-order list of the dropdown's rows (Tasks group,
  // then its "Show completed" pseudo-row, then Events, then Projects, then
  // Labels) so the shared keyboard-nav hook can drive one highlighted index
  // across all of them, same as CommandPalette's grouped-but-flat list. The
  // input itself stays bound directly to the raw `searchQuery` string
  // throughout — Arrow/Enter only move/activate the highlighted row, never
  // touch the text. Events sit right after Tasks (and their "Show completed"
  // row) since both are "jump to a specific item" results, as opposed to
  // Projects/Tags which behave more like filters.
  const flatItems = useMemo(() => {
    const items = matchingTasks.map((t) => ({ key: `task-${t.id}`, run: () => selectTask(t) }));
    if (hasHiddenCompletedMatches) items.push({ key: 'show-completed', run: () => setShowCompleted(true) });
    items.push(...matchingEvents.map((e) => ({ key: `event-${e.id}`, run: () => selectEvent(e) })));
    items.push(...matchingProjects.map((p) => ({ key: `project-${p.id}`, run: () => goToProject(p) })));
    items.push(...matchingLabels.map((l) => ({ key: `label-${l.id}`, run: () => applyTag(l.name) })));
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingTasks, hasHiddenCompletedMatches, matchingEvents, matchingProjects, matchingLabels]);

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: showDropdown ? flatItems.length : 0,
    onSelect: (index) => flatItems[index]?.run(),
    resetKey: searchQuery,
  });

  return (
    <div className="search-bar" ref={rootRef}>
      {appliedTagTokens.length > 0 && (
        <div className="search-bar-tag-pills">
          {appliedTagTokens.map((token) => (
            <Badge key={token} pill className="search-bar-tag-pill">
              {token}
              <button type="button" onClick={() => removeTagToken(token)} title={`Remove ${token}`} aria-label={`Remove ${token}`}>
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="search-bar-field">
        <span className="search-bar-icon">
          <Search size={14} />
        </span>
        <input
          type="text"
          className="search-bar-input"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="search-bar-listbox"
          aria-activedescendant={showDropdown && flatItems[activeIndex] ? `search-bar-option-${flatItems[activeIndex].key}` : undefined}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
        {searchQuery && (
          <button className="btn btn-icon search-bar-clear" onClick={() => setSearchQuery('')} title="Clear search">
            <X size={13} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="search-bar-dropdown" id="search-bar-listbox" role="listbox" ref={listRef}>
          {showOperatorHint && (
            <div className="search-bar-hint">
              <span className="search-bar-hint-label">Filter with</span>
              {SEARCH_OPERATOR_HINTS.map((hint) => (
                <code key={hint} className="search-bar-hint-token">
                  {hint}
                </code>
              ))}
            </div>
          )}
          {(matchingTasks.length > 0 || hasHiddenCompletedMatches) && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Tasks</div>
              {matchingTasks.map((t) => {
                const index = flatItems.findIndex((it) => it.key === `task-${t.id}`);
                return (
                  <button
                    key={t.id}
                    id={`search-bar-option-task-${t.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={`search-bar-dropdown-item ${index === activeIndex ? 'active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectTask(t)}
                  >
                    <CheckSquare size={13} />
                    <span className="search-bar-dropdown-item-label">{t.title}</span>
                  </button>
                );
              })}
              {hasHiddenCompletedMatches && (
                <button
                  id="search-bar-option-show-completed"
                  type="button"
                  role="option"
                  aria-selected={flatItems[activeIndex]?.key === 'show-completed'}
                  data-active={flatItems[activeIndex]?.key === 'show-completed'}
                  className={`search-bar-dropdown-item search-bar-dropdown-show-completed ${
                    flatItems[activeIndex]?.key === 'show-completed' ? 'active' : ''
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(flatItems.findIndex((it) => it.key === 'show-completed'))}
                  onClick={() => setShowCompleted(true)}
                >
                  <CheckSquare size={13} />
                  <span className="search-bar-dropdown-item-label">Show completed tasks</span>
                </button>
              )}
            </div>
          )}
          {matchingEvents.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Events</div>
              {matchingEvents.map((e) => {
                const index = flatItems.findIndex((it) => it.key === `event-${e.id}`);
                return (
                  <button
                    key={e.id}
                    id={`search-bar-option-event-${e.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={`search-bar-dropdown-item ${index === activeIndex ? 'active' : ''}`}
                    onMouseDown={(e2) => e2.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectEvent(e)}
                  >
                    <Calendar size={13} />
                    <span className="search-bar-dropdown-item-label">
                      {e.title}
                      <span className="search-bar-dropdown-item-hint"> · {e.date}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {matchingProjects.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Projects</div>
              {matchingProjects.map((p) => {
                const index = flatItems.findIndex((it) => it.key === `project-${p.id}`);
                return (
                  <button
                    key={p.id}
                    id={`search-bar-option-project-${p.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={`search-bar-dropdown-item ${index === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => goToProject(p)}
                  >
                    <Folder size={13} />
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
          {matchingLabels.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Tags</div>
              {matchingLabels.map((l) => {
                const index = flatItems.findIndex((it) => it.key === `label-${l.id}`);
                return (
                  <button
                    key={l.id}
                    id={`search-bar-option-label-${l.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    className={`search-bar-dropdown-item ${index === activeIndex ? 'active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => applyTag(l.name)}
                  >
                    <Tag size={13} style={{ color: l.color }} />
                    {l.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shared filter predicate: does this task match the given search query?
 *
 * The grammar lives in utils/searchQuery.js — `@tag`, `#project`, `p1`-`p4`,
 * `due:<date>`, `is:overdue`, `is:done`, `no:date` and friends, with anything
 * left over matched as plain text against title/notes/section. A query with no
 * operators behaves exactly as it always did. `projects` is only needed to
 * resolve `#project`; callers without it simply can't use that one operator.
 *
 * NOTE: this used to also match a task via its embedded `subtasks[].title`
 * (the old nested-array Subtask model). Now that a sub-task is just another
 * Task linked by `parentId`, it's matched independently by this same
 * predicate wherever the flat `tasks` list is searched — no separate
 * cross-reference is needed, and TaskListPanel's nested rows mean a
 * matching child still surfaces (under its parent, if the parent is also
 * in the visible/top-level set — see TaskListPanel's own doc comment for
 * that trade-off).
 */
export function taskMatchesQuery(task, query, labels = [], projects = []) {
  if (!query || !query.trim()) return true;
  return taskMatchesParsedQuery(task, parseSearchQuery(query), { labels, projects });
}

/**
 * Shared filter predicate: does this CalendarEvent match the given search
 * query? Simple case-insensitive substring match against title/description/
 * location — no "@tag" handling like `taskMatchesQuery` above, since events
 * don't carry Labels. Callers are expected to pass MASTER events only (never
 * expanded per-occurrence instances — see recurrenceExpansion.js), so a
 * matching recurring series is represented once here regardless of how many
 * occurrences it has.
 */
export function eventMatchesQuery(event, query) {
  if (!query || !query.trim()) return true;
  const q = query.trim().toLowerCase();
  if (event.title?.toLowerCase().includes(q)) return true;
  if (event.description?.toLowerCase().includes(q)) return true;
  if (event.location?.toLowerCase().includes(q)) return true;
  return false;
}

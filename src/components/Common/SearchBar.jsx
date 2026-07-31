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
 *  - While the last word being typed is non-empty, it also lists matching
 *    Projects and Labels/tags (this part predates and is independent of the
 *    Tasks suggestions above). Clicking a project navigates to it (via
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

import React, { useEffect, useRef, useState } from 'react';
import { Search, X, Folder, Tag, CheckSquare } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';

export default function SearchBar({ placeholder = 'Search tasks, @tag, or a project…', onSelectProject, onSelectTask }) {
  const { searchQuery, setSearchQuery, projects, labels, tasks } = useScheduler();
  const [isFocused, setIsFocused] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function handlePointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setIsFocused(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

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
      ? projects.filter((p) => !activeWordText || p.name.toLowerCase().includes(activeWordText)).slice(0, 5)
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
  // Completed tasks are excluded here — jumping to a finished task from
  // search isn't a useful action, unlike the List/Board views where seeing
  // a completed match in place is still informative.
  const matchingTasks =
    !activeWordIsProject && !activeWordIsTag && trimmedQuery.length > 0
      ? tasks.filter((t) => !t.isCompleted && taskMatchesQuery(t, trimmedQuery, labels)).slice(0, 5)
      : [];
  const showDropdown = isFocused && (matchingProjects.length > 0 || matchingLabels.length > 0 || matchingTasks.length > 0);

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

  return (
    <div className="search-bar" ref={rootRef}>
      {appliedTagTokens.length > 0 && (
        <div className="search-bar-tag-pills">
          {appliedTagTokens.map((token) => (
            <span key={token} className="badge tag-pill search-bar-tag-pill">
              {token}
              <button type="button" onClick={() => removeTagToken(token)} title={`Remove ${token}`} aria-label={`Remove ${token}`}>
                <X size={11} />
              </button>
            </span>
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
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          placeholder={placeholder}
        />
        {searchQuery && (
          <button className="btn btn-icon search-bar-clear" onClick={() => setSearchQuery('')} title="Clear search">
            <X size={13} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="search-bar-dropdown">
          {matchingTasks.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Tasks</div>
              {matchingTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="search-bar-dropdown-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectTask(t)}
                >
                  <CheckSquare size={13} />
                  <span className="search-bar-dropdown-item-label">{t.title}</span>
                </button>
              ))}
            </div>
          )}
          {matchingProjects.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Projects</div>
              {matchingProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="search-bar-dropdown-item"
                  onClick={() => goToProject(p)}
                >
                  <Folder size={13} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {matchingLabels.length > 0 && (
            <div className="search-bar-dropdown-group">
              <div className="search-bar-dropdown-label">Tags</div>
              {matchingLabels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="search-bar-dropdown-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyTag(l.name)}
                >
                  <Tag size={13} style={{ color: l.color }} />
                  {l.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shared filter predicate: does this task match the given search query?
 * Whitespace-separated tokens starting with "@" (e.g. "@errand") are
 * matched against the task's Label names instead of title/notes text, and
 * are required (AND'd) rather than merely one-of, since they read as an
 * explicit filter rather than free text; any remaining non-"@" text is
 * matched against title/notes/section (OR'd).
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
export function taskMatchesQuery(task, query, labels = []) {
  if (!query || !query.trim()) return true;
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const tagTokens = tokens.filter((t) => t.length > 1 && t.startsWith('@')).map((t) => t.slice(1));
  const textTokens = tokens.filter((t) => !t.startsWith('@'));

  if (tagTokens.length > 0) {
    const taskLabelNames = (task.labelIds || [])
      .map((id) => labels.find((l) => l.id === id)?.name?.toLowerCase())
      .filter(Boolean);
    const matchesEveryTag = tagTokens.every((tag) => taskLabelNames.some((name) => name.includes(tag)));
    if (!matchesEveryTag) return false;
  }

  if (textTokens.length === 0) return true;
  const q = textTokens.join(' ');
  if (task.title?.toLowerCase().includes(q)) return true;
  if (task.notes?.toLowerCase().includes(q)) return true;
  if (task.sectionName?.toLowerCase().includes(q)) return true;
  return false;
}

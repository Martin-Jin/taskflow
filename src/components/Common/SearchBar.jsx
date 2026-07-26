/**
 * SearchBar — a small controlled search input used on both the Tasks list
 * and the Board view to filter tasks by title, notes, subtask text, or —
 * via a leading "@" token, e.g. "@errand" — by Label/tag name. Reads/writes
 * the shared `searchQuery` on SchedulerContext so the two views stay in
 * sync if the user switches tabs mid-search.
 *
 * The input itself stays bound directly to the raw `searchQuery` string,
 * exactly as before — typing/backspace/cursor behavior is unchanged. On top
 * of that:
 *  - Every already-applied "@tag" token in the query renders as a removable
 *    pill chip next to the input (styled like the app's other tag pills),
 *    so an applied filter reads as a distinct chip rather than being buried
 *    in free text; removing one strips just that token from the query.
 *  - While the last word being typed is non-empty, a dropdown lists
 *    matching Projects and Labels/tags. Clicking a project navigates to it
 *    (via `onSelectProject`) and clears the query. Clicking a tag commits
 *    the word being typed into an "@tag" token instead of navigating.
 * Tasks themselves are NOT listed here — they're already filtered in place
 * in whichever view (List/Board) is open, via `taskMatchesQuery` below.
 *
 * Sized via the `.search-bar` CSS classes (global.css) rather than inline
 * styles so the mobile media query can drop the desktop max-width — an
 * inline `maxWidth` can't be overridden by a stylesheet without
 * `!important`, which was clipping this to 320px even inside a full-width
 * mobile toolbar row.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Search, X, Folder, Tag } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';

export default function SearchBar({ placeholder = 'Search tasks, @tag, or a project…', onSelectProject }) {
  const { searchQuery, setSearchQuery, projects, labels } = useScheduler();
  const [isFocused, setIsFocused] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function handlePointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setIsFocused(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const allTokens = searchQuery.trim().length ? searchQuery.trim().split(/\s+/) : [];
  const appliedTagTokens = allTokens.filter((t) => t.length > 1 && t.startsWith('@'));
  // The word currently being typed — the last token — drives dropdown
  // matching, so results update as the user types rather than only once a
  // full "@tag" token is already committed.
  const activeWord = allTokens[allTokens.length - 1] || '';
  const activeWordIsTag = activeWord.startsWith('@');
  // "#project" mirrors smart-parse's own project shorthand (see
  // utils/smartParse.js) — recognized here the same way "@tag" is, so a
  // leading "#" narrows the dropdown to Projects only instead of being
  // matched as a literal "#" character (which never matches anything).
  const activeWordIsProject = activeWord.startsWith('#');
  const activeWordText = (activeWordIsTag || activeWordIsProject ? activeWord.slice(1) : activeWord).toLowerCase();

  const matchingProjects =
    activeWordText && !activeWordIsTag ? projects.filter((p) => p.name.toLowerCase().includes(activeWordText)).slice(0, 5) : [];
  const matchingLabels =
    activeWordText && !activeWordIsProject
      ? labels
          .filter((l) => l.name.toLowerCase().includes(activeWordText) && !appliedTagTokens.includes(`@${l.name.toLowerCase()}`))
          .slice(0, 5)
      : [];
  const showDropdown = isFocused && activeWordText.length > 0 && (matchingProjects.length > 0 || matchingLabels.length > 0);

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
 * matched the same way as before (title/notes/section/subtask, OR'd).
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
  if (task.subtasks?.some((s) => s.title.toLowerCase().includes(q))) return true;
  return false;
}

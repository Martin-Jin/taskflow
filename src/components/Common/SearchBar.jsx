/**
 * SearchBar — a small controlled search input used on both the Tasks list
 * and the Board view to filter tasks by title, notes, subtask text, or —
 * via a leading "@" token, e.g. "@errand" — by Label/tag name. Reads/writes
 * the shared `searchQuery` on SchedulerContext so the two views stay in
 * sync if the user switches tabs mid-search.
 *
 * Sized via the `.search-bar` CSS classes (global.css) rather than inline
 * styles so the mobile media query can drop the desktop max-width — an
 * inline `maxWidth` can't be overridden by a stylesheet without
 * `!important`, which was clipping this to 320px even inside a full-width
 * mobile toolbar row.
 */

import React from 'react';
import { Search, X } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';

export default function SearchBar({ placeholder = 'Search tasks or @tag…' }) {
  const { searchQuery, setSearchQuery } = useScheduler();

  return (
    <div className="search-bar">
      <span className="search-bar-icon">
        <Search size={14} />
      </span>
      <input
        type="text"
        className="search-bar-input"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={placeholder}
      />
      {searchQuery && (
        <button className="btn btn-icon search-bar-clear" onClick={() => setSearchQuery('')} title="Clear search">
          <X size={13} />
        </button>
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

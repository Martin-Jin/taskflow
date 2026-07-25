/**
 * SearchBar — a small controlled search input used on both the Tasks list
 * and the Board view to filter tasks by title, notes, or subtask text.
 * Reads/writes the shared `searchQuery` on SchedulerContext so the two
 * views stay in sync if the user switches tabs mid-search.
 */

import React from 'react';
import { Search, X } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';

export default function SearchBar({ placeholder = 'Search tasks…' }) {
  const { searchQuery, setSearchQuery } = useScheduler();

  return (
    <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
      <span
        style={{
          position: 'absolute',
          left: 9,
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--text-tertiary)',
          display: 'flex',
          pointerEvents: 'none',
        }}
      >
        <Search size={14} />
      </span>
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '7px 10px 7px 30px',
          background: 'var(--bg-surface-raised)',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontSize: 13,
        }}
      />
      {searchQuery && (
        <button
          className="btn btn-icon"
          onClick={() => setSearchQuery('')}
          title="Clear search"
          style={{ position: 'absolute', right: 2, top: 2, padding: '4px 7px', border: 'none', background: 'transparent' }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** Shared filter predicate: does this task match the given search query? */
export function taskMatchesQuery(task, query) {
  if (!query || !query.trim()) return true;
  const q = query.trim().toLowerCase();
  if (task.title?.toLowerCase().includes(q)) return true;
  if (task.notes?.toLowerCase().includes(q)) return true;
  if (task.sectionName?.toLowerCase().includes(q)) return true;
  if (task.subtasks?.some((s) => s.title.toLowerCase().includes(q))) return true;
  return false;
}

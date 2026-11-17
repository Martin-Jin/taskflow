/**
 * useProjectSearch — the "type to filter/rank projects, arrow through the
 * results, Enter to pick one" behavior shared by every project-only search
 * box in the app (today just ManageProjectsModal). Kept as its own hook so
 * another project-only search can reuse the same query state +
 * sortProjectsForSidebar + rankByNameSearch + useListKeyboardNav wiring
 * instead of copying it.
 *
 * Fuzzy by design, not just substring — rankByNameSearch's tiers (prefix,
 * substring, subsequence, then typo-tolerant edit-distance) are what every
 * project search in this app already runs on, so a project named "Personal
 * Errands" still turns up for "prsnl" or a minor typo, same as it would in
 * ManageProjectsModal.
 */

import { useState } from 'react';
import { useListKeyboardNav } from './useListKeyboardNav';
import { sortProjectsForSidebar } from '../utils/projectConstants';
import { rankByNameSearch } from '../utils/nameSearch';

export function useProjectSearch(projects, onSelect) {
  const [query, setQuery] = useState('');

  const sortedProjects = sortProjectsForSidebar(projects);
  // Empty query keeps the pinned/recency order; a real query re-ranks by
  // relevance instead (see rankByNameSearch's own doc comment on tie-breaks).
  const visibleProjects = query.trim()
    ? rankByNameSearch(query, sortedProjects.map((p) => ({ ...p, label: p.name })))
    : sortedProjects;
  const isSearching = query.trim().length > 0;

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListKeyboardNav({
    itemCount: isSearching ? visibleProjects.length : 0,
    onSelect: (index) => {
      const project = visibleProjects[index];
      if (project) onSelect(project.id);
    },
    resetKey: query,
  });

  return { query, setQuery, visibleProjects, isSearching, activeIndex, setActiveIndex, listRef, handleKeyDown };
}

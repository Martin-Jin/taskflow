/**
 * ChangelogModal — "What's New" panel listing every entry in
 * `src/changelog.js`, newest first, with a search box that filters across
 * version titles and individual change lines (so e.g. searching "calendar"
 * surfaces every release that touched calendar syncing). Opened either
 * automatically on first load after a new version ships (see App.jsx) or
 * manually from Settings → Versions.
 *
 * GROUPING: entries are grouped by major.minor version (the "1.10" in
 * "1.10.1") so a run of patch-level bugfix entries (1.10.1, 1.10.2, ...)
 * doesn't clutter the main list with near-duplicate headers — only the
 * x.y.0 feature entry is shown up front, with any later patches collapsed
 * into a "N patch fixes" dropdown underneath it. A query match inside a
 * collapsed patch auto-expands that group so search still finds it.
 *
 * Only the 2 newest major.minor groups are shown by default, with a
 * "See N more versions" button to reveal the rest — searching bypasses
 * this cap so older matches are never hidden.
 */

import React, { useMemo, useState } from 'react';
import { X, Search, Sparkles, ChevronDown } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { CHANGELOG } from '../../changelog';

function majorMinor(version) {
  return version.split('.').slice(0, 2).join('.');
}

function entryMatches(entry, q) {
  return entry.title.toLowerCase().includes(q) || entry.version.includes(q) || entry.changes.some((c) => c.toLowerCase().includes(q));
}

// Collapses the flat, newest-first CHANGELOG into one group per major.minor
// version: `base` is the x.y.0 entry (falls back to the newest entry in the
// group if a .0 was never recorded), `fixes` is every later patch, newest
// first.
function groupChangelog(entries) {
  const order = [];
  const byKey = new Map();
  entries.forEach((entry) => {
    const key = majorMinor(entry.version);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key).push(entry);
  });
  return order.map((key) => {
    const groupEntries = byKey.get(key);
    const base = groupEntries.find((e) => e.version.endsWith('.0')) || groupEntries[groupEntries.length - 1];
    const fixes = groupEntries.filter((e) => e !== base);
    return { key, base, fixes };
  });
}

export default function ChangelogModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showAllVersions, setShowAllVersions] = useState(false);

  const groups = useMemo(() => groupChangelog(CHANGELOG), []);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => {
        const baseMatches = entryMatches(group.base, q);
        const matchingFixes = group.fixes.filter((fix) => entryMatches(fix, q));
        if (!baseMatches && matchingFixes.length === 0) return null;
        return { ...group, fixes: baseMatches ? group.fixes : matchingFixes, forceExpand: matchingFixes.length > 0 };
      })
      .filter(Boolean);
  }, [groups, query]);

  const isSearching = query.trim().length > 0;
  const displayedGroups = !isSearching && !showAllVersions ? filteredGroups.slice(0, 2) : filteredGroups;
  const hiddenCount = filteredGroups.length - displayedGroups.length;

  function toggleExpanded(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>What's new</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="sidebar-project-search">
          <Search size={13} className="sidebar-project-search-icon" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search updates…"
            aria-label="Search updates"
          />
        </div>

        {filteredGroups.length === 0 ? (
          <div className="now-empty">No updates match "{query}".</div>
        ) : (
          <ul className="missed-tasks-list stat-list-modal-list changelog-list">
            {displayedGroups.map((group) => {
              const isOpen = group.forceExpand || expanded.has(group.key);
              return (
                <li key={group.key} className="changelog-entry">
                  <div className="changelog-entry-header">
                    <span className="changelog-entry-title">
                      <Sparkles size={13} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                      {group.base.title}
                    </span>
                    <span className="changelog-entry-meta">
                      v{group.key} · {group.base.date}
                    </span>
                  </div>
                  <ul className="changelog-entry-changes">
                    {group.base.changes.map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                  </ul>
                  {group.fixes.length > 0 && (
                    <div className="changelog-fixes">
                      <button
                        type="button"
                        className="changelog-fixes-toggle"
                        onClick={() => toggleExpanded(group.key)}
                        aria-expanded={isOpen}
                      >
                        <ChevronDown size={13} className={`changelog-fixes-chevron ${isOpen ? 'is-open' : ''}`} />
                        {group.fixes.length === 1 ? '1 fix' : `${group.fixes.length} fixes`}
                      </button>
                      {isOpen && (
                        <ul className="changelog-fixes-list">
                          {group.fixes.map((fix) => (
                            <li key={fix.version} className="changelog-fix-entry">
                              <div className="changelog-entry-meta changelog-fix-meta">
                                v{fix.version} · {fix.date}
                              </div>
                              <ul className="changelog-entry-changes">
                                {fix.changes.map((change, i) => (
                                  <li key={i}>{change}</li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!isSearching && hiddenCount > 0 && (
          <button
            type="button"
            className="changelog-fixes-toggle changelog-see-more"
            onClick={() => setShowAllVersions(true)}
          >
            <ChevronDown size={13} />
            See {hiddenCount} more version{hiddenCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}

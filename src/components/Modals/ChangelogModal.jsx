/**
 * ChangelogModal — "What's New" panel listing every entry in
 * `src/changelog.js`, newest first, with a search box that filters across
 * version titles and individual change lines (so e.g. searching "calendar"
 * surfaces every release that touched calendar syncing). Opened either
 * automatically on first load after a new version ships (see App.jsx) or
 * manually from Settings → Versions.
 */

import React, { useMemo, useState } from 'react';
import { X, Search, Sparkles } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { CHANGELOG } from '../../changelog';

export default function ChangelogModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [query, setQuery] = useState('');

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CHANGELOG;
    return CHANGELOG.filter(
      (entry) => entry.title.toLowerCase().includes(q) || entry.version.includes(q) || entry.changes.some((c) => c.toLowerCase().includes(q))
    );
  }, [query]);

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

        {filteredEntries.length === 0 ? (
          <div className="now-empty">No updates match "{query}".</div>
        ) : (
          <ul className="missed-tasks-list stat-list-modal-list changelog-list">
            {filteredEntries.map((entry) => (
              <li key={entry.version} className="changelog-entry">
                <div className="changelog-entry-header">
                  <span className="changelog-entry-title">
                    <Sparkles size={13} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                    {entry.title}
                  </span>
                  <span className="changelog-entry-meta">
                    v{entry.version} · {entry.date}
                  </span>
                </div>
                <ul className="changelog-entry-changes">
                  {entry.changes.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

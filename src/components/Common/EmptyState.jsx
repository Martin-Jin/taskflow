/**
 * EmptyState — the shared "nothing here" placeholder, generalising the
 * already-reused `.now-empty` class (a dozen-plus hand-copied
 * `<div className="now-empty">...</div>`s across dashboard cards, modals,
 * and search/filter dropdowns) plus its optional `.empty-state-icon`
 * pairing (NowNextCard, NotesCard).
 *
 * Deliberately NOT absorbing every small "muted placeholder text" class in
 * the app — `board-column-empty`, `sidebar-project-empty`,
 * `dependency-picker-empty`, `projects-page-column-empty`,
 * `detail-move-to-empty`, `assign-to-empty` are each a single, tiny,
 * already-minimal CSS rule tuned to one specific dropdown/list-row context;
 * forcing them through a shared component would trade a real, working rule
 * for a marginal reduction in CSS line count, with real risk of subtle
 * padding/sizing drift across many surfaces. Same reasoning kept
 * `gantt-empty-state` (a one-off "full card: icon + heading + paragraph +
 * action button" shape, with exactly one consumer) out of scope — there's
 * no genuine duplication to consolidate there, just a single bespoke state.
 */

import React from 'react';

export default function EmptyState({ icon: Icon, iconSize = 20, className = '', children }) {
  return (
    <div className={`now-empty ${className}`.trim()}>
      {Icon && <Icon size={iconSize} className="empty-state-icon" aria-hidden="true" />}
      {children}
    </div>
  );
}

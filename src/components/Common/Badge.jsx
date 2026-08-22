/**
 * Badge — the one shared pill treatment for priority/label/status, replacing
 * the ad-hoc `.badge`/`.tag-pill` markup that used to be hand-copied at every
 * call site (BoardView, TaskListPanel, BlockDetailModal task-priority pills;
 * TaskListPanel/SearchBar label/tag pills; IntegrationsSection's
 * connection-status pills).
 *
 * `variant` maps straight onto the existing bare-word CSS classes
 * (`.badge.urgent/high/medium/low` for priority, `.badge.success`/`.neutral`
 * for a connection-status pill) — pass a task's `priority` directly, or
 * `'success'`/`'neutral'` for a status pill. Omit it for a label pill, which
 * gets its color from the label itself via `style`, not a variant class.
 *
 * `pill` adds `.tag-pill` (overrides the priority badge's bold letter-
 * spacing for a plain label/tag name — see that class's own comment in
 * global.css) — set it for label/tag pills, not priority/status ones.
 *
 * `icon` renders a lucide icon at the front, sized to match the badge's own
 * small type scale.
 */

import React from 'react';

export default function Badge({ variant, pill = false, icon: Icon, className = '', style, children }) {
  const classes = ['badge', variant, pill ? 'tag-pill' : '', className].filter(Boolean).join(' ');
  return (
    <span className={classes} style={style}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

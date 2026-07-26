/**
 * MentionDropdown — the popup list shown by useMentionAutocomplete while
 * typing "@" or "#" into SmartTitleInput. Portaled to document.body and
 * positioned from a caller-supplied anchor rect (the pixel position of the
 * trigger character), same reasoning as SelectMenu's portal: the title
 * field usually sits inside a scrollable modal, so an in-flow popup would
 * get clipped rather than floating freely over the rest of the page.
 *
 * CLAMPING: unlike ProjectActionsMenu/SelectMenu (fixed-width dropdowns, so
 * their horizontal position can be computed from the trigger rect alone),
 * this list's width depends on its content (label/project names, the
 * "Create …" option), so it has to actually mount and be measured before
 * its position can be clamped — same "no dependency array, bail out via
 * functional setState" trick as the anchor-measuring effect in
 * SmartTitleInput, so this settles before the browser ever paints it
 * on-screen instead of visibly jumping into place a frame later.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tag, Folder, Layers, Plus } from 'lucide-react';

const MODE_ICONS = { label: Tag, project: Folder, section: Layers };
const EDGE_MARGIN = 8;

export default function MentionDropdown({ anchorRect, mode, matches, showCreateOption, highlightedIndex, onHighlight, onSelect, query }) {
  const listRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!anchorRect || !listRef.current) return;
    const rect = listRef.current.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN, Math.min(anchorRect.left, window.innerWidth - rect.width - EDGE_MARGIN));
    const spaceBelow = window.innerHeight - anchorRect.top;
    const openAbove = spaceBelow < rect.height + EDGE_MARGIN && anchorRect.aboveTop > rect.height + EDGE_MARGIN;
    const top = openAbove
      ? Math.max(EDGE_MARGIN, anchorRect.aboveTop - rect.height)
      : Math.min(anchorRect.top, window.innerHeight - rect.height - EDGE_MARGIN);
    setPosition((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  });

  if (!anchorRect) return null;
  const Icon = MODE_ICONS[mode] || Tag;
  const pos = position || anchorRect;

  return createPortal(
    <ul ref={listRef} className="mention-dropdown" role="listbox" style={{ position: 'fixed', left: pos.left, top: pos.top }}>
      {matches.map((item, i) => (
        <li key={item.id} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={i === highlightedIndex}
            className={`mention-dropdown-option ${i === highlightedIndex ? 'highlighted' : ''}`}
            onMouseEnter={() => onHighlight(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(i);
            }}
          >
            <Icon size={13} aria-hidden="true" />
            {item.name}
          </button>
        </li>
      ))}
      {showCreateOption && (
        <li role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={highlightedIndex >= matches.length}
            className={`mention-dropdown-option mention-dropdown-create ${highlightedIndex >= matches.length ? 'highlighted' : ''}`}
            onMouseEnter={() => onHighlight(matches.length)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(matches.length);
            }}
          >
            <Plus size={13} aria-hidden="true" />
            Create "{query.trim()}"
          </button>
        </li>
      )}
    </ul>,
    document.body
  );
}

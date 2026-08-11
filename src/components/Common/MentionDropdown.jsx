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
 * its position can be clamped — see useAnchoredPosition (shared with
 * KeywordSuggestPopup) for that measure-then-clamp logic.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { Tag, Folder, Layers, Plus } from 'lucide-react';
import { useAnchoredPosition } from '../../hooks/useAnchoredPosition';

const MODE_ICONS = { label: Tag, project: Folder, section: Layers, sectionShorthand: Layers };

export default function MentionDropdown({ anchorRect, mode, matches, showCreateOption, highlightedIndex, onHighlight, onSelect, query }) {
  const { elementRef: listRef, position: pos } = useAnchoredPosition(anchorRect);

  if (!anchorRect) return null;
  const Icon = MODE_ICONS[mode] || Tag;

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

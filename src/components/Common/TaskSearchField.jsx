/**
 * TaskSearchField — a type-to-search task picker: a text box with a fuzzy-
 * matched suggestion list underneath.
 *
 * Nothing is suggested until at least MIN_QUERY_LENGTH characters are typed,
 * so a long task list isn't dumped on the user before they've said what they
 * want. Arrow keys move through the suggestions, Enter picks the highlighted
 * one, and Escape closes just the list (via useEscapeLayer, so it doesn't
 * close the modal around it).
 *
 * The list sits in the page flow rather than floating over it: this is used
 * inside a scrolling modal, where a floating list would be clipped.
 *
 * Editing the text after picking a task clears the pick, so what's shown
 * always matches what will be scheduled.
 */

import React, { useMemo, useState } from 'react';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { fuzzyFilterTasks } from '../../utils/fuzzyTaskSearch';

export const MIN_QUERY_LENGTH = 2;
const MAX_SUGGESTIONS = 8;

export default function TaskSearchField({ tasks, selectedTaskId, onSelect, disabled }) {
  const selectedTask = tasks.find((t) => t.id === selectedTaskId);
  const [text, setText] = useState(selectedTask?.title || '');
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const query = text.trim();
  const matches = useMemo(
    () => (query.length >= MIN_QUERY_LENGTH ? fuzzyFilterTasks(tasks, query, (t) => t.title).slice(0, MAX_SUGGESTIONS) : []),
    [tasks, query]
  );
  const showList = isOpen && !selectedTask && query.length >= MIN_QUERY_LENGTH;

  useEscapeLayer(showList, () => setIsOpen(false));

  function pick(task) {
    setText(task.title);
    setIsOpen(false);
    onSelect(task.id);
  }

  function handleKeyDown(e) {
    if (!showList || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[Math.min(highlighted, matches.length - 1)]);
    }
  }

  return (
    <>
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls="task-search-list"
        aria-autocomplete="list"
        aria-label="Task"
        autoComplete="off"
        value={text}
        placeholder="Type to search tasks…"
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setIsOpen(true);
          setHighlighted(0);
          if (selectedTaskId) onSelect('');
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {showList && (
        <ul id="task-search-list" className="task-search-list" role="listbox">
          {matches.length === 0 ? (
            <li className="task-search-empty">No matching tasks</li>
          ) : (
            matches.map((t, i) => (
              <li key={t.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlighted}
                  className={`task-search-option ${i === highlighted ? 'highlighted' : ''}`}
                  onMouseEnter={() => setHighlighted(i)}
                  // mousedown, not click: the input's blur must not close the list before the pick lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(t);
                  }}
                >
                  {t.title}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </>
  );
}

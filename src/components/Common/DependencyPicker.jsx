/**
 * DependencyPicker — combobox-style multi-select for a task's dependencies.
 *
 * Replaces the previous native <select multiple>, which required an
 * undiscoverable ctrl/cmd-click to deselect an already-picked option (a
 * plain click could only ever replace the selection with a single item).
 * Here, removal is an explicit click target (the chip's X button), so
 * there's no hidden gesture to know about.
 *
 * `options` is expected to already be filtered by the caller (cycle
 * prevention, excluding completed tasks, etc. — see AddTaskModal /
 * TaskDetailModal, which apply slightly different filtering rules).
 *
 * The query/open-state plumbing is shared with LabelPicker via
 * useComboboxMultiSelect — this component owns the option filtering and
 * keyboard navigation, since both depend on this picker's own row count.
 */

import React, { useMemo } from 'react';
import { X } from 'lucide-react';
import { useComboboxMultiSelect } from '../../hooks/useComboboxMultiSelect';

// Wrapped in memo — see LabelPicker's equivalent note; callers must keep
// `options`/`selectedIds`/`onChange` reference-stable for this to help.
function DependencyPicker({ options, selectedIds, onChange, placeholder = 'Search tasks…' }) {
  const { query, setQuery, isOpen, highlightedIndex, setHighlightedIndex, inputRef, handleBlur, handleFocus, resetQuery } =
    useComboboxMultiSelect();

  const optionById = useMemo(() => new Map(options.map((t) => [t.id, t])), [options]);
  const selectedTasks = useMemo(() => selectedIds.map((id) => optionById.get(id)).filter(Boolean), [selectedIds, optionById]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((t) => !selectedIds.includes(t.id) && (!q || t.title.toLowerCase().includes(q)));
  }, [options, selectedIds, query]);

  function selectOption(id) {
    onChange([...selectedIds, id]);
    resetQuery();
  }

  function removeId(id) {
    onChange(selectedIds.filter((sid) => sid !== id));
  }

  function handleKeyDown(e) {
    if (e.key === 'Backspace' && query === '' && selectedIds.length > 0) {
      removeId(selectedIds[selectedIds.length - 1]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredOptions[highlightedIndex];
      if (target) selectOption(target.id);
      return;
    }
    if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  }

  return (
    <div className="dependency-picker">
      {selectedTasks.length > 0 && (
        <div className="dependency-picker-chips">
          {selectedTasks.map((t) => (
            <span key={t.id} className="chip chip-dependency">
              {t.title}
              <button
                type="button"
                className="chip-dependency-remove"
                onClick={() => removeId(t.id)}
                title={`Remove ${t.title}`}
                aria-label={`Remove ${t.title}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="dependency-picker-input-row">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={selectedTasks.length > 0 ? 'Add another…' : placeholder}
        />

        {isOpen && (
          <div className="dependency-picker-dropdown">
            {filteredOptions.length === 0 ? (
              <div className="dependency-picker-empty">
                {options.length === selectedIds.length ? 'All eligible tasks selected.' : 'No matching tasks.'}
              </div>
            ) : (
              filteredOptions.map((t, i) => (
                <button
                  type="button"
                  key={t.id}
                  className={`dependency-picker-option ${i === highlightedIndex ? 'highlighted' : ''}`}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectOption(t.id)}
                >
                  {t.title}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(DependencyPicker);

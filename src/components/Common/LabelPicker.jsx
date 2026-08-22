/**
 * LabelPicker — combobox-style multi-select for a task's Labels (tags),
 * mirroring DependencyPicker's chip-based interaction (see its doc comment
 * for the shared query/open-state plumbing, via useComboboxMultiSelect).
 * The one addition: typing a name that doesn't match any existing label
 * offers a "Create" option, since labels (unlike dependency tasks) don't
 * need to already exist — see SchedulerContext.getOrCreateLabelIds.
 */

import React, { useMemo } from 'react';
import { X, Plus } from 'lucide-react';
import { useComboboxMultiSelect } from '../../hooks/useComboboxMultiSelect';

// Wrapped in memo: its own re-renders are otherwise driven by every keystroke
// in TaskDetailModal's title/notes fields, which don't touch this picker's
// props at all — see call sites for the useCallback/useMemo needed to keep
// `selectedIds`/`onCreateLabel` reference-stable so memo actually pays off.
function LabelPicker({ labels, selectedIds, onChange, onCreateLabel, placeholder = 'Add a tag…', disabled = false }) {
  const { query, setQuery, isOpen, highlightedIndex, setHighlightedIndex, inputRef, handleBlur, handleFocus, resetQuery } =
    useComboboxMultiSelect();

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const selectedLabels = useMemo(() => selectedIds.map((id) => labelById.get(id)).filter(Boolean), [selectedIds, labelById]);

  const trimmedQuery = query.trim();
  const filteredOptions = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    return labels.filter((l) => !selectedIds.includes(l.id) && (!q || l.name.toLowerCase().includes(q)));
  }, [labels, selectedIds, trimmedQuery]);

  const exactMatchExists = filteredOptions.some((l) => l.name.toLowerCase() === trimmedQuery.toLowerCase());
  const canCreate = trimmedQuery.length > 0 && !exactMatchExists;
  // The "Create" row lives after every filtered option in the keyboard order.
  const totalRows = filteredOptions.length + (canCreate ? 1 : 0);

  function selectExisting(id) {
    onChange([...selectedIds, id]);
    resetQuery();
  }

  function createAndSelect() {
    if (!trimmedQuery) return;
    const id = onCreateLabel(trimmedQuery);
    if (id) onChange([...selectedIds, id]);
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
      setHighlightedIndex((i) => Math.min(i + 1, totalRows - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex < filteredOptions.length) {
        const target = filteredOptions[highlightedIndex];
        if (target) selectExisting(target.id);
      } else if (canCreate) {
        createAndSelect();
      }
      return;
    }
    // Escape is handled by useComboboxMultiSelect's escape layer, not here —
    // a keydown on this input never sees it (see useEscapeLayer).
  }

  return (
    <div className="dependency-picker">
      {selectedLabels.length > 0 && (
        <div className="dependency-picker-chips">
          {selectedLabels.map((l) => (
            <span key={l.id} className="chip chip-label" style={{ background: `${l.color}22`, color: l.color }}>
              {l.name}
              <button
                type="button"
                className="chip-dependency-remove"
                onClick={() => removeId(l.id)}
                disabled={disabled}
                title={`Remove ${l.name}`}
                aria-label={`Remove ${l.name}`}
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
          placeholder={selectedLabels.length > 0 ? 'Add another…' : placeholder}
          disabled={disabled}
        />

        {!disabled && isOpen && (
          <div className="dependency-picker-dropdown">
            {filteredOptions.length === 0 && !canCreate ? (
              <div className="dependency-picker-empty">
                {labels.length === selectedIds.length ? 'All tags selected.' : 'No matching tags.'}
              </div>
            ) : (
              <>
                {filteredOptions.map((l, i) => (
                  <button
                    type="button"
                    key={l.id}
                    className={`dependency-picker-option ${i === highlightedIndex ? 'highlighted' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectExisting(l.id)}
                  >
                    <span className="label-swatch" style={{ background: l.color }} />
                    {l.name}
                  </button>
                ))}
                {canCreate && (
                  <button
                    type="button"
                    className={`dependency-picker-option ${filteredOptions.length === highlightedIndex ? 'highlighted' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(filteredOptions.length)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={createAndSelect}
                  >
                    <Plus size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
                    Create "{trimmedQuery}"
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(LabelPicker);

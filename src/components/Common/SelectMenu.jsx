/**
 * SelectMenu — a button-triggered popup listbox that replaces a native
 * <select> when the surrounding UI needs the popup itself themed (native
 * <option> lists are OS-rendered and can't be dark-themed). Used for the
 * project/list picker in AddTaskModal's footer, matching the app's other
 * custom popups (see DependencyPicker/LabelPicker's dropdown pattern in
 * forms.css) instead of leaking a native select's browser chrome.
 *
 * Portaled to document.body and positioned via getBoundingClientRect
 * rather than `position: absolute` in-flow, because the trigger usually
 * sits inside .modal, which has `overflow-y: auto` — an in-flow popup
 * gets clipped at the modal's edge the moment the trigger is near the
 * bottom (exactly where AddTaskModal's footer places it). Flips above
 * the trigger when there isn't room below.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export default function SelectMenu({ icon: Icon, value, options, onChange, ariaLabel }) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [position, setPosition] = useState(null);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const dropdownRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    function reposition() {
      const trigger = buttonRef.current;
      const dropdown = dropdownRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const dropdownHeight = dropdown ? dropdown.offsetHeight : 220;
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const openAbove = spaceBelow < dropdownHeight && triggerRect.top > spaceBelow;
      setPosition({
        left: triggerRect.left,
        width: triggerRect.width,
        top: openAbove ? undefined : triggerRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - triggerRect.top + 4 : undefined,
      });
    }

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handlePointerDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      if (dropdownRef.current?.contains(e.target)) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen]);

  function open() {
    setHighlightedIndex(Math.max(0, options.findIndex((o) => o.value === value)));
    setIsOpen(true);
  }

  function choose(optionValue) {
    onChange(optionValue);
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  function handleKeyDown(e) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[highlightedIndex];
      if (opt) choose(opt.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  }

  return (
    <div className="select-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="select-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => (isOpen ? setIsOpen(false) : open())}
        onKeyDown={handleKeyDown}
      >
        {Icon && <Icon size={14} />}
        <span className="select-menu-value">{selected ? selected.label : ''}</span>
        <ChevronDown size={14} className="select-menu-chevron" />
      </button>

      {isOpen &&
        position &&
        createPortal(
          <ul
            ref={dropdownRef}
            className="select-menu-dropdown"
            role="listbox"
            aria-label={ariaLabel}
            style={{ position: 'fixed', left: position.left, minWidth: position.width, top: position.top, bottom: position.bottom }}
          >
            {options.map((o, i) => (
              <li key={o.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`select-menu-option ${i === highlightedIndex ? 'highlighted' : ''} ${o.value === value ? 'selected' : ''}`}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o.value)}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}

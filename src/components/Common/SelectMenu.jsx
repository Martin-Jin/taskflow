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
 * the trigger when there isn't room below, and falls back to a centered
 * popup (see useMenuPosition) if even that wouldn't fit the viewport.
 *
 * `marquee` (default off) swaps the plain label span for MarqueeText, which
 * only animates when the label actually overflows its box — opt-in so the
 * default rendering (e.g. AddTaskModal's footer picker, which has plenty of
 * room and isn't width-constrained) is unaffected. The Tasks page's project
 * switcher passes it since long project names get a fixed max-width there
 * (see tasklist.css's `.taskpage-project-header .select-menu-value`).
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import MarqueeText from './MarqueeText';

export default function SelectMenu({ icon: Icon, value, options, onChange, ariaLabel, footerActions, marquee = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  const { menuRef, mode, style } = useMenuPosition({
    isOpen,
    anchorRef: buttonRef,
    onClose: () => setIsOpen(false),
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.left,
        minWidth: anchorRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  function open() {
    setHighlightedIndex(Math.max(0, options.findIndex((o) => o.value === value)));
    setIsOpen(true);
  }

  function choose(optionValue) {
    if (options.find((o) => o.value === optionValue)?.disabled) return;
    onChange(optionValue);
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  function runFooterAction(action) {
    setIsOpen(false);
    buttonRef.current?.focus();
    action.onClick();
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
        <span className="select-menu-value">
          {selected ? (marquee ? <MarqueeText text={selected.label} /> : selected.label) : ''}
        </span>
        <ChevronDown size={14} className="select-menu-chevron" />
      </button>

      {isOpen &&
        createPortal(
          <>
            {mode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setIsOpen(false)} />}
            <ul
              ref={menuRef}
              className={`select-menu-dropdown ${mode === 'centered' ? 'menu-popover-centered' : ''}`}
              role="listbox"
              aria-label={ariaLabel}
              style={mode === 'anchored' ? style : undefined}
            >
              {options.map((o, i) => (
                <li key={o.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled || undefined}
                    disabled={o.disabled}
                    title={o.disabledReason}
                    className={`select-menu-option ${i === highlightedIndex ? 'highlighted' : ''} ${o.value === value ? 'selected' : ''} ${o.disabled ? 'is-disabled' : ''}`}
                    onMouseEnter={() => !o.disabled && setHighlightedIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o.value)}
                  >
                    {o.label}
                  </button>
                </li>
              ))}
              {footerActions && footerActions.length > 0 && (
                <li role="presentation" className="select-menu-footer-wrap">
                  {footerActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className="select-menu-footer-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runFooterAction(action)}
                    >
                      {action.icon && <action.icon size={13} />}
                      {action.label}
                    </button>
                  ))}
                </li>
              )}
            </ul>
          </>,
          document.body
        )}
    </div>
  );
}

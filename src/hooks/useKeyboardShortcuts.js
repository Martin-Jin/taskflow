/**
 * useKeyboardShortcuts — global keyboard shortcuts (undo/redo/new task),
 * customizable from Settings → Keyboard shortcuts (see ShortcutsModal).
 * Replaces the old always-visible topbar Undo/Redo buttons (see App.jsx).
 *
 * Custom bindings are stored under one localStorage key (see persistence.js)
 * as { [shortcutId]: 'Ctrl+Shift+Z', ... } — only entries that differ from
 * SHORTCUT_DEFS' defaultCombo are ever written, so a fresh browser has an
 * empty override map and just falls back to the defaults below.
 *
 * The global listener reads overrides straight from localStorage on every
 * keydown rather than through React state, so an edit made in the Shortcuts
 * modal takes effect immediately without that modal and this hook needing to
 * share any state.
 */

import { useEffect, useRef } from 'react';
import { loadPersisted, savePersisted } from '../utils/persistence';

export const BINDINGS_STORAGE_KEY = 'shortcutBindings';

// `editable: true` entries can be rebound from Settings and are intercepted
// by useKeyboardShortcuts below (the caller supplies the actual handler per
// id). Non-editable entries are handled elsewhere in the app already
// (Escape-to-close is per-modal, see useModalA11y) — listed here purely so
// they show up alongside the real ones in the Shortcuts modal for reference.
export const SHORTCUT_DEFS = [
  { id: 'undo', label: 'Undo', description: 'Undo the last change', defaultCombo: 'Ctrl+Z', editable: true },
  { id: 'redo', label: 'Redo', description: 'Redo the last undone change', defaultCombo: 'Ctrl+Shift+Z', editable: true },
  { id: 'newTask', label: 'New task', description: 'Open the "Add task" dialog', defaultCombo: 'Alt+N', editable: true },
  { id: 'closeDialog', label: 'Close dialog', description: 'Close the open modal or popup menu', defaultCombo: 'Esc', editable: false },
];

// Offered in the "pick a combo" dropdown when editing a binding — a lighter
// alternative to pressing the actual keys (helps mobile/accessibility).
// Ctrl+N, Ctrl+Shift+N, Ctrl+T, Ctrl+W, Ctrl+S and similar are reserved by
// every major browser (new window/incognito/tab/close/save) — the browser
// acts on them regardless of e.preventDefault(), so they're deliberately
// left out here even though they'd look like natural picks.
export const PRESET_COMBOS = [
  'Ctrl+Z',
  'Ctrl+Shift+Z',
  'Ctrl+Y',
  'Ctrl+K',
  'Ctrl+/',
  'Alt+N',
  'Alt+Z',
];

/** Turns a keydown event into the same canonical string used for storage/display, e.g. "Ctrl+Shift+Z". */
export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.code || '';
  if (key.startsWith('Key')) key = key.slice(3);
  else if (key.startsWith('Digit')) key = key.slice(5);
  else if (e.key === 'Escape') key = 'Esc';
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key || key;
  parts.push(key);
  return parts.join('+');
}

export function getShortcutBindings() {
  return loadPersisted(BINDINGS_STORAGE_KEY, {});
}

export function setShortcutBinding(id, combo) {
  const bindings = getShortcutBindings();
  savePersisted(BINDINGS_STORAGE_KEY, { ...bindings, [id]: combo });
}

export function resetShortcutBinding(id) {
  const bindings = getShortcutBindings();
  const next = { ...bindings };
  delete next[id];
  savePersisted(BINDINGS_STORAGE_KEY, next);
}

/** Current effective combo for a shortcut id — its override if set, else its default. */
export function comboFor(id) {
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  return getShortcutBindings()[id] || def?.defaultCombo;
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Registers the app-wide shortcut listener. `handlers` maps a SHORTCUT_DEFS
 * id to the function to call when its (possibly-rebound) combo is pressed —
 * a shortcut that's currently disabled (e.g. undo with nothing to undo)
 * should still no-op inside its handler rather than being omitted, so the
 * reserved combo doesn't fall through to the browser's own binding for it.
 *
 * `onTrigger(def)`, if given, fires right after a handler runs — used by
 * App.jsx to pop a small "Undo" / "Redo" / "New task" confirmation toast so
 * pressing a shortcut always gives *some* visible feedback, the same way
 * clicking the equivalent button would.
 */
export function useKeyboardShortcuts(handlers, onTrigger) {
  // Ref so the listener (registered once) always calls the latest closures
  // without re-subscribing on every render — same pattern as useModalA11y's
  // onCloseRef.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  useEffect(() => {
    function handleKeyDown(e) {
      if (isEditableTarget(document.activeElement)) return;
      const combo = comboFromEvent(e);
      const bindings = getShortcutBindings();
      for (const def of SHORTCUT_DEFS) {
        if (!def.editable) continue;
        const handler = handlersRef.current[def.id];
        if (!handler) continue;
        if ((bindings[def.id] || def.defaultCombo) === combo) {
          e.preventDefault();
          handler();
          onTriggerRef.current?.(def);
          return;
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}

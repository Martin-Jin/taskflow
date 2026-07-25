/**
 * usePersistedState — a drop-in `useState` replacement that reads its
 * initial value from localStorage (falling back to `initialValue` if
 * nothing's saved yet) and writes back to localStorage on every change.
 *
 * Deliberately simple: no debouncing, no cross-tab sync. Settings-style
 * state (routines, rules, a boolean toggle) changes rarely enough that
 * writing on every change is cheap, and correctness/simplicity matters
 * more here than shaving a few localStorage.setItem calls.
 */

import { useEffect, useState } from 'react';
import { loadPersisted, savePersisted } from '../utils/persistence';

export function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(() => loadPersisted(key, typeof initialValue === 'function' ? initialValue() : initialValue));

  useEffect(() => {
    savePersisted(key, value);
  }, [key, value]);

  return [value, setValue];
}
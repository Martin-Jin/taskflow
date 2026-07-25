import { useLayoutEffect } from 'react';

/** Grows a textarea to fit its content instead of showing a scrollbar/resize grip. */
export function useAutosizeTextarea(ref, value) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

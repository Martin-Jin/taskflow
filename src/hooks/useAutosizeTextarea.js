import { useLayoutEffect } from 'react';

/** Grows a textarea to fit its content, optionally clamped to a max number of lines. */
export function useAutosizeTextarea(ref, value, options = {}) {
  const { maxLines = null } = options;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const computed = window.getComputedStyle(el);
    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const paddingBottom = parseFloat(computed.paddingBottom) || 0;
    const lineHeight = parseFloat(computed.lineHeight) || 0;

    el.style.height = 'auto';
    const preferredHeight = el.scrollHeight;
    const maxHeight =
      maxLines && lineHeight > 0 ? lineHeight * maxLines + paddingTop + paddingBottom : null;

    const nextHeight = maxHeight != null ? Math.min(preferredHeight, maxHeight) : preferredHeight;
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = maxHeight != null && preferredHeight > maxHeight ? 'auto' : 'hidden';
  }, [ref, value, maxLines]);
}
